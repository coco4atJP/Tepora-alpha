import {spawn} from 'node:child_process';
import {AgentRPC} from './rpc.mjs';
import {invariant} from '../policy.mjs';
/** Use the installed App Server's managed login. Never copy or impersonate its auth tokens. */
export class CodexLogin{
 constructor(store,network,{rpcFactory=opts=>new AgentRPC(opts),openURL=launchAuthBrowser}={}){Object.assign(this,{store,network,rpcFactory,openURL});this.state={phase:'idle'};this.rpc=null;this.early=[];}
 status(){return {...this.state};}
 async open(loginId){
  this.network.assertUncontained('Codex account browser');
  invariant(this.state.phase==='waiting'&&this.state.loginId===loginId,'サインイン手続きが更新されています。',409);
  await this.openURL(this.state.url);return {opened:true};
 }
 async start({type='device',switchAccount=false}={}){
  invariant(['browser','device'].includes(type)&&typeof switchAccount==='boolean','Unsupported login flow');this.network.assertUncontained('Codex account login');invariant(this.store.settings.codexEnabled,'Codex連携を有効にしてください。',403);
  invariant(!this.rpc,'サインイン手続きは既に起動しています。',409);this.state={phase:'starting'};
  const rpc=this.rpcFactory({command:this.store.settings.codexBinary||'codex',args:['app-server'],cwd:this.store.dir}).start();this.rpc=rpc;
  rpc.on('request',m=>rpc.reject(m.id));
  rpc.on('notification',m=>{if(m.method==='account/login/completed'){if(!this.state.loginId)this.early.push(m.params);else this.completed(m.params);}});
  rpc.on('disconnect',()=>{if(this.rpc===rpc){this.rpc=null;if(!['complete','cancelled','failed'].includes(this.state.phase))this.state={phase:'failed',note:'サインイン接続が終了しました。'};}});
  const current=()=>invariant(this.rpc===rpc,'サインインは取り消されています。',409);
  try{
   await rpc.request('initialize',{clientInfo:{name:'tepora',version:'3.0.0-beta.10'}});current();rpc.notify('initialized');
   const account=await rpc.request('account/read',{refreshToken:false});
   current();if(account.account?.type==='chatgpt'&&!switchAccount){this.state={phase:'complete',authenticated:true,accountType:'chatgpt'};this.dispose();return this.status();}
   if(account.account&&!switchAccount){this.state={phase:'existing-api-key',authenticated:true,accountType:account.account.type||'unknown',note:'既存のCodex認証はChatGPT契約ではありません。変更は別途確認してください。'};this.dispose();return this.status();}
   const r=await rpc.request('account/login/start',{type:type==='device'?'chatgptDeviceCode':'chatgpt'});
   current();const url=r.verificationUrl||r.authUrl;invariant(typeof r.loginId==='string'&&r.loginId.length<200&&typeof url==='string','Invalid managed login reply',502);
   const u=new URL(url);invariant(u.protocol==='https:'&&['auth.openai.com','chatgpt.com','auth0.openai.com'].includes(u.hostname)&&!u.username&&!u.password,'Unexpected managed login origin',502);
   invariant(type!=='device'||typeof r.userCode==='string'&&r.userCode.length<=80,'Missing device code',502);
   this.state={phase:'waiting',loginId:r.loginId,type,url:u.href,...(type==='device'?{userCode:r.userCode}:{}),note:'認証情報はCodex側で管理します。利用枠・課金は契約に従います。'};
   this.timer=setTimeout(()=>this.cancel().catch(()=>{}),600000);this.timer.unref?.();
   for(const e of this.early.splice(0))this.completed(e);return this.status();
  }catch(e){if(this.rpc!==rpc)throw e;this.state={phase:'failed',note:'Codexのサインインを開始できませんでした。インストールと対応バージョンを確認してください。'};this.dispose();throw e;}
 }
 completed(p){if(p?.loginId!==this.state.loginId)return;this.state={phase:p.success?'complete':'failed',authenticated:p.success===true,...(p.success?{accountType:'chatgpt'}:{})};this.dispose();}
 async cancel(){const rpc=this.rpc,id=this.state.loginId;this.state={phase:'cancelled'};
  if(rpc&&id)try{await rpc.request('account/login/cancel',{loginId:id},undefined,3000);}catch{}this.dispose();return this.status();}
 dispose(){clearTimeout(this.timer);const rpc=this.rpc;this.rpc=null;rpc?.close();this.early=[];}
 close(){this.state={phase:'cancelled'};this.dispose();}
}

/** The URL is issued by the currently running official managed-login flow, never arbitrary user input. */
export async function launchAuthBrowser(url,platform=process.platform,spawnImpl=spawn){
 const u=new URL(url);invariant(u.protocol==='https:'&&['auth.openai.com','chatgpt.com','auth0.openai.com'].includes(u.hostname)&&!u.username&&!u.password,'Unexpected managed login origin',502);
 const [exe,args]=platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',u.href]]:platform==='darwin'?['open',[u.href]]:['xdg-open',[u.href]];
 await new Promise((resolve,reject)=>{const child=spawnImpl(exe,args,{shell:false,stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('spawn',()=>{child.unref?.();resolve();});});
}
