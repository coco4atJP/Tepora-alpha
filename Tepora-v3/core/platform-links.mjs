import {spawn} from 'node:child_process';
export function installerURL(platform=process.platform){return `https://ollama.com/download${platform==='win32'?'/windows':platform==='darwin'?'/mac':''}`;}
/** Explicit click opens a fixed vendor page. No arbitrary URL, shell, installer, or elevation. */
export async function openInstallerPage(platform=process.platform,spawnImpl=spawn){
 const url=installerURL(platform);
 const [exe,args]=platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',url]]:platform==='darwin'?['open',[url]]:['xdg-open',[url]];
 await new Promise((resolve,reject)=>{const p=spawnImpl(exe,args,{shell:false,stdio:'ignore',windowsHide:true});p.once('error',reject);p.once('spawn',()=>{p.unref?.();resolve();});});
 return {opened:true,note:'公式の導入ページを開きました。導入後、この画面でAIをもう一度探してください。'};
}
