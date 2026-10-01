import {NetworkPolicy,NetworkBlocked} from './network-policy.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { endpoint, invariant, text, webURL, LIMITS } from './policy.mjs';
export function killTree(child) {
  if(!child?.pid) return;
  if(process.platform==='win32') {const k=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});k.on('error',()=>child.kill());}
  else {try {process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
}
export function runProcess(executable,args,{cwd,signal,timeout=120000,onOutput=()=>{}}={}) {
  invariant(typeof executable==='string' && Array.isArray(args) && args.every(x=>typeof x==='string'),'Executable and string arguments required');
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,detached:process.platform!=='win32',env:{PATH:process.env.PATH,HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,LANG:process.env.LANG}});
    let output='',settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
    const abort=()=>{killTree(child);finish(signal.reason||new Error('Cancelled'));};
    const timer=setTimeout(()=>{killTree(child);finish(new Error('Command timed out'));},timeout);
    signal?.addEventListener('abort',abort,{once:true});
    const consume=b=>{const value=b.toString();output+=value;if(output.length>LIMITS.output){killTree(child);finish(new Error('Command output limit exceeded'));return;}onOutput(value);};
    child.stdout.on('data',consume);child.stderr.on('data',consume);
    child.on('error',e=>finish(e));child.on('close',code=>finish(null,{exitCode:code,output}));
  });
}

/** Installed-runtime launcher. Never guess a model's tool parser or install a plugin implicitly. */
export function runtimeLaunch(s,platform=process.platform,parser='') {
  invariant(['llama.cpp','vllm'].includes(s.provider),'Only llama.cpp/vLLM process launch is supported');
  text(s.modelPath,'GGUF path or model identifier',2000);
  const target=endpoint(s.baseUrl,false),port=target.port||(s.provider==='vllm'?'8000':'8080');
  if(s.provider==='llama.cpp')return {executable:s.runtimeBinary||'llama-server',args:['-m',s.modelPath,'--host','127.0.0.1','--port',port,'-c','8192','-ngl','99','--jinja']};
  invariant(/^[A-Za-z0-9_]{1,80}$/.test(parser),'vLLMの起動にはモデルに合うtool parserが必要です。TEPORA_VLLM_TOOL_PARSERを設定してTeporaを再起動するか、vLLMを手動起動して接続してください（docs/RUNTIME-LAUNCH.md）。',409);
  return {executable:s.runtimeBinary||(platform==='win32'?'wsl.exe':'vllm'),args:[...(platform==='win32'?['--exec','vllm']:[]),'serve',s.modelPath,'--host','127.0.0.1','--port',port,'--max-model-len','8192','--enable-auto-tool-choice','--tool-call-parser',parser]};
}

