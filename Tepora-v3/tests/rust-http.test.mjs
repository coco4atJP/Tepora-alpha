/** Process-level contract for the explicit development-only Rust HTTP host.
 * The test runner uses Node to prepare fixture data and bundle the existing UI.
 * Every service process starts by absolute binary path with an empty PATH, an
 * isolated home/data directory, and no provider credentials or compatibility
 * worker. Build the native core and native service before running this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browserBundle} from '../core/frontend.mjs';
import {Store} from '../core/store.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webDir=path.join(root,'web');
const binary=path.resolve(process.env.TEPORA_NATIVE_SERVICE_BINARY||path.join(root,'native-service','target','debug',process.platform==='win32'?'tepora-native-service.exe':'tepora-native-service'));
const version='3.0.0-beta.11';
const BODY_LIMIT=12*1024*1024;
const STATIC_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
let bundled;
const getBundle=()=>bundled??=(browserBundle(webDir));
const deadline=(promise,message,ms=15000)=>{
 let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));
};
function assertBaseHeaders(response){
 assert.equal(response.headers['x-content-type-options'],'nosniff');
 assert.equal(response.headers['referrer-policy'],'no-referrer');
 assert.equal(response.headers['x-frame-options'],'DENY');
 assert.equal(response.headers['permissions-policy'],'camera=(), microphone=(self), geolocation=()');
 assert.equal(response.headers['access-control-allow-origin'],undefined);
}
function parsed(response,status=200){
 assert.equal(response.status,status,response.text);
 assert.match(response.headers['content-type']||'',/^application\/json; charset=utf-8$/);
 assert.equal(response.headers['cache-control'],'no-store');
 return JSON.parse(response.text);
}
function request(origin,pathname,{method='GET',headers={},rawHeaders,body,chunks}={}){
 const bytes=body===undefined?undefined:Buffer.from(body);
 return deadline(new Promise((resolve,reject)=>{
  const r=http.request(origin,{path:pathname,method,agent:false,headers:rawHeaders?[...(bytes?['Content-Length',String(bytes.length)]:[]),...rawHeaders]:{...(bytes?{'Content-Length':bytes.length}:{}),...headers}},res=>{
   const received=[];res.on('data',chunk=>received.push(chunk));res.on('error',reject);res.on('end',()=>{
    const data=Buffer.concat(received);resolve({status:res.statusCode,headers:res.headers,bytes:data,text:data.toString('utf8')});
   });
  });
  r.on('error',reject);r.setTimeout(15000,()=>r.destroy(new Error(`HTTP timeout: ${method} ${pathname}`)));
  if(chunks){for(const chunk of chunks)r.write(chunk);r.end();}else r.end(bytes);
 }),`HTTP request did not finish: ${method} ${pathname}`,20000);
}
async function fixture(t,{seed}={}){
 await access(binary,constants.X_OK).catch(()=>{throw new Error(`Build the Rust service before this suite: cargo build --locked --manifest-path Tepora-v3/native-service/Cargo.toml (missing ${binary})`);});
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-rust-http-'));
 const data=path.join(dir,'data'),noNode=path.join(dir,'empty-path'),bundle=path.join(dir,'app.bundle.js');
 await mkdir(noNode);await mkdir(data);await writeFile(bundle,await getBundle());
 const children=[];
 const f={dir,data,noNode,bundle,children};
 t.after(async()=>{
  for(const child of children.reverse())await child.close();
  await rm(dir,{recursive:true,force:true});
 });
 if(seed){const store=new Store(data);try{await seed(store);}finally{store.close();}}
 f.spawn=(options={})=>launch(f,options);
 f.start=async(options={})=>{
  const app=await f.spawn(options);await app.ready;
  const exchange=await request(app.origin,app.launchPath);parsedCookie(exchange);
  app.cookie=exchange.headers['set-cookie'][0].split(';')[0];
  app.headers={'Cookie':app.cookie,'Content-Type':'application/json'};
  app.bootstrap=parsed(await request(app.origin,'/api/bootstrap',{headers:app.headers}));
  app.csrf=app.bootstrap.csrf;app.headers['X-Tepora-CSRF']=app.csrf;
  app.request=(pathname,method='GET',body,headers={})=>request(app.origin,pathname,{method,headers:{...app.headers,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  app.raw=(pathname,options={})=>request(app.origin,pathname,{...options,headers:{...app.headers,...options.headers}});
  return app;
 };
 return f;
}
function parsedCookie(response){
 assert.equal(response.status,303,response.text);
 assert.equal(response.headers.location,'/');assert.equal(response.headers['cache-control'],'no-store');
 assert.equal(response.headers['set-cookie'].length,1);
 assert.match(response.headers['set-cookie'][0],/^tepora_session=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
}
function launch(f,{dev=true,bundle=f.bundle,extraArgs=[],extraEnv={}}={}){
 const args=[...(dev?['--dev-native']:[]),'--sidecar','--port','0','--data-dir',f.data,'--web-dir',webDir,'--bundle',bundle,...extraArgs];
 const env={PATH:f.noNode,HOME:f.dir,USERPROFILE:f.dir,TMPDIR:f.dir,TEMP:f.dir,TMP:f.dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}),...extraEnv};
 const child=spawn(binary,args,{stdio:['pipe','pipe','pipe'],env,windowsHide:true});
 const app={child,args,env,lines:[],stderr:'',exitResult:null};
 f.children.push(app);
 app.exited=new Promise(resolve=>{
  child.on('error',error=>{app.spawnError=error;resolve({error});});
  child.on('exit',(code,signal)=>{app.exitResult={code,signal};resolve(app.exitResult);});
 });
 child.stderr.setEncoding('utf8');child.stderr.on('data',value=>{app.stderr=(app.stderr+value).slice(-32000);});
 // Keep this pipe open. EOF is itself a sidecar shutdown command.
 child.stdin.on('error',()=>{});
 const lines=createInterface({input:child.stdout});
 app.ready=deadline(new Promise((resolve,reject)=>{
  lines.on('line',line=>{
   app.lines.push(line);
   try{
    const ready=JSON.parse(line);assert.equal(ready.type,'ready');assert.equal(ready.version,version);
    const url=new URL(ready.url);assert.equal(url.protocol,'http:');assert.equal(url.hostname,'127.0.0.1');assert.ok(Number(url.port)>0);
    assert.equal(url.pathname,'/launch');assert.match(url.searchParams.get('token')||'',/^[a-f0-9]{64}$/);
    Object.assign(app,{readyInfo:ready,origin:url.origin,launchPath:url.pathname+url.search,token:url.searchParams.get('token')});resolve(ready);
   }catch(error){reject(error);}
  });
  app.exited.then(result=>reject(new Error(`Native service exited before readiness: ${JSON.stringify(result)} ${app.stderr}`)));
 }),`Native service did not become ready: ${binary}`);
 // Negative startup tests intentionally consume exited, rather than ready.
 app.ready.catch(()=>{});
 app.close=async(command='shutdown')=>{
  if(!app.exitResult&&!app.spawnError){
   if(command==='eof')child.stdin.end();else if(command==='SIGINT'||command==='SIGTERM')child.kill(command);else child.stdin.write(command+'\n');
   try{await deadline(app.exited,'Native service did not shut down',8000);}catch(error){child.kill('SIGKILL');await app.exited;throw error;}
  }
  lines.close();
  return app.exitResult;
 };
 return app;
}
async function openEvents(app,{since=0,lastEventId}={}){
 const queue=[],waiters=[];let remainder='',failure=null,ended=false,response;
 const req=http.request(app.origin,{path:`/api/events?since=${encodeURIComponent(since)}`,agent:false,headers:{Cookie:app.cookie,...(lastEventId===undefined?{}:{'Last-Event-ID':String(lastEventId)})}});
 const finish=error=>{ended=true;failure=error;for(const waiter of waiters.splice(0))error?waiter.reject(error):waiter.resolve(null);};
 const connected=new Promise((resolve,reject)=>{req.on('error',reject);req.on('response',res=>{
  response=res;res.setEncoding('utf8');
  res.on('data',chunk=>{
   remainder+=chunk;let boundary;
   while((boundary=remainder.indexOf('\n\n'))>=0){
    const raw=remainder.slice(0,boundary);remainder=remainder.slice(boundary+2);
    const lines=raw.split('\n'),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    const packet={raw,lines,...(data?{event:JSON.parse(data)}:{comment:true})};
    const waiter=waiters.shift();if(waiter)waiter.resolve(packet);else queue.push(packet);
   }
  });
  res.on('end',()=>finish());res.on('error',finish);resolve(res);
 });});req.end();
 const res=await deadline(connected,'SSE headers did not arrive');assert.equal(res.statusCode,200);assert.equal(res.headers['content-type'],'text/event-stream');
 assert.equal(res.headers['cache-control'],'no-cache, no-transform');
 const next=()=>queue.length?Promise.resolve(queue.shift()):failure?Promise.reject(failure):ended?Promise.resolve(null):deadline(new Promise((resolve,reject)=>waiters.push({resolve,reject})),'SSE event did not arrive');
 return {next,queue,close(){response.destroy();req.destroy();},async event(){let packet;do{packet=await next();assert.ok(packet,'SSE ended before the expected event');}while(packet.comment);assertEnvelope(packet);return packet;}};
}
function assertEnvelope(packet){
 assert.ok(Object.hasOwn(packet.event,'seq'));assert.equal(typeof packet.event.type,'string');assert.ok(Object.hasOwn(packet.event,'data'));
 assert.equal(packet.lines.some(line=>line.startsWith('event:')),false,'the browser consumes full envelopes through onmessage');
 const ids=packet.lines.filter(line=>line.startsWith('id:'));
 if(packet.event.seq===null)assert.equal(ids.length,0,'broadcasts must not change the reconnect cursor');
 else{assert.ok(Number.isSafeInteger(packet.event.seq)&&packet.event.seq>=0);assert.deepEqual(ids,[`id: ${packet.event.seq}`]);}
}

// Security checks deliberately use node:http rather than fetch, which rewrites
// some encoded paths and restricts headers before they reach the native parser.
test('Rust HTTP: native process boots without Node and requires explicit development mode',async t=>{
 const f=await fixture(t);const rejected=f.spawn({dev:false});
 const refusal=await deadline(rejected.exited,'Ungated native startup did not fail');assert.notEqual(refusal.code,0);assert.equal(rejected.lines.length,0);assert.match(rejected.stderr,/dev-native|development/i);
 const app=await f.start();assert.equal(app.env.PATH,f.noNode);assert.equal(app.readyInfo.mode,'native-workspace-development');
 assert.equal(app.lines.length,1);assert.equal(parsed(await request(app.origin,'/health')).version,version);
 assert.equal((await app.request('/')).status,200);
 const bundle=await app.request('/app.bundle.js');assert.equal(bundle.status,200);assert.equal(bundle.text,await getBundle());
 assert.equal(bundle.headers['content-type'],'text/javascript; charset=utf-8');
 assert.equal(bundle.headers['cache-control'],'no-cache');
 if(process.platform==='linux'){
  let children;
  try{children=await readFile(`/proc/${app.child.pid}/task/${app.child.pid}/children`,'utf8');}
  catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error;t.diagnostic('Child PID procfs is unavailable here; direct native startup with an empty PATH is still verified.');}
  if(children!==undefined)assert.equal(children.trim(),'','no compatibility child was started');
 }
});

test('Rust HTTP: missing prebuilt bundle fails without running a runtime bundler',async t=>{
 const f=await fixture(t),app=f.spawn({bundle:path.join(f.dir,'missing.bundle.js')});
 const exit=await deadline(app.exited,'Missing bundle startup did not fail');assert.notEqual(exit.code,0);assert.equal(app.lines.length,0);assert.match(app.stderr,/bundle|not found|No such file/i);
});

test('Rust HTTP: Host, Origin, and fetch metadata protect even health and launch',async t=>{
 const f=await fixture(t),app=await f.start();
 for(const pathname of ['/health',app.launchPath,'/api/bootstrap','/']){
  for(const headers of [{Host:'evil.example'},{Host:`localhost:${new URL(app.origin).port}`},{Host:new URL(app.origin).host.toUpperCase()+'.'},{Origin:'https://evil.example'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}]){
   const denied=await request(app.origin,pathname,{headers:{Cookie:app.cookie,...headers}});parsed(denied,403);assertBaseHeaders(denied);
  }
 }
 const health=await request(app.origin,'/health',{headers:{Origin:app.origin,'Sec-Fetch-Site':'same-origin'}});
 assert.deepEqual(parsed(health),{ok:true,version});assertBaseHeaders(health);
 assert.equal((await request(app.origin,'/health',{method:'HEAD'})).status,401,'health is not implicitly a HEAD route');
 assert.equal((await app.request('/health','HEAD')).status,404);
});

test('Rust HTTP: launch exchange is reusable, cookies are required, and CSRF tokens are separate',async t=>{
 const f=await fixture(t),app=await f.start();
 assert.match(app.csrf,/^[a-f0-9]{64}$/);assert.notEqual(app.csrf,app.token);
 for(let repeat=0;repeat<2;repeat++){const exchange=await request(app.origin,app.launchPath);parsedCookie(exchange);assert.equal(exchange.headers['set-cookie'][0].split(';')[0],app.cookie);}
 for(const pathname of ['/launch','/launch?token=bad',`/launch?token=${app.token.slice(1)}`,`/launch?token=${(app.token[0]==='a'?'b':'a')+app.token.slice(1)}`])parsed(await request(app.origin,pathname),403);
 for(const pathname of ['/','/index.html','/app.bundle.js','/api/bootstrap','/api/events'])parsed(await request(app.origin,pathname),401);
 parsed(await request(app.origin,'/api/bootstrap',{headers:{Cookie:'tepora_session=wrong; '+app.cookie}}),401,'first matching cookie remains authoritative');
 assert.equal((await request(app.origin,'/api/bootstrap',{headers:{Cookie:'unrelated=x; '+app.cookie+'; trailing=y'}})).status,200);
 for(const headers of [{},{'X-Tepora-CSRF':'bad'},{'X-Tepora-CSRF':app.token}])parsed(await request(app.origin,'/api/presence',{method:'POST',headers:{Cookie:app.cookie,...headers},body:'{"state":"present"}'}),403);
 assert.deepEqual(parsed(await app.request('/api/presence','POST',{state:'present'})),{presence:'present'});
});

test('Rust HTTP: duplicate singleton security headers are rejected while Cookie lines retain Node combination order',async t=>{
 const f=await fixture(t),app=await f.start(),base=['Host',new URL(app.origin).host,'Cookie',app.cookie];
 // Flat raw headers preserve distinct wire header lines. Object Cookie arrays
 // would be joined by Node before writing and would not test the HTTP parser.
 for(const origins of [[app.origin,'https://evil.example'],['https://evil.example',app.origin]]){
  parsed(await request(app.origin,'/health',{rawHeaders:[...base,...origins.flatMap(value=>['Origin',value])]}),403);
 }
 for(const tokens of [[app.csrf,'invalid'],['invalid',app.csrf]]){
  parsed(await request(app.origin,'/api/presence',{method:'POST',rawHeaders:[...base,'Content-Type','application/json',...tokens.flatMap(value=>['X-Tepora-CSRF',value])],body:'{"state":"present"}'}),403);
 }
 parsed(await request(app.origin,'/api/events',{rawHeaders:[...base,'Last-Event-ID','0','Last-Event-ID','1']}),400);
 const host=['Host',new URL(app.origin).host];
 assert.equal((await request(app.origin,'/api/bootstrap',{rawHeaders:[...host,'Cookie','unrelated=x','Cookie',app.cookie]})).status,200);
 assert.equal((await request(app.origin,'/api/bootstrap',{rawHeaders:[...host,'Cookie',app.cookie,'Cookie','tepora_session=invalid']})).status,200,'first matching cookie wins after duplicate lines are combined');
 parsed(await request(app.origin,'/api/bootstrap',{rawHeaders:[...host,'Cookie','tepora_session=invalid','Cookie',app.cookie]}),401);
});

test('Rust HTTP: static allowlist, CSP, HEAD, methods, and literal path encodings match the existing host',async t=>{
 const f=await fixture(t,{seed(store){store.artifact('Encoded ID','literal percent slash',{id:'encoded%2Fartifact',kind:'text'});store.put('memory',{id:'encoded%2Fmemory',content:'before',confirmed:true,scope:'private'});}}),app=await f.start();
 for(const pathname of ['/','/index.html','/styles.css','/avatar.css','/favicon.svg','/pcm-worklet.js','/app.mjs']){
  const get=await app.request(pathname);assert.equal(get.status,200,pathname);assert.ok(get.bytes.length>0);assert.equal(get.headers['content-security-policy'],STATIC_CSP);assertBaseHeaders(get);
  const head=await app.request(pathname,'HEAD');assert.equal(head.status,200,pathname);assert.equal(head.bytes.length,0);assert.equal(head.headers['content-type'],get.headers['content-type']);assert.equal(head.headers['content-security-policy'],STATIC_CSP);
 }
 for(const pathname of ['/core/server.mjs','/package.json','/status.mjs','/%69ndex.html','/styles%2Ecss','/vendor%2Fthree.module.js','/api%2Fbootstrap','/favicon.svg%00','/app.bundle.js/'])parsed(await app.request(pathname),404);
 parsed(await app.request('/styles.css','POST',{}),405);
 parsed(await app.request('/missing','DELETE',{}),405);
 assert.equal((await app.request('/app.bundle.js','HEAD')).status,404);
 for(const [pathname,method] of [['/api/bootstrap','POST'],['/api/memories','GET'],['/api/not-implemented','GET'],['/api/artifacts','POST']])parsed(await app.request(pathname,method,method==='POST'?{}:undefined),404);
 const literal=await app.request('/render/encoded%2Fartifact');assert.equal(literal.status,200);assert.match(literal.text,/literal percent slash/);
 parsed(await app.request('/render/encoded/artifact'),404);
 assert.equal(parsed(await app.request('/api/memories/encoded%2Fmemory','PATCH',{content:'literal ID updated'})).id,'encoded%2Fmemory');
 parsed(await app.request('/api/memories/encoded/memory','PATCH',{content:'not the same ID'}),404);
});

test('Rust HTTP: JSON parsing, exact 12 MiB byte limits, chunking, and incomplete requests are bounded',async t=>{
 const f=await fixture(t),app=await f.start();
 for(const body of ['{','{"state":','not json'])assert.match(parsed(await app.raw('/api/presence',{method:'POST',body}),400).error,/Invalid JSON body/);
 const empty=parsed(await app.raw('/api/presence',{method:'POST',body:''}),400);assert.match(empty.error,/presence/i);assert.doesNotMatch(empty.error,/JSON/);
 const replacement=parsed(await app.raw('/api/memories',{method:'POST',body:Buffer.concat([Buffer.from('{\"content\":\"'),Buffer.from([255]),Buffer.from('\"}')])}),201);assert.equal(replacement.content,'\ufffd','invalid UTF-8 is decoded like Node Buffer.toString');
 const valid='{"state":"present"}';
 const exact=Buffer.concat([Buffer.from(valid),Buffer.alloc(BODY_LIMIT-Buffer.byteLength(valid),0x20)]);
 assert.deepEqual(parsed(await app.raw('/api/presence',{method:'POST',body:exact})),{presence:'present'});
 parsed(await app.raw('/api/presence',{method:'POST',body:Buffer.concat([exact,Buffer.from(' ')])}),413);
 const chunks=[exact.subarray(0,3),exact.subarray(3,256*1024),exact.subarray(256*1024)];
 assert.deepEqual(parsed(await app.raw('/api/presence',{method:'POST',chunks})),{presence:'present'});
 parsed(await app.raw('/api/presence',{method:'POST',chunks:[...chunks,Buffer.from(' ')]}),413);
 const unfinished=http.request(app.origin,{path:'/api/memories',method:'POST',headers:{...app.headers,'Content-Length':'100'},agent:false});unfinished.on('error',()=>{});unfinished.write('{');t.after(()=>unfinished.destroy());
 assert.equal((await app.request('/api/bootstrap')).status,200,'an incomplete body must not hold the state owner');
 assert.equal((await app.request('/api/memories','POST',{content:'independent completed write'})).status,201);unfinished.destroy();
});

test('Rust HTTP: memory CRUD preserves validation, UTF-16 JSON, and durable deletion',async t=>{
 const f=await fixture(t),app=await f.start();
 const content='  日本語 🦊 lone surrogate \ud800 and \udfff\n  ';
 const memory=parsed(await app.request('/api/memories','POST',{content,title:'t'.repeat(170),scope:'unsupported'}),201);
 assert.equal(memory.content,content.trim());assert.equal(memory.title,'t'.repeat(160));assert.equal(memory.confirmed,true);assert.equal(memory.scope,'private');assert.equal(memory.source,'user');
 const changed=parsed(await app.request('/api/memories/'+memory.id,'PATCH',{content:'revised',title:'Title',scope:'shared',confirmed:false}));
 assert.equal(changed.id,memory.id);assert.equal(changed.scope,'shared');assert.equal(changed.confirmed,false);
 for(const body of [{content:''},{content:'x'.repeat(32001)},{title:'x'.repeat(161)},{confirmed:'yes'},{scope:'cloud'}])parsed(await app.request('/api/memories/'+memory.id,'PATCH',body),400);
 for(const content of ['',null,'x'.repeat(32001),'🦊'.repeat(16001)])parsed(await app.request('/api/memories','POST',{content}),400);
 assert.equal((await app.request('/api/memories','POST',{content:'🦊'.repeat(16000)})).status,201,'limits count UTF-16 code units');
 const snapshot=parsed(await app.request('/api/bootstrap'));assert.equal(snapshot.memories.find(m=>m.id===memory.id).content,'revised');
 assert.deepEqual(parsed(await app.request('/api/memories/'+memory.id,'DELETE')),{deleted:true});
 parsed(await app.request('/api/memories/'+memory.id,'DELETE'),404);
 assert.equal(parsed(await app.request('/api/context/export')).collections.memory.some(m=>m.id===memory.id),false);
 await app.close();const reopened=new Store(f.data);try{assert.equal(reopened.get('memory',memory.id),null);}finally{reopened.close();}
});

test('Rust HTTP: artifact edits are atomic CAS with ordered history and pinned restrictive renders',async t=>{
 const codec='\ue000\ue100 \ue000\ue000 \ue100 \ud800 \udfff 🦊';
 const f=await fixture(t,{seed(store){store.artifact('Native artifact',`<h1>version one ${codec}</h1><script>window.fixture=1</script>`,{id:'versioned',kind:'html'});store.artifact('Codec text',codec,{id:'codec-text',kind:'text'});}}),app=await f.start();
 const first=parsed(await app.request('/api/artifacts')).find(a=>a.id==='versioned');assert.equal(first.version,1);
 parsed(await app.request('/api/artifacts/versioned','PATCH',{content:'missing base'}),400);
 parsed(await app.request('/api/artifacts/versioned','PATCH',{content:'fractional base',expectedVersion:1.5}),400);
 const edits=await Promise.all([`<h1>version two A ${codec}</h1>`,`<h1>version two B ${codec}</h1>`].map(content=>app.request('/api/artifacts/versioned','PATCH',{content,expectedVersion:1})));
 assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);const second=parsed(edits.find(r=>r.status===200));assert.equal(second.version,2);
 parsed(await app.request('/api/artifacts/versioned','PATCH',{content:'stale',expectedVersion:1}),409);
 const history=parsed(await app.request('/api/artifacts/versioned/revisions'));assert.equal(history.id,'versioned');assert.deepEqual(history.versions.map(v=>v.version),[2,1]);
 assert.equal(parsed(await app.request('/api/artifacts/versioned/revisions/1')).content,first.content);
 assert.equal(parsed(await app.request('/api/artifacts/versioned/revisions/2')).content,second.content);
 parsed(await app.request('/api/artifacts/versioned/revisions/999'),404);
 for(const v of ['0','-1','1.5','NaN','9007199254740992'])parsed(await app.request('/render/versioned?v='+v),400);
 parsed(await app.request('/render/versioned?v=999'),404);
 for(const [v,content] of [[1,first.content],[2,second.content]]){
  const render=await app.request('/render/versioned?v='+v);assert.equal(render.status,200);assert.equal(render.text,Buffer.from(content).toString('utf8'));assert.equal(render.headers['x-frame-options'],undefined);
  assert.equal(render.headers['content-security-policy'],`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${app.origin}; sandbox allow-scripts`);
 }
 assert.equal((await app.request('/render/versioned','HEAD')).status,404);
 assert.equal(parsed(await app.request('/api/artifacts')).find(a=>a.id==='codec-text').content,codec);
 assert.ok((await app.request('/render/codec-text')).text.includes(Buffer.from(codec).toString('utf8')),'text render decodes codec markers exactly once');
});

test('Rust HTTP: safe integral floating-point artifact bases retain Number.isSafeInteger semantics',async t=>{
 const f=await fixture(t,{seed(store){store.artifact('Integral JSON revision','first',{id:'integral-version',kind:'text'});}}),app=await f.start();
 const updated=parsed(await app.raw('/api/artifacts/integral-version',{method:'PATCH',body:'{"content":"edited with 1.0","expectedVersion":1.0}'}));
 assert.equal(updated.version,2);assert.equal(updated.content,'edited with 1.0');
 parsed(await app.raw('/api/artifacts/integral-version',{method:'PATCH',body:'{"content":"stale floating base","expectedVersion":1.0}'}),409);
 assert.equal(parsed(await app.request('/api/artifacts/integral-version/revisions/1')).content,'first');
});

test('Rust HTTP: non-off sandbox renders escaped artifact source instead of executing scripts',async t=>{
 const f=await fixture(t,{seed(store){store.value('agent-settings',{sandbox:{mode:'readonly',network:false}});store.artifact('Restricted','<script>document.body.textContent="unsafe"</script>',{id:'restricted',kind:'html'});}}),app=await f.start();
 const render=await app.request('/render/restricted');assert.equal(render.status,200);assert.match(render.headers['content-security-policy'],/script-src 'none'/);assert.match(render.headers['content-security-policy'],/; sandbox$/);assert.doesNotMatch(render.text,/<script>/);assert.match(render.text,/&lt;script&gt;/);
});

function importBundle(){
 return {format:'tepora-v3-context',version:2,collections:{
  memory:[{id:'source-memory',content:'imported memory',scope:'shared',confirmed:true,source:'user'}],
  skill:[{id:'source-skill',name:'Imported skill',content:'untrusted instructions',enabled:true,source:'builtin'}],
  artifact:[{id:'source-artifact',title:'Archive artifact',content:'current import',kind:'text',version:2,jobId:'source-job'}],
  revision:[{id:'source-artifact:1',artifactId:'source-artifact',title:'Archive artifact',content:'old import',kind:'text',version:1}],
  job:[{id:'source-job',status:'running',approval:{id:'old-grant'},characterSessionId:'live',dialogueSequence:90,pendingQuestionId:'question'}],
  checkpoint:[{id:'source-job',summary:'checkpoint'}],
  routine:[{id:'source-routine',enabled:true,status:'active',runtime:{execute:true},destination:'remote',nextAt:'2099-01-01',lastJobId:'source-job'},{id:'missing-routine',enabled:true,lastJobId:'missing-job'}],
  plan:[{id:'source-plan',status:'running',jobs:{run:'source-job'},runtime:{execute:true},destination:'remote'}],
 },dialogueArchive:{version:1,session:{id:'old-session'},personas:{character:{name:'Old character',instructions:'archived instructions'}},messages:[{role:'assistant',content:'archived only',kind:'character',jobId:'source-job',questionId:'old-question',grant:{allow:true}}],questions:[{id:'old-question',status:'pending'}],archives:[]},settings:{allowCloud:true},providers:{profiles:[{id:'untrusted-provider',apiKey:'fixture-token'}]},mcp:[{id:'untrusted-mcp',enabled:true}]};
}

test('Rust HTTP: context import remaps identities, disables authority, preserves archives, and exports history',async t=>{
 const f=await fixture(t),app=await f.start();const before=parsed(await app.request('/api/bootstrap'));
 const source=importBundle(),result=parsed(await app.request('/api/context/import','POST',source));
 assert.equal(result.imported,9);assert.equal(result.counts.routine,2);assert.equal(result.dialogueArchiveIds.length,1);
 const exportedResponse=await app.request('/api/context/export');assert.equal(exportedResponse.headers['content-disposition'],'attachment; filename="tepora-context.json"');
 const exported=parsed(exportedResponse),c=exported.collections;assert.equal(exported.format,'tepora-v3-context');assert.equal(exported.version,2);
 for(const [kind,docs] of Object.entries(source.collections)){for(const doc of docs)assert.equal(c[kind].some(saved=>saved.id===doc.id),false,kind+' has fresh IDs');}
 const memory=c.memory.find(d=>d.content==='imported memory');assert.equal(memory.confirmed,false);assert.equal(memory.scope,'private');assert.equal(memory.source,'import');
 const skill=c.skill.find(d=>d.name==='Imported skill');assert.equal(skill.enabled,false);assert.equal(skill.source,'import');
 const job=c.job[0];assert.equal(job.status,'interrupted');assert.equal(job.approval,null);assert.equal(job.resumeBlocked,true);assert.equal(job.characterSessionId,null);assert.equal(job.dialogueSequence,0);assert.equal(job.pendingQuestionId,null);
 for(const routine of c.routine){assert.equal(routine.enabled,false);assert.equal(routine.status,'proposed');assert.equal(routine.runtime,null);assert.equal(routine.destination,null);assert.equal(routine.nextAt,null);}
 assert.deepEqual(new Set(c.routine.map(r=>r.lastJobId)),new Set([job.id,null]));
 assert.equal(c.plan[0].status,'proposed');assert.deepEqual(c.plan[0].jobs,{});assert.equal(c.plan[0].runtime,null);assert.equal(c.plan[0].destination,null);
 assert.equal(c.checkpoint[0].id,job.id);assert.equal(c.checkpoint[0].imported,true);
 const artifact=c.artifact[0],revision=c.revision[0];assert.equal(artifact.jobId,job.id);assert.equal(revision.artifactId,artifact.id);assert.equal(revision.id,artifact.id+':1');
 assert.equal(parsed(await app.request('/api/artifacts/'+artifact.id+'/revisions/1')).content,'old import');
 const archive=exported.dialogueArchive.archives.find(a=>a.id===result.dialogueArchiveId);assert.equal(archive.readOnly,true);assert.equal(archive.sourceSessionId,'old-session');assert.equal(archive.messages[0].readOnly,true);assert.equal(archive.messages[0].content,'archived only');assert.equal(archive.messages[0].grant,undefined);assert.equal(archive.messages[0].sourceQuestionId,'old-question');
 const after=parsed(await app.request('/api/bootstrap'));assert.deepEqual(after.settings,before.settings);assert.deepEqual(after.providers,before.providers);assert.deepEqual(after.mcp,before.mcp);assert.equal(after.dialogue.session.id,before.dialogue.session.id);assert.equal(after.dialogue.messages.some(m=>m.content==='archived only'),false);
 const legacy=parsed(await app.request('/api/context/import','POST',{format:'tepora-v3-context',version:1,memories:[{id:'legacy',content:'v1 only'}],skills:[{content:'must not activate'}],artifacts:[{content:'not v1 authority'}]}));assert.equal(legacy.imported,1);
});

test('Rust HTTP: invalid context imports roll back all documents and emit no committed change',async t=>{
 const f=await fixture(t),app=await f.start();const before=parsed(await app.request('/api/context/export'));
 for(const bundle of [
  {format:'wrong',version:2,collections:{}},
  {format:'tepora-v3-context',version:2,collections:[]},
  {format:'tepora-v3-context',version:2,collections:{memory:[{id:'a',content:'valid'},{id:'a',content:'duplicate'}]}},
  {format:'tepora-v3-context',version:2,collections:{memory:[{content:'valid'},{content:''}]}},
  {...importBundle(),dialogueArchive:{version:1,messages:[{role:'administrator',content:'invalid role'}]}},
 ])parsed(await app.request('/api/context/import','POST',bundle),400);
 const after=parsed(await app.request('/api/context/export'));assert.deepEqual(after.collections,before.collections);assert.deepEqual(after.dialogueArchive,before.dialogueArchive);
});

test('Rust HTTP: bootstrap and session reads preserve UI projections and hide internal transcript fields',async t=>{
 const f=await fixture(t,{seed(store){
  const sessions=new SessionStore(store);sessions.create({id:'fixture-main',kind:'main',title:'Character',extra:{system:'private cached prompt',tools:['private tool cache']}});
  sessions.create({id:'fixture-worker',kind:'worker',title:'Worker',parentId:'fixture-main',extra:{status:'done',result:'worker output',accepted:false}});
  sessions.append('fixture-main','input',{text:'visible question',from:'user'});
  sessions.append('fixture-main','input',{text:'hidden heartbeat',from:'timer',kind:'heartbeat'});
  sessions.append('fixture-main','assistant',{content:'NO_REPLY hidden'});
  sessions.append('fixture-main','assistant',{content:'first half ',truncated:true});
  sessions.append('fixture-main','assistant',{content:'second half',truncated:false});
  sessions.append('fixture-main','assistant',{content:'withdrawn answer',withdrawn:true});
  sessions.append('fixture-main','input',{text:'untrusted worker report',kind:'report',sessionId:'fixture-worker',title:'Worker',status:'done'});
  sessions.append('fixture-main','tool',{content:'z'.repeat(5000),name:'fixture_tool'});
  sessions.append('fixture-main','checkpoint',{summary:'checkpoint',upTo:5,method:'fixture',reason:'test',privateField:'not public'});
 }}),app=await f.start();
 for(const key of ['seq','memories','artifacts','settings','skills','mcp','dialogue','jobs','approvals','agent','network','providers','computer','capabilities','mediaJobs','display','avatar','avatarAssets','frame','sandbox','setup','csrf','platform','workspace','preview','version'])assert.ok(Object.hasOwn(app.bootstrap,key),'missing bootstrap '+key);
 assert.equal(app.bootstrap.version,version);assert.equal(app.bootstrap.preview,false);
 const dialogue=parsed(await app.request('/api/agent/dialogue'));assert.deepEqual(dialogue,app.bootstrap.dialogue);assert.equal(dialogue.session.id,'fixture-main');
 assert.deepEqual(dialogue.messages.map(m=>m.content),['visible question','first halfsecond half','untrusted worker report']);assert.equal(dialogue.messages[2].untrusted,true);assert.equal(dialogue.messages[2].role,'tool');
 const agent=parsed(await app.request('/api/agent'));assert.deepEqual(agent.dialogue,dialogue);assert.equal(agent.jobs.find(j=>j.id==='fixture-worker').status,'review');
 const sessions=parsed(await app.request('/api/agent/sessions'));assert.equal(sessions.length,2);assert.ok(sessions.every(s=>!Object.hasOwn(s,'system')));
 const detail=parsed(await app.request('/api/agent/sessions/fixture-main'));assert.equal(detail.session.system,undefined);assert.equal(detail.job,null);assert.equal(detail.entries.find(e=>e.type==='tool').content.length,4000);assert.equal(detail.entries.find(e=>e.type==='checkpoint').privateField,undefined);assert.deepEqual(detail.processes,[]);
 assert.deepEqual(parsed(await app.request('/api/agent/sessions/fixture-main?before=5&limit=2')).entries.map(e=>e.seq),[3,4]);
 assert.deepEqual(parsed(await app.request('/api/agent/sessions/fixture-main?before=5&limit=0')).entries.map(e=>e.seq),[1,2,3,4],'slice(-0) preserves every entry before the cursor');
 assert.deepEqual(parsed(await app.request('/api/agent/sessions/fixture-main?limit=0')).entries,[],'tail(0) remains empty without a before cursor');
 parsed(await app.request('/api/agent/sessions/missing'),404);
 const doctor=parsed(await app.request('/api/doctor'));assert.equal(doctor.dataLocation,f.data);assert.equal(doctor.platform,process.platform);assert.equal(doctor.workRoot,app.bootstrap.workspace);assert.equal(typeof doctor.note,'string');
 assert.deepEqual(parsed(await app.request('/api/presence','POST',{state:'away'})),{presence:'away'});parsed(await app.request('/api/presence','POST',{state:'busy'}),400);
});

test('Rust HTTP: SSE uses full unnamed envelopes, increasing durable IDs, and filters raw agent internals',async t=>{
 const hidden=['session.entry','session.inbox','agent.delta','agent.event','agent.reply','agent.compaction','agent.finished'];
 const f=await fixture(t,{seed(store){for(const type of hidden)store.emit(type,{secret:'raw fixture internals'});store.emit('fixture.visible',{marker:'after internals'});}}),app=await f.start(),stream=await openEvents(app);t.after(()=>stream.close());
 const first=await stream.event();assert.equal(first.event.type,'fixture.visible');assert.equal(first.event.data.marker,'after internals');assert.equal(typeof first.event.at,'string');assert.doesNotMatch(first.raw,/raw fixture internals/);
 const created=parsed(await app.request('/api/memories','POST',{content:'SSE full document'}),201),second=await stream.event();assert.equal(second.event.type,'memory.updated');assert.equal(second.event.data.id,created.id);assert.equal(second.event.data.content,created.content);assert.ok(second.event.seq>first.event.seq);
 assert.deepEqual(parsed(await app.request('/api/memories/'+created.id,'DELETE')),{deleted:true});const third=await stream.event();assert.equal(third.event.type,'memory.deleted');assert.deepEqual(third.event.data,{id:created.id});assert.ok(third.event.seq>second.event.seq);
});

test('Rust HTTP: SSE reconnect precedence, cursor validation, and retention gaps produce fresh snapshots',async t=>{
 const f=await fixture(t,{seed(store){for(let i=0;i<100;i++)store.db.call('event.append',{type:'fixture.retained',data:{i},at:'2026-10-07T00:00:00.000Z',retention:2});}}),app=await f.start();
 for(const cursor of ['-1','1.5','NaN','Infinity','9007199254740992'])parsed(await app.request('/api/events?since='+cursor),400);
 parsed(await app.request('/api/events?since=0','GET',undefined,{'Last-Event-ID':'not-a-number'}),400);
 const gap=await openEvents(app,{since:0});t.after(()=>gap.close());const initial=await gap.event();assert.equal(initial.event.type,'snapshot');assert.equal(initial.event.seq,app.bootstrap.seq);assert.deepEqual(initial.event.data.memories,app.bootstrap.memories);gap.close();
 const current=parsed(await app.request('/api/memories','POST',{content:'fresh reconnect marker'}),201);
 const reconnect=await openEvents(app,{since:'invalid-query-ignored',lastEventId:0});t.after(()=>reconnect.close());
 const snapshot=await reconnect.event();assert.equal(snapshot.event.type,'snapshot');assert.ok(snapshot.event.data.memories.some(m=>m.id===current.id));
 const next=parsed(await app.request('/api/memories','POST',{content:'after reconnect'}),201);const live=await reconnect.event();assert.equal(live.event.type,'memory.updated');assert.equal(live.event.data.id,next.id);assert.ok(live.event.seq>snapshot.event.seq);
});

test('Rust HTTP: concurrent subscribe/replay and writes neither lose nor duplicate ordered events',async t=>{
 const f=await fixture(t,{seed(store){for(let i=0;i<128;i++)store.emit('fixture.race',{i});}}),app=await f.start();
 let cursor=0;
 for(let round=0;round<4;round++){
  const connecting=openEvents(app,{since:cursor});
  const writes=Array.from({length:24},(_,i)=>app.request('/api/memories','POST',{content:`race ${round}/${i}`}));
  const stream=await connecting;t.after(()=>stream.close());const documents=(await Promise.all(writes)).map(r=>parsed(r,201));const expected=new Set(documents.map(d=>d.id)),seen=new Set(),seqs=[];
  while(seen.size<expected.size){const {event}=await stream.event();seqs.push(event.seq);if(event.type==='memory.updated'&&expected.has(event.data.id)){assert.equal(seen.has(event.data.id),false,'duplicate live/replay delivery');seen.add(event.data.id);}}
  assert.equal(seen.size,24);assert.deepEqual(seqs,[...new Set(seqs)].sort((a,b)=>a-b),'durable frames have unique strictly increasing IDs');cursor=seqs.at(-1);stream.close();
 }
});

test('Rust HTTP: shutdown commands, EOF, and signals drain SSE and release the durable service lease',async t=>{
 const f=await fixture(t);
 for(const command of ['shutdown','eof',...(process.platform==='win32'?[]:['SIGINT','SIGTERM'])]){
  const app=await f.start();await app.request('/api/memories','POST',{content:'survives '+command});
  const stream=await openEvents(app,{lastEventId:0});await stream.event();
  if(command==='shutdown'){app.child.stdin.write('stop\n');assert.equal((await app.request('/health')).status,200,'tray stop does not shut down the main service');}
  const closed=app.close(command),drained=stream.next();assert.equal((await closed).code,0);assert.equal(await deadline(drained,'SSE did not drain on shutdown'),null);stream.close();assert.equal(app.lines.length,1,'diagnostics never pollute stdout readiness protocol');
  const store=new Store(f.data);try{assert.ok(store.list('memory').some(m=>m.content==='survives '+command));}finally{store.close();}
 }
});

test('Rust HTTP: unported effects fail explicitly instead of reporting fabricated success',async t=>{
 const f=await fixture(t),app=await f.start(),main=app.bootstrap.dialogue.session.id;
 const routes=[
  ['POST','/api/agent/input'],['POST','/api/agent/spawn'],
  ...['message','stop','resume','accept'].map(action=>['POST',`/api/agent/sessions/${main}/${action}`]),
  ['PATCH','/api/agent/settings'],['POST','/api/agent/policy/revert'],['POST','/api/agent/dream'],['PUT','/api/agent/search-key'],['POST','/api/agent/plugins/reload'],
  ['POST','/api/agent/approvals'],['POST','/api/agent/approvals/fixture-approval'],['POST','/api/stop'],
  ['PUT','/api/dialogue/personas'],['PATCH','/api/settings'],
  ['PUT','/api/avatar/assets'],
  ['POST','/api/skills'],['PATCH','/api/skills/fixture-skill'],['DELETE','/api/skills/fixture-skill'],['POST','/api/shared/scan'],
  ['PUT','/api/providers'],['POST','/api/providers/fixture-provider/key'],['POST','/api/providers/fixture-provider/probe'],
  ['PATCH','/api/network'],['POST','/api/runtime/discover'],
  ...['install-help','scan','dismiss','select','install','stop'].map(action=>['POST','/api/setup/'+action]),
  ['POST','/api/model-catalog/import'],['POST','/api/model-catalog/refresh'],['PUT','/api/capabilities'],['POST','/api/capabilities/fixture-capability/key'],
  ['POST','/api/semantic/index'],['POST','/api/semantic/search'],['POST','/api/media/jobs'],['POST','/api/media/embed'],['POST','/api/media/open'],
  ['POST','/api/connector/weather'],['POST','/api/connector/news'],['POST','/api/mcp'],['PATCH','/api/mcp/fixture-mcp'],['DELETE','/api/mcp/fixture-mcp'],
  ...['import/preview','import/apply','connect/preview','connect/apply','search','fixture-tool/discover'].map(action=>['POST','/api/tools/'+action]),
  ['PATCH','/api/computer'],...['windows','status','release'].map(action=>['POST','/api/computer/'+action]),
  ...['start','chunk','finish','cancel','edit','transcribe'].map(action=>['POST','/api/voice/'+action]),
 ];
 for(const [method,pathname] of routes){
  const response=await app.request(pathname,method,{fixture:true}),error=parsed(response,503);
  assert.equal(typeof error.error,'string',method+' '+pathname);assert.ok(error.error.length>0);assert.notEqual(error.accepted,true);assert.notEqual(error.ok,true);
 }
 const after=parsed(await app.request('/api/bootstrap'));assert.deepEqual(after.dialogue,app.bootstrap.dialogue);assert.deepEqual(after.settings,app.bootstrap.settings);
});

test('Rust HTTP: a dead legacy Store lease recovers without replaying work or touching other files',async t=>{
 const f=await fixture(t),backup=path.join(f.data,'fixture-backup.sqlite');await writeFile(backup,'untouched fixture backup');
 const source=`import {Store} from ${JSON.stringify(new URL('../core/store.mjs',import.meta.url).href)};
  const store=new Store(process.argv[1]);store.memory('from a stopped legacy process');
  store.put('job',{id:'old-running',status:'running',approval:{id:'stale'}});
  process.exit(0);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,f.data],{stdio:['ignore','pipe','pipe'],env:{...process.env,TEPORA_DATA_DIR:f.data}});
 let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 const exit=await deadline(new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code));}),'Legacy fixture process did not finish');assert.equal(exit,0,stderr);
 const app=await f.start();assert.ok(app.bootstrap.memories.some(m=>m.content==='from a stopped legacy process'));
 const exported=parsed(await app.request('/api/context/export'));const job=exported.collections.job.find(j=>j.id==='old-running');assert.equal(job.status,'interrupted');assert.equal(job.approval,null);
 assert.equal(await readFile(backup,'utf8'),'untouched fixture backup');
});

test('Rust HTTP: pending approvals are withdrawn durably before the first snapshot without replay',async t=>{
 let originalSequence;
 const f=await fixture(t,{seed(store){
  const sessions=new SessionStore(store);sessions.create({id:'approval-main',kind:'main',title:'Restart fixture'});
  sessions.append('approval-main','input',{from:'user',text:'previous completed input'});
  sessions.enqueue('approval-main',{id:'queued-before-restart',text:'must not auto-deliver',from:'user'});
  const approval={sessionId:'approval-main',sessionTitle:'Restart fixture',tool:'fixture_no_effect',args:{command:'never execute'},createdAt:'2026-10-06T00:00:00.000Z'};
  store.put('approval',{...approval,id:'stale-pending',status:'pending'});
  store.put('approval',{...approval,id:'already-approved',status:'approved',decidedAt:'2026-10-06T01:00:00.000Z'});
  store.emit('fixture.before-restart',{marker:true});originalSequence=store.seq;
 }}),app=await f.start();
 const withdrawn=app.bootstrap.approvals.find(a=>a.id==='stale-pending');assert.equal(withdrawn.status,'withdrawn');assert.ok(Number.isFinite(Date.parse(withdrawn.decidedAt)));
 assert.equal(app.bootstrap.approvals.find(a=>a.id==='already-approved').status,'approved');assert.equal(app.bootstrap.seq,originalSequence,'restart normalization does not fabricate a new durable event');
 assert.equal(parsed(await app.request('/api/agent')).approvals.find(a=>a.id==='stale-pending').status,'withdrawn');
 const stream=await openEvents(app,{lastEventId:0});t.after(()=>stream.close());const snapshot=await stream.event();assert.equal(snapshot.event.type,'snapshot');assert.equal(snapshot.event.data.approvals.find(a=>a.id==='stale-pending').status,'withdrawn');stream.close();
 await app.close();const store=new Store(f.data);try{
  assert.equal(store.get('approval','stale-pending').status,'withdrawn');assert.equal(store.get('approval','stale-pending').decidedAt,withdrawn.decidedAt);
  assert.equal(store.get('approval','already-approved').decidedAt,'2026-10-06T01:00:00.000Z');
  const sessions=new SessionStore(store);assert.deepEqual(sessions.pending('approval-main').map(i=>i.id),['queued-before-restart']);assert.equal(sessions.entries('approval-main').length,1);assert.equal(store.list('effect').length,0);assert.equal(store.seq,originalSequence);
 }finally{store.close();}
});

test('Rust HTTP: live data directory ownership excludes another native host and the existing JS Store',async t=>{
 const f=await fixture(t),app=await f.start();
 assert.throws(()=>new Store(f.data),/already using this data directory/i);
 const contender=f.spawn(),exit=await deadline(contender.exited,'Second native host did not reject a live lease');assert.notEqual(exit.code,0);assert.equal(contender.lines.length,0);assert.match(contender.stderr,/already using|already in use|owner/i);
 assert.equal((await app.request('/api/bootstrap')).status,200,'failed competing opens do not invalidate the live owner');await app.close();
 const store=new Store(f.data);try{
  const blocked=f.spawn(),blockedExit=await deadline(blocked.exited,'Native host did not reject the JS Store lease');assert.notEqual(blockedExit.code,0);assert.equal(blocked.lines.length,0);assert.match(blocked.stderr,/already using|already in use|owner/i);
  store.memory('legacy Store still owns its data');
 }finally{store.close();}
 const reopened=await f.start();assert.ok(reopened.bootstrap.memories.some(m=>m.content==='legacy Store still owns its data'));
});

 test('Rust HTTP: inert attachment staging preserves metadata and validates before writes',async t=>{
 const f=await fixture(t),app=await f.start();const content='attachment 日本\ud800\ue000\ue100';
 const saved=parsed(await app.request('/api/inputs','POST',{files:[{name:'notes.md',content}]}),201).files[0];
 assert.equal(saved.name,'notes.md');assert.equal(saved.kind,'text');assert.equal(saved.bytes,Buffer.byteLength(content));assert.match(saved.sha256,/^[a-f0-9]{64}$/);assert.equal(saved.content,undefined);
 parsed(await app.request('/api/inputs','POST',{files:[{name:'valid.txt',content:'before'},{name:'bad.pdf',content:'not supported'}]}),415);
 parsed(await app.request('/api/inputs','POST',{files:[{name:'../bad.txt',content:'bad'}]}),400);
 parsed(await app.request('/api/inputs','POST',{files:[{name:'empty.txt',content:''}]}),413);
 await app.close();const store=new Store(f.data);try{const docs=store.list('input-file');assert.equal(docs.length,1);assert.equal(docs[0].content,content);}finally{store.close();}
 const again=await f.start();assert.deepEqual(parsed(await again.request('/api/inputs/'+saved.id,'DELETE')),{deleted:true});await again.close();const reopened=new Store(f.data);try{assert.equal(reopened.list('input-file').length,0);}finally{reopened.close();}
 });

test('Rust HTTP: display and avatar config keep CAS, undo, presets and restart without Node',async t=>{
 for(const agent of [false,true]){
  const f=await fixture(t),options=agent?{extraArgs:['--agent']}:{},app=await f.start(options),saved={};
  for(const kind of ['display','avatar']){
   const base=`/api/${kind}`,initial=parsed(await app.request(base));assert.equal(initial.revision,0);
   const patches=kind==='display'?[{theme:'dark',hiddenUntil:{clock:'Jan 1 2030'}},{theme:'light'}]:[{body:'andon'},{body:'kokedama'}];
   const responses=await Promise.all(patches.map(patch=>app.request(base,'PATCH',{patch,expectedRevision:0})));
   assert.deepEqual(responses.map(r=>r.status).sort((a,b)=>a-b),[200,409]);
   const changed=parsed(responses.find(r=>r.status===200));assert.equal(changed.revision,1);
   const preset=parsed(await app.request(base+'/export'));assert.equal(preset.format,`tepora-${kind}`);assert.equal(preset.version,1);
   for(const key of ['schema','revision'])assert.equal(Object.hasOwn(preset.settings,key),false);
   if(kind==='avatar')assert.equal(Object.hasOwn(preset.settings,'asset'),false);
   parsed(await app.request(base+'/undo','POST',{expectedRevision:0}),409);
   const undone=parsed(await app.request(base+'/undo','POST',{expectedRevision:1}));assert.deepEqual(undone,{...initial,revision:2});
   parsed(await app.request(base,'PATCH',{expectedRevision:2,patch:{allowNetwork:true}}),400);
   parsed(await app.request(base+'/import','POST',{expectedRevision:2,preset:{...preset,capabilities:{network:true}}}),400);
   const imported=parsed(await app.request(base+'/import','POST',{expectedRevision:2,preset}));assert.deepEqual(imported,{...changed,revision:3});
   const reset=parsed(await app.request(base+'/reset','POST',{expectedRevision:3}));assert.deepEqual(reset,{...initial,revision:4});
   saved[kind]=parsed(await app.request(base+'/import','POST',{expectedRevision:4,preset}));
   assert.equal(saved[kind].revision,5);
  }
  const assets=parsed(await app.request('/api/avatar/assets'));assert.deepEqual(assets.assets,[]);assert.equal(assets.limits.maxAssets,24);
  assert.deepEqual(parsed(await app.request('/api/frame')).photos,[]);
  parsed(await app.request('/api/avatar/assets','PUT',{}),400);parsed(await app.request('/api/frame/photos','PUT',{}),400);
  assert.equal((await app.close()).code,0);
  const restarted=await f.start(options);
  for(const kind of ['display','avatar'])assert.deepEqual(parsed(await restarted.request('/api/'+kind)),saved[kind]);
  assert.deepEqual(restarted.bootstrap.settings,app.bootstrap.settings,'visual settings never expand permissions');
 }
});
