import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {invariant} from '../policy.mjs';

/** Desktop apps through each OS's accessibility layer, behind one JSON-lines helper protocol
 * (desktop-contract.json): macOS uses a small Swift helper (Accessibility API) compiled on first use with the
 * Xcode Command Line Tools; Windows (UI Automation + SendInput) and Linux X11 (AT-SPI2 + XTest) use the Rust
 * tepora-desktop-helper, shipped next to the app or built from desktop-helper/ on first use. The helper stays
 * running; requests and replies are JSON lines. */
const SOURCE=fileURLToPath(new URL('./ax-helper.swift',import.meta.url));
const CRATE=fileURLToPath(new URL('../../desktop-helper/',import.meta.url));
const BACKENDS={
 darwin:{id:'macos',label:'macOS Accessibility'},
 win32:{id:'windows',label:'Windows UI Automation'},
 linux:{id:'linux-x11',label:'Linux X11 (AT-SPI)'},
};
const REASONS={
 wayland:'Desktop apps cannot be operated in a Wayland session yet (it needs the desktop portals). Sign in to an X11 session ("GNOME on Xorg" or similar) to use them.',
 'no-display':'No X11 display (DISPLAY is not set), so desktop apps cannot be operated here.',
 platform:'Desktop apps cannot be operated on this operating system.',
 helper:'The desktop helper source is missing from this installation.',
};
/** Which desktop backend this computer uses, and why there is none when there is none. Linux works in X11
 * sessions only; Wayland is reported unsupported (not an error), like the helper does. */
export function desktopBackend(platform=process.platform,env=process.env){
 const base=BACKENDS[platform],has=k=>typeof env?.[k]==='string'&&env[k]!=='';
 let reason='';
 if(!base)reason='platform';
 else if(platform==='darwin'&&!existsSync(SOURCE))reason='helper';
 else if(platform==='linux'&&(String(env?.XDG_SESSION_TYPE||'').toLowerCase()==='wayland'||has('WAYLAND_DISPLAY')&&!has('DISPLAY')))reason='wayland';
 else if(platform==='linux'&&!has('DISPLAY'))reason='no-display';
 return {id:base?.id||'unsupported',label:base?.label||'',supported:!reason,reason,message:reason?REASONS[reason]:''};
}
export const desktopSupported=(platform=process.platform,env=process.env)=>desktopBackend(platform,env).supported;
const helperFile=platform=>platform==='win32'?'tepora-desktop-helper.exe':'tepora-desktop-helper';
/** Where a prebuilt Rust helper may be: next to the bundled runtime (packaged app), then a local cargo build. */
export function helperCandidates(platform=process.platform,{execPath=process.execPath,crate=CRATE}={}){
 const file=helperFile(platform);
 return [path.join(path.dirname(execPath),file),path.join(crate,'target','release',file),path.join(crate,'target','debug',file)];
}
/** Status in one shape for every backend: macOS reports {trusted,screen}; the Rust helper reports
 * {backend,accessibility,input,capture,problem}. */
