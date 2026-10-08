import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {spawnSandboxed,loginShellPath,userShell} from '../sandbox.mjs';
import {invariant} from '../policy.mjs';

const ANSI=/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]/g;
/** What a terminal would show: a carriage return rewrites its line (progress bars), and runs of the
 * same line collapse into one with a count. */
export function terminalText(raw){
 const out=[];let prev=null,runs=0;
 const close=()=>{if(runs>1)out.push(`… (line above repeated ${runs-1} more time${runs>2?'s':''})`);runs=0;};
 for(let line of String(raw).replace(/\r+\n/g,'\n').split('\n')){
  if(line.includes('\r')){const parts=line.split('\r');line=parts.findLast(x=>x.length)??'';}
  if(line===prev&&line.trim()){runs++;continue;}
  close();out.push(line);prev=line;runs=1;
 }
 close();return out.join('\n');
}
const HEAD=200_000,TAIL=800_000;
/** Commands that outlive a model turn keep running here; the agent polls them instead of blocking. */
export class ProcessManager{
 constructor(){this.items=new Map();}
 start(command,{sessionId,cwd,policy,env={},stdin}){
  const id='p'+randomUUID().slice(0,8),containerName=policy?.mode==='container'?'tepora-'+id:null;
  mkdirSync(cwd,{recursive:true});
  const child=spawnSandboxed(command,{cwd,policy,containerName,env:{...process.env,PATH:loginShellPath(),...env,TEPORA_SESSION:sessionId||''}});
  const item={id,sessionId,command,cwd,child,sandbox:child.plan.sandbox,containerName,startedAt:Date.now(),endedAt:null,exitCode:null,signal:null,status:'running',head:'',tail:'',dropped:0,total:0,cursor:0,waiters:new Set()};
  // One decoder per stream: a multi-byte character split across two chunks must not become U+FFFD.
  const out=new StringDecoder('utf8'),err=new StringDecoder('utf8');
  const take=raw=>{
   const text=raw.replace(ANSI,'');if(!text)return;item.total+=text.length;
   if(item.head.length<HEAD){const room=HEAD-item.head.length;item.head+=text.slice(0,room);if(text.length>room)item.tail+=text.slice(room);}else item.tail+=text;
   if(item.tail.length>TAIL){const cut=item.tail.length-TAIL;item.tail=item.tail.slice(cut);item.dropped+=cut;}
   for(const w of item.waiters)w();
  };
  child.stdout.on('data',c=>take(out.write(c)));child.stderr.on('data',c=>take(err.write(c)));child.stdin.on('error',()=>{});
  child.on('error',e=>{take(`\n[failed to start: ${e.message}]\n`);finish(127,null);});
  const finish=(code,sig)=>{if(item.status!=='running')return;take(out.end()+err.end());item.status=item.killed?'killed':'exited';item.exitCode=code;item.signal=sig;item.endedAt=Date.now();for(const w of item.waiters)w();};
  child.on('close',finish);
  if(typeof stdin==='string'){child.stdin.write(stdin);child.stdin.end();}
  this.items.set(id,item);return item;
 }
 get(id,sessionId){const item=this.items.get(id);invariant(item&&(!sessionId||item.sessionId===sessionId),`プロセス ${id} が見つかりません。`,404);return item;}
 output(item,from=0){
  const headEnd=item.head.length,tailStart=item.total-item.tail.length;
  if(from<headEnd)return item.head.slice(from)+(item.dropped?`\n…[${item.dropped} characters dropped]…\n`:'')+item.tail;
  return item.tail.slice(Math.max(0,from-tailStart));
 }
 /** Resolves when the process ends or `ms` passes, whichever is first. */
 wait(item,ms,signal,{output=false}={}){
  if(item.status!=='running')return Promise.resolve(true);
  const seen=item.total;
  return new Promise(resolve=>{
   const done=()=>{clearTimeout(t);item.waiters.delete(check);signal?.removeEventListener('abort',stop);resolve(item.status!=='running');};
   const check=()=>{if(item.status!=='running'||output&&item.total>seen)done();};const stop=()=>done();
   const t=setTimeout(done,ms);item.waiters.add(check);signal?.addEventListener('abort',stop,{once:true});
  });
 }
 kill(item){
  if(item.status!=='running')return;item.killed=true;
  const pid=item.child.pid;
  if(process.platform==='win32'){spawn('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});}
  else{try{process.kill(-pid,'SIGTERM');}catch{try{item.child.kill('SIGTERM');}catch{}}setTimeout(()=>{if(item.status==='running'){try{process.kill(-pid,'SIGKILL');}catch{try{item.child.kill('SIGKILL');}catch{}}}},3000).unref?.();}
  if(item.containerName){const engine=item.child.plan.file;spawn(engine,['kill',item.containerName],{stdio:'ignore'}).on('error',()=>{});}
 }
 list(sessionId){return [...this.items.values()].filter(i=>!sessionId||i.sessionId===sessionId).map(view);}
 killSession(sessionId){for(const i of this.items.values())if(i.sessionId===sessionId)this.kill(i);}
 close(){for(const i of this.items.values())this.kill(i);}
}
const view=i=>({id:i.id,command:i.command,status:i.status,exitCode:i.exitCode,cwd:i.cwd,sandbox:i.sandbox,runningForMs:(i.endedAt||Date.now())-i.startedAt,outputChars:i.total});
function report(item,raw,{waitedMs}={}){
 const text=terminalText(raw);
 const head=item.status==='running'?`still running as process ${item.id} after ${Math.round(waitedMs/1000)} s (use process poll/kill)`:`exit ${item.exitCode??'?'}${item.signal?' ('+item.signal+')':''}${item.status==='killed'?' (killed)':''} · ${((item.endedAt-item.startedAt)/1000).toFixed(1)} s`;
 return `${head}${item.sandbox!=='off'?` · sandbox ${item.sandbox}`:''}\n${text||'(no output)'}`;
}
const quote=s=>`'${String(s).replace(/'/g,`'\\''`)}'`;
/** Gives a command a pseudo-terminal (programs that insist on a terminal: interactive prompts, REPLs, some
 * installers); its prompts are answered with process write. Python's pty module accepts a pipe as its own input,
 * which BSD `script` on macOS does not; `script` remains the fallback on Linux without Python. */
const PTY=`import os,pty,sys;sys.exit(os.waitstatus_to_exitcode(pty.spawn(['/bin/sh','-c',sys.argv[1]])))`;
export function withTTY(command){
 if(process.platform==='win32')throw new Error('A pseudo-terminal is available on macOS and Linux only.');
 return `if command -v python3 >/dev/null 2>&1; then exec python3 -c ${quote(PTY)} ${quote(command)}; else exec script -qec ${quote(command)} /dev/null; fi`;
}
export function execTools({processes,settings}){
 const resolveCwd=(ctx,cwd)=>cwd?path.resolve(ctx.cwd,cwd):ctx.cwd;
 return [{
  name:'exec',group:'core',
  description:'Run a shell command on this computer and return its output. Use for files, git, builds, tests, scripts, package managers, system tools. Commands still running after `yield` seconds (default 20) continue in the background and return a process id: check them with process(action:"poll"). Use background:true for servers/watchers. Runs in the working directory unless cwd is given.',
  parameters:{type:'object',additionalProperties:false,required:['command'],properties:{
   command:{type:'string',description:'Shell command line ('+userShell().name+').'},
   cwd:{type:'string',description:'Working directory (absolute, or relative to the session folder).'},
   yield:{type:'integer',minimum:0,maximum:600,description:'Seconds to wait before backgrounding (default 20).'},
   background:{type:'boolean',description:'Start in the background and return immediately.'},
   timeout:{type:'integer',minimum:1,maximum:86400,description:'Kill after this many seconds (default 3600).'},
   stdin:{type:'string',description:'Text written to standard input, then closed.'},
   tty:{type:'boolean',description:'Run in a pseudo-terminal, for programs that need one (interactive prompts, REPLs). Answer their prompts with process write.'}}},
  summarize:a=>`exec ${JSON.stringify(String(a.command||'').slice(0,80))}`,
  async run(a,ctx){
   const policy=ctx.sandbox||settings?.().sandbox;
   const item=processes.start(a.tty?withTTY(a.command):a.command,{sessionId:ctx.session.id,cwd:resolveCwd(ctx,a.cwd),policy,stdin:a.tty?undefined:a.stdin});
   if(a.tty&&typeof a.stdin==='string')item.child.stdin.write(a.stdin);
   const limit=setTimeout(()=>processes.kill(item),(a.timeout||3600)*1000);limit.unref?.();item.child.on('close',()=>clearTimeout(limit));
   const waitMs=a.background?300:(a.yield??20)*1000;
   const abort=()=>processes.kill(item);ctx.signal?.addEventListener('abort',abort,{once:true});
   const finished=await processes.wait(item,waitMs,ctx.signal);
   ctx.signal?.removeEventListener('abort',abort);
   const text=processes.output(item,0);if(!finished)item.cursor=item.total;
   return {text:report(item,text,{waitedMs:waitMs}),data:{processId:item.status==='running'?item.id:null,exitCode:item.exitCode}};
  },
  stub:(a,r)=>`exec ${JSON.stringify(String(a.command||'').slice(0,70))} → ${r?.data?.processId?'running '+r.data.processId:'exit '+(r?.data?.exitCode??'?')}`
 },{
  name:'process',group:'core',ephemeral:true,
  description:'Manage background processes started by exec: list, poll (new output since the last poll and status), log (output from an offset), write (send stdin text), kill.',
  parameters:{type:'object',additionalProperties:false,required:['action'],properties:{
   action:{type:'string',enum:['list','poll','log','write','kill']},id:{type:'string'},
   wait:{type:'integer',minimum:0,maximum:300,description:'poll: seconds to wait for more output or exit (default 5).'},
   input:{type:'string',description:'write: text to send (a newline is not added).'},
   offset:{type:'integer',minimum:0},close:{type:'boolean',description:'write: close stdin afterwards.'}}},
  ephemeralKey:a=>'process:'+(a.id||'list'),
  async run(a,ctx){
   if(a.action==='list')return {text:JSON.stringify(processes.list(ctx.session.id),null,1)};
   const item=processes.get(String(a.id||''),ctx.session.id);
   if(a.action==='kill'){processes.kill(item);await processes.wait(item,4000,ctx.signal);return {text:report(item,processes.output(item,item.cursor))};}
   if(a.action==='write'){invariant(item.status==='running','The process has already exited.',409);item.child.stdin.write(a.input||'');if(a.close)item.child.stdin.end();await processes.wait(item,500,ctx.signal);}
   if(a.action==='log')return {text:report(item,processes.output(item,a.offset||0))};
   if(a.action==='poll'&&item.status==='running'&&item.total===item.cursor){await processes.wait(item,(a.wait??5)*1000,ctx.signal,{output:true});await processes.wait(item,300,ctx.signal);}
   const text=processes.output(item,item.cursor);item.cursor=item.total;
   return {text:report(item,text,{waitedMs:Date.now()-item.startedAt})};
  }
 }];
}
