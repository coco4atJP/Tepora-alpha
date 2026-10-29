/** Conversational canvas: stream parsers, the turn runner, the client-side state engine and the HTTP routes.
 * The model boundary is synthetic; no provider account or external network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {canvasCreateParser,canvasPatchParser,canvasMode,canvasMessages,validateCanvasTurn,runCanvasTurn} from '../core/canvas.mjs';
import {canvasFrameDocument,canvasFrameCsp} from '../core/canvas-frame.mjs';
import {canvasNormalizeOp,canvasDescribeOps,canvasAppendVersion,canvasRestoreVersion,canvasInitialState,canvasStartTurn,canvasReduce,canvasFinishTurn,canvasRevert,canvasTurnBody} from '../web/canvas-engine.mjs';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

const CREATE='<reply>ロケットを描きますね。</reply>\n<summary>夜空のロケット</summary>\n```html\n<svg data-id="scene" viewBox="0 0 800 600">\n <rect data-id="bg" width="800" height="600" fill="#0b1030"/>\n <g data-id="rocket"><path data-id="body" d="M400 120 L440 360 L360 360 Z"/></g>\n</svg>\n```';
const PATCH='<reply>炎を赤くします。</reply>\n<summary>赤い炎</summary>\n{"op":"set","id":"bg","attrs":{"fill":"#000"}}\n[{"op":"add","parent":"rocket","html":"<g data-id=\\"flame\\"></g>"},\n{"op":"remove","id":"ghost"}]\n';
const chunks=(s,n)=>s.match(new RegExp(`[\\s\\S]{1,${n}}`,'g'));
function feed(parser,text,n){const out=[];for(const c of chunks(text,n))out.push(...parser.push(c));out.push(...parser.end());return out;}

test('create parser yields the same artifact for any chunking and keeps the reply separate',()=>{
 for(const n of [1,2,3,7,64,9999]){
  const ev=feed(canvasCreateParser(),CREATE,n),end=ev.find(e=>e.type==='tool.end');
  assert.equal(ev.filter(e=>e.type==='reply').map(e=>e.delta).join(''),'ロケットを描きますね。',`reply @${n}`);
  assert.deepEqual(ev.filter(e=>e.type==='tool.start'),[{type:'tool.start',name:'create_artifact',summary:'夜空のロケット'}]);
  assert.equal(end.name,'create_artifact');assert.ok(end.args.html.startsWith('<svg data-id="scene"'));assert.ok(end.args.html.endsWith('</svg>'),`no fence leaks @${n}`);
  assert.equal(ev.filter(e=>e.type==='tool.html').map(e=>e.delta).join(''),end.args.html,'streamed html equals the final html');
 }
});

test('create parser treats untagged prose as a clarifying question, not an artifact',()=>{
 const ev=feed(canvasCreateParser(),'どんな雰囲気のポスターにしますか？',3);
 assert.equal(ev.some(e=>e.type.startsWith('tool.')),false);
 assert.equal(ev.map(e=>e.delta).join(''),'どんな雰囲気のポスターにしますか？');
});

test('patch parser releases each op when its line completes, tolerating arrays and prose',()=>{
 for(const n of [1,4,9,9999]){
  const ev=feed(canvasPatchParser(),PATCH+'以上です',n);
  assert.deepEqual(ev.filter(e=>e.type==='tool.op').map(e=>e.op.op),['set','add','remove'],`ops @${n}`);
  const end=ev.at(-1);assert.equal(end.type,'tool.end');assert.equal(end.args.summary,'赤い炎');assert.equal(end.args.ops.length,3);
  assert.ok(ev.filter(e=>e.type==='reply').map(e=>e.delta).join('').includes('以上です'));
 }
});

test('turn mode, validation and context follow the canvas protocol',()=>{
 assert.equal(canvasMode({text:'ロケット',artifact:null}),'create');
 assert.equal(canvasMode({text:'炎を赤く',artifact:{html:'<svg/>',version:1}}),'patch');
 assert.equal(canvasMode({text:'回路図にして',artifact:{html:'<svg/>',version:1}}),'create');
 assert.throws(()=>validateCanvasTurn({text:' '}),/依頼/);
 assert.throws(()=>validateCanvasTurn({text:'x',artifact:{html:'x'.repeat(200001),version:1}}),e=>e.status===413);
 const input=validateCanvasTurn({text:' 赤く ',artifact:{html:'<svg data-id="s"/>',version:2},history:[{role:'system',text:'no'},{role:'user',text:'描いて'}],versions:[{n:1,caption:'a'},{n:2,caption:'b'}]});
 assert.deepEqual(input.history,[{role:'user',text:'描いて'}]);
 const messages=canvasMessages(input);
 assert.equal(messages[0].role,'system');assert.match(messages[0].content,/JSON object per line/);
 assert.match(messages.at(-1).content,/version 2[\s\S]*data-id="s"[\s\S]*v1 a \| v2 b/);
});

test('runCanvasTurn streams through the work route without tools and recovers from a retried route',async()=>{
 const calls=[],events=[];
 const invoke=async(role,messages,options)=>{
  calls.push({role,tools:options.tools,system:messages[0].content});
  options.onRoute({model:'a',domain:'device',attempt:1});options.onDelta('<reply>途中まで書いた返事がここに届いています');
  options.onRoute({model:'b',domain:'device',attempt:2});for(const c of chunks(CREATE,5))options.onDelta(c);
  return {content:CREATE};
 };
 await runCanvasTurn(invoke,validateCanvasTurn({text:'ロケットを描いて'}),{emit:e=>events.push(e)});
 assert.equal(calls[0].role,'work');assert.deepEqual(calls[0].tools,[]);assert.match(calls[0].system,/create_artifact/);
 assert.deepEqual(events.map(e=>e.type).filter((t,i,a)=>t!==a[i-1]),['turn','route','reply','reset','route','reply','tool.start','tool.html','tool.end','done']);
 const non=[];await runCanvasTurn(async()=>({content:CREATE}),validateCanvasTurn({text:'描いて'}),{emit:e=>non.push(e)});
 assert.ok(non.find(e=>e.type==='tool.end').args.html.includes('rocket'),'non-streaming providers still produce the artifact');
});

test('canvas engine: op normalisation, captions and an append-only version log',()=>{
 assert.deepEqual(canvasNormalizeOp({type:'update','data-id':'bg',attrs:{fill:'red'}}),{op:'set',id:'bg',attrs:{fill:'red'},style:undefined,text:undefined});
 assert.deepEqual(canvasNormalizeOp({action:'insert',parentId:'g',html:'<i/>'}),{op:'add',parent:'g',before:null,html:'<i/>'});
 assert.equal(canvasNormalizeOp({op:'replace',id:'x'}),null);assert.equal(canvasNormalizeOp('nope'),null);
 assert.equal(canvasDescribeOps([{op:'add',html:'<i/>'},{op:'set',id:'a'},{op:'remove',id:'b'},{op:'?'}]),'1件追加 / 1件変更 / 1件削除');
 let log=canvasAppendVersion([],{html:'a',caption:'one',source:'create'},1);log=canvasAppendVersion(log,{html:'b',caption:'two',source:'patch'},2);
 log=canvasRestoreVersion(log,1);assert.deepEqual(log.map(v=>[v.n,v.html,v.source]),[[1,'a','create'],[2,'b','patch'],[3,'a','restore']]);
 assert.equal(log[2].from,1);assert.throws(()=>canvasRestoreVersion(log,9),/not found/);
});

test('canvas state folds a streamed create and patch, drops unfinished drafts and undoes by appending',()=>{
 const apply=(html,ops)=>({html:html+ops.map(o=>`[${o.op}:${o.id||o.parent}]`).join('')});
 let s=canvasStartTurn(canvasInitialState(),'描いて');
 for(const e of [{type:'turn',mode:'create'},{type:'reply',delta:'描きます。'},{type:'tool.start',name:'create_artifact',summary:'絵'},{type:'tool.html',delta:'<svg>'},{type:'tool.html',delta:'</svg>'}])s=canvasReduce(s,e,apply);
 assert.equal(s.shown,'<svg></svg>');assert.equal(s.versions.length,0,'nothing is saved before tool.end');
 s=canvasReduce(s,{type:'tool.end',name:'create_artifact',args:{summary:'絵',html:'<svg></svg>'}},apply);s=canvasReduce(s,{type:'done'},apply);
 assert.deepEqual([s.versions.length,s.versions[0].caption,s.turn,s.messages.map(m=>m.role)],[1,'絵',null,['user','assistant']]);
 const body=canvasTurnBody(s,'赤く');assert.deepEqual(body.artifact,{html:'<svg></svg>',version:1});assert.deepEqual(body.versions,[{n:1,caption:'絵'}]);
 s=canvasStartTurn(s,'赤く');s=canvasReduce(s,{type:'tool.op',op:{op:'set',id:'bg'}},apply);assert.equal(s.shown,'<svg></svg>[set:bg]');
 s=canvasReduce(s,{type:'tool.end',name:'patch_artifact',args:{summary:'',ops:[{op:'set',id:'bg'}]}},apply);s=canvasFinishTurn(s);
 assert.deepEqual(s.versions.map(v=>v.caption),['絵','1件変更']);
 s=canvasStartTurn(s,'もっと');s=canvasReduce(s,{type:'tool.op',op:{op:'add',parent:'scene'}},apply);s=canvasFinishTurn(s,'接続が切れました');
 assert.equal(s.shown,'<svg></svg>[set:bg]','an interrupted patch is not kept');assert.equal(s.error,'接続が切れました');
 s=canvasRevert(s);assert.deepEqual([s.versions.length,s.shown,s.versions[2].source],[3,'<svg></svg>','revert']);
});

test('canvas frame runs only its nonce runtime inside an opaque, network-less sandbox',()=>{
 const csp=canvasFrameCsp('n0nce','http://127.0.0.1:1');
 assert.match(csp,/script-src 'nonce-n0nce';/);assert.match(csp,/sandbox allow-scripts$/);assert.match(csp,/connect-src 'none'/);assert.match(csp,/frame-ancestors http:\/\/127\.0\.0\.1:1/);
 assert.doesNotMatch(csp,/allow-same-origin|script-src[^;]*unsafe/);
 const doc=canvasFrameDocument('n0nce');assert.equal(doc.match(/<script/g).length,1);assert.match(doc,/<script nonce="n0nce">/);assert.match(doc,/e\.source!==parent/);
});

test('the web bundle includes the canvas modules before the app',async()=>{
 const {browserBundle,BUNDLE_ORDER}=await import('../core/frontend.mjs');
 assert.ok(BUNDLE_ORDER.indexOf('canvas-engine')<BUNDLE_ORDER.indexOf('canvas')&&BUNDLE_ORDER.indexOf('canvas')<BUNDLE_ORDER.indexOf('app'));
 const bundle=await browserBundle(path.join(import.meta.dirname,'..','web'));
 assert.match(bundle,/function createCanvasView\(/);assert.match(bundle,/function canvasApplyOps\(/);assert.match(bundle,/data-view="canvas"/);
});

async function fixture(t,{configure=true}={}){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-canvas-')));
 const denyNetwork=()=>{throw new Error('External network is forbidden in canvas tests');};
 const seen=[];
 const chat=async(messages,options)=>{
  seen.push({system:messages[0].content,tools:options.tools});
  const text=/JSON object per line/.test(messages[0].content)?PATCH:CREATE;
  for(const c of chunks(text,11))options.onDelta?.(c);
  return {content:text,finish:'stop',tool_calls:[],usage:{input:1,output:1}};
 };
 const app=cleanup.service(await startServer({dir,agentOptions:{autoStart:false},networkOptions:{lookup:denyNetwork,transport:denyNetwork},registryOptions:{detectLimits:false,clientFactory:()=>({chat})}}));
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body,csrf=boot.csrf)=>fetch(app.origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(configure){const r=await request('/api/providers','PUT',{expectedRevision:boot.providers.revision,config:{profiles:[{id:'fixture',protocol:'chat-completions',baseUrl:'http://127.0.0.1:9/v1',model:'fixture',domain:'device',contextTokens:131072,maxTokens:2048,capabilities:{tools:true}}],routes:{main:{primary:'fixture'}}}});assert.equal(r.status,200,await r.text());}
 return {...app,request,seen,cookie};
}
const ndjson=async response=>(await response.text()).trim().split('\n').map(line=>JSON.parse(line));

test('POST /api/canvas/turn streams create then patch events through the provider registry',async t=>{
 const a=await fixture(t);
 const first=await a.request('/api/canvas/turn','POST',{text:'ロケットを描いて'});
 assert.equal(first.status,200);assert.match(first.headers.get('content-type'),/application\/x-ndjson/);assert.equal(first.headers.get('cache-control'),'no-store');
 const created=await ndjson(first),end=created.find(e=>e.type==='tool.end');
 assert.equal(created[0].type,'turn');assert.equal(created.at(-1).type,'done');assert.ok(created.some(e=>e.type==='route'&&e.model==='fixture'));
 assert.equal(end.name,'create_artifact');assert.match(end.args.html,/data-id="rocket"/);
 const second=await ndjson(await a.request('/api/canvas/turn','POST',{text:'炎を赤く',artifact:{html:end.args.html,version:1},history:[{role:'user',text:'ロケットを描いて'}],versions:[{n:1,caption:'夜空のロケット'}]}));
 assert.deepEqual(second.filter(e=>e.type==='tool.op').map(e=>e.op.op),['set','add','remove']);
 assert.deepEqual(a.seen.map(s=>s.tools),[[],[]],'canvas turns never offer agent tools');
 assert.match(a.seen[1].system,/patch_artifact/);
});

test('canvas routes keep the app boundary: CSRF, validation, configured model and frame headers',async t=>{
 const a=await fixture(t,{configure:false});
 assert.equal((await a.request('/api/canvas/turn','POST',{text:'描いて'},'wrong')).status,403);
 assert.equal((await a.request('/api/canvas/turn','POST',{text:''})).status,400);
 const unconfigured=await a.request('/api/canvas/turn','POST',{text:'描いて'});assert.equal(unconfigured.status,409);assert.match((await unconfigured.json()).error,/モデル/);
 assert.equal((await fetch(a.origin+'/canvas/frame')).status,401,'the frame needs the session cookie');
 const frame=await fetch(a.origin+'/canvas/frame',{headers:{Cookie:a.cookie}});assert.equal(frame.status,200);
 const csp=frame.headers.get('content-security-policy'),nonce=/'nonce-([^']+)'/.exec(csp)[1];
 assert.equal(frame.headers.get('x-frame-options'),null);assert.match(csp,/sandbox allow-scripts$/);assert.match(csp,new RegExp(`frame-ancestors ${a.origin.replace(/[.]/g,'\\.')}`));
 assert.match(await frame.text(),new RegExp(`<script nonce="${nonce}">`));
 const again=await fetch(a.origin+'/canvas/frame',{headers:{Cookie:a.cookie}});assert.notEqual(/'nonce-([^']+)'/.exec(again.headers.get('content-security-policy'))[1],nonce,'a fresh nonce per load');
});
