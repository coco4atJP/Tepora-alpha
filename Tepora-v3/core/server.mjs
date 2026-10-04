import {ModelCatalog} from './model-catalog.mjs';
import {CodexLogin} from './agents/codex-login.mjs';
import {NetworkPolicy,NetworkBlocked} from './network-policy.mjs';
import {ProviderRegistry} from './provider-registry.mjs';
import {openInstallerPage} from './platform-links.mjs';
import {SetupManager} from './setup.mjs';
import {Companion} from './companion.mjs';
import {Dialogue} from './dialogue.mjs';
import {IntentProposals} from './intent.mjs';
import {Requests} from './requests.mjs';
import {stageInputs,removeStagedInput} from './input-files.mjs';
import {listWorkspace,workspaceRoot} from './workspace.mjs';
import {Routines} from './routines.mjs';
import {Plans} from './plans.mjs';
import {CodexAgent} from './agents/codex.mjs';
import {probeRuntime} from './probe.mjs';
import {editDictation} from './dictation.mjs';
import {verifyJob} from './verification.mjs';
import { SpeechStream } from './speech-stream.mjs';
import { CharacterModels, MAX_VRM_BYTES } from './character.mjs';
/** Loopback-only service. UI and API share an origin; credentials never enter browser storage. */
import http from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Display } from './display.mjs';
import { discoverSharedSkills } from './shared-assets.mjs';
import { Store } from './store.mjs';
import { browserBundle } from './frontend.mjs';
import { Harness } from './harness.mjs';
import { Connectors } from './connectors.mjs';
import { Runtime, discover } from './runtime.mjs';
import { invariant, text, endpoint, validateSettings, safeError, workspacePath, LIMITS } from './policy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const VENDOR_FILES=['three.core.js','three.module.js','GLTFLoader.js','BufferGeometryUtils.js','SkeletonUtils.js','three-vrm.module.min.js'];
const TYPES={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'};
const same=(a,b)=>typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const token=()=>randomBytes(32).toString('hex');
async function rawBody(req,limit){let size=0;const chunks=[];for await(const b of req){size+=b.length;invariant(size<=limit,'ファイルが大きすぎます。',413);chunks.push(b);}return Buffer.concat(chunks);}
async function body(req,raw=false) {let size=0;const chunks=[];for await(const b of req){size+=b.length;invariant(size<=LIMITS.body,'Request body too large',413);chunks.push(b);}const buffer=Buffer.concat(chunks);if(raw)return buffer;try{return buffer.length?JSON.parse(buffer.toString('utf8')):{};}catch{throw Object.assign(new Error('Invalid JSON body'),{status:400});}}
function json(res,value,status=200){if(res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function dataDir(){if(process.env.TEPORA_DATA_DIR)return process.env.TEPORA_DATA_DIR;if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'Tepora','v3');if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','Tepora','v3');return path.join(os.homedir(),'.local','share','tepora-v3');}
export async function startServer({port=0,dir=dataDir(),webDir=process.env.TEPORA_WEB_DIR||path.resolve(here,'../web'),runtimeFactory,setupOptions={},networkOptions={},registryOptions={},computerOptions={},mediaOptions={},toolHubOptions={},loginOptions={},executionOptions={}}={}) {
 const bundledFrontend=await browserBundle(webDir);
 const store=new Store(dir),network=new NetworkPolicy(store,networkOptions),registry=new ProviderRegistry(store,network,registryOptions);
 const connectors=new Connectors(store,network),harness=new Harness(store,connectors,{runtimeFactory,network,registry,computerOptions,mediaOptions,toolHubOptions,executionOptions});
 const display=new Display(store),speech=new SpeechStream(store,network.fetch({purpose:'worker'})),characters=new CharacterModels(store);
 const setup=new SetupManager(store,harness,{runtimeFactory,fetchImpl:(url,init)=>network.request(url,init,{purpose:String(url).includes('/api/pull')?'download':'model',allowCloud:false}),...setupOptions}),requests=new Requests(store,harness);
 const companion=new Companion(store),intents=new IntentProposals(store,harness,requests),dialogue=new Dialogue(store,harness,requests);
 const routines=new Routines(store,harness),plans=new Plans(store,harness);harness.routines=routines;harness.plans=plans;routines.start();
 const probes=new Map(),catalog=new ModelCatalog(store,network),login=new CodexLogin(store,network,loginOptions);
 const loginPolicy=policy=>{if(policy.mode!=='online')login.close();};network.listeners.add(loginPolicy);
 const secret=token(),csrf=token();let origin='',closing=false;const streams=new Set(),mediaFrames=new Map();
  harness.presence=()=>!streams.size?'away':store.value('presence')?.state==='away'?'away':'present';
 if(!store.get('skill','artifact-studio'))store.put('skill',{id:'artifact-studio',name:'Artifact studio',description:'成果物を早く公開し、同じIDで段階的に更新する。',content:'# Artifact studio\nPublish a first useful HTML or Markdown artifact early. Keep the id and revise it as the task develops. Prefer self-contained accessible HTML, with no remote scripts or fonts. State evidence and unknowns. Never invent live data.',createdAt:new Date().toISOString()});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=()');
  try {
   const host=new URL(origin).host;invariant(req.headers.host===host,'Invalid Host',403);
   if(req.headers.origin)invariant(req.headers.origin===origin,'Cross-origin requests are not allowed',403);
   invariant(req.headers['sec-fetch-site']!=='cross-site','Cross-site requests are not allowed',403);
   const u=new URL(req.url,origin), p=u.pathname, method=req.method;
   if(p==='/health' && method==='GET')return json(res,{ok:true,version:'3.0.0-beta.11'});
   if(p==='/launch' && method==='GET') {invariant(same(u.searchParams.get('token'),secret),'Launch token is invalid',403);res.writeHead(303,{'Set-Cookie':`tepora_session=${secret}; HttpOnly; SameSite=Strict; Path=/`,'Location':'/','Cache-Control':'no-store'});return res.end();}
   const cookie=req.headers.cookie?.split(';').map(c=>c.trim()).find(c=>c.startsWith('tepora_session='))?.slice(15);
   invariant(same(cookie,secret),'このアプリを起動したときのURLから開いてください。',401);
   if(!['GET','HEAD'].includes(method))invariant(same(req.headers['x-tepora-csrf'],csrf),'Invalid CSRF token',403);
   if(p.startsWith('/render/') && method==='GET') {
    let a=store.get('artifact',p.slice(8));invariant(a,'Artifact not found',404);
    if(u.searchParams.has('v')){const version=Number(u.searchParams.get('v'));invariant(Number.isSafeInteger(version)&&version>0,'Invalid revision');
     if(a.version!==version)a=store.get('revision',`${p.slice(8)}:${version}`);invariant(a,'Artifact revision not found',404);}
    res.removeHeader('X-Frame-Options');
    const interactive=harness.execution.config().mode==='legacy-host';
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
   if(p==='/api/bootstrap' && method==='GET')return json(res,{...store.snapshot(),dialogue:dialogue.snapshot(),network:network.get(),providers:registry.publicSnapshot(),computer:harness.computer.snapshot(),capabilities:harness.capabilities.snapshot(),mediaJobs:harness.media.snapshot(),display:display.get(),setup:setup.snapshot(),approvals:harness.approvalList({limit:30}),character:characters.get(),csrf,skills:store.list('skill'),mcp:store.list('mcp'),platform:process.platform,workspace:path.join(dir,'workspace'),preview:false});
   if(p==='/api/events' && method==='GET') {
    const since=Number(req.headers['last-event-id']||u.searchParams.get('since')||0);invariant(Number.isSafeInteger(since)&&since>=0,'Invalid event cursor');
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
    // Send a full snapshot as a recovery boundary if persisted events were trimmed.
    const events=store.events(since);const send=e=>{if(!res.write(`${e.seq===null?'':`id: ${e.seq}\n`}data: ${JSON.stringify(e)}\n\n`))res.destroy();};
    if(events.length && events[0].seq>since+1)send({seq:store.seq,type:'snapshot',data:{...store.snapshot(),dialogue:dialogue.snapshot(),network:network.get(),providers:registry.publicSnapshot(),computer:harness.computer.snapshot(),capabilities:harness.capabilities.snapshot(),mediaJobs:harness.media.snapshot(),display:display.get(),approvals:harness.approvalList({limit:30}),character:characters.get()}});else for(const e of events)send(e);
    store.listeners.add(send);streams.add(res);const beat=setInterval(()=>{if(!res.write(': heartbeat\n\n'))res.destroy();},15000);
    res.on('close',()=>{clearInterval(beat);store.listeners.delete(send);streams.delete(res);});return;
   }
   const fileRoute=p.match(/^\/api\/jobs\/([^/]+)\/(files|download)$/);
   if(fileRoute&&method==='GET'){
    invariant(store.get('job',fileRoute[1]),'Unknown task',404);
    if(fileRoute[2]==='files')return json(res,await listWorkspace(store,fileRoute[1]));
    const relative=u.searchParams.get('path'),file=await workspacePath(workspaceRoot(store,fileRoute[1]),relative);
    const info=await stat(file);invariant(info.isFile()&&info.size<=25_000_000,'Download is limited to 25 MB',413);
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,'Cache-Control':'no-store'});return res.end(data);
   }
   if(p==='/api/routines'&&method==='GET')return json(res,store.list('routine'));
   if(p==='/api/routines'&&method==='POST')return json(res,routines.save(await body(req)),201);
   let action=p.match(/^\/api\/routines\/([^/]+)\/(enable)$/);
   if(action&&method==='POST'){const b=await body(req);return json(res,routines.enable(action[1],b.enabled,b.expectedRevision));}
   if(p==='/api/plans'&&method==='GET')return json(res,store.list('plan'));
   if(p==='/api/plans'&&method==='POST')return json(res,plans.create(await body(req)),201);
   action=p.match(/^\/api\/plans\/([^/]+)\/(activate|pause)$/);
   if(action&&method==='POST'){const b=await body(req);return json(res,action[2]==='activate'?plans.activate(action[1],b.expectedRevision):plans.pause(action[1]));}
   action=p.match(/^\/api\/jobs\/([^/]+)\/(priority|verify)$/);
   if(action&&method==='POST'){
    const b=await body(req),job=store.get('job',action[1]);invariant(job,'Task not found',404);
    if(action[2]==='priority')return json(res,harness.priority(job.id,b.priority));
    const report=await verifyJob(store,job);harness.update(harness.live(job.id),{verification:{...job.verification,checks:report}});return json(res,report);
   }
   const jobRoute=p.match(/^\/api\/jobs\/([^/]+)\/route$/);
   if(jobRoute&&method==='GET')return json(res,harness.routeProposal(jobRoute[1]));
   if(jobRoute&&method==='POST')return json(res,harness.rebind(jobRoute[1],await body(req)));
   if(p==='/api/capabilities'&&method==='GET')return json(res,harness.capabilities.snapshot());
   if(p==='/api/capabilities'&&method==='PUT'){const b=await body(req);return json(res,harness.capabilities.save(b.config,b.expectedRevision));}
   const capKey=p.match(/^\/api\/capabilities\/([^/]+)\/key$/);
   if(capKey&&method==='POST'){const b=await body(req);return json(res,harness.capabilities.setKey(capKey[1],b.key,b.identity));}
   if(p==='/api/semantic/index'&&method==='POST'){const b=await body(req);const selected=harness.capabilities.pin('embedding');if(selected.domain!=='device')invariant(b.profileIdentity===selected.identity,'埋め込みの送信先が変わっています。',409);return json(res,await harness.semantic.index({allowExternal:b.consent===true,signal:AbortSignal.timeout(90000)}));}
   if(p==='/api/semantic/search'&&method==='POST'){const b=await body(req);if(b.consent){const selected=harness.capabilities.pin('embedding');invariant(b.profileIdentity===selected.identity,'埋め込みの送信先が変わっています。',409);}return json(res,await harness.semantic.search(b.query,{allowExternal:b.consent===true,signal:AbortSignal.timeout(30000)}));}
   if(p==='/api/media/jobs'&&method==='GET')return json(res,{jobs:harness.media.snapshot()});
   if(p==='/api/media/jobs'&&method==='POST'){const b=await body(req);invariant(b.consent===true,'送信先と生成内容への確認が必要です。',403);return json(res,harness.media.create(b),202);}
   const mediaJob=p.match(/^\/api\/media\/jobs\/([a-f0-9]{64})(?:\/(cancel|resume))?$/);
   if(mediaJob){
    if(method==='DELETE'&&!mediaJob[2])return json(res,await harness.media.remove(mediaJob[1]));
    if(method==='POST'&&mediaJob[2])return json(res,harness.media[mediaJob[2]](mediaJob[1]));
   }
   const mediaAsset=p.match(/^\/api\/media\/assets\/([a-f0-9-]{36})$/);
   if(mediaAsset&&['GET','HEAD'].includes(method)){
    const a=await harness.media.readAsset(mediaAsset[1]),bytes=a.bytes;
    res.setHeader('Content-Type',a.mime);res.setHeader('Cache-Control','no-store');res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    if(u.searchParams.get('download')==='1')res.setHeader('Content-Disposition',`attachment; filename="tepora-${a.id}.${{'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','video/mp4':'mp4'}[a.mime]}"`);
    let begin=0,end=bytes.length-1,status=200;
    if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);invariant(m&&(m[1]||m[2]),'Invalid media range',416);
     if(!m[1])begin=Math.max(0,bytes.length-Number(m[2]));else begin=Number(m[1]);if(m[1]&&m[2])end=Math.min(end,Number(m[2]));
     invariant(Number.isSafeInteger(begin)&&Number.isSafeInteger(end)&&begin>=0&&begin<=end&&begin<bytes.length,'Range is outside asset',416);
     status=206;res.setHeader('Content-Range',`bytes ${begin}-${end}/${bytes.length}`);
    }
    res.writeHead(status,{'Content-Length':end-begin+1});return res.end(method==='HEAD'?undefined:bytes.subarray(begin,end+1));
   }
   if(p==='/api/tools/import/preview'&&method==='POST')return json(res,harness.toolHub.stage(await body(req)));
   if(p==='/api/tools/import/apply'&&method==='POST'){const b=await body(req);return json(res,harness.toolHub.apply(b.id,b.consent));}
   if(p==='/api/tools/connect/preview'&&method==='POST'){const b=await body(req);return json(res,harness.toolHub.previewConnect(b.ids));}
   if(p==='/api/tools/connect/apply'&&method==='POST'){const b=await body(req);return json(res,await harness.toolHub.connectBatch(b.id,b.consent,AbortSignal.timeout(120000)));}
   if(p==='/api/tools/search'&&method==='POST'){const b=await body(req);return json(res,harness.toolHub.search(b.query));}
   const discovery=p.match(/^\/api\/tools\/([^/]+)\/discover$/);
   if(discovery&&method==='POST'){const b=await body(req);invariant(b.consent===true,'接続の確認が必要です。',403);return json(res,await harness.toolHub.discover(discovery[1],AbortSignal.timeout(90000)));}
   if(p==='/api/model-catalog'&&method==='GET')return json(res,catalog.search(u.searchParams.get('q')||''));
   if(p==='/api/model-catalog/import'&&method==='POST')return json(res,catalog.import(await body(req)));
   if(p==='/api/model-catalog/refresh'&&method==='POST')return json(res,await catalog.refresh(AbortSignal.timeout(30000)));
   if(p==='/api/codex/login'&&method==='GET')return json(res,login.status());
   if(p==='/api/codex/login'&&method==='POST'){const b=await body(req);invariant(harness.execution.config().mode==='legacy-host','Codex requires explicit legacy-host mode',403);return json(res,await login.start(b));}
   if(p==='/api/codex/login/open'&&method==='POST'){const b=await body(req);return json(res,await login.open(b.loginId));}
   if(p==='/api/codex/login/cancel'&&method==='POST')return json(res,await login.cancel());
   if(p==='/api/computer'&&method==='GET')return json(res,harness.computer.snapshot());
   if(p==='/api/computer'&&method==='PATCH'){const b=await body(req);return json(res,harness.computer.save(b.patch,b.expectedRevision));}
   if(p==='/api/computer/windows'&&method==='POST')return json(res,await harness.computer.windows(AbortSignal.timeout(20000)));
   if(p==='/api/computer/release'&&method==='POST'){harness.computer.close();return json(res,{released:true});}
   if(p==='/api/network'&&method==='GET')return json(res,network.get());
   if(p==='/api/network'&&method==='PATCH'){
    const b=await body(req),next=network.change(b.patch,b.expectedRevision);
    if(Object.hasOwn(b.patch,'internetTools')){store.settings={...store.settings,allowNetwork:next.internetTools};store.emit('settings.updated',store.settings);}
    if(next.mode!=='online'){setup.stop();for(const probe of probes.values()){probe.abort?.(new NetworkBlocked());probe.close?.();}mediaFrames.clear();}
    return json(res,{...next,note:'Tepora管理の通信に適用します。OS全体のファイアウォールではありません。独立したアプリ・推論サーバー自身の外部通信は別管理です。'});
   }
   if(p==='/api/providers'&&method==='GET')return json(res,registry.publicSnapshot());
   if(p==='/api/providers'&&method==='PUT'){const b=await body(req);return json(res,registry.save(b.config,b.expectedRevision));}
   const providerAction=p.match(/^\/api\/providers\/([\w-]+)\/(key|probe)$/);
   if(providerAction&&method==='POST'){
    const b=await body(req);if(providerAction[2]==='key')return json(res,registry.setKey(providerAction[1],b.key,b.identity));
    invariant(b.consent===true,'接続試験は短い推論リクエストを使います。',403);
    return json(res,await registry.probe(providerAction[1],AbortSignal.timeout(45000)));
   }
   if(p==='/api/setup/install-help'&&method==='POST'){network.assertUncontained('Open installer page');return json(res,await openInstallerPage());}
   if(p==='/api/setup'&&method==='GET')return json(res,setup.snapshot());
   if(p==='/api/setup/scan'&&method==='POST')return json(res,await setup.scan());
   if(p==='/api/setup/dismiss'&&method==='POST')return json(res,setup.dismiss());
   if(p==='/api/setup/select'&&method==='POST'){const b=await body(req);return json(res,await setup.select(b.candidateId,b));}
   if(p==='/api/setup/install'&&method==='POST'){if(network.get().mode!=='online')throw new NetworkBlocked('制限モードではモデルを取得しません。事前導入済みモデルを利用してください。');return json(res,setup.install(await body(req)),202);}
   if(p==='/api/setup/stop'&&method==='POST')return json(res,setup.stop());
   if(p==='/api/inputs'&&method==='POST'){const b=await body(req);return json(res,{files:stageInputs(store,b.files)},201);}
   const inputDelete=p.match(/^\/api\/inputs\/([^/]+)$/);
   if(inputDelete&&method==='DELETE')return json(res,removeStagedInput(store,inputDelete[1]));
   if(p==='/api/execution'&&method==='GET')return json(res,harness.execution.snapshot());
   if(p==='/api/execution'&&method==='PUT'){const b=await body(req);invariant(harness.active.size===0&&harness.queue.length===0&&harness.toolHub.active.size===0&&!harness.computer.session&&harness.computer.computing.size===0&&connectors.processes.size===0&&!login.rpc&&probes.size===0,'Stop running jobs, host workers and model launchers before changing execution mode',409);const result=harness.execution.configure(b);harness.toolHub.stopDiscovery();login.close();return json(res,result);}
   if(p==='/api/execution/probe'&&method==='POST')return json(res,await harness.execution.probe());
   if(p==='/api/execution/promote'&&method==='POST'){const b=await body(req),job=harness.live(b.jobId);invariant(job,'Task not found',404);return json(res,harness.execution.promote(job,b.candidateId,b));}
   if(p==='/api/execution/reconcile'&&method==='POST'){const b=await body(req);return json(res,harness.execution.reconcile(b.runId,b.disposition));}
   if(p.startsWith('/api/execution/candidates/')&&method==='GET'){const candidate=store.get('execution-candidate',decodeURIComponent(p.slice('/api/execution/candidates/'.length)));invariant(candidate,'Candidate not found',404);return json(res,candidate);}
   if(p==='/api/dialogue'&&method==='GET')return json(res,dialogue.snapshot());
   if(p==='/api/dialogue/context'&&method==='GET')return json(res,dialogue.context());
   if(p==='/api/dialogue/relay'&&method==='GET')return json(res,dialogue.relayPreview(u.searchParams.get('jobId')));
   if(p==='/api/dialogue/relay'&&method==='POST')return json(res,dialogue.relay(await body(req)));
   if(p==='/api/dialogue/personas'&&method==='GET')return json(res,dialogue.personas());
   if(p==='/api/dialogue/personas'&&method==='PUT')return json(res,dialogue.configure(await body(req)));
   if(p==='/api/dialogue'&&method==='POST')return json(res,dialogue.submit(await body(req)),202);
   if(p==='/api/dialogue/reply'&&method==='POST')return json(res,dialogue.reply(await body(req)),202);
   if(p==='/api/companion'&&method==='GET')return json(res,companion.snapshot());
   if(p==='/api/companion/focus'&&method==='POST'){const b=await body(req);return json(res,companion.focus(b.jobId,{expectedRevision:b.expectedRevision,pushReturn:b.pushReturn}));}
   if(p==='/api/companion/return'&&method==='POST'){const b=await body(req);return json(res,companion.back(b.expectedRevision));}
   if(p==='/api/companion/context'&&method==='GET')return json(res,intents.publicContext());
   if(p==='/api/companion/propose'&&method==='POST'){
    invariant(!probes.has('intent'),'対象を判断中です。',429);const cancel=new AbortController();probes.set('intent',cancel);
    try{return json(res,await intents.propose(await body(req),AbortSignal.any([cancel.signal,AbortSignal.timeout(45000)])));}finally{probes.delete('intent');}
   }
   if(p==='/api/companion/submit'&&method==='POST')return json(res,intents.submit(await body(req)),202);
   if(p==='/api/requests/context'&&method==='GET')return json(res,requests.context(u.searchParams.get('engine')||'builtin',u.searchParams.get('role')||'work',u.searchParams.get('targetJobId')));
   if(p==='/api/requests'&&method==='POST')return json(res,requests.submit(await body(req)),202);
   const requestLookup=p.match(/^\/api\/requests\/([a-zA-Z0-9-]+)$/);
   if(requestLookup&&method==='GET')return json(res,requests.get(requestLookup[1]));
   if(p==='/api/codex/check'&&method==='POST'){
    invariant(harness.execution.config().mode==='legacy-host','Codex requires explicit legacy-host mode',403);
    network.assertUncontained('Codex');
    invariant(store.settings.codexEnabled,'Codex requires explicit consent',403);
    invariant(!probes.has('codex'),'Codex connection check is already running',429);
    const c=new CodexAgent({command:store.settings.codexBinary||'codex',cwd:dir});probes.set('codex',c);
    try{return json(res,await c.account(AbortSignal.timeout(20000)));}finally{c.close();probes.delete('codex');}
   }
   if(p==='/api/runtime/probe'&&method==='POST'){
    invariant(!probes.has('model'),'Model probe is already running',429);const cancel=new AbortController();probes.set('model',cancel);
    const settings=store.settings;
    try{
     const runtime=runtimeFactory?runtimeFactory(settings,harness.key):new Runtime(settings,harness.legacyKey(settings),network.fetch({purpose:'model',allowCloud:settings.allowCloud}));
     const result=await probeRuntime(runtime,settings,AbortSignal.any([cancel.signal,AbortSignal.timeout(45000)]));
     store.value('model-probe',result);return json(res,result);
    }finally{probes.delete('model');}
   }
   if(p==='/api/voice/edit'&&method==='POST'){
    const b=await body(req);invariant(store.settings.dictationEditing===true,'Local dictation editing is not enabled',403);
    invariant(!probes.has('dictation'),'Another draft edit is running',429);const cancel=new AbortController();probes.set('dictation',cancel);
    let settings=store.settings;
    try{
     let runtime;
     if(registry.configured){const snapshot=registry.pin('dictation');snapshot.profiles=snapshot.profiles.filter(p=>p.domain==='device');invariant(snapshot.profiles.length,'同一PCの音声編集モデルを設定してください。',409);settings=registry.settingsFor(snapshot);runtime=registry.runtime(snapshot);}
     else runtime=runtimeFactory?runtimeFactory(settings,harness.key):new Runtime(settings,harness.legacyKey(settings),network.fetch({purpose:'model',allowCloud:false}));
     return json(res,await editDictation(runtime,settings,b,AbortSignal.any([cancel.signal,AbortSignal.timeout(12000)])));
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
    return json(res,store.artifact(old.title,b.content,{id:old.id,kind:old.kind,jobId:old.jobId,expectedVersion:b.expectedVersion}));
   }
   if(p==='/api/display' && method==='GET')return json(res,display.get());
   if(p==='/api/display' && method==='PATCH'){const b=await body(req);return json(res,display.change(b.patch,b.expectedRevision));}
   if(p==='/api/display/undo' && method==='POST'){const b=await body(req);return json(res,display.undo(b.expectedRevision));}
   if(p==='/api/display/reset' && method==='POST'){const b=await body(req);return json(res,display.reset(b.expectedRevision));}
   if(p==='/api/display/export' && method==='GET')return json(res,display.export());
   if(p==='/api/display/import' && method==='POST'){const b=await body(req);return json(res,display.import(b.preset,b.expectedRevision));}
   if(p==='/api/doctor' && method==='GET')return json(res,{
    platform:process.platform,arch:process.arch,ramBytes:os.totalmem(),cpuThreads:os.cpus().length,
    configured:{model:!!store.settings.model,decision:!!store.settings.decisionUrl,voice:!!store.settings.asrUrl},
    modelReady:false,lastProbe:store.value('model-probe'),note:'設定の有無であり、実モデル・GPUの動作確認ではありません。',
    dataLocation:dir,workspace:path.join(dir,'workspace','tasks')
   });
   if(p==='/api/shared/scan' && method==='POST') {
    const b=await body(req);invariant(b.consent===true,'Shared asset discovery requires explicit consent',403);
    const found=await discoverSharedSkills();
    for(const skill of found.skills){
     const old=store.get('skill',skill.id);
     store.put('skill',{...skill,enabled:old?.sha256===skill.sha256&&old?.enabled===true});
    }
    return json(res,{...found,skills:store.list('skill')});
   }
   const taskAction=p.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|accept|effects)$/);
   if(taskAction) {
    const [,id,action]=taskAction;
    if(action==='effects'&&method==='GET')return json(res,store.list('effect').filter(e=>e.jobId===id));
    if(method==='POST'){
     if(action==='pause')return json(res,harness.pause(id));
     if(action==='resume')return json(res,harness.resume(id));
     if(action==='accept'){
      const b=await body(req),job=store.get('job',id);
      invariant(job?.status==='review'&&job.revision===b.expectedRevision,'Task changed or is not awaiting review',409);
      invariant(!store.list('execution-candidate').some(c=>c.jobId===id&&c.jobRevision===job.revision&&c.status==='staged'),'Preview and promote staged candidates before accepting this task',409);
      const checkReport=await verifyJob(store,job);
      invariant(checkReport.status!=='checks-failed'||b.acceptUnmet===true,'指定した検査がまだ通っていません。成果物を修正・再検査してください。',409);
      return json(res,harness.update(job,{status:'completed',acceptedAt:new Date().toISOString(),
       verification:{...job.verification,checks:checkReport,status:b.acceptUnmet?'accepted-with-unmet-checks':'accepted-by-user'},note:'確認した結果として保存しました'}));
     }
    }
   }
   const effectAction=p.match(/^\/api\/effects\/([^/]+)\/reconcile$/);
   if(effectAction&&method==='POST'){
    const b=await body(req);return json(res,harness.acknowledgeEffect(decodeURIComponent(effectAction[1]),b.disposition));
   }
   const skillAction=p.match(/^\/api\/skills\/([^/]+)$/);
   if(skillAction&&method==='PATCH'){
    const b=await body(req),skill=store.get('skill',skillAction[1]);
    invariant(skill&&typeof b.enabled==='boolean','Unknown skill or invalid enabled flag');
    const result=store.put('skill',{...skill,enabled:b.enabled});store.emit('skill.updated',result);return json(res,result);
   }
   if(p==='/api/settings' && method==='PATCH') {
    const input=await body(req),previous=store.settings,next=validateSettings(input,previous);
    if('sessionKey'in input)invariant(typeof input.sessionKey==='string'&&input.sessionKey.length<2000,'Invalid key');
    const revoked=['allowCloud','allowNetwork','shareMemory','codexEnabled','codexNetwork'].some(key=>previous[key]&&!next[key]);
    store.settings=next;if(!next.codexEnabled||previous.codexBinary!==next.codexBinary)login.close();
    if(Object.hasOwn(input,'allowNetwork'))network.change({internetTools:next.allowNetwork},network.get().revision);
    if('sessionKey'in input)harness.key=input.sessionKey;
    if(revoked){
     store.value('consent-epoch',(store.value('consent-epoch')||0)+1);routines.pauseAll();for(const plan of store.list('plan'))if(plan.status==='running')plans.pause(plan.id);for(const probe of probes.values())probe.abort?.(new Error('Permissions revoked'));
     for(const job of store.list('job'))if(['queued','running','waiting_approval'].includes(job.status))harness.pause(job.id);
    }
    store.emit('settings.updated',next);return json(res,next);
   }
   if(p==='/api/jobs' && method==='POST') {const b=await body(req);return json(res,harness.submit(b.input,b.kind||'work',{engine:b.engine,checks:b.checks,priority:b.priority}),202);}
   if(p==='/api/stop' && method==='POST'){setup.stop();login.close();harness.toolHub.stopDiscovery();harness.media.stopAll();routines.pauseAll();for(const plan of store.list('plan'))if(plan.status==='running')plans.pause(plan.id);harness.cancelAll();harness.computer.close();for(const rpc of harness.computer.computing)rpc.close();await speech.close();for(const probe of probes.values()){probe.abort?.(new Error('Stopped'));probe.close?.();}return json(res,{stopped:true});}
   let m=p.match(/^\/api\/jobs\/([^/]+)\/(cancel|steer)$/);
   if(m && method==='POST') {if(m[2]==='cancel')return json(res,harness.cancel(m[1]));const b=await body(req);harness.steer(m[1],b.input);return json(res,{accepted:true,applies:'next model step'});}
   if(p==='/api/approvals'&&method==='GET')return json(res,{approvals:harness.approvalList(),presence:harness.approvalPresence()});
   if(p==='/api/approvals'&&method==='POST'){const b=await body(req);invariant(Array.isArray(b.ids)&&b.ids.length>0&&b.ids.length<=50&&b.ids.every(id=>typeof id==='string'&&id.length<=80),'Approval ids are required');invariant(typeof b.allow==='boolean','allow must be boolean');
    return json(res,{results:b.ids.map(id=>{try{harness.approve(id,b.allow);return {id,ok:true};}catch(e){return {id,ok:false,error:safeError(e)};}})});}
   if(p==='/api/presence'&&method==='POST'){const b=await body(req);invariant(['present','away'].includes(b.state),'Invalid presence');store.value('presence',{state:b.state,at:new Date().toISOString()});return json(res,{presence:harness.approvalPresence()});}
   if(p==='/api/character'&&method==='GET')return json(res,{model:characters.get()});
   if(p==='/api/character/model'&&method==='GET'){const {bytes}=await characters.read();res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(bytes);}
   if(p==='/api/character/model'&&method==='PUT'){let filename='';try{filename=decodeURIComponent(String(req.headers['x-tepora-filename']||''));}catch{filename='';}return json(res,await characters.save(await rawBody(req,MAX_VRM_BYTES),{filename}));}
   if(p==='/api/character/model'&&method==='DELETE')return json(res,await characters.remove());
   m=p.match(/^\/api\/approvals\/([^/]+)$/);if(m && method==='POST'){const b=await body(req);invariant(typeof b.allow==='boolean','allow must be boolean');harness.approve(m[1],b.allow);return json(res,{resolved:true});}
   if(p==='/api/runtime/discover' && method==='POST')return json(res,await Promise.all((await import('./runtime.mjs')).PROVIDERS.map(async p=>{try{return {...p,available:true,models:await new Runtime({baseUrl:p.url,allowCloud:false},'',network.fetch({purpose:'model'})).models()};}catch{return {...p,available:false,models:[]};}})));
   if(p==='/api/runtime/check' && method==='POST') {const s=store.settings;return json(res,{models:await new Runtime(s,harness.legacyKey(s),network.fetch({purpose:'model',allowCloud:s.allowCloud})).models()});}
   if(p==='/api/runtime/start' && method==='POST')return json(res,connectors.startRuntime(),202);
   if(p==='/api/memories' && method==='POST') {const b=await body(req);return json(res,store.memory(b.content,{title:typeof b.title==='string'?b.title:'',confirmed:true,scope:b.scope}),201);}
   m=p.match(/^\/api\/memories\/([^/]+)$/);
   if(m && ['PATCH','DELETE'].includes(method)) {const old=store.get('memory',m[1]);invariant(old,'Memory not found',404);if(method==='DELETE'){store.remove('memory',m[1]);store.emit('memory.deleted',{id:m[1]});return json(res,{deleted:true});}const b=await body(req);const value={...old};if('title'in b){invariant(typeof b.title==='string'&&b.title.length<=160,'Invalid memory title');value.title=b.title;}if('content'in b)value.content=text(b.content);if('confirmed'in b){invariant(typeof b.confirmed==='boolean','Invalid confirmed');value.confirmed=b.confirmed;}if('scope'in b){invariant(['shared','private'].includes(b.scope),'Invalid scope');value.scope=b.scope;}store.put('memory',value);store.emit('memory.updated',value);return json(res,value);}
   if(p==='/api/skills' && method==='POST') {const b=await body(req);const doc={id:randomUUID(),name:text(b.name,'name',100),description:text(b.description,'description',300),content:text(b.content,'SKILL.md',32000),createdAt:new Date().toISOString()};store.put('skill',doc);store.emit('skill.updated',doc);return json(res,doc,201);}
   m=p.match(/^\/api\/skills\/([^/]+)$/);if(m && method==='DELETE'){store.remove('skill',m[1]);store.emit('skill.deleted',{id:m[1]});return json(res,{deleted:true});}
   if(p==='/api/mcp' && method==='POST') {
    const b=await body(req);invariant(['stdio','http'].includes(b.transport),'Use stdio or http');const doc={id:randomUUID(),name:text(b.name,'name',100),transport:b.transport,enabled:b.enabled===true};
    if(b.transport==='stdio'){doc.command=text(b.command,'command',2000);invariant(Array.isArray(b.args)&&b.args.length<50&&b.args.every(a=>typeof a==='string'&&a.length<2000),'Invalid arguments');doc.args=b.args;}
    else {doc.url=endpoint(b.url,store.settings.allowNetwork).href;doc.apiKeyEnv=typeof b.apiKeyEnv==='string'?b.apiKeyEnv:'';invariant(!doc.apiKeyEnv||/^[A-Z_][A-Z0-9_]*$/.test(doc.apiKeyEnv),'Invalid env name');}
    store.put('mcp',doc);store.emit('mcp.updated',doc);return json(res,doc,201);
   }
   m=p.match(/^\/api\/mcp\/([^/]+)$/);if(m && ['PATCH','DELETE'].includes(method)){const d=store.get('mcp',m[1]);invariant(d,'MCP config not found',404);if(method==='DELETE'){harness.toolHub.revoke(d.id);store.remove('mcp',d.id);store.emit('mcp.deleted',{id:d.id});return json(res,{deleted:true});}const b=await body(req);invariant(typeof b.enabled==='boolean','Invalid enabled');if(!b.enabled)harness.toolHub.revoke(d.id);d.enabled=b.enabled;store.put('mcp',d);store.emit('mcp.updated',d);return json(res,d);}
   if(p==='/api/connector/weather' && method==='POST')return json(res,await connectors.weather());
   if(p==='/api/connector/news' && method==='POST')return json(res,await connectors.news());
   if(p==='/api/media/open' && method==='POST'){const b=await body(req);return json(res,await connectors.openMedia(b.url));}
   if(p==='/api/voice/transcribe' && method==='POST')return json(res,await connectors.transcribe(await body(req,true)));
   if(p==='/api/context/export' && method==='GET'){res.setHeader('Content-Disposition','attachment; filename="tepora-context.json"');return json(res,store.export());}
   if(p==='/api/context/import' && method==='POST')return json(res,store.import(await body(req)));
   if(p==='/api/artifacts' && method==='GET')return json(res,store.list('artifact'));
   if(p.startsWith('/api/'))return json(res,{error:'Unknown endpoint or HTTP method'},404);
   invariant(['GET','HEAD'].includes(method),'Method not allowed',405);
   const allowed=['/','/index.html','/styles.css','/app.mjs','/ui.mjs','/bridge.mjs','/voice.mjs','/draft.mjs','/realtime-voice.mjs','/onboarding.mjs','/provider-settings.mjs','/capability-ui.mjs','/pcm-worklet.js','/display-model.mjs','/demo.mjs','/favicon.svg','/vrm-stage.mjs',...VENDOR_FILES.map(f=>'/vendor/'+f)];invariant(allowed.includes(p),'Not found',404);
   const file=path.join(webDir,p==='/'?'index.html':p.slice(1));const data=await readFile(file);
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
   res.writeHead(200,{'Content-Type':TYPES[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:data);
  }catch(e){if(res.headersSent){res.end();return;}json(res,{error:safeError(e),...(e.blocked?{blocked:true}:{})},e.status||500);}
 });
 server.requestTimeout=150000;server.headersTimeout=15000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
 const launchUrl=`${origin}/launch?token=${secret}`;
 const close=async()=>{if(closing)return;closing=true;dialogue.close();routines.close();plans.close();for(const probe of probes.values()){probe.abort?.(new Error('Service stopping'));probe.close?.();}login.close();network.listeners.delete(loginPolicy);harness.close();await harness.media.close();harness.capabilities.close();connectors.close();await setup.close();await speech.close();for(const res of streams)res.end();for(let i=0;i<30&&harness.active.size;i++)await new Promise(r=>setTimeout(r,20));network.close();registry.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();};
 return {server,store,network,registry,catalog,login,harness,connectors,setup,requests,companion,intents,dialogue,routines,plans,origin,launchUrl,close};
}
const isMain=process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isMain){const app=await startServer({port:Number(process.env.TEPORA_PORT||0)});console.log(JSON.stringify({type:'ready',url:app.launchUrl,version:'3.0.0-beta.11'}));if(process.argv.includes('--open')){const [exe,args]=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',app.launchUrl]]:process.platform==='darwin'?['open',[app.launchUrl]]:['xdg-open',[app.launchUrl]];const p=spawn(exe,args,{stdio:'ignore',shell:false});p.on('error',()=>console.error('Open the URL printed above in a browser.'));}if(process.argv.includes('--sidecar')){process.stdin.setEncoding('utf8');let stdinBuffer='';process.stdin.on('data',chunk=>{
 stdinBuffer=(stdinBuffer+chunk).slice(-4096);let end;
 while((end=stdinBuffer.indexOf('\n'))>=0){const command=stdinBuffer.slice(0,end).trim();stdinBuffer=stdinBuffer.slice(end+1);
  if(command==='shutdown')app.close().then(()=>process.exit(0));
  else if(command==='stop'){app.routines.pauseAll();for(const p of app.store.list('plan'))if(p.status==='running')app.plans.pause(p.id);app.harness.cancelAll();}
 }});process.stdin.on('end',()=>app.close().then(()=>process.exit(0)));}for(const name of ['SIGINT','SIGTERM'])process.once(name,()=>app.close().then(()=>process.exit(0)));}