export class Connectors {
  constructor(store,network=new NetworkPolicy(store)) {this.network=network;this.store=store;this.cache=new Map();this.processes=new Map();}
  async cached(key,ttl,fn) {const item=this.cache.get(key);if(item && Date.now()-item.at<ttl)return item.value;const value=await fn();this.cache.set(key,{value,at:Date.now()});return value;}
  async weather() {
    const s=this.store.settings;invariant(s.allowNetwork,'天気の取得にはネットワーク接続の許可が必要です。',403);text(s.weatherCity,'city',100);
    return this.cached(`weather:${s.weatherCity}`,900000,async()=>{
      const opts={signal:AbortSignal.timeout(10000),redirect:'error'};
      const g=await this.network.request(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(s.weatherCity)}&count=1&language=ja`,opts,{purpose:'feed',allowCloud:true});invariant(g.ok,'Weather location service unavailable',502);
      const place=(await g.json()).results?.[0];invariant(place,'都市が見つかりません。英字表記も試してください。',404);
      const r=await this.network.request(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,{signal:AbortSignal.timeout(10000),redirect:'error'},{purpose:'feed',allowCloud:true});invariant(r.ok,'Weather provider unavailable',502);
      const data=await r.json();return {city:place.name,current:data.current,daily:data.daily,source:'Open-Meteo',sourceUrl:'https://open-meteo.com/',fetchedAt:new Date().toISOString()};
    });
  }
  async news() {
    const s=this.store.settings;invariant(s.allowNetwork && s.newsUrl,'RSSのURLとネットワーク許可を設定してください。',409);
    return this.cached(`news:${s.newsUrl}`,600000,async()=>{
      const r=await this.network.request(endpoint(s.newsUrl,true),{redirect:'error',signal:AbortSignal.timeout(10000)},{purpose:'feed',allowCloud:true});invariant(r.ok,'RSS feed unavailable',502);
      let xml='';const decoder=new TextDecoder();for await(const c of r.body){xml+=decoder.decode(c,{stream:true});invariant(xml.length<1_000_000,'RSS feed too large');}xml+=decoder.decode();
      // Conservative RSS/Atom extraction; never evaluate XML entities, scripts, or feed HTML.
      const clean=x=>String(x||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();
      const field=(b,t)=>clean(b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`,'i'))?.[1]);
      const items=[...xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0,12).map(m=>{
        const b=m[1],url=field(b,'link')||b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]||'';
        try {return {title:field(b,'title').slice(0,240),url:webURL(url).href,publishedAt:field(b,'pubDate')||field(b,'published')||field(b,'updated')};}catch{return null;}
      }).filter(Boolean);
      return {items,source:s.newsUrl,fetchedAt:new Date().toISOString()};
    });
  }
  braveExecutable() {
    const custom=this.store.settings.bravePath;
    const paths=process.platform==='win32'?[path.join(process.env.PROGRAMFILES||'C:\\Program Files','BraveSoftware/Brave-Browser/Application/brave.exe'),path.join(process.env.LOCALAPPDATA||'','BraveSoftware/Brave-Browser/Application/brave.exe')]:['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'];
    return [custom,...paths].find(p=>p && existsSync(p))||null;
  }
  async openMedia(url) {
    invariant(this.store.value('execution-config')?.mode==='legacy-host','External host applications require explicit legacy-host mode',403);
    this.network.assertUncontained('External media player');if(!this.network.get().internetTools)throw new NetworkBlocked('インターネットを使う道具は無効です。');
    const target=webURL(url);invariant(['youtube.com','www.youtube.com','music.youtube.com','youtu.be'].includes(target.hostname),'Only YouTube and YouTube Music are allowed here');
    const executable=this.braveExecutable();invariant(executable,'Braveが見つかりません。設定で実行ファイルを指定するか、アプリ内プレーヤーを使ってください。',409);
    const child=spawn(executable,[`--app=${target.href}`,`--user-data-dir=${path.join(this.store.dir,'media-profile')}`],{shell:false,detached:true,stdio:'ignore',windowsHide:false});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {opened:true,mode:'external-brave',adBlocking:'Managed by Brave Shields; playback and blocking are not guaranteed'};
  }
  async transcribe(audio) {
    const s=this.store.settings;invariant(s.asrUrl,'音声モデルが未接続です。接続設定でASRサーバーを指定してください。',409);
    const url=endpoint(s.asrUrl,s.allowCloud);const form=new FormData();form.append('file',new Blob([audio],{type:'audio/wav'}),'recording.wav');form.append('model',s.asrModel);form.append('language','ja');form.append('response_format','json');
    const r=await this.network.request(url,{method:'POST',body:form,headers:process.env.TEPORA_ASR_KEY?{Authorization:`Bearer ${process.env.TEPORA_ASR_KEY}`}:{},redirect:'error',signal:AbortSignal.timeout(120000)},{purpose:'worker'});invariant(r.ok,`ASR returned HTTP ${r.status}`,502);
    const body=await r.json();invariant(typeof body.text==='string','ASR did not return text',502);return {text:body.text};
  }
  startRuntime() {
    invariant(this.store.value('execution-config')?.mode==='legacy-host','Starting a host model process requires explicit legacy-host mode; connect an already-running provider in protected mode',403);
    this.network.assertUncontained('Runtime installer/launcher');
    const s=this.store.settings;invariant(!this.processes.has('model'),'Runtime already started',409);
    invariant(s.provider==='llama.cpp' || s.provider==='vllm','Only llama.cpp/vLLM process launch is supported');
    const {executable,args}=runtimeLaunch(s,process.platform,process.env.TEPORA_VLLM_TOOL_PARSER||'');
    const child=spawn(executable,args,{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});this.processes.set('model',child);
    child.on('error',e=>{this.processes.delete('model');this.store.emit('runtime.error',{message:e.message});});
    child.on('close',()=>{this.processes.delete('model');this.store.emit('runtime.stopped',{});});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
    return {starting:true,executable,args};
  }
  close(){for(const p of this.processes.values())killTree(p);this.processes.clear();}
}
