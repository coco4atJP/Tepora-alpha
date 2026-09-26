/** Loopback-only service. UI and API share an origin; credentials never enter browser storage. */
import http from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { Harness } from './harness.mjs';
import { Connectors } from './connectors.mjs';
import { Runtime, discover } from './runtime.mjs';
import { invariant, text, endpoint, validateSettings, safeError, LIMITS } from './policy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const TYPES={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const same=(a,b)=>typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const token=()=>randomBytes(32).toString('hex');
async function body(req,raw=false) {let size=0;const chunks=[];for await(const b of req){size+=b.length;invariant(size<=LIMITS.body,'Request body too large',413);chunks.push(b);}const buffer=Buffer.concat(chunks);if(raw)return buffer;try{return buffer.length?JSON.parse(buffer.toString('utf8')):{};}catch{throw Object.assign(new Error('Invalid JSON body'),{status:400});}}
function json(res,value,status=200){if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function dataDir(){if(process.env.TEPORA_DATA_DIR)return process.env.TEPORA_DATA_DIR;if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'Tepora','v3');if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','Tepora','v3');return path.join(os.homedir(),'.local','share','tepora-v3');}
export async function startServer({port=0,dir=dataDir(),webDir=process.env.TEPORA_WEB_DIR||path.resolve(here,'../web'),runtimeFactory}={}) {
 const store=new Store(dir), connectors=new Connectors(store), harness=new Harness(store,connectors,{runtimeFactory});
 const secret=token(),csrf=token();let origin='',closing=false;const streams=new Set(),mediaFrames=new Map();
 if(!store.get('skill','artifact-studio'))store.put('skill',{id:'artifact-studio',name:'Artifact studio',description:'成果物を早く公開し、同じIDで段階的に更新する。',content:'# Artifact studio\nPublish a first useful HTML or Markdown artifact early. Keep the id and revise it as the task develops. Prefer self-contained accessible HTML, with no remote scripts or fonts. State evidence and unknowns. Never invent live data.',createdAt:new Date().toISOString()});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
  try {
   const host=new URL(origin).host;invariant(req.headers.host===host,'Invalid Host',403);
   if(req.headers.origin)invariant(req.headers.origin===origin,'Cross-origin requests are not allowed',403);
   invariant(req.headers['sec-fetch-site']!=='cross-site','Cross-site requests are not allowed',403);
   const u=new URL(req.url,origin), p=u.pathname, method=req.method;
   if(p==='/health' && method==='GET')return json(res,{ok:true,version:'3.0.0-beta.1'});
   if(p==='/launch' && method==='GET') {invariant(same(u.searchParams.get('token'),secret),'Launch token is invalid',403);res.writeHead(303,{'Set-Cookie':`tepora_session=${secret}; HttpOnly; SameSite=Strict; Path=/`,'Location':'/','Cache-Control':'no-store'});return res.end();}
   const cookie=req.headers.cookie?.split(';').map(c=>c.trim()).find(c=>c.startsWith('tepora_session='))?.slice(15);
   invariant(same(cookie,secret),'このアプリを起動したときのURLから開いてください。',401);
   if(!['GET','HEAD'].includes(method))invariant(same(req.headers['x-tepora-csrf'],csrf),'Invalid CSRF token',403);
   if(p.startsWith('/render/') && method==='GET') {
    const a=store.get('artifact',p.slice(8));invariant(a,'Artifact not found',404);
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}; sandbox allow-scripts`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    const esc=x=>x.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    return res.end(a.kind==='html'?a.content:`<!doctype html><meta charset="utf-8"><body style="font:16px/1.8 system-ui;padding:30px;background:#faf6ee;color:#42372b;white-space:pre-wrap;overflow-wrap:anywhere">${esc(a.content)}</body>`);
   }
   if(p.startsWith('/media-view/') && method==='GET') {
    const id=mediaFrames.get(p.slice(12));invariant(id,'Media view expired',404);res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; frame-src https://www.youtube-nocookie.com; frame-ancestors ${origin}`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(`<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;overflow:hidden;background:#120c0a}</style><iframe title="YouTube player" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen src="https://www.youtube-nocookie.com/embed/${id}?autoplay=0&amp;playsinline=1&amp;rel=0"></iframe>`);
   }
   if(p==='/api/media/embed' && method==='POST'){const b=await body(req);invariant(typeof b.id==='string'&&/^[\w-]{11}$/.test(b.id),'Invalid video ID');const key=token();if(mediaFrames.size>=32)mediaFrames.delete(mediaFrames.keys().next().value);mediaFrames.set(key,b.id);return json(res,{path:`/media-view/${key}`});}
   if(p==='/api/bootstrap' && method==='GET')return json(res,{...store.snapshot(),csrf,skills:store.list('skill'),mcp:store.list('mcp'),platform:process.platform,workspace:path.join(dir,'workspace'),preview:false});
   if(p==='/api/events' && method==='GET') {
    const since=Number(req.headers['last-event-id']||u.searchParams.get('since')||0);invariant(Number.isSafeInteger(since)&&since>=0,'Invalid event cursor');
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
    // Send a full snapshot as a recovery boundary if persisted events were trimmed.
    const events=store.events(since);const send=e=>{if(!res.write(`${e.seq===null?'':`id: ${e.seq}\n`}data: ${JSON.stringify(e)}\n\n`))res.destroy();};
    if(events.length && events[0].seq>since+1)send({seq:store.seq,type:'snapshot',data:store.snapshot()});else for(const e of events)send(e);
    store.listeners.add(send);streams.add(res);const beat=setInterval(()=>{if(!res.write(': heartbeat\n\n'))res.destroy();},15000);
    res.on('close',()=>{clearInterval(beat);store.listeners.delete(send);streams.delete(res);});return;
   }
   if(p==='/api/settings' && method==='PATCH') {const input=await body(req);store.settings=validateSettings(input,store.settings);if('sessionKey'in input){invariant(typeof input.sessionKey==='string' && input.sessionKey.length<2000,'Invalid key');harness.key=input.sessionKey;}store.emit('settings.updated',store.settings);return json(res,store.settings);}
   if(p==='/api/jobs' && method==='POST') {const b=await body(req);return json(res,harness.submit(b.input,b.kind||'work'),202);}
   if(p==='/api/stop' && method==='POST'){harness.cancelAll();return json(res,{stopped:true});}
   let m=p.match(/^\/api\/jobs\/([^/]+)\/(cancel|steer)$/);
   if(m && method==='POST') {if(m[2]==='cancel')return json(res,harness.cancel(m[1]));const b=await body(req);harness.steer(m[1],b.input);return json(res,{accepted:true,applies:'next model step'});}
   m=p.match(/^\/api\/approvals\/([^/]+)$/);if(m && method==='POST'){const b=await body(req);invariant(typeof b.allow==='boolean','allow must be boolean');harness.approve(m[1],b.allow);return json(res,{resolved:true});}
   if(p==='/api/runtime/discover' && method==='POST')return json(res,await discover());
   if(p==='/api/runtime/check' && method==='POST') {const s=store.settings;return json(res,{models:await new Runtime(s,harness.key||(s.apiKeyEnv?process.env[s.apiKeyEnv]:'')||'').models()});}
   if(p==='/api/runtime/start' && method==='POST')return json(res,connectors.startRuntime(),202);
   if(p==='/api/memories' && method==='POST') {const b=await body(req);return json(res,store.memory(b.content,{title:typeof b.title==='string'?b.title:'',confirmed:true,scope:b.scope}),201);}
   m=p.match(/^\/api\/memories\/([^/]+)$/);
   if(m && ['PATCH','DELETE'].includes(method)) {const old=store.get('memory',m[1]);invariant(old,'Memory not found',404);if(method==='DELETE'){store.remove('memory',m[1]);store.emit('memory.deleted',{id:m[1]});return json(res,{deleted:true});}const b=await body(req);const value={...old};if('content'in b)value.content=text(b.content);if('confirmed'in b){invariant(typeof b.confirmed==='boolean','Invalid confirmed');value.confirmed=b.confirmed;}if('scope'in b){invariant(['shared','private'].includes(b.scope),'Invalid scope');value.scope=b.scope;}store.put('memory',value);store.emit('memory.updated',value);return json(res,value);}
   if(p==='/api/skills' && method==='POST') {const b=await body(req);const doc={id:randomUUID(),name:text(b.name,'name',100),description:text(b.description,'description',300),content:text(b.content,'SKILL.md',32000),createdAt:new Date().toISOString()};store.put('skill',doc);store.emit('skill.updated',doc);return json(res,doc,201);}
   m=p.match(/^\/api\/skills\/([^/]+)$/);if(m && method==='DELETE'){store.remove('skill',m[1]);store.emit('skill.deleted',{id:m[1]});return json(res,{deleted:true});}
   if(p==='/api/mcp' && method==='POST') {
    const b=await body(req);invariant(['stdio','http'].includes(b.transport),'Use stdio or http');const doc={id:randomUUID(),name:text(b.name,'name',100),transport:b.transport,enabled:b.enabled===true};
    if(b.transport==='stdio'){doc.command=text(b.command,'command',2000);invariant(Array.isArray(b.args)&&b.args.length<50&&b.args.every(a=>typeof a==='string'&&a.length<2000),'Invalid arguments');doc.args=b.args;}
    else {doc.url=endpoint(b.url,store.settings.allowNetwork).href;doc.apiKeyEnv=typeof b.apiKeyEnv==='string'?b.apiKeyEnv:'';invariant(!doc.apiKeyEnv||/^[A-Z_][A-Z0-9_]*$/.test(doc.apiKeyEnv),'Invalid env name');}
    store.put('mcp',doc);store.emit('mcp.updated',doc);return json(res,doc,201);
   }
   m=p.match(/^\/api\/mcp\/([^/]+)$/);if(m && ['PATCH','DELETE'].includes(method)){const d=store.get('mcp',m[1]);invariant(d,'MCP config not found',404);if(method==='DELETE'){store.remove('mcp',d.id);store.emit('mcp.deleted',{id:d.id});return json(res,{deleted:true});}const b=await body(req);invariant(typeof b.enabled==='boolean','Invalid enabled');d.enabled=b.enabled;store.put('mcp',d);store.emit('mcp.updated',d);return json(res,d);}
   if(p==='/api/connector/weather' && method==='POST')return json(res,await connectors.weather());
   if(p==='/api/connector/news' && method==='POST')return json(res,await connectors.news());
   if(p==='/api/media/open' && method==='POST'){const b=await body(req);return json(res,await connectors.openMedia(b.url));}
   if(p==='/api/voice/transcribe' && method==='POST')return json(res,await connectors.transcribe(await body(req,true)));
   if(p==='/api/context/export' && method==='GET'){res.setHeader('Content-Disposition','attachment; filename="tepora-context.json"');return json(res,store.export());}
   if(p==='/api/context/import' && method==='POST') {
    const b=await body(req);invariant(b.format==='tepora-v3-context'&&b.version===1,'Only Tepora V3 context export is accepted');invariant(Array.isArray(b.memories)&&b.memories.length<=500,'At most 500 memories per import');
    // Validate everything before changing anything. Imported claims require confirmation.
    const docs=b.memories.map(x=>({content:text(x.content),title:typeof x.title==='string'?x.title.slice(0,160):''}));
    store.db.exec('BEGIN');try{for(const d of docs)store.memory(d.content,{title:d.title,source:'import',confirmed:false,scope:'private'});store.db.exec('COMMIT');}catch(e){store.db.exec('ROLLBACK');throw e;}
    return json(res,{imported:docs.length,note:'Memories only. Imported entries remain unconfirmed and private. Executable skills, endpoints and credentials are never auto-imported.'});
   }
   if(p==='/api/artifacts' && method==='GET')return json(res,store.list('artifact'));
   if(p.startsWith('/api/'))return json(res,{error:'Unknown endpoint or HTTP method'},404);
   invariant(['GET','HEAD'].includes(method),'Method not allowed',405);
   const allowed=['/','/index.html','/styles.css','/app.mjs','/ui.mjs','/bridge.mjs','/voice.mjs','/demo.mjs','/favicon.svg'];invariant(allowed.includes(p),'Not found',404);
   const file=path.join(webDir,p==='/'?'index.html':p.slice(1));const data=await readFile(file);
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
   res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:data);
  }catch(e){if(res.headersSent){res.end();return;}json(res,{error:safeError(e)},e.status||500);}
 });
 server.requestTimeout=150000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
 const launchUrl=`${origin}/launch?token=${secret}`;
 const close=async()=>{if(closing)return;closing=true;harness.close();connectors.close();for(const res of streams)res.end();for(let i=0;i<30&&harness.active.size;i++)await new Promise(r=>setTimeout(r,20));server.closeAllConnections();await new Promise(r=>server.close(r));store.close();};
 return {server,store,harness,connectors,origin,launchUrl,close};
}
const isMain=process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isMain){const app=await startServer({port:Number(process.env.TEPORA_PORT||0)});console.log(JSON.stringify({type:'ready',url:app.launchUrl,version:'3.0.0-beta.1'}));if(process.argv.includes('--open')){const [exe,args]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',app.launchUrl]]:process.platform==='darwin'?['open',[app.launchUrl]]:['xdg-open',[app.launchUrl]];const p=spawn(exe,args,{stdio:'ignore',shell:false});p.on('error',()=>console.error('Open the URL printed above in a browser.'));}if(process.argv.includes('--sidecar')){process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{if(chunk.includes('shutdown'))app.close().then(()=>process.exit(0));});process.stdin.on('end',()=>app.close().then(()=>process.exit(0)));}for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>app.close().then(()=>process.exit(0)));}
