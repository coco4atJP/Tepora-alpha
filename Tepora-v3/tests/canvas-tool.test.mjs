import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {CanvasParser} from '../core/canvas-dom.mjs';
import {CanvasBoard,canvasTool} from '../core/canvas-board.mjs';
import {canvasApplyOps} from '../web/canvas-engine.mjs';
import {last,toolResults} from './helpers/scripted-model.mjs';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {scriptedModel} from './helpers/scripted-model.mjs';
import {canvasModel} from './helpers/canvas-model.mjs';
import {startServer} from '../core/server.mjs';
import {canvasFrameDocument,canvasSnapshotDocument} from '../core/canvas-frame.mjs';
import {randomUUID} from 'node:crypto';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}
const isMain=body=>body.messages[0].content.includes('chief of staff');
const replies=events=>events.filter(e=>e.type==='agent.reply').map(e=>e.data.text);
// A first draw without a read is refused with the guide; a well-behaved model simply repeats the call.
const refusedRetry=body=>{const m=body.messages,t=m.at(-1),txt=typeof t?.content==='string'?t.content:JSON.stringify(t?.content||'');
 if(t?.role!=='tool'||!/^Not drawn yet/.test(txt))return null;
 const a=m.findLast(x=>x.role==='assistant'&&x.tool_calls?.length),c=a.tool_calls.find(c=>c.id===t.tool_call_id)||a.tool_calls[0];
 return {calls:[{name:c.function.name,args:JSON.parse(c.function.arguments)}]};};
