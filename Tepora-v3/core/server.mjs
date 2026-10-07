import {ModelCatalog} from './model-catalog.mjs';
import {NetworkPolicy,NetworkBlocked} from './network-policy.mjs';
import {ProviderRegistry} from './provider-registry.mjs';
import {openInstallerPage} from './platform-links.mjs';
import {SetupManager} from './setup.mjs';
import {stageInputs,removeStagedInput,resolveInputs} from './input-files.mjs';
import {editDictation} from './dictation.mjs';
import {SpeechStream} from './speech-stream.mjs';
import {Avatar,AvatarAssets,MAX_ASSET_BYTES} from './avatar.mjs';
import {PhotoFrame,MAX_PHOTO_BYTES} from './photo-frame.mjs';
import {Capabilities} from './capabilities.mjs';
import {MediaJobs} from './media-jobs.mjs';
import {SemanticMemory} from './semantic.mjs';
import {ToolHub} from './tool-hub.mjs';
import {ComputerUse} from './computer/index.mjs';
import {loadImage} from './agent/images.mjs';
import {AgentRuntime} from './agent/runtime.mjs';
import {AgentUIModel} from './agent/ui-model.mjs';
import {validateRules} from './agent/policy.mjs';
import {detectSandbox} from './sandbox.mjs';
import {defaultPersonas,nextVoice,normalizePersonas} from './persona.mjs';
/** Loopback-only service. UI and API share an origin; credentials never enter browser storage. */
import http from 'node:http';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import {readFile,mkdir,stat,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {Display} from './display.mjs';
import {discoverSharedSkills} from './shared-assets.mjs';
import {Store} from './store.mjs';
import {browserBundle} from './frontend.mjs';
import {Connectors} from './connectors.mjs';
import {Runtime,PROVIDERS} from './runtime.mjs';
import {invariant,text,endpoint,validateSettings,safeError,LIMITS} from './policy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const VERSION='3.0.0-beta.11';
const VENDOR_FILES=['three.core.js','three.module.js','GLTFLoader.js','BufferGeometryUtils.js','SkeletonUtils.js','three-vrm.module.min.js',...['createMeshAvatar','renderer','rig','motion','motions','physics','sprites','kana'].map(name=>`mesh-avatar/${name}.js`)];
const TYPES={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const same=(a,b)=>typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const token=()=>randomBytes(32).toString('hex');
async function rawBody(req,limit){let size=0;const chunks=[];for await(const b of req){size+=b.length;invariant(size<=limit,'ファイルが大きすぎます。',413);chunks.push(b);}return Buffer.concat(chunks);}
async function body(req,raw=false) {let size=0;const chunks=[];for await(const b of req){size+=b.length;invariant(size<=LIMITS.body,'Request body too large',413);chunks.push(b);}const buffer=Buffer.concat(chunks);if(raw)return buffer;try{return buffer.length?JSON.parse(buffer.toString('utf8')):{};}catch{throw Object.assign(new Error('Invalid JSON body'),{status:400});}}
function json(res,value,status=200){if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function dataDir(){if(process.env.TEPORA_DATA_DIR)return process.env.TEPORA_DATA_DIR;if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'Tepora','v3');if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','Tepora','v3');return path.join(os.homedir(),'.local','share','tepora-v3');}
/** Personas are the response side of the characters; changing one never changes permissions. */
function configurePersonas(store,raw){
 invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid personas');
 const current=normalizePersonas(store.value('dialogue-personas')||defaultPersonas(store.settings.companion));
 invariant(raw.expectedRevision===current.revision,'人格設定が変更されています。読み直してください。',409);
 const persona=(value,previous,voice)=>{if(value===undefined)return previous;invariant(value&&typeof value==='object'&&!Array.isArray(value),'Invalid persona');
  invariant(typeof value.instructions==='string'&&value.instructions.length<=8000,'Invalid persona instructions');
  const out={name:text(value.name,'persona name',80),instructions:value.instructions};if(voice)out.voice=nextVoice(value.voice,previous.voice);return out;};
 const next={revision:current.revision+1,character:persona(raw.character,current.character,true),worker:persona(raw.worker,current.worker,false)};
 store.value('dialogue-personas',next);return next;
}
export async function startServer({port=0,dir=dataDir(),webDir=process.env.TEPORA_WEB_DIR||path.resolve(here,'../web'),runtimeFactory,setupOptions={},networkOptions={},registryOptions={},computerOptions={},mediaOptions={},toolHubOptions={},agentOptions={}}={}) {
 const bundledFrontend=await browserBundle(webDir);
 const store=new Store(dir),network=new NetworkPolicy(store,networkOptions),registry=new ProviderRegistry(store,network,registryOptions);
 const connectors=new Connectors(store,network),capabilities=new Capabilities(store,network),media=new MediaJobs(store,capabilities,mediaOptions);
 const semantic=new SemanticMemory(store,capabilities),toolHub=new ToolHub(store,network,toolHubOptions);
 const computer=new ComputerUse(store,network,{dataDir:dir,registry,...computerOptions});
 // The work folder is ~/Tepora only for the real data folder. Tests and alternative data folders (TEPORA_DATA_DIR)
 // keep their work inside that folder, so they never write into the user's home.
 const isolated=!!process.env.TEPORA_DATA_DIR||path.resolve(dir)!==path.resolve(dataDir());
 const agent=new AgentRuntime(store,{registry,network,toolHub,capabilities,computer,media,semantic,pluginDir:path.join(dir,'plugins'),...(isolated&&!(store.value('agent-settings')||{}).workRoot?{workRoot:path.join(dir,'work')}:{}),...agentOptions});
 const ui=new AgentUIModel(store,agent);
 await agent.tools.loadPlugins().catch(()=>{});
 const display=new Display(store),speech=new SpeechStream(store,network.fetch({purpose:'worker'})),avatarAssets=new AvatarAssets(store),avatar=new Avatar(store,avatarAssets),frame=new PhotoFrame(store);
 const setup=new SetupManager(store,{registry,busy:()=>agent.runs.size>0},{runtimeFactory,fetchImpl:(url,init)=>network.request(url,init,{purpose:String(url).includes('/api/pull')?'download':'model',allowCloud:false}),...setupOptions});
 const probes=new Map(),catalog=new ModelCatalog(store,network),seen=new Map();
 const secret=token(),csrf=token();let origin='',closing=false;const streams=new Set(),mediaFrames=new Map();
 const snapshot=()=>({...store.snapshot(),...ui.snapshot(),network:network.get(),providers:registry.publicSnapshot(),computer:computer.snapshot(),capabilities:capabilities.snapshot(),mediaJobs:media.snapshot(),display:display.get(),avatar:avatar.get(),avatarAssets:avatarAssets.snapshot(),frame:frame.snapshot(),sandbox:detectSandbox()});
 if(!store.get('skill','artifact-studio'))store.put('skill',{id:'artifact-studio',name:'Artifact studio',description:'成果物を早く公開し、同じIDで段階的に更新する。',content:'# Artifact studio\nPublish a first useful HTML or Markdown artifact early, then revise it with artifact edit.',enabled:true,source:'builtin',createdAt:new Date().toISOString()});
 /** Files the person attaches are copied into a dated inbox folder the agents can read. */
 async function saveAttachments(ids){
  const docs=resolveInputs(store,ids);if(!docs.length)return [];
  const folder=path.join(agent.workRoot,'inbox',new Date().toISOString().slice(0,10));await mkdir(folder,{recursive:true});
  const saved=[];for(const d of docs){let name=d.name.replace(/[\\/:*?"<>|]/g,'_'),file=path.join(folder,name);for(let i=1;;i++){try{await stat(file);file=path.join(folder,name.replace(/(\.[^.]*)?$/,`-${i}$1`));}catch{break;}}
   await writeFile(file,d.kind==='image'?Buffer.from(d.base64,'base64'):d.content);saved.push({path:file,name:d.name,kind:d.kind||'text'});}
  return saved;
 }
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
  try {
   const host=new URL(origin).host;invariant(req.headers.host===host,'Invalid Host',403);
   if(req.headers.origin)invariant(req.headers.origin===origin,'Cross-origin requests are not allowed',403);
   invariant(req.headers['sec-fetch-site']!=='cross-site','Cross-site requests are not allowed',403);
   const u=new URL(req.url,origin), p=u.pathname, method=req.method;
   if(p==='/health' && method==='GET')return json(res,{ok:true,version:VERSION});
   if(p==='/launch' && method==='GET') {invariant(same(u.searchParams.get('token'),secret),'Launch token is invalid',403);res.writeHead(303,{'Set-Cookie':`tepora_session=${secret}; HttpOnly; SameSite=Strict; Path=/`,'Location':'/','Cache-Control':'no-store'});return res.end();}
   const cookie=req.headers.cookie?.split(';').map(c=>c.trim()).find(c=>c.startsWith('tepora_session='))?.slice(15);
   invariant(same(cookie,secret),'このアプリを起動したときのURLから開いてください。',401);
   if(!['GET','HEAD'].includes(method))invariant(same(req.headers['x-tepora-csrf'],csrf),'Invalid CSRF token',403);
   if(p.startsWith('/render/') && method==='GET') {
    let a=store.get('artifact',p.slice(8));invariant(a,'Artifact not found',404);
    if(u.searchParams.has('v')){const version=Number(u.searchParams.get('v'));invariant(Number.isSafeInteger(version)&&version>0,'Invalid revision');
     if(a.version!==version)a=store.get('revision',`${p.slice(8)}:${version}`);invariant(a,'Artifact revision not found',404);}
    res.removeHeader('X-Frame-Options');
    // Interactive HTML runs in an opaque-origin sandbox with no network; turning on the sandbox setting shows source instead.
    const interactive=agent.sandboxPolicy().mode==='off';
    res.setHeader('Content-Security-Policy',`default-src 'none'; script-src ${interactive?"'unsafe-inline'":"'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}; sandbox${interactive?' allow-scripts':''}`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    const esc=x=>x.replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
    return res.end(a.kind==='html'&&interactive?a.content:`<!doctype html><meta charset="utf-8"><body style="font:16px/1.8 system-ui;padding:30px;background:#faf6ee;color:#42372b;white-space:pre-wrap;overflow-wrap:anywhere">${esc(a.content)}</body>`);
   }
   if(p.startsWith('/media-view/') && method==='GET') {
    if(!network.permitted('cloud','web'))throw new NetworkBlocked('現在の通信設定では外部メディアを表示しません。');
    const id=mediaFrames.get(p.slice(12));invariant(id,'Media view expired',404);res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; frame-src https://www.youtube-nocookie.com; frame-ancestors ${origin}`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(`<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;overflow:hidden;background:#120c0a}</style><iframe title="YouTube player" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen src="https://www.youtube-nocookie.com/embed/${id}?autoplay=0&amp;playsinline=1&amp;rel=0"></iframe>`);
   }
   if(p==='/api/media/embed' && method==='POST'){const b=await body(req);invariant(typeof b.id==='string'&&/^[\w-]{11}$/.test(b.id),'Invalid video ID');if(!network.permitted('cloud','web'))throw new NetworkBlocked('インターネットを使う道具を許可してください。');const key=token();if(mediaFrames.size>=32)mediaFrames.delete(mediaFrames.keys().next().value);mediaFrames.set(key,b.id);return json(res,{path:`/media-view/${key}`});}
   if(p==='/app.bundle.js' && method==='GET') {res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache'});return res.end(bundledFrontend);}
   if(p==='/api/bootstrap' && method==='GET')return json(res,{...snapshot(),setup:setup.snapshot(),csrf,skills:store.list('skill'),mcp:store.list('mcp'),platform:process.platform,workspace:agent.workRoot,preview:false,version:VERSION});
   if(p==='/api/events' && method==='GET') {
    const since=Number(req.headers['last-event-id']||u.searchParams.get('since')||0);invariant(Number.isSafeInteger(since)&&since>=0,'Invalid event cursor');
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
    // The first connection replays from the bootstrap cursor; an automatic reconnect (Last-Event-ID) gets a full
    // snapshot, because the live projections (conversation, work) are broadcasts, not replayable events.
    // Raw agent internals (transcript entries, inboxes, deltas) stay in the service; the screen gets projections.
    const internal=/^(session\.(entry|inbox)|agent\.(delta|event|reply|compaction|finished))$/;
    const events=store.events(since);const send=e=>{if(internal.test(e.type))return;if(!res.write(`${e.seq===null?'':`id: ${e.seq}\n`}data: ${JSON.stringify(e)}\n\n`))res.destroy();};
    if(req.headers['last-event-id']||events.length&&events[0].seq>since+1)send({seq:store.seq,type:'snapshot',data:snapshot()});else for(const e of events)send(e);
    store.listeners.add(send);streams.add(res);const beat=setInterval(()=>{if(!res.write(': heartbeat\n\n'))res.destroy();},15000);
    res.on('close',()=>{clearInterval(beat);store.listeners.delete(send);streams.delete(res);});return;
   }
   /* ---------- agent ---------- */
   if(p==='/api/agent'&&method==='GET')return json(res,ui.snapshot());
   if(p==='/api/agent/dialogue'&&method==='GET')return json(res,ui.dialogue());
   if(p==='/api/agent/input'&&method==='POST'){
    const b=await body(req),input=text(b.text,'message',32000);
    invariant(b.requestId===undefined||typeof b.requestId==='string'&&/^[\w-]{8,80}$/.test(b.requestId),'Invalid request id');
    if(b.requestId&&seen.has(b.requestId))return json(res,seen.get(b.requestId),202);
    invariant(registry.configured,'先に「AIを接続」でモデルを登録してください。',409);
    const files=await saveAttachments(b.attachmentIds||[]);
    const main=agent.main(),source=b.source==='voice'?'voice':'text';
    // Pictures go to the character as images (it sees them if its model can); every file is also on disk for work agents.
    const images=[];for(const f of files.filter(f=>f.kind==='image').slice(0,4)){try{images.push({...await loadImage(f.path),name:f.name});}catch{}}
    const message=files.length?`${input}\n\n[添付ファイル（このPCに保存済み）: ${files.map(f=>f.path).join(', ')}]`:input;
    agent.send(main.id,{text:message,from:'user',kind:'message',source:source==='voice'?'user via voice':'user',...(images.length?{images}:{}),meta:{source,attachments:files}});
    const receipt={accepted:true,sessionId:main.id,requestId:b.requestId||null};
    if(b.requestId){seen.set(b.requestId,receipt);if(seen.size>500)seen.delete(seen.keys().next().value);}
    return json(res,receipt,202);
   }
   if(p==='/api/agent/sessions'&&method==='GET')return json(res,agent.sessions.list().map(({system,...s})=>s));
   if(p==='/api/agent/spawn'&&method==='POST'){const b=await body(req);invariant(registry.configured,'先にモデルを登録してください。',409);const s=await agent.spawn(agent.main(),{task:text(b.task,'task',32000),title:b.title,from:'user'});return json(res,ui.job(s),202);}
   let m=p.match(/^\/api\/agent\/sessions\/([\w-]+)(?:\/(message|stop|resume|accept|files|download))?$/);
   if(m){
    const s=agent.sessions.get(m[1]);invariant(s,'Session not found',404);const action=m[2];
    if(!action&&method==='GET'){
     const before=Number(u.searchParams.get('before')||0),limit=Math.min(500,Number(u.searchParams.get('limit')||150));
     const all=before?agent.sessions.entries(s.id,{to:before-1}).slice(-limit):agent.sessions.tail(s.id,limit);
     const {system,...rest}=s;return json(res,{session:rest,job:s.kind==='main'?null:ui.job(s),entries:all.map(e=>e.type==='tool'?{...e,content:String(e.content||'').slice(0,4000)}:e.type==='checkpoint'?{seq:e.seq,type:e.type,at:e.at,upTo:e.upTo,method:e.method,reason:e.reason,summary:e.summary}:e),processes:agent.processes.list(s.id)});
    }
    if(!action&&method==='DELETE'){invariant(s.kind!=='main','The main session cannot be deleted.',403);invariant(!agent.runs.has(s.id),'止めてから削除してください。',409);agent.processes.killSession(s.id);agent.sessions.remove(s.id);store.emit('session.removed',{id:s.id});return json(res,{deleted:true});}
    if(action==='message'&&method==='POST'){const b=await body(req);agent.send(s.id,{text:text(b.text,'message',32000),from:'user',mode:['steer','notify'].includes(b.mode)?b.mode:'followup',source:'user'});return json(res,ui.job(agent.sessions.get(s.id)),202);}
    if(action==='stop'&&method==='POST'){const stopped=agent.stop(s.id,'あなたが止めました');if(s.kind==='main')agent.resume(s.id);return json(res,s.kind==='main'?{stopped:true}:ui.job(stopped));}
    if(action==='resume'&&method==='POST')return json(res,ui.job(agent.resume(s.id)));
    if(action==='accept'&&method==='POST')return json(res,ui.job(agent.sessions.update(s.id,{accepted:true,acceptedAt:new Date().toISOString()})));
    if(action==='files'&&method==='GET'){
     const root=s.cwd||agent.workRoot,files=[];
     const walk=async(dir,depth)=>{let list=[];try{list=await readdir(dir,{withFileTypes:true});}catch{return;}for(const e of list){if(files.length>=300)return;if(['.git','node_modules','.venv','__pycache__'].includes(e.name))continue;const full=path.join(dir,e.name);
      if(e.isDirectory()){if(depth<5)await walk(full,depth+1);}else if(e.isFile()){const st=await stat(full);files.push({path:path.relative(root,full).split(path.sep).join('/'),bytes:st.size,modifiedAt:st.mtime.toISOString()});}}};
     await walk(root,0);return json(res,{root,files});
    }
    if(action==='download'&&method==='GET'){
     const root=path.resolve(s.cwd||agent.workRoot),file=path.resolve(root,String(u.searchParams.get('path')||''));invariant(file.startsWith(root+path.sep),'File is outside the session folder',403);
     const info=await stat(file);invariant(info.isFile()&&info.size<=50_000_000,'Download is limited to 50 MB',413);
     res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,'Cache-Control':'no-store'});return res.end(await readFile(file));
    }
   }
   if(p==='/api/agent/settings'&&method==='GET')return json(res,{...agent.settings(),sandboxAvailable:detectSandbox()});
   if(p==='/api/agent/settings'&&method==='PATCH'){
    const b=await body(req);if(b.policy)b.policy={rules:validateRules(b.policy.rules||[])};
    const next=agent.configure(b);if(b.sandbox||b.toolsChanged)agent.refreshPrompts();return json(res,next);
   }
   if(p==='/api/agent/search-key'&&method==='PUT'){const b=await body(req);invariant(['brave'].includes(b.provider)&&typeof b.key==='string'&&b.key.length<=500,'Invalid key');const keys={...(store.value('search-keys')||{})};if(b.key)keys[b.provider]=b.key;else delete keys[b.provider];store.value('search-keys',keys);return json(res,{provider:b.provider,keyPresent:!!b.key});}
   if(p==='/api/agent/plugins/reload'&&method==='POST'){const r=await agent.tools.loadPlugins();agent.refreshPrompts();return json(res,r);}
   if(p==='/api/agent/approvals'&&method==='GET')return json(res,{approvals:ui.approvals()});
   if(p==='/api/agent/approvals'&&method==='POST'){const b=await body(req);invariant(Array.isArray(b.ids)&&b.ids.length>0&&b.ids.length<=50,'Approval ids are required');invariant(typeof b.allow==='boolean','allow must be boolean');
    return json(res,{results:b.ids.map(id=>{try{agent.policy.decide(id,b.allow);return {id,ok:true};}catch(e){return {id,ok:false,error:safeError(e)};}})});}
   m=p.match(/^\/api\/agent\/approvals\/([\w-]+)$/);
   if(m&&method==='POST'){const b=await body(req);return json(res,agent.policy.decide(m[1],b.allow));}
   if(p==='/api/stop' && method==='POST'){
    setup.stop();toolHub.stopDiscovery();media.stopAll();computer.close();await speech.close();
    for(const probe of probes.values()){probe.abort?.(new Error('Stopped'));probe.close?.();}
    for(const s of agent.sessions.list())if(agent.runs.has(s.id)||['running','waiting'].includes(s.status)){agent.stop(s.id,'すべて停止しました');if(s.kind==='main')agent.resume(s.id);}
    return json(res,{stopped:true});
   }
   if(p==='/api/dialogue/personas'&&method==='GET')return json(res,agent.personas());
   if(p==='/api/dialogue/personas'&&method==='PUT'){const next=configurePersonas(store,await body(req));agent.refreshPrompts();store.emit('personas.updated',next);return json(res,next);}
   /* ---------- capabilities, media, tools ---------- */
   if(p==='/api/capabilities'&&method==='GET')return json(res,capabilities.snapshot());
   if(p==='/api/capabilities'&&method==='PUT'){const b=await body(req);return json(res,capabilities.save(b.config,b.expectedRevision));}
   const capKey=p.match(/^\/api\/capabilities\/([^/]+)\/key$/);
   if(capKey&&method==='POST'){const b=await body(req);return json(res,capabilities.setKey(capKey[1],b.key,b.identity));}
   if(p==='/api/semantic/index'&&method==='POST'){const b=await body(req);return json(res,await semantic.index({allowExternal:b.consent===true,signal:AbortSignal.timeout(90000)}));}
   if(p==='/api/semantic/search'&&method==='POST'){const b=await body(req);return json(res,await semantic.search(b.query,{allowExternal:b.consent===true,signal:AbortSignal.timeout(30000)}));}
   if(p==='/api/media/jobs'&&method==='GET')return json(res,{jobs:media.snapshot()});
   if(p==='/api/media/jobs'&&method==='POST'){const b=await body(req);invariant(b.consent===true,'送信先と生成内容への確認が必要です。',403);return json(res,media.create(b),202);}
   const mediaJob=p.match(/^\/api\/media\/jobs\/([a-f0-9]{64})(?:\/(cancel|resume))?$/);
   if(mediaJob){
    if(method==='DELETE'&&!mediaJob[2])return json(res,await media.remove(mediaJob[1]));
    if(method==='POST'&&mediaJob[2])return json(res,media[mediaJob[2]](mediaJob[1]));
   }
   const mediaAsset=p.match(/^\/api\/media\/assets\/([a-f0-9-]{36})$/);
   if(mediaAsset&&['GET','HEAD'].includes(method)){
    const a=await media.readAsset(mediaAsset[1]),bytes=a.bytes;
    res.setHeader('Content-Type',a.mime);res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    if(u.searchParams.get('download')==='1')res.setHeader('Content-Disposition',`attachment; filename="tepora-${a.id}.${{'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','video/mp4':'mp4'}[a.mime]}"`);
    let begin=0,end=bytes.length-1,status=200;
    if(req.headers.range){const r=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);invariant(r&&(r[1]||r[2]),'Invalid media range',416);
     if(!r[1])begin=Math.max(0,bytes.length-Number(r[2]));else begin=Number(r[1]);if(r[1]&&r[2])end=Math.min(end,Number(r[2]));
     invariant(Number.isSafeInteger(begin)&&Number.isSafeInteger(end)&&begin>=0&&begin<=end&&begin<bytes.length,'Range is outside asset',416);
     status=206;res.setHeader('Content-Range',`bytes ${begin}-${end}/${bytes.length}`);
    }
    res.writeHead(status,{'Content-Length':end-begin+1});return res.end(method==='HEAD'?undefined:bytes.subarray(begin,end+1));
   }
   if(p==='/api/tools/import/preview'&&method==='POST')return json(res,toolHub.stage(await body(req)));
   if(p==='/api/tools/import/apply'&&method==='POST'){const b=await body(req);return json(res,toolHub.apply(b.id,b.consent));}
   if(p==='/api/tools/connect/preview'&&method==='POST'){const b=await body(req);return json(res,toolHub.previewConnect(b.ids));}
   if(p==='/api/tools/connect/apply'&&method==='POST'){const b=await body(req);return json(res,await toolHub.connectBatch(b.id,b.consent,AbortSignal.timeout(120000)));}
   if(p==='/api/tools/search'&&method==='POST'){const b=await body(req);return json(res,toolHub.search(b.query));}
   const discovery=p.match(/^\/api\/tools\/([^/]+)\/discover$/);
   if(discovery&&method==='POST'){const b=await body(req);invariant(b.consent===true,'接続の確認が必要です。',403);return json(res,await toolHub.discover(discovery[1],AbortSignal.timeout(90000)));}
   if(p==='/api/model-catalog'&&method==='GET')return json(res,catalog.search(u.searchParams.get('q')||''));
   if(p==='/api/model-catalog/import'&&method==='POST')return json(res,catalog.import(await body(req)));
   if(p==='/api/model-catalog/refresh'&&method==='POST')return json(res,await catalog.refresh(AbortSignal.timeout(30000)));
   if(p==='/api/computer'&&method==='GET')return json(res,computer.snapshot());
   if(p==='/api/computer'&&method==='PATCH'){const b=await body(req);return json(res,computer.save(b.patch,b.expectedRevision));}
   if(p==='/api/computer/windows'&&method==='POST')return json(res,computer.snapshot().desktop.supported?await computer.desktopClient().windows():[]);
   if(p==='/api/computer/status'&&method==='POST')return json(res,{...computer.snapshot(),permissions:computer.snapshot().desktop.supported?await computer.desktopClient().status().catch(e=>({error:e.message})):null});
   if(p==='/api/computer/release'&&method==='POST'){computer.close();store.emit('computer.updated',computer.snapshot());return json(res,{released:true});}
   if(p==='/api/network'&&method==='GET')return json(res,network.get());
   if(p==='/api/network'&&method==='PATCH'){
    const b=await body(req),next=network.change(b.patch,b.expectedRevision);
    if(Object.hasOwn(b.patch,'internetTools')){store.settings={...store.settings,allowNetwork:next.internetTools};store.emit('settings.updated',store.settings);}
    if(next.mode!=='online'){setup.stop();for(const probe of probes.values()){probe.abort?.(new NetworkBlocked());probe.close?.();}mediaFrames.clear();}
    return json(res,{...next,note:'Tepora管理の通信に適用します。OS全体のファイアウォールではありません。'});
   }
   if(p==='/api/providers'&&method==='GET')return json(res,registry.publicSnapshot());
   if(p==='/api/providers'&&method==='PUT'){const b=await body(req);return json(res,registry.save(b.config,b.expectedRevision));}
   const providerAction=p.match(/^\/api\/providers\/([\w-]+)\/(key|probe)$/);
   if(providerAction&&method==='POST'){
    const b=await body(req);if(providerAction[2]==='key')return json(res,registry.setKey(providerAction[1],b.key));
    return json(res,await registry.probe(providerAction[1],AbortSignal.timeout(90000)));
   }
   if(p==='/api/setup/install-help'&&method==='POST'){return json(res,await openInstallerPage());}
   if(p==='/api/setup'&&method==='GET')return json(res,setup.snapshot());
   if(p==='/api/setup/scan'&&method==='POST')return json(res,await setup.scan());
   if(p==='/api/setup/dismiss'&&method==='POST')return json(res,setup.dismiss());
   if(p==='/api/setup/select'&&method==='POST'){const b=await body(req);return json(res,await setup.select(b.candidateId,b));}
   if(p==='/api/setup/install'&&method==='POST'){if(network.get().mode!=='online')throw new NetworkBlocked('制限モードではモデルを取得しません。');return json(res,setup.install(await body(req)),202);}
   if(p==='/api/setup/stop'&&method==='POST')return json(res,setup.stop());
   if(p==='/api/inputs'&&method==='POST'){const b=await body(req);return json(res,{files:stageInputs(store,b.files)},201);}
   const inputDelete=p.match(/^\/api\/inputs\/([^/]+)$/);
   if(inputDelete&&method==='DELETE')return json(res,removeStagedInput(store,inputDelete[1]));
   if(p==='/api/runtime/discover' && method==='POST')return json(res,await Promise.all(PROVIDERS.map(async x=>{try{return {...x,available:true,models:await new Runtime({baseUrl:x.url,allowCloud:false},'',network.fetch({purpose:'model'})).models()};}catch{return {...x,available:false,models:[]};}})));
   if(p==='/api/voice/edit'&&method==='POST'){
    const b=await body(req);invariant(store.settings.dictationEditing===true,'Local dictation editing is not enabled',403);
    invariant(!probes.has('dictation'),'Another draft edit is running',429);const cancel=new AbortController();probes.set('dictation',cancel);
    try{
     const chain=registry.chain('dictation').filter(x=>x.domain==='device');invariant(chain.length,'同一PCの音声編集モデルを設定してください。',409);
     const runtime={chat:(messages,options)=>registry.invoke(chain,messages,{...options,signal:options.signal})};
     return json(res,await editDictation(runtime,{model:chain[0].model,baseUrl:chain[0].baseUrl},b,AbortSignal.any([cancel.signal,AbortSignal.timeout(12000)])));
    }finally{probes.delete('dictation');}
   }
   if(p==='/api/voice/start'&&method==='POST')return json(res,await speech.start());
   if(p==='/api/voice/chunk'&&method==='POST')return json(res,await speech.chunk(await body(req)));
   if(p==='/api/voice/finish'&&method==='POST'){const b=await body(req);return json(res,await speech.finish(b.id));}
   if(p==='/api/voice/cancel'&&method==='POST'){const b=await body(req);return json(res,await speech.cancel(b.id));}
   const artifactHistory=p.match(/^\/api\/artifacts\/([^/]+)\/revisions(?:\/(\d+))?$/);
   if(artifactHistory&&method==='GET'){
    const current=store.get('artifact',artifactHistory[1]);invariant(current,'Artifact not found',404);
    if(artifactHistory[2]){const version=Number(artifactHistory[2]);const doc=version===current.version?current:store.get('revision',`${current.id}:${version}`);invariant(doc,'Artifact revision not found',404);return json(res,{id:current.id,title:doc.title,kind:doc.kind,version:doc.version,updatedAt:doc.updatedAt,content:doc.content});}
    const versions=store.list('revision').filter(r=>r.artifactId===current.id).map(r=>({version:r.version,updatedAt:r.updatedAt,title:r.title}));
    return json(res,{id:current.id,versions:[{version:current.version,updatedAt:current.updatedAt,title:current.title},...versions].sort((a,b)=>b.version-a.version)});
   }
   const artifactEdit=p.match(/^\/api\/artifacts\/([^/]+)$/);
   if(artifactEdit&&method==='PATCH'){
    const b=await body(req),old=store.get('artifact',artifactEdit[1]);invariant(old,'Artifact not found',404);
    invariant(Number.isSafeInteger(b.expectedVersion),'A base revision is required');
    return json(res,store.artifact(old.title,b.content,{id:old.id,kind:old.kind,jobId:old.jobId,sessionId:old.sessionId,expectedVersion:b.expectedVersion}));
   }
   if(p==='/api/display' && method==='GET')return json(res,display.get());
   if(p==='/api/display' && method==='PATCH'){const b=await body(req);return json(res,display.change(b.patch,b.expectedRevision));}
   if(p==='/api/display/undo' && method==='POST'){const b=await body(req);return json(res,display.undo(b.expectedRevision));}
   if(p==='/api/display/reset' && method==='POST'){const b=await body(req);return json(res,display.reset(b.expectedRevision));}
   if(p==='/api/display/export' && method==='GET')return json(res,display.export());
   if(p==='/api/display/import' && method==='POST'){const b=await body(req);return json(res,display.import(b.preset,b.expectedRevision));}
   if(p==='/api/doctor' && method==='GET')return json(res,{
    platform:process.platform,arch:process.arch,ramBytes:os.totalmem(),cpuThreads:os.cpus().length,sandbox:detectSandbox(),
    providers:registry.get().profiles.map(x=>({id:x.id,model:x.model,domain:x.domain,limits:registry.knownLimits(x)})),
    note:'設定の有無であり、実モデル・GPUの動作確認ではありません。',dataLocation:dir,workRoot:agent.workRoot
   });
   if(p==='/api/shared/scan' && method==='POST') {
    const b=await body(req);invariant(b.consent===true,'Shared asset discovery requires explicit consent',403);
    const found=await discoverSharedSkills();
    for(const skill of found.skills){const old=store.get('skill',skill.id);store.put('skill',{...skill,enabled:old?.sha256===skill.sha256&&old?.enabled===true});}
    return json(res,{...found,skills:store.list('skill')});
   }
   const skillAction=p.match(/^\/api\/skills\/([^/]+)$/);
   if(skillAction&&method==='PATCH'){
    const b=await body(req),skill=store.get('skill',skillAction[1]);
    invariant(skill&&typeof b.enabled==='boolean','Unknown skill or invalid enabled flag');
    const result=store.put('skill',{...skill,enabled:b.enabled});store.emit('skill.updated',result);agent.refreshPrompts();return json(res,result);
   }
   if(p==='/api/settings' && method==='PATCH') {
    const input=await body(req),previous=store.settings,next=validateSettings(input,previous);
    store.settings=next;
    if(Object.hasOwn(input,'allowNetwork'))network.change({internetTools:next.allowNetwork},network.get().revision);
    store.emit('settings.updated',next);return json(res,next);
   }
   if(p==='/api/presence'&&method==='POST'){const b=await body(req);invariant(['present','away'].includes(b.state),'Invalid presence');store.value('presence',{state:b.state,at:new Date().toISOString()});return json(res,{presence:b.state});}
   if(p==='/api/avatar'&&method==='GET')return json(res,avatar.get());
   if(p==='/api/avatar'&&method==='PATCH'){const b=await body(req);return json(res,avatar.change(b.patch,b.expectedRevision));}
   if(p==='/api/avatar/undo'&&method==='POST'){const b=await body(req);return json(res,avatar.undo(b.expectedRevision));}
   if(p==='/api/avatar/reset'&&method==='POST'){const b=await body(req);return json(res,avatar.reset(b.expectedRevision));}
   if(p==='/api/avatar/export'&&method==='GET')return json(res,avatar.export());
   if(p==='/api/avatar/import'&&method==='POST'){const b=await body(req);return json(res,avatar.import(b.preset,b.expectedRevision));}
   if(p==='/api/avatar/assets'&&method==='GET')return json(res,avatarAssets.snapshot());
   if(p==='/api/avatar/assets'&&method==='PUT'){let filename='';try{filename=decodeURIComponent(String(req.headers['x-tepora-filename']||''));}catch{filename='';}return json(res,await avatarAssets.add(String(req.headers['x-tepora-asset-kind']||''),await rawBody(req,MAX_ASSET_BYTES),{filename}));}
   const assetFile=p.match(/^\/api\/avatar\/assets\/([a-f0-9-]{36})\/files\/(.+)$/);
   if(assetFile&&['GET','HEAD'].includes(method)){let filePath='';try{filePath=decodeURIComponent(assetFile[2]);}catch{filePath='';}const {entry,bytes}=await avatarAssets.read(assetFile[1],filePath);res.writeHead(200,{'Content-Type':entry.mime,'Content-Length':bytes.length,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(method==='HEAD'?undefined:bytes);}
   const assetRoute=p.match(/^\/api\/avatar\/assets\/([a-f0-9-]{36})$/);
   if(assetRoute&&method==='DELETE'){const result=await avatarAssets.remove(assetRoute[1]);avatar.assetRemoved(assetRoute[1]);return json(res,result);}
   if(p==='/api/frame'&&method==='GET')return json(res,frame.snapshot());
   if(p==='/api/frame/photos'&&method==='PUT'){let filename='';try{filename=decodeURIComponent(String(req.headers['x-tepora-filename']||''));}catch{filename='';}return json(res,await frame.add(await rawBody(req,MAX_PHOTO_BYTES),{filename}));}
   const photoRoute=p.match(/^\/api\/frame\/photos\/([0-9a-f-]{36})$/);
   if(photoRoute&&['GET','HEAD'].includes(method)){const {meta,bytes}=await frame.read(photoRoute[1]);res.writeHead(200,{'Content-Type':meta.mime,'Content-Length':bytes.length,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});return res.end(method==='HEAD'?undefined:bytes);}
   if(photoRoute&&method==='DELETE')return json(res,await frame.remove(photoRoute[1]));
   if(p==='/api/memories' && method==='POST') {const b=await body(req);return json(res,store.memory(b.content,{title:typeof b.title==='string'?b.title:'',confirmed:true,scope:b.scope}),201);}
   m=p.match(/^\/api\/memories\/([^/]+)$/);
   if(m && ['PATCH','DELETE'].includes(method)) {const old=store.get('memory',m[1]);invariant(old,'Memory not found',404);if(method==='DELETE'){store.remove('memory',m[1]);store.emit('memory.deleted',{id:m[1]});return json(res,{deleted:true});}const b=await body(req);const value={...old};if('title'in b){invariant(typeof b.title==='string'&&b.title.length<=160,'Invalid memory title');value.title=b.title;}if('content'in b)value.content=text(b.content);if('confirmed'in b){invariant(typeof b.confirmed==='boolean','Invalid confirmed');value.confirmed=b.confirmed;}if('scope'in b){invariant(['shared','private'].includes(b.scope),'Invalid scope');value.scope=b.scope;}store.put('memory',value);store.emit('memory.updated',value);return json(res,value);}
   if(p==='/api/skills' && method==='POST') {const b=await body(req);const doc={id:randomUUID(),name:text(b.name,'name',100),description:text(b.description,'description',1024),content:text(b.content,'SKILL.md',32000),enabled:b.enabled!==false,createdAt:new Date().toISOString()};store.put('skill',doc);store.emit('skill.updated',doc);agent.refreshPrompts();return json(res,doc,201);}
   m=p.match(/^\/api\/skills\/([^/]+)$/);if(m && method==='DELETE'){store.remove('skill',m[1]);store.emit('skill.deleted',{id:m[1]});agent.refreshPrompts();return json(res,{deleted:true});}
   if(p==='/api/mcp' && method==='POST') {
    const b=await body(req);invariant(['stdio','http'].includes(b.transport),'Use stdio or http');const doc={id:randomUUID(),name:text(b.name,'name',100),transport:b.transport,enabled:b.enabled===true};
    if(b.transport==='stdio'){doc.command=text(b.command,'command',2000);invariant(Array.isArray(b.args)&&b.args.length<50&&b.args.every(a=>typeof a==='string'&&a.length<2000),'Invalid arguments');doc.args=b.args;}
    else {doc.url=endpoint(b.url,true).href;doc.apiKeyEnv=typeof b.apiKeyEnv==='string'?b.apiKeyEnv:'';invariant(!doc.apiKeyEnv||/^[A-Z_][A-Z0-9_]*$/.test(doc.apiKeyEnv),'Invalid env name');}
    store.put('mcp',doc);store.emit('mcp.updated',doc);return json(res,doc,201);
   }
   m=p.match(/^\/api\/mcp\/([^/]+)$/);if(m && ['PATCH','DELETE'].includes(method)){const d=store.get('mcp',m[1]);invariant(d,'MCP config not found',404);if(method==='DELETE'){toolHub.revoke(d.id);store.remove('mcp',d.id);store.emit('mcp.deleted',{id:d.id});return json(res,{deleted:true});}const b=await body(req);invariant(typeof b.enabled==='boolean','Invalid enabled');if(!b.enabled)toolHub.revoke(d.id);d.enabled=b.enabled;store.put('mcp',d);store.emit('mcp.updated',d);return json(res,d);}
   if(p==='/api/connector/weather' && method==='POST')return json(res,await connectors.weather());
   if(p==='/api/connector/news' && method==='POST')return json(res,await connectors.news());
   if(p==='/api/media/open' && method==='POST'){const b=await body(req);return json(res,await connectors.openMedia(b.url));}
   if(p==='/api/voice/transcribe' && method==='POST')return json(res,await connectors.transcribe(await body(req,true)));
   if(p==='/api/context/export' && method==='GET'){res.setHeader('Content-Disposition','attachment; filename="tepora-context.json"');return json(res,store.export());}
   if(p==='/api/context/import' && method==='POST')return json(res,store.import(await body(req)));
   if(p==='/api/artifacts' && method==='GET')return json(res,store.list('artifact'));
   if(p.startsWith('/api/'))return json(res,{error:'Unknown endpoint or HTTP method'},404);
   invariant(['GET','HEAD'].includes(method),'Method not allowed',405);
   const allowed=['/','/index.html','/styles.css','/avatar.css','/app.mjs','/ui.mjs','/bridge.mjs','/voice.mjs','/draft.mjs','/realtime-voice.mjs','/onboarding.mjs','/provider-settings.mjs','/capability-ui.mjs','/pcm-worklet.js','/display-model.mjs','/demo.mjs','/favicon.svg','/vrm-stage.mjs','/mesh-avatar.mjs','/three-body.mjs',...VENDOR_FILES.map(f=>'/vendor/'+f)];invariant(allowed.includes(p),'Not found',404);
   const file=path.join(webDir,p==='/'?'index.html':p.slice(1));const data=await readFile(file);
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
   res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:data);
  }catch(e){if(res.headersSent){res.end();return;}json(res,{error:safeError(e),...(e.blocked?{blocked:true}:{})},e.status||500);}
 });
 server.requestTimeout=150000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
 const launchUrl=`${origin}/launch?token=${secret}`;
 const close=async()=>{if(closing)return;closing=true;for(const probe of probes.values()){probe.abort?.(new Error('Service stopping'));probe.close?.();}
  ui.close();await agent.close();computer.close();toolHub.close();await media.close();capabilities.close();connectors.close();await setup.close();await speech.close();
  for(const res of streams)res.end();network.close();registry.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();};
 return {server,store,network,registry,catalog,agent,ui,connectors,setup,capabilities,media,toolHub,computer,frame,avatar,avatarAssets,origin,launchUrl,csrf,close};
}
const isMain=process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isMain){const app=await startServer({port:Number(process.env.TEPORA_PORT||0)});console.log(JSON.stringify({type:'ready',url:app.launchUrl,version:VERSION}));if(process.argv.includes('--open')){const [exe,args]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',app.launchUrl]]:process.platform==='darwin'?['open',[app.launchUrl]]:['xdg-open',[app.launchUrl]];const p=spawn(exe,args,{stdio:'ignore',shell:false});p.on('error',()=>console.error('Open the URL printed above in a browser.'));}if(process.argv.includes('--sidecar')){process.stdin.setEncoding('utf8');let stdinBuffer='';process.stdin.on('data',chunk=>{
 stdinBuffer=(stdinBuffer+chunk).slice(-4096);let end;
 while((end=stdinBuffer.indexOf('\n'))>=0){const command=stdinBuffer.slice(0,end).trim();stdinBuffer=stdinBuffer.slice(end+1);
  if(command==='shutdown')app.close().then(()=>process.exit(0));
  else if(command==='stop'){for(const s of app.agent.sessions.list())if(s.kind!=='main'&&app.agent.runs.has(s.id))app.agent.stop(s.id,'stopped from the tray');}
 }});process.stdin.on('end',()=>app.close().then(()=>process.exit(0)));}for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>app.close().then(()=>process.exit(0)));}
