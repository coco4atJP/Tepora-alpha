import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import {invariant} from '../policy.mjs';

/** macOS desktop apps through the Accessibility API, via a small Swift helper compiled on first use (Xcode
 * Command Line Tools provide swiftc). The helper stays running; requests and replies are JSON lines. */
const SOURCE=fileURLToPath(new URL('./ax-helper.swift',import.meta.url));
export const desktopSupported=()=>process.platform==='darwin'&&existsSync(SOURCE);
const run=(file,args,opts={})=>new Promise((resolve,reject)=>execFile(file,args,{timeout:300000,...opts},(e,out,err)=>e?reject(Object.assign(e,{stderr:String(err||'')})):resolve(out)));
export class Desktop{
 constructor({binDir}){this.binDir=binDir;this.proc=null;this.pending=new Map();this.id=0;this.targets=new Map();this.building=null;}
 get alive(){return !!this.proc&&this.proc.exitCode===null;}
 /** Builds the helper when it is missing or its source changed. */
 async binary(){
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
 async start(){
  if(this.alive)return;
  const bin=await this.binary();
  this.proc=spawn(bin,[],{stdio:['pipe','pipe','ignore']});
  readline.createInterface({input:this.proc.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}const p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.ok?p.resolve(m.result):p.reject(new Error(m.error||'Desktop helper error'));});
  this.proc.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('The desktop helper stopped'));}this.pending.clear();});
 }
 async call(cmd,params={},timeoutMs=20000){
  await this.start();
  const id=++this.id;this.proc.stdin.write(JSON.stringify({id,cmd,...params})+'\n');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(this.pending.delete(id))reject(new Error(`The desktop helper did not answer ${cmd}`));},timeoutMs);this.pending.set(id,{resolve,reject,timer});});
 }
 status(){return this.call('status');}
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
 press(t,ref,{x,y}={}){return ref?this.call('press',{pid:t.pid,ref}):this.call('click',{pid:t.pid,x,y,title:t.window||''});}
 setText(t,ref,text){return ref?this.call('setText',{pid:t.pid,ref,text}):this.call('type',{pid:t.pid,text});}
 choose(t,ref,option){return this.call('choose',{pid:t.pid,ref,option});}
 key(t,combo){return this.call('key',{pid:t.pid,combo});}
 scroll(t,ref,dy){return this.call('scroll',{pid:t.pid,ref:ref||'',dy});}
 async screenshot(t){const r=await this.call('screenshot',{pid:t.pid,title:t.window||''},30000);return {mime:'image/jpeg',base64:r.base64,width:r.width,height:r.height};}
 async open(what){await run('/usr/bin/open',/^[a-z]+:\/\//i.test(what)?[what]:['-a',what]);await new Promise(r=>setTimeout(r,1500));}
 settle(){return new Promise(r=>setTimeout(r,400));}
 forget(sessionId){this.targets.delete(sessionId);}
 close(){if(this.alive)this.proc.kill();this.proc=null;}
}