const toolNames=body=>(body.tools||[]).map(t=>t.function.name);
const ROCKET='<svg data-id="scene" viewBox="0 0 800 600" width="100%" height="100%"><rect data-id="bg" width="800" height="600" fill="#0b1030"/><g data-id="rocket"><path data-id="body" d="M400 120 L440 360 L360 360 Z" fill="#eee"/><circle data-id="window" cx="400" cy="250" r="22" fill="#4ab"/></g><g data-id="flame"><path d="M380 360 L400 440 L420 360 Z" fill="#f80"/></g></svg>';
async function tempStore(t){const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-canvas-'));const store=new Store(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {dir,store};}

test('the service-side fragment DOM applies canvas ops like a browser would, keeping SVG case and escaping',()=>{
 const html='<div data-id="app"><style>.a>b{color:red}</style><p data-id="t">A &amp; B<br>x</p><svg viewBox="0 0 10 10"><path data-id="p" d="M0 0"/></svg><img src="a.png" alt="q&quot;"></div>';
 const r=canvasApplyOps(html,[{op:'set',id:'t',text:'<b>'},{op:'set',id:'p',attrs:{fill:'red','x onload':'1'}},{op:'add',parent:'app',html:'<g data-id="new"><i>n</i></g>',before:'t'},{op:'remove',id:'p'},{op:'replace',id:'nope',html:'<i>z</i>'}],CanvasParser);
 assert.deepEqual(r.results.map(x=>x.ok),[true,false,true,true,false]);
 assert.match(r.results[1].error,/invalid attribute name/);
 assert.equal(r.html,'<div data-id="app"><style>.a>b{color:red}</style><g data-id="new"><i>n</i></g><p data-id="t">&lt;b&gt;<br>x</p><svg viewBox="0 0 10 10"></svg><img src="a.png" alt="q&quot;"></div>');
 assert.deepEqual([r.added,r.removed],[['new'],['p']]);
});

test('the board keeps an append-only, persisted version log with authors, and streams progress live',async t=>{
 const {dir,store}=await tempStore(t),seen=[];store.listeners.add(e=>{if(e.type.startsWith('canvas.'))seen.push(e);});
 const board=new CanvasBoard(store,{paceMs:0}),agent={kind:'agent',sessionId:'s1',title:'会話'};
 const a=await board.create({html:ROCKET,summary:'ロケット',by:agent});
 assert.equal(a.version.n,1);
 const b=await board.patch({ops:[{op:'set',id:'flame',style:{opacity:0.5}},{op:'remove',id:'window'},{op:'set',id:'ghost',text:'x'}],summary:'炎を薄く',by:agent});
 assert.equal(b.version.n,2);assert.deepEqual(b.results.map(r=>r.ok),[true,true,false]);
 assert.doesNotMatch(board.latest().html,/data-id="window"/);
 await assert.rejects(board.patch({ops:[{op:'remove',id:'flame'}],expectedVersion:1,by:agent}),/now v2, not v1/);
 const stream=seen.filter(e=>e.type==='canvas.stream').map(e=>e.data.kind);
 assert.equal(stream[0],'start');assert.ok(stream.filter(k=>k==='html').length>=3,'a create appears in steps');
 assert.deepEqual(stream.slice(-5),['start','op','op','op','end'],'a patch streams op by op (the unknown id too) then commits');
 assert.ok(seen.filter(e=>e.type==='canvas.stream').every(e=>e.seq===null),'live progress is not persisted');
 const updated=seen.filter(e=>e.type==='canvas.updated');assert.equal(updated.length,2);assert.ok(updated.every(e=>e.seq>0&&!('html' in e.data)));
 store.close();
 const again=new Store(dir),reopened=new CanvasBoard(again,{paceMs:0});t.after(()=>again.close());
 assert.deepEqual(reopened.snapshot().versions.map(v=>[v.n,v.caption,v.by.kind]),[[1,'ロケット','agent'],[2,'炎を薄く','agent']]);
 assert.equal(reopened.snapshot().html,board.latest().html);
});

test('aborting a drawing commits nothing and tells the screen to drop it',async t=>{
 const {store}=await tempStore(t),seen=[];store.listeners.add(e=>{if(e.type==='canvas.stream')seen.push(e.data.kind);});
 const board=new CanvasBoard(store,{paceMs:400}),ctl=new AbortController();
 const run=board.create({html:ROCKET,summary:'ロケット',by:{kind:'agent'},signal:ctl.signal});
 await until(()=>seen.includes('html'));ctl.abort();
 await assert.rejects(run);
 assert.equal(board.latest(),null);assert.equal(seen.at(-1),'abort');assert.equal(board.snapshot().live,null);
});

test('what the user selects or removes becomes one context note, newest selection winning',async t=>{
 const {store}=await tempStore(t),board=new CanvasBoard(store,{paceMs:0,settleMs:10_000}),notes=[];
 board.onUserEvents=(text,lastAgent)=>notes.push({text,lastAgent});
 await board.create({html:ROCKET,summary:'ロケット',by:{kind:'agent',sessionId:'w1'}});
 board.select('rocket');board.select('flame');
 const snap=board.edit({action:'remove',id:'window'});
 assert.equal(snap.version,2);assert.deepEqual(snap.versions.at(-1).by,{kind:'user'});
 assert.throws(()=>board.select('missing'),/not on the canvas/);
 assert.equal(board.flush().length>0,true);
 assert.equal(notes.length,1);assert.equal(notes[0].lastAgent,'w1');
 assert.match(notes[0].text,/selected "flame" in v1: <g data-id="flame">/);
 assert.doesNotMatch(notes[0].text,/selected "rocket"/);
 assert.match(notes[0].text,/removed "window" \(circle\), making v2/);
 assert.equal(board.flush(),'','reported once');
 board.edit({action:'revert'});assert.equal(board.latest().html,board.version(1).html);
 assert.match(board.takeUserEvents(),/went back to v1, making v3/);
 board.close();
});

test('a session that draws before reading is refused once and handed the guide instead',async t=>{
 const {store}=await tempStore(t),board=new CanvasBoard(store,{paceMs:0}),tool=canvasTool(board),ctx={session:{id:'s9',kind:'main'}};
 const first=await tool.run({action:'create',html:ROCKET,summary:'ロケット'},ctx);
 assert.equal(first.data.refused,true);assert.match(first.text,/^Not drawn yet: read the canvas first/);assert.match(first.text,/Drawing guide/);
 assert.equal(board.snapshot().version,0,'nothing is drawn without the guide');
 const again=await tool.run({action:'create',html:ROCKET,summary:'ロケット'},ctx);
 assert.match(again.text,/^Drew v1/);
 const other=await tool.run({action:'patch',ops:[{op:'set',id:'bg',attrs:{fill:'#000'}}]},{session:{id:'w2',kind:'worker'}});
 assert.equal(other.data.refused,true,'each session reads for itself');assert.match(other.text,/Canvas v1/);
 board.close();
});

test('an agent edit of the selected element clears the selection, marks it edited and rides along in the next note',async t=>{
 const {store}=await tempStore(t),board=new CanvasBoard(store,{paceMs:0,settleMs:10_000}),tool=canvasTool(board),notes=[];
 board.onUserEvents=text=>notes.push(text);
 const agent={kind:'agent',sessionId:'s1',title:'会話'},ctx={sessionId:'s1',session:{title:'会話'}};
 await board.create({html:ROCKET,summary:'ロケット',by:agent});
 board.select('rocket');assert.match(board.flush(),/selected "rocket"/);notes.length=0;
 const other=await board.patch({ops:[{op:'set',id:'bg',attrs:{fill:'#000'}}],summary:'背景',by:agent});
 assert.equal(other.edited,null);assert.equal(board.summary().selection.id,'rocket','editing something else keeps the selection');
 await tool.run({action:'read'},ctx);
 const r=await tool.run({action:'patch',ops:[{op:'set',id:'window',style:{fill:'#e02020'}}],summary:'窓を赤く'},ctx);
 assert.equal(r.data.edited,'rocket','an edit inside the selected group counts');
 assert.match(r.text,/edited the user's selection "rocket"; it is now cleared/);
 assert.equal(board.summary().selection,null);assert.deepEqual(board.summary().edited,{id:'rocket',version:3});
 assert.deepEqual(notes,[],'the edit does not wake anyone by itself');
 const note=board.flush();
 assert.match(note,/^Shared canvas update \(it is now v3\)/);
 assert.match(note,/their selection "rocket" was edited by .* in v3, so it is no longer selected/);
 board.select('flame');assert.equal(board.summary().edited,null,'a new selection retires the edited mark');
 board.close();
});

test('read returns the drawing guide on demand, so the tool description stays short',async t=>{
 const {store}=await tempStore(t),board=new CanvasBoard(store,{paceMs:0}),tool=canvasTool(board);
 assert.ok(tool.description.length<300,`description is ${tool.description.length} chars`);
 const empty=await tool.run({action:'read'},{});
 assert.match(empty.text,/^Drawing guide/);assert.match(empty.text,/viewBox="0 0 800 600"/);assert.match(empty.text,/R1 330Ω/);assert.match(empty.text,/canvas is empty/);
 await board.create({html:ROCKET,summary:'ロケット',by:{kind:'agent'}});
 const full=await tool.run({action:'read'},{});
 assert.match(full.text,/Drawing guide[\s\S]*Canvas v1 "ロケット"[\s\S]*HTML:\n<svg/);
 board.close();
});

test('the canvas tool is gated by the board like computer use: disabled means not offered',async t=>{
 const {store}=await tempStore(t),board=new CanvasBoard(store,{paceMs:0}),tool=canvasTool(board);
 assert.equal(tool.name,'canvas');assert.equal(tool.available(),true);
 board.configure({enabled:false});assert.equal(tool.available(),false);
 assert.throws(()=>board.configure({enabled:'yes'}),/true or false/);
 assert.equal(tool.ephemeralKey({action:'read'}),'canvas:read');assert.equal(tool.ephemeralKey({action:'create'}),null);
});

test('the conversation draws with the canvas tool itself, patches it, and the user\'s selection reaches its next turn',async t=>{
 const f=await agentFixture(t,body=>{
  const again=refusedRetry(body);if(again)return again;
  const tools=toolResults(body),user=String(last(body,'user')?.content||'');
  if(!isMain(body))return {content:'unused'};
  assert.ok(toolNames(body).includes('canvas'),'the conversation is offered the canvas');
  assert.match(body.messages[0].content,/Draw visuals yourself with canvas, not via agents/);
  if(user.includes('ロケットを描いて')&&!tools.length)return {calls:[{name:'canvas',args:{action:'create',html:ROCKET,summary:'夜空のロケット'}}]};
  if(user.includes('これを赤くして')&&!tools.some(m=>/Made v2/.test(m.content))){
   const sel=/selected "([\w-]+)"/.exec(body.messages.map(m=>typeof m.content==='string'?m.content:'').join('\n'))?.[1];
   return {calls:[{name:'canvas',args:{action:'patch',ops:[{op:'set',id:sel||'?',style:{fill:'#e02020'}},{op:'set',id:'nope',text:'x'}],summary:'赤くした'}}]};
  }
  const lastTool=tools.at(-1)?.content||'';
  return {content:/Made v2/.test(lastTool)?'選んだところを赤くしました。':'夜空を飛ぶロケットを描きました。'};
 },{canvas:{}});
 const main=f.rt.main();
 f.rt.send(main.id,{text:'ロケットを描いて',from:'user'});
 await until(()=>replies(f.events).includes('夜空を飛ぶロケットを描きました。'));
 assert.equal(f.board.latest().n,1);assert.deepEqual(f.board.latest().by,{kind:'agent',sessionId:main.id,sessionKind:'main',title:'会話'});
 f.board.select('flame');
 f.rt.send(main.id,{text:'これを赤くして',from:'user'});
 await until(()=>replies(f.events).includes('選んだところを赤くしました。'));
 assert.equal(f.board.latest().n,2);assert.match(f.board.latest().html,/data-id="flame" style="fill: #e02020"/);
 const req=f.model.requests.find(b=>String(last(b,'user')?.content||'').includes('これを赤くして'));
 const before=req.messages.map(m=>typeof m.content==='string'?m.content:'').join('\n');
 assert.ok(before.indexOf('selected "flame"')>=0&&before.indexOf('selected "flame"')<before.lastIndexOf('これを赤くして'),'the selection precedes the words that refer to it');
 const result=f.rt.sessions.entries(main.id,{types:['tool']}).at(-1);
 assert.match(result.content,/1\/2 ops applied[\s\S]*op 2: set: id "nope" not found/);
 assert.equal(f.rt.sessions.list({kind:'worker'}).length,0,'drawing was not delegated');
});

test('a work agent draws on the same shared canvas, and the user\'s later edit reaches it as context',async t=>{
 let workerTurns=0;
 const f=await agentFixture(t,body=>{
  const again=refusedRetry(body);if(again)return again;
  const tools=toolResults(body);
  if(isMain(body)){
   const user=String(last(body,'user')?.content||'');
   if(user.includes('report from'))return {content:'回路図ができました。'};
   if(!tools.length)return {calls:[{name:'sessions_spawn',args:{task:'Draw an LED circuit on the shared canvas.',title:'回路図'}}]};
   return {content:'回路図を頼みました。'};
  }
  workerTurns++;
  assert.ok(toolNames(body).includes('canvas'),'work agents are offered the canvas');
  if(!tools.length)return {calls:[{name:'canvas',args:{action:'create',html:'<div data-id="sheet"><svg data-id="schematic" viewBox="0 0 400 200"><g data-id="R1"><rect x="10" y="10" width="40" height="12"/></g><g data-id="D1"><path d="M100 10 L120 20 L100 30 Z"/></g></svg></div>',summary:'LED回路'}}]};
  return {content:'LED回路を描きました。'};
 },{canvas:{}});
 const main=f.rt.main();
 f.rt.send(main.id,{text:'LEDの回路図を描いて',from:'user'});
 await until(()=>replies(f.events).includes('回路図ができました。'));
 const worker=f.rt.sessions.list({kind:'worker'})[0];
 assert.equal(f.board.latest().by.sessionId,worker.id);assert.equal(f.board.latest().by.title,'回路図');
 assert.ok(workerTurns>=2);
 f.board.edit({action:'remove',id:'D1'});f.board.flush();
 const note=await until(()=>f.rt.sessions.entries(main.id,{types:['input']}).find(e=>e.from==='canvas'));
 assert.match(note.text,/removed "D1" \(g\), making v2/);assert.match(note.header,/canvas/);
 assert.equal(f.rt.sessions.get(main.id).status,'idle','a context note does not wake the conversation');
 assert.equal(f.rt.sessions.entries(worker.id,{types:['input']}).some(e=>e.from==='canvas'),false,'a finished work agent is not told');
});

test('policy rules apply to the canvas tool like any other: deny blocks the drawing',async t=>{
 const f=await agentFixture(t,body=>{
  const again=refusedRetry(body);if(again)return again;
  const tools=toolResults(body);
  if(!tools.length)return {calls:[{name:'canvas',args:{action:'create',html:ROCKET,summary:'ロケット'}}]};
  return {content:/rules do not allow canvas/.test(tools.at(-1).content)?'描けませんでした。':'描きました。'};
 },{canvas:{},settings:{policy:{rules:[{tool:'canvas',action:'deny',match:'"create"'}]}}});
 const main=f.rt.main();
 f.rt.send(main.id,{text:'ロケットを描いて',from:'user'});
 await until(()=>replies(f.events).length);
 assert.deepEqual(replies(f.events),['描けませんでした。']);assert.equal(f.board.latest(),null);
});

test('through the service: a spoken request draws on the shared board, a click and a removal reach the next turn',async t=>{
 const seen=[],model=await scriptedModel(canvasModel({seen}));
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-canvas-e2e-'));
 const app=await startServer({dir,canvasOptions:{paceMs:0,settleMs:30}});
 t.after(async()=>{await app.close();await model.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(p,method='GET',data,csrf=boot.csrf)=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':csrf,'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});
 const get=async()=>(await request('/api/canvas')).json();
 assert.equal(boot.canvas.version,0);assert.equal(boot.canvas.enabled,true);
 const put=await request('/api/providers','PUT',{expectedRevision:boot.providers.revision,config:{profiles:[{id:'local',protocol:'chat-completions',baseUrl:model.url,model:'m',domain:'device',capabilities:{tools:true}}],routes:{main:{primary:'local'}}}});
 assert.equal(put.status,200,await put.text());
 const say=async text=>assert.equal((await request('/api/agent/input','POST',{requestId:randomUUID(),text,attachmentIds:[]})).status,202);
 await say('ロケットを描いて');
 const v1=await until(async()=>{const s=await get();return s.version===1&&s;});
 assert.equal(v1.versions[0].by.title,'会話');assert.match(v1.html,/data-id="flame"/);
 assert.ok(seen[0].tools.includes('canvas'),'the conversation is offered the canvas tool');
 assert.equal((await request('/api/canvas/select','POST',{id:'flame',version:1},'wrong')).status,403,'user hands keep the CSRF boundary');
 assert.equal((await request('/api/canvas/select','POST',{id:'flame',version:1})).status,200);
 assert.equal((await get()).selection.id,'flame');
 await until(async()=>(await (await request('/api/agent/dialogue')).json()).status!=='running');
 await say('これを赤くして');
 const v2=await until(async()=>{const s=await get();return s.version===2&&s;});
 assert.match(v2.html,/data-id="flame"[^>]*fill="#e5322d"/);
 const turn=seen.find(x=>/これを赤く/.test(x.context));
 assert.ok(turn.context.indexOf('selected "flame"')>=0&&turn.context.indexOf('selected "flame"')<turn.context.indexOf('これを赤く'),'the click arrives before the words that refer to it');
 const removed=await(await request('/api/canvas/edit','POST',{action:'remove',id:'window'})).json();
 assert.equal(removed.version,3);assert.equal(removed.versions.at(-1).by.kind,'user');
 assert.equal((await request('/api/canvas/edit','POST',{action:'paint',id:'x'})).status,400);
 await until(async()=>(await (await request('/api/agent/dialogue')).json()).status!=='running');
 await say('星をもっと');
 await until(async()=>(await get()).version===4);
 assert.match(seen.findLast(x=>/星をもっと/.test(x.context)).context,/removed "window"/);
 const off=await request('/api/canvas','PATCH',{enabled:false});assert.equal((await off.json()).enabled,false);
});

test('read with image:true returns a picture; a session that has the guide gets just the picture',async t=>{
 const {store}=await tempStore(t),board=new CanvasBoard(store,{paceMs:0}),shots=[];
 const tool=canvasTool(board,{snapshot:async html=>{shots.push(html);return {mime:'image/jpeg',base64:'AAAA',width:800,height:600};}}),ctx={session:{id:'w1',kind:'worker'}};
 assert.ok(!(await tool.run({action:'read',image:true},ctx)).images,'an empty canvas has nothing to picture');
 await board.create({html:ROCKET,summary:'ロケット',by:{kind:'agent'}});
 const plain=await tool.run({action:'read'},ctx);assert.ok(!plain.images,'a plain read stays text-only');
 const look=await tool.run({action:'read',image:true},ctx);
 assert.equal(look.text,'Canvas v1 "ロケット" as the user sees it.');assert.deepEqual(look.images,[{mime:'image/jpeg',base64:'AAAA',width:800,height:600,name:'canvas'}]);
 assert.equal(shots.at(-1),ROCKET);
 const first=await tool.run({action:'read',image:true},{session:{id:'w2'}});
 assert.match(first.text,/^Drawing guide[\s\S]*HTML:\n<svg/);assert.equal(first.images.length,1);
 const none=await canvasTool(board).run({action:'read',image:true},ctx);assert.match(none.text,/No picture: no browser/);assert.ok(!none.images);
 const failed=await canvasTool(board,{snapshot:async()=>{throw new Error('browser did not start');}}).run({action:'read',image:true},ctx);
 assert.match(failed.text,/No picture: browser did not start/);
 board.close();
});

test('the canvas picture is offline and inert: no script, no navigation, no network',()=>{
 const doc=canvasSnapshotDocument('<svg data-id="a"></svg><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://x.test"><iframe src="https://x.test"></iframe><p onclick="x()">t</p>');
 assert.match(doc,/content="default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
 assert.doesNotMatch(doc,/<script|refresh|<iframe/);assert.match(doc,/<svg data-id="a">/);
});

test('the canvas frame lets a click name the nearest data-id and marks the selection',()=>{
 const doc=canvasFrameDocument('n0nce');
 assert.match(doc,/closest\?\.\('\[data-id\]'\)/);assert.match(doc,/type:'select'/);assert.match(doc,/data-lc-selected/);
});