export function normalStatus(raw,backend){
 const r=raw&&typeof raw==='object'?raw:{};
 const accessibility=typeof r.accessibility==='boolean'?r.accessibility:!!r.trusted,capture=typeof r.capture==='boolean'?r.capture:!!r.screen;
 return {backend:r.backend||backend.id,accessibility,capture,input:typeof r.input==='boolean'?r.input:accessibility,problem:r.problem||null,trusted:accessibility,screen:capture};
}
const run=(file,args,opts={})=>new Promise((resolve,reject)=>execFile(file,args,{timeout:300000,...opts},(e,out,err)=>e?reject(Object.assign(e,{stderr:String(err||'')})):resolve(out)));
export class Desktop{
 /** command: [file, ...args] of a helper to run instead of locating one (tests). */
 constructor({binDir,platform=process.platform,env=process.env,command=null}){this.binDir=binDir;this.platform=platform;this.backend=desktopBackend(platform,env);this.command=command;this.proc=null;this.pending=new Map();this.id=0;this.targets=new Map();this.building=null;}
 get alive(){return !!this.proc&&this.proc.exitCode===null;}
 /** A signal belongs to one invocation, never to the shared desktop helper. */
 withSignal(signal){return new Proxy(this,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return typeof value==='function'?async(...args)=>{signal?.throwIfAborted();const result=await value.apply(receiver,args);signal?.throwIfAborted();return result;}:value;}});}
 /** The helper to run: on macOS built when it is missing or its source changed; elsewhere the Rust helper. */
 async binary(){
  if(this.platform!=='darwin')return this.rustHelper();
  const src=readFileSync(SOURCE),hash=createHash('sha256').update(src).digest('hex').slice(0,16),bin=path.join(this.binDir,'tepora-ax'),stamp=bin+'.sha';
  if(existsSync(bin)&&existsSync(stamp)&&readFileSync(stamp,'utf8')===hash)return bin;
  if(this.building)return this.building;
  this.building=(async()=>{
   mkdirSync(this.binDir,{recursive:true});
   try{await run('/usr/bin/xcrun',['swiftc','-O','-module-cache-path',path.join(this.binDir,'swift-cache'),SOURCE,'-o',bin]);}
   catch(e){throw new Error(/xcrun|No such file|invalid active developer path/i.test(e.message+e.stderr)?'Operating desktop apps needs the Xcode Command Line Tools. Install them with: xcode-select --install':`Building the desktop helper failed: ${String(e.stderr||e.message).slice(0,400)}`);}
   writeFileSync(stamp,hash);return bin;
  })();
  try{return await this.building;}finally{this.building=null;}
 }
 /** A prebuilt Rust helper, or one built from desktop-helper/ with cargo the first time (like swiftc on macOS). */
 async rustHelper(){
  const found=helperCandidates(this.platform).find(f=>existsSync(f));if(found)return found;
  const manifest=path.join(CRATE,'Cargo.toml');
  if(!existsSync(manifest))throw new Error('The desktop helper (tepora-desktop-helper) is missing from this installation.');
  if(this.building)return this.building;
  this.building=(async()=>{
   try{await run(process.env.CARGO||'cargo',['build','--release','--locked','--manifest-path',manifest],{timeout:900000});}
   catch(e){throw new Error(/ENOENT/.test(e.code||e.message)?'Operating desktop apps needs the desktop helper. Build it once with: npm run build:desktop-helper (needs the Rust toolchain).':`Building the desktop helper failed: ${String(e.stderr||e.message).slice(-400)}`);}
   return helperCandidates(this.platform)[1];
  })();
  try{return await this.building;}finally{this.building=null;}
 }
 async start(){
  if(this.alive)return;
  invariant(this.command||this.backend.supported,this.backend.message||'Desktop apps cannot be operated here.',409);
  const [bin,...args]=this.command||[await this.binary()];
  this.proc=spawn(bin,args,{stdio:['pipe','pipe','ignore'],windowsHide:true});
  readline.createInterface({input:this.proc.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m.result):p.reject(new Error(m.error||'Desktop helper error'));});
  this.proc.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('The desktop helper stopped'));}this.pending.clear();});
 }
 async call(cmd,params={},timeoutMs=20000){
  await this.start();
  const id=++this.id;this.proc.stdin.write(JSON.stringify({id,cmd,...params})+'\n');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(this.pending.delete(id))reject(new Error(`The desktop helper did not answer ${cmd}`));},timeoutMs);this.pending.set(id,{resolve,reject,timer});});
 }
 async status(){return normalStatus(await this.call('status'),this.backend);}
 async windows(){return (await this.call('windows')).windows;}
 /** The app a session works in: by name or pid, remembered until another is named. */
 async target(sessionId,app,window){
  if(!app){const t=this.targets.get(sessionId);invariant(t,'Name the app to operate (app: name or pid). action "windows" lists them.');return window?{...t,window}:t;}
  const list=await this.windows(),key=String(app).toLowerCase();
  const hit=/^\d+$/.test(key)?list.find(w=>w.pid===Number(key)):list.find(w=>w.app.toLowerCase()===key)||list.find(w=>w.app.toLowerCase().includes(key));
  invariant(hit,`No open window of "${app}". Open it with action "open" (app name), then observe.`,404);
  const t={pid:hit.pid,app:hit.app,window:window||''};this.targets.set(sessionId,t);return t;
 }
 async observe(t){const r=await this.call('observe',{pid:t.pid,title:t.window||''},30000);return {...r,app:t.app};}
 matches(t,checks){return this.call('matches',{pid:t.pid,checks});}
 press(t,ref,{x,y}={}){return ref?this.call('press',{pid:t.pid,ref}):this.call('click',{pid:t.pid,x,y,title:t.window||''});}
 setText(t,ref,text){return ref?this.call('setText',{pid:t.pid,ref,text}):this.call('type',{pid:t.pid,text});}
 choose(t,ref,option){return this.call('choose',{pid:t.pid,ref,option});}
 key(t,combo){return this.call('key',{pid:t.pid,combo});}
 scroll(t,ref,dy,dx=0){return this.call('scroll',{pid:t.pid,ref:ref||'',dy,dx});}
 /** Window coordinates, like click. */
 drag(t,from,to){return this.call('drag',{pid:t.pid,x:from.x,y:from.y,toX:to.x,toY:to.y,title:t.window||''});}
 async screenshot(t){const r=await this.call('screenshot',{pid:t.pid,title:t.window||''},30000);return {mime:'image/jpeg',base64:r.base64,width:r.width,height:r.height};}
 /** macOS: /usr/bin/open. Windows/Linux: the helper (ShellExecute, or .desktop entries and xdg-open for http(s)). */
 async open(what){
  if(this.platform==='darwin')return void await run('/usr/bin/open',/^[a-z]+:\/\//i.test(what)?[what]:['-a',what]);
  await this.call('open',{what:String(what)},30000);
 }
 async openedTarget(sessionId,app,window,{signal,timeoutMs=10000}={}){
  const until=Date.now()+timeoutMs;
  for(;;){
   signal?.throwIfAborted();
   try{
    if(app)return await this.target(sessionId,app,window);
    const front=(await this.windows()).find(w=>w.active);if(front)return await this.target(sessionId,String(front.pid),window);
   }catch(e){if(e.status!==404)throw e;}
   if(Date.now()>=until)throw new Error(`No window appeared after opening ${app||'the URL'}.`);
   await delay(200,undefined,{signal});
  }
 }
 settle(){return new Promise(r=>setTimeout(r,400));}
 forget(sessionId){this.targets.delete(sessionId);}
 close(){if(this.alive)this.proc.kill();this.proc=null;}
}
