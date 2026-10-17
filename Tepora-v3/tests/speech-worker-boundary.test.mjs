/** Exercise the shipped Python HTTP parser through the real Node voice routes.
 * Only the inference backend is synthetic; no models or external services run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../core/server.mjs';
import {serviceCleanup} from './helpers/service-cleanup.mjs';

const workers=fileURLToPath(new URL('../workers',import.meta.url));
const workerScript=String.raw`
import faulthandler, json, sys, threading, time, types
sys.stdout.reconfigure(encoding="utf-8")
faulthandler.dump_traceback_later(5)
started = time.monotonic()
print(json.dumps({"event": "phase", "phase": "import", "executable": sys.executable}), flush=True)
sys.path.insert(0, sys.argv[1])
import speech_server
output_lock = threading.Lock()
def emit(**value):
    with output_lock:
        print(json.dumps(value, ensure_ascii=False), flush=True)
counter = 0
def next_id():
    global counter
    counter += 1
    # An opaque worker session ID may contain non-ASCII text. Exercise byte,
    # rather than JavaScript string, length without changing the HTTP parser.
    value = "日本語🌿-" + str(counter)
    emit(event="session", id=value)
    return types.SimpleNamespace(hex=value)
speech_server.uuid.uuid4 = next_id
holding = False
class Backend:
    def start(self):
        return {"cancelled": threading.Event()}
    def start_duplex(self):
        return self.start()
    def chunk(self, samples, state):
        emit(event="chunk", samples=len(samples), held=holding)
        if holding and not state["cancelled"].wait(10):
            raise RuntimeError("Fixture cancellation was not delivered")
        return "途中の音声🌿"
    def detection(self, state):
        return True
    def finish(self, state):
        return "確定した音声🌿"
    def cancel(self, state):
        state["cancelled"].set()
        emit(event="cancelled")
emit(event="phase", phase="bind", elapsed_ms=round((time.monotonic() - started) * 1000))
server = speech_server.make_server(Backend(), token="synthetic-worker-token")
faulthandler.cancel_dump_traceback_later()
class ObservedHandler(server.RequestHandlerClass):
    def do_POST(self):
        emit(event="request", route=self.path,
             length=self.headers.get("Content-Length"),
             transfer=self.headers.get("Transfer-Encoding"))
        super().do_POST()
    def reply(self, status, value):
        emit(event="reply", route=self.path, status=status)
        super().reply(status, value)
server.RequestHandlerClass = ObservedHandler
def commands():
    global holding
    for line in sys.stdin:
        if line.strip() == "hold":
            holding = True
            emit(event="holding")
        elif line.strip() == "shutdown":
            server.shutdown()
            return
threading.Thread(target=commands, daemon=True).start()
emit(event="ready", port=server.server_port)
try:
    server.serve_forever(poll_interval=0.02)
finally:
    server.server_close()
`;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(fn,label){
 for(let i=0;i<400;i++){const value=fn();if(value)return value;await pause(25);}
 throw new Error('Timed out: '+label);
}
const pcm=count=>Buffer.alloc(count*4).toString('base64');
const startRoute=mode=>'/api/voice/'+(mode==='asr'?'start':mode+'/start');
async function fixture(t){
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-python-speech-')));
 const previous={wake:process.env.TEPORA_WAKE_URL,token:process.env.TEPORA_SPEECH_TOKEN};
 const child=spawn(process.env.PYTHON||(process.platform==='win32'?'python':'python3'),['-I','-S','-u','-c',workerScript,workers],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 const events=[];let stderr='',exit,spawnError,app;
 child.stderr.on('data',value=>{stderr=(stderr+value).slice(-12000);});
 child.on('error',error=>{spawnError=error;});child.stdin.on('error',()=>{});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);}));
 const lines=createInterface({input:child.stdout});lines.on('line',line=>events.push(JSON.parse(line)));
 cleanup.service({close:async()=>{
  try{await app?.close();}finally{
   try{
    if(!exit&&!spawnError){child.stdin.write('shutdown\n');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{assert.equal((await exited).code,0,stderr);}finally{clearTimeout(timer);}}
   }finally{
    lines.close();
    for(const [name,value] of [['TEPORA_WAKE_URL',previous.wake],['TEPORA_SPEECH_TOKEN',previous.token]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}
   }
  }
 }});
 const ready=await wait(()=>{if(spawnError)throw spawnError;if(exit)throw new Error('Python worker exited');return events.find(e=>e.event==='ready');},'bundled Python worker readiness').catch(error=>{
  const diagnostic={phases:events.filter(e=>e.event==='phase'),exit,stderr:stderr.slice(-4000)};
  throw new Error(error.message+'\nWorker startup diagnostics: '+JSON.stringify(diagnostic),{cause:error});
 });
 const workerOrigin=`http://127.0.0.1:${ready.port}`;
 process.env.TEPORA_WAKE_URL=workerOrigin;process.env.TEPORA_SPEECH_TOKEN='synthetic-worker-token';
 app=await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})});
 const launch=await fetch(app.launchUrl,{redirect:'manual'});assert.equal(launch.status,303);
 const origin=new URL(app.launchUrl).origin,cookie=launch.headers.get('set-cookie').split(';')[0];
 const bootstrap=await (await fetch(origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const request=(route,body,headers={})=>fetch(origin+route,{method:'POST',headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
 const json=async(route,body,status=200)=>{const response=await request(route,body),value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
 const settings=await fetch(origin+'/api/settings',{method:'PATCH',headers:{Cookie:cookie,'X-Tepora-CSRF':bootstrap.csrf},body:JSON.stringify({voiceEnabled:true,asrStreamUrl:workerOrigin})});assert.equal(settings.status,200);
 const framing=(route,body)=>{
  const last=events.filter(e=>e.event==='request').at(-1);
  assert.deepEqual(last,{event:'request',route,length:String(Buffer.byteLength(JSON.stringify(body),'utf8')),transfer:null});
 };
 const effects=async()=>{const response=await fetch(origin+'/api/agent',{headers:{Cookie:cookie}});assert.equal(response.status,200);const {dialogue,jobs}=await response.json();return {dialogue,jobs};};
 return {events,child,request,json,framing,effects,upstreamId:()=>events.filter(e=>e.event==='session').at(-1).id};
}

test('Node voice routes use the bundled Python parser with UTF-8 framing and worker auth',{timeout:60000},async t=>{
 const f=await fixture(t),beforeEffects=await f.effects();
 for(const mode of ['asr','wake','barge']){
  const before=f.events.length;
  assert.equal((await f.request(startRoute(mode),undefined,{Cookie:''})).status,401);
  assert.equal((await f.request(startRoute(mode),undefined,{'X-Tepora-CSRF':''})).status,403);
  assert.equal(f.events.length,before,'unauthenticated UI requests never reach the worker');
  process.env.TEPORA_SPEECH_TOKEN='synthetic-wrong-token';
  const denied=await f.json(startRoute(mode),undefined,502);assert.match(denied.error,/HTTP 401/);
  assert.equal(f.events.filter(e=>e.event==='reply').at(-1).status,401);
  process.env.TEPORA_SPEECH_TOKEN='synthetic-worker-token';
  const session=await f.json(startRoute(mode));
  f.framing('/api/start',{sample_rate:16000,...(mode==='barge'?{channels:2}:{})});
  const session_id=f.upstreamId(),body={id:session.id,sequence:0,pcm:pcm(mode==='barge'?6400:3200)};
  assert.ok(Buffer.byteLength(session_id)>session_id.length,'fixture exercises non-ASCII request bytes');
  const partial=await f.json('/api/voice/chunk',body);
  assert.equal(partial.text,'途中の音声🌿');assert.equal(partial.detected,mode==='asr'?undefined:true);
  f.framing('/api/chunk',{session_id,sequence:0,pcm:body.pcm});
  assert.equal(f.events.filter(e=>e.event==='chunk').at(-1).samples,mode==='barge'?6400:3200);
  const count=f.events.length;assert.deepEqual(await f.json('/api/voice/chunk',body),partial);assert.equal(f.events.length,count);
  const final=await f.json('/api/voice/finish',{id:session.id});assert.equal(final.text,'確定した音声🌿');assert.equal(final.submitted,false);
  f.framing('/api/finish',{session_id});
  const next=await f.json(startRoute(mode)),nextId=f.upstreamId();
  assert.deepEqual(await f.json('/api/voice/cancel',{id:next.id}),{cancelled:true});
  f.framing('/api/cancel',{session_id:nextId});
  await f.json('/api/voice/finish',{id:next.id},409);
 }
 assert.deepEqual(await f.effects(),beforeEffects,'worker transcripts never submit dialogue or jobs');
});

test('Node cancel and Stop release real Python sessions while a chunk is pending',{timeout:60000},async t=>{
 const f=await fixture(t),beforeEffects=await f.effects();
 f.child.stdin.write('hold\n');await wait(()=>f.events.some(e=>e.event==='holding'),'held backend enabled');
 for(const mode of ['asr','wake','barge'])for(const stop of ['cancel','stop']){
  const session=await f.json(startRoute(mode)),session_id=f.upstreamId(),count=f.events.filter(e=>e.event==='chunk').length;
  const pending=f.request('/api/voice/chunk',{id:session.id,sequence:0,pcm:pcm(mode==='barge'?6400:3200)}).then(async response=>({status:response.status,body:await response.json()}));
  await wait(()=>f.events.filter(e=>e.event==='chunk').length===count+1,'real Python parser entered held backend');
  await f.json(stop==='cancel'?'/api/voice/cancel':'/api/stop',stop==='cancel'?{id:session.id}:{});
  assert.equal((await pending).status,499);f.framing('/api/cancel',{session_id});
  const next=await f.json('/api/voice/start');await f.json('/api/voice/cancel',{id:next.id});
 }
 assert.deepEqual(await f.effects(),beforeEffects,'late worker results cannot submit dialogue or jobs');
});
