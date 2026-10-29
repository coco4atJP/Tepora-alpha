/** Conversational canvas: stream parsers, the turn runner, the client-side state engine and the HTTP routes.
 * The model boundary is synthetic; no provider account or external network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {canvasFrameDocument,canvasFrameCsp} from '../core/canvas-frame.mjs';
import {canvasNormalizeOp,canvasDescribeOps} from '../web/canvas-engine.mjs';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

test('canvas engine: op normalisation and captions',()=>{
 assert.deepEqual(canvasNormalizeOp({type:'update','data-id':'bg',attrs:{fill:'red'}}),{op:'set',id:'bg',attrs:{fill:'red'},style:undefined,text:undefined});
 assert.deepEqual(canvasNormalizeOp({action:'insert',parentId:'g',html:'<i/>'}),{op:'add',parent:'g',before:null,html:'<i/>'});
 assert.equal(canvasNormalizeOp({op:'replace',id:'x'}),null);assert.equal(canvasNormalizeOp('nope'),null);
 assert.equal(canvasDescribeOps([{op:'add',html:'<i/>'},{op:'set',id:'a'},{op:'remove',id:'b'},{op:'?'}]),'1件追加 / 1件変更 / 1件削除');
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
 assert.match(bundle,/function createCanvasView\(/);assert.match(bundle,/function canvasApplyOps\(/);assert.match(bundle,/data-action="canvas-open"/);
});

async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-canvas-')));
 const denyNetwork=()=>{throw new Error('External network is forbidden in canvas tests');};
 const app=cleanup.service(await startServer({dir,agentOptions:{autoStart:false},networkOptions:{lookup:denyNetwork,transport:denyNetwork},registryOptions:{detectLimits:false}}));
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const boot=await(await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,method='GET',body,csrf=boot.csrf)=>fetch(app.origin+route,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...app,request,cookie};
}

test('canvas routes keep the app boundary: no standalone drawing route, frame headers',async t=>{
 const a=await fixture(t);
 assert.equal((await a.request('/api/canvas/turn','POST',{text:'描いて'})).status,404,'drawing only goes through the agents\' canvas tool');
 assert.equal((await fetch(a.origin+'/canvas/frame')).status,401,'the frame needs the session cookie');
 const frame=await fetch(a.origin+'/canvas/frame',{headers:{Cookie:a.cookie}});assert.equal(frame.status,200);
 const csp=frame.headers.get('content-security-policy'),nonce=/'nonce-([^']+)'/.exec(csp)[1];
 assert.equal(frame.headers.get('x-frame-options'),null);assert.match(csp,/sandbox allow-scripts$/);assert.match(csp,new RegExp(`frame-ancestors ${a.origin.replace(/[.]/g,'\\.')}`));
 assert.match(await frame.text(),new RegExp(`<script nonce="${nonce}">`));
 const again=await fetch(a.origin+'/canvas/frame',{headers:{Cookie:a.cookie}});assert.notEqual(/'nonce-([^']+)'/.exec(again.headers.get('content-security-policy'))[1],nonce,'a fresh nonce per load');
});
