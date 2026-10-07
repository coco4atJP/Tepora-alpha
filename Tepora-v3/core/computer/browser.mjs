import {spawn} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {OBSERVE,SETTLE} from './page-script.mjs';

/** A Chromium-family browser driven over the DevTools protocol with Node's own WebSocket: nothing to install.
 * One process for all sessions, one tab per session, its own profile under Tepora's data folder (so logins made
 * in a visible window carry over to headless work). */
export function findBrowser(preferred=''){
 if(preferred&&existsSync(preferred))return preferred;
 const mac=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
 const linux=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/snap/bin/chromium','/usr/bin/microsoft-edge'];
 const win=[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).flatMap(b=>[path.join(b,'Google/Chrome/Application/chrome.exe'),path.join(b,'Microsoft/Edge/Application/msedge.exe')]);
 return (process.platform==='darwin'?mac:process.platform==='win32'?win:linux).find(p=>existsSync(p))||null;
}
/** Finds a control by ref through open shadow roots and same-origin frames; returns [element, frameX, frameY]. */
const DEEP=`function __find(root,ref){let el=root.querySelector('[data-tepora-ref="'+ref+'"]');if(el)return [el,0,0];for(const h of root.querySelectorAll('*')){if(h.shadowRoot){const r=__find(h.shadowRoot,ref);if(r)return r;}if(h.tagName==='IFRAME'){try{const d=h.contentDocument;if(d){const r=__find(d,ref);if(r){const b=h.getBoundingClientRect();return [r[0],r[1]+b.left,r[2]+b.top];}}}catch(e){}}}return null;}`;
const KEYS={Enter:[13,'\r'],Tab:[9,'\t'],Escape:[27],Backspace:[8],Delete:[46],ArrowUp:[38],ArrowDown:[40],ArrowLeft:[37],ArrowRight:[39],Home:[36],End:[35],PageUp:[33],PageDown:[34],Space:[32,' '],F5:[116]};
const MOD={Alt:1,Control:2,Ctrl:2,Meta:4,Cmd:4,Command:4,Shift:8};
/** "Enter", "Control+A", "Meta+Shift+K" → DevTools key events. "Mod" is Command on macOS, Control elsewhere. */
export function keyEvents(combo){
 const parts=String(combo).split('+').map(s=>s.trim()).filter(Boolean).map(p=>p==='Mod'?(process.platform==='darwin'?'Meta':'Control'):p);
 const key=parts.pop()||'';for(const p of parts)if(!MOD[p])throw new Error(`Unknown modifier "${p}". Use Control, Alt, Shift, Meta (Command) or Mod.`);
 const modifiers=parts.reduce((m,p)=>m|MOD[p],0);
 let code,vk,text;
 if(KEYS[key]){[vk,text]=KEYS[key];code=key==='Space'?'Space':key;}
 else if(/^[a-z]$/i.test(key)){vk=key.toUpperCase().charCodeAt(0);code='Key'+key.toUpperCase();text=modifiers&~8?undefined:(modifiers&8?key.toUpperCase():key);}
 else if(/^[0-9]$/.test(key)){vk=key.charCodeAt(0);code='Digit'+key;text=modifiers&~8?undefined:key;}
 else throw new Error(`Unknown key "${key}". Use names like Enter, Tab, Escape, ArrowDown, Backspace, or combinations like Control+A.`);
 const name=key==='Space'?' ':key.length===1?(modifiers&8?key.toUpperCase():key):key;
 return [{type:text?'keyDown':'rawKeyDown',key:name,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers,...(text?{text,unmodifiedText:text}:{})},{type:'keyUp',key:name,code,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk,modifiers}];
}
class Connection{
 constructor(url){
  this.id=0;this.pending=new Map();this.listeners=new Set();this.closed=false;
  this.ws=new WebSocket(url);
  this.ready=new Promise((resolve,reject)=>{this.ws.onopen=resolve;this.ws.onerror=()=>reject(new Error('Could not connect to the browser'));});
  this.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}
   if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id);this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Object.assign(new Error(m.error.message||'DevTools error'),{cdp:m.error})):p.resolve(m.result||{});}
   else for(const l of this.listeners)try{l(m);}catch{}};
  this.ws.onclose=()=>{this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('The browser closed'));}this.pending.clear();};
 }
 send(method,params={},sessionId=undefined,timeoutMs=30000){
  if(this.closed)return Promise.reject(new Error('The browser closed'));
  const id=++this.id;this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(this.pending.delete(id))reject(new Error(`${method} timed out`));},timeoutMs);timer.unref?.();this.pending.set(id,{resolve,reject,timer});});
 }
 on(fn){this.listeners.add(fn);return ()=>this.listeners.delete(fn);}
 close(){try{this.ws.close();}catch{}}
}
export class Browser{
 constructor({executable,profileDir,downloadDir,headless=true,windowSize='1280,900'}){Object.assign(this,{executable,profileDir,downloadDir,headless,windowSize});this.pages=new Map();this.starting=null;this.proc=null;this.conn=null;}
 get alive(){return !!this.conn&&!this.conn.closed&&!!this.proc&&this.proc.exitCode===null;}
 async start(){
  if(this.alive)return this;if(this.starting)return this.starting;
  this.starting=(async()=>{
   if(!this.executable)throw new Error('No Chrome, Edge, Brave or Chromium was found. Install one, or set its path in the computer-use settings.');
   mkdirSync(this.profileDir,{recursive:true});
   const args=['--remote-debugging-port=0',`--user-data-dir=${this.profileDir}`,'--no-first-run','--no-default-browser-check','--disable-sync','--use-mock-keychain','--password-store=basic',
    '--disable-features=Translate,MediaRouter','--disable-popup-blocking',`--window-size=${this.windowSize}`,'--lang=ja',...(this.headless?['--headless=new','--hide-scrollbars','--mute-audio']:[]),'about:blank'];
   const proc=spawn(this.executable,args,{stdio:['ignore','ignore','pipe']});this.proc=proc;
   const url=await new Promise((resolve,reject)=>{
    let buf='';const t=setTimeout(()=>reject(new Error('The browser did not start within 20 seconds')),20000);
    proc.stderr.on('data',c=>{buf+=c;const m=/DevTools listening on (ws:\/\/\S+)/.exec(buf);if(m){clearTimeout(t);resolve(m[1]);}if(buf.length>100000)buf=buf.slice(-10000);});
    proc.on('exit',code=>{clearTimeout(t);reject(new Error(`The browser exited (${code}). If another Tepora browser uses the same profile, close it.`));});
    proc.on('error',e=>{clearTimeout(t);reject(e);});
   });
   this.conn=new Connection(url);await this.conn.ready;
   await this.conn.send('Target.setDiscoverTargets',{discover:true});
   if(this.downloadDir){mkdirSync(this.downloadDir,{recursive:true});await this.conn.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:this.downloadDir,eventsEnabled:true}).catch(()=>{});}
   // A link that opens a new tab moves its session there, like a person following it.
   this.conn.on(m=>{if(m.method==='Target.targetCreated'){const info=m.params.targetInfo;if(info.type==='page'&&info.openerId)for(const page of this.pages.values())if(page.targetId===info.openerId)page.adopt(info.targetId).catch(()=>{});}});
   proc.on('exit',()=>{this.conn?.close();this.pages.clear();});
   return this;
  })();
  try{return await this.starting;}finally{this.starting=null;}
 }
 /** The tab of a session (created on first use). */
 async page(key){
  await this.start();
  let p=this.pages.get(key);if(p&&!p.closed)return p;
  const {targetId}=await this.conn.send('Target.createTarget',{url:'about:blank'});
  p=new Page(this,key);await p.attach(targetId);this.pages.set(key,p);return p;
 }
 async release(key){const p=this.pages.get(key);if(!p)return;this.pages.delete(key);await p.close();}
 /** Closes every tab and the browser, and waits for the process to end (its profile is then free). */
 async close(){
  for(const k of [...this.pages.keys()])await this.release(k).catch(()=>{});
  await this.conn?.send('Browser.close',{},undefined,3000).catch(()=>{});this.conn?.close();
  const proc=this.proc;if(!proc||proc.exitCode!==null||proc.signalCode)return;
  await new Promise(resolve=>{const t=setTimeout(()=>{try{proc.kill('SIGKILL');}catch{}resolve();},5000);proc.once('exit',()=>{clearTimeout(t);resolve();});});
 }
}
export class Page{
 constructor(browser,owner){this.browser=browser;this.owner=owner;this.closed=false;this.dialogs=[];this.downloads=[];this.off=null;}
 get conn(){return this.browser.conn;}
 send(method,params={},timeoutMs){return this.conn.send(method,params,this.sessionId,timeoutMs);}
 async attach(targetId){
  this.off?.();this.targetId=targetId;
  const {sessionId}=await this.conn.send('Target.attachToTarget',{targetId,flatten:true});this.sessionId=sessionId;
  await Promise.all([this.send('Page.enable'),this.send('Runtime.enable')]);
  await this.send('Emulation.setFocusEmulationEnabled',{enabled:true}).catch(()=>{});
  this.off=this.conn.on(m=>{
   if(m.sessionId!==this.sessionId)return;
   if(m.method==='Page.javascriptDialogOpening'){this.dialogs.push({type:m.params.type,message:String(m.params.message||'').slice(0,300)});this.send('Page.handleJavaScriptDialog',{accept:true,promptText:m.params.defaultPrompt||''}).catch(()=>{});}
  });
 }
 async adopt(targetId){if(targetId===this.targetId)return;this.opened=targetId;await this.attach(targetId);await this.send('Target.activateTarget',{targetId}).catch(()=>{});}
 async eval(expression,{awaitPromise=false,timeoutMs=15000}={}){
  const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise,userGesture:true},timeoutMs);
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0]||r.exceptionDetails.text||'Script error');
  return r.result?.value;
 }
 /** Waits for navigation and a quiet DOM. A navigation destroys the page's context mid-wait, so it retries. */
 async settle(maxMs=10000){
  const t0=Date.now();
  for(;;){
   try{await this.eval(SETTLE,{awaitPromise:true,timeoutMs:Math.max(1000,maxMs-(Date.now()-t0))});const state=await this.eval('document.readyState');if(state!=='loading')return;}
   catch{}
   if(Date.now()-t0>maxMs)return;await new Promise(r=>setTimeout(r,200));
  }
 }
 async goto(url){
  const r=await this.send('Page.navigate',{url},30000);if(r.errorText)throw new Error(`Could not open ${url}: ${r.errorText}`);
  await this.settle(15000);
 }
 async observe(){const o=await this.eval(OBSERVE,{timeoutMs:20000});o.dialogs=this.dialogs.splice(0);if(this.opened){o.newTab=true;this.opened=null;}return o;}
 /** Runs `body` in the page with `el` bound to the control (and dx, dy its frame offset). */
 async withEl(ref,body){
  const v=await this.eval(`(()=>{${DEEP};const f=__find(document,${JSON.stringify(String(ref))});if(!f)return {__missing:true};const [el,dx,dy]=f;${body}})()`);
  if(v?.__missing)throw new Error(`Control ${ref} is no longer on the page. Observe again.`);
  return v;
 }
 /** Scrolls a control into view and returns its centre in viewport coordinates. */
 locate(ref){return this.withEl(ref,`el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});const r=el.getBoundingClientRect();
  return {x:Math.round(r.left+r.width/2+dx),y:Math.round(r.top+r.height/2+dy),tag:el.tagName,editable:el.isContentEditable||/^(INPUT|TEXTAREA)$/.test(el.tagName)};`);}
 async mouse(x,y,{clicks=1,button='left'}={}){
  await this.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  for(let i=1;i<=clicks;i++){await this.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button,clickCount:i});await this.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button,clickCount:i});}
 }
 async click(target,options){const {x,y}=typeof target==='string'?await this.locate(target):target;await this.mouse(x,y,options);return {x,y};}
 /** Replaces a field's content the way a person would: focus, select all, type. Works with React-style inputs. */
 async fill(ref,text){
  const at=await this.locate(ref);
  if(!at.editable)await this.mouse(at.x,at.y);
  await this.withEl(ref,`el.focus();if(el.select&&el.tagName!=='SELECT')el.select();else if(el.isContentEditable){const r=el.ownerDocument.createRange();r.selectNodeContents(el);const s=el.ownerDocument.getSelection();s.removeAllRanges();s.addRange(r);}return true;`);
  if(text)await this.send('Input.insertText',{text});else await this.key('Delete');
 }
 async type(text){await this.send('Input.insertText',{text});}
 async key(combo){for(const e of keyEvents(combo))await this.send('Input.dispatchKeyEvent',e);}
 async select(ref,option){
  const r=await this.withEl(ref,`if(el.tagName!=='SELECT')return 'not a select';const want=${JSON.stringify(String(option))};
   const o=[...el.options].find(o=>o.text.trim()===want||o.value===want)||[...el.options].find(o=>o.text.includes(want));if(!o)return 'no option '+want;el.value=o.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';`);
  if(r!=='ok')throw new Error(r==='not a select'?`${ref} is not a drop-down; click it and choose from the list instead.`:`No option "${option}" in ${ref}.`);
 }
 async scroll({ref,dy=600,x,y}={}){
  const at=ref?await this.locate(ref):{x:x??400,y:y??400};
  await this.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:at.x,y:at.y,deltaX:0,deltaY:dy});
 }
 async upload(ref,files){
  const {root}=await this.send('DOM.getDocument',{depth:-1,pierce:true});
  const {nodeId}=await this.send('DOM.querySelector',{nodeId:root.nodeId,selector:`[data-tepora-ref="${ref}"]`});
  if(!nodeId)throw new Error(`Control ${ref} is no longer on the page.`);
  await this.send('DOM.setFileInputFiles',{nodeId,files});
 }
 async back(){await this.eval('history.back()');await this.settle(10000);}
 async screenshot({quality=70}={}){
  const m=await this.send('Page.getLayoutMetrics');const w=Math.round(m.cssVisualViewport?.clientWidth||1280),h=Math.round(m.cssVisualViewport?.clientHeight||900);
  const r=await this.send('Page.captureScreenshot',{format:'jpeg',quality,captureBeyondViewport:false},30000);
  return {mime:'image/jpeg',base64:r.data,width:w,height:h};
 }
 async html(){return this.eval('document.documentElement.outerHTML');}
 async close(){this.closed=true;this.off?.();try{await this.conn.send('Target.closeTarget',{targetId:this.targetId});}catch{}}
}
