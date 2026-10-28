import {spawn} from 'node:child_process';
import {normalURL,ipDomain} from './network-policy.mjs';
import {invariant} from './policy.mjs';
export function installerURL(platform=process.platform){return `https://ollama.com/download${platform==='win32'?'/windows':platform==='darwin'?'/mac':''}`;}
/** Explicit click opens a fixed vendor page. No arbitrary URL, shell, installer, or elevation. */
export async function openInstallerPage(platform=process.platform,spawnImpl=spawn){
 const url=installerURL(platform);
 const [exe,args]=platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',url]]:platform==='darwin'?['open',[url]]:['xdg-open',[url]];
 await new Promise((resolve,reject)=>{const p=spawnImpl(exe,args,{shell:false,stdio:'ignore',windowsHide:true});p.once('error',reject);p.once('spawn',()=>{p.unref?.();resolve();});});
 return {opened:true,note:'公式の導入ページを開きました。導入後、この画面でAIをもう一度探してください。'};
}

/** Only a service-owned active authentication URL reaches this launcher. Never invoke a shell. */
export async function openAuthenticationPage(value,{platform=process.platform,spawnImpl=spawn,timeoutMs=2000}={}){
 invariant(typeof value==='string'&&value.length<=16384&&!/[\u0000-\u0020\u007f]/.test(value),'認証URLが不正です。');
 const url=normalURL(value,{query:true}),host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
 invariant(url.protocol==='https:'&&host!=='localhost'&&!host.endsWith('.localhost')&&!host.endsWith('.local')&&['name','cloud'].includes(ipDomain(host)),'ブラウザーで開ける認証URLではありません。');
 const [exe,args]=platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',url.href]]:platform==='darwin'?['open',[url.href]]:['xdg-open',[url.href]];
 const failure=()=>Object.assign(new Error('既定のブラウザーを開けませんでした。ブラウザーの設定を確認して、もう一度お試しください。'),{status:503});
 await new Promise((resolve,reject)=>{
  let child,timer,settled=false;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);child?.unref?.();error?reject(failure()):resolve();};
  try{
   child=spawnImpl(exe,args,{shell:false,stdio:'ignore',windowsHide:true});
   child.once('error',()=>finish(true));child.once('exit',code=>finish(code!==0));
   // Some Linux desktop launchers stay attached to the opened browser. A running launcher is accepted, not killed.
   child.once('spawn',()=>{if(!settled)timer=setTimeout(()=>finish(false),timeoutMs);});
  }catch{finish(true);}
 });
 return {opened:true};
}
