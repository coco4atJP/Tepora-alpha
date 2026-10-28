/** Sign in with ChatGPT for the ordinary local service (public OSS OAuth client).
 * No Codex credential scraping, private backend API, client secret, or paid API fallback.
 * The Store's exclusive service-owner lease serializes processes using this data directory;
 * refresh promises serialize workers inside that owner. Secrets never enter SQLite/events/UI.
 * Contract: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */
import http from 'node:http';
import path from 'node:path';
import {constants,existsSync,lstatSync,mkdirSync,openSync,readFileSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,chmodSync} from 'node:fs';
import {randomBytes,randomUUID,createHash,createPublicKey,verify,timingSafeEqual} from 'node:crypto';

export const CHATGPT_ISSUER='https://auth.openai.com';
export const CHATGPT_RESOURCE='https://api.openai.com/v1';
const AUTHORIZE=CHATGPT_ISSUER+'/api/accounts/authorize';
const TOKEN=CHATGPT_ISSUER+'/api/accounts/oauth/token';
const JWKS=CHATGPT_ISSUER+'/.well-known/jwks.json';
const DISCOVERY=CHATGPT_ISSUER+'/.well-known/openid-configuration';
const SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random=()=>randomBytes(32).toString('base64url');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const accountPattern=/^chatgpt-[a-f0-9-]{36}$/;
const issuedClient=x=>typeof x==='string'&&/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(x);
export class ProviderAuthError extends Error {
 constructor(message,{status=409,kind='auth'}={}){super(message);this.name='ProviderAuthError';this.status=status;this.kind=kind;}
}
function require(ok,message,status=400){if(!ok)throw new ProviderAuthError(message,{status});}
function credentialString(value){return typeof value==='string'&&value.length>0&&value.length<=64000&&!/[\r\n]/.test(value);}
function safeFile(file){if(existsSync(file))require(lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink(),'認証ファイルを安全に読み書きできません。');}
function readVault(file){
 const dir=path.dirname(file);if(existsSync(dir))require(lstatSync(dir).isDirectory()&&!lstatSync(dir).isSymbolicLink(),'認証フォルダーが安全ではありません。');
 if(!existsSync(file))return {schema:1,hostId:'',accounts:{}};
 safeFile(file);const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const source=readFileSync(fd,'utf8');require(source.length<=2_000_000,'認証ファイルが大きすぎます。');const v=JSON.parse(source);
  require(v.schema===1&&typeof v.hostId==='string'&&/^urn:uuid:[a-f0-9-]{36}$/.test(v.hostId)&&object(v.accounts)&&Object.keys(v.accounts).length<=16,'認証ファイルの形式が不正です。');
  for(const [id,a] of Object.entries(v.accounts))require(accountPattern.test(id)&&object(a)&&a.id===id&&issuedClient(a.clientId)&&typeof a.subject==='string'&&a.subject.length>0,'認証アカウントの形式が不正です。');
  return v;
 }finally{closeSync(fd);}
}
export function atomicVault(file,value){
 const dir=path.dirname(file);if(existsSync(dir))require(lstatSync(dir).isDirectory()&&!lstatSync(dir).isSymbolicLink(),'認証フォルダーが安全ではありません。');
 mkdirSync(dir,{recursive:true,mode:0o700});if(process.platform!=='win32')chmodSync(dir,0o700);safeFile(file);
 const tmp=path.join(dir,'.chatgpt-'+randomUUID()+'.tmp');let fd;
 try{fd=openSync(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(tmp,file);
  if(process.platform!=='win32'){const d=openSync(dir,constants.O_RDONLY);try{fsyncSync(d);}finally{closeSync(d);}}
 }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(tmp);}catch{}}
}
/** Restrict JWT algorithms and JWK types, then verify before reading identity claims.
 * No token-provided key URL, symmetric algorithm, or unsigned token is accepted.
 */
export function verifyIdentity(token,jwks,{clientId,nonce,subject,now=Date.now()}={}){
 require(credentialString(token),'IDトークンがありません。');const parts=token.split('.');require(parts.length===3&&parts.every(p=>/^[A-Za-z0-9_-]+$/.test(p)),'IDトークンの形式が不正です。');
 let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw new ProviderAuthError('IDトークンの形式が不正です。');}
 require(object(header)&&object(claims)&&['RS256','ES256'].includes(header.alg)&&typeof header.kid==='string'&&!header.crit&&header.b64!==false,'IDトークンの署名方式が不正です。');
 const keys=(jwks?.keys||[]).filter(k=>k.kid===header.kid&&(!k.use||k.use==='sig')&&(!k.key_ops||k.key_ops.includes('verify'))&&(!k.alg||k.alg===header.alg));
 require(keys.length===1,'OpenAIの署名鍵を確認できません。');const key=keys[0];
 require(header.alg==='RS256'?key.kty==='RSA':key.kty==='EC'&&key.crv==='P-256','IDトークンの鍵形式が不正です。');
 let valid=false;try{valid=verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key:createPublicKey({key,format:'jwk'}),...(header.alg==='ES256'?{dsaEncoding:'ieee-p1363'}:{})},Buffer.from(parts[2],'base64url'));}catch{}
 require(valid,'IDトークンの署名を確認できません。');
 const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud],seconds=now/1000;
 require(claims.iss===CHATGPT_ISSUER&&aud.includes(clientId)&&(aud.length===1||claims.azp===clientId)&&(!claims.azp||claims.azp===clientId),'IDトークンの発行元・宛先が一致しません。');
 require(Number.isFinite(claims.exp)&&claims.exp>seconds-5&&Number.isFinite(claims.iat)&&claims.iat<=seconds+5&&claims.iat<claims.exp&&(!Object.hasOwn(claims,'nbf')||Number.isFinite(claims.nbf)&&claims.nbf<=seconds+5),'IDトークンの有効期間が不正です。');
 require(typeof claims.sub==='string'&&claims.sub.length>0&&claims.sub.length<=512&&(!subject||claims.sub===subject),'ログインしたアカウントが選択した登録と一致しません。');
 if(nonce!==undefined)require(equal(claims.nonce,nonce),'ログインのnonceが一致しません。');return claims;
}
function tokenRecord(raw,previous,now){
 require(object(raw)&&credentialString(raw.access_token)&&credentialString(raw.refresh_token)&&/^Bearer$/i.test(raw.token_type||''),'アクセストークン・更新トークンを確認できません。');
 const scopes=typeof raw.scope==='string'?raw.scope.split(/\s+/).filter(Boolean):previous?.scopes;
 require(scopes?.includes('chatgpt.tokens.use.direct')&&scopes.includes('resource.invoke'),'ChatGPTプランを利用する権限が許可されていません。');
 require(Number.isFinite(raw.expires_in)&&raw.expires_in>0&&raw.expires_in<=86400,'トークンの有効期限が不正です。');
 let earliest=0;if(raw.earliest_refresh_at!==undefined){const x=raw.earliest_refresh_at;earliest=typeof x==='number'?x*1000:Date.parse(x);require(Number.isFinite(earliest),'トークンの更新可能時刻が不正です。');}
 return {accessToken:raw.access_token,refreshToken:raw.refresh_token,idToken:raw.id_token||previous?.idToken||'',scopes,expiresAt:now+raw.expires_in*1000,earliestRefreshAt:earliest,savedAt:now,connected:true,error:null};
}
async function waitFor(promise,signal){
 signal?.throwIfAborted();if(!signal)return promise;let abort;
 try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]);}
 finally{signal.removeEventListener('abort',abort);}
}
function publicAccount(a){return {id:a.id,label:a.label,email:a.email||'',connected:!!a.connected,expiresAt:a.expiresAt||null,error:a.error||null};}

export class ProviderAuth {
 constructor(store,network,{clock=()=>Date.now(),attemptMs=600000}={}){
  Object.assign(this,{store,network,clock,attemptMs});this.file=path.join(store.dir,'credentials','chatgpt.json');this.pending=null;this.refreshes=new Map();this.lives=new Map();this.tasks=new Set();this.closed=false;this.shutdown=new AbortController();this.jwks=null;
  try{this.vault=readVault(this.file);}catch{this.storageError='認証ファイルを読み込めませんでした。ファイルを保全したまま認証を停止しています。';this.vault={schema:1,hostId:'',accounts:{}};}
  this.onNetwork=p=>{if(p.mode!=='online')this.cancel();};network.listeners?.add(this.onNetwork);
 }
 snapshot(){return {supported:!this.storageError,note:this.storageError||'ChatGPTプランの利用枠です。従量課金APIへの自動切替はしません。',accounts:Object.values(this.vault.accounts).map(publicAccount),pending:this.pending?{id:this.pending.id,status:this.pending.status,accountId:this.pending.accountId||null,error:this.pending.error||null,expiresAt:this.pending.expiresAt,canOpenBrowser:this.pending.status==='pending'&&this.clock()<this.pending.expiresAt&&!!this.pending.authorizationUrl}:null};}
 browserURL(id){this.available();const p=this.pending;require(p?.id===id&&p.status==='pending'&&!p.cancel.signal.aborted&&this.clock()<p.expiresAt&&p.authorizationUrl,'認証の状態が変わりました。ログインをやり直してください。',409);return p.authorizationUrl;}
 status(id){return this.vault.accounts[id]?publicAccount(this.vault.accounts[id]):{id,connected:false,error:'ChatGPTのアカウントを接続してください。'};}
 emit(){if(!this.closed&&!this.store.closed)this.store.broadcast?.('provider-auth.updated',this.snapshot());}
 persist(next=this.vault){require(!this.storageError,'認証ファイルを保全するため変更できません。');atomicVault(this.file,next);this.vault=next;}
 available(){require(!this.closed&&!this.storageError,'認証サービスを利用できません。');require(this.network.permitted('cloud','model'),'オンラインにしてからChatGPTへ接続してください。',403);}
 account(id){require(accountPattern.test(id||'')&&this.vault.accounts[id],'ChatGPTアカウントが見つかりません。',404);return this.vault.accounts[id];}
 life(id){let c=this.lives.get(id);if(!c){c=new AbortController();this.lives.set(id,c);}return c;}
 invalidate(id){this.lives.get(id)?.abort(new ProviderAuthError('ChatGPTの認証状態が変更されました。'));this.lives.delete(id);}
 async request(url,init={},signal){
  this.available();require([CHATGPT_ISSUER,new URL(CHATGPT_RESOURCE).origin].includes(new URL(url).origin),'認証の送信先が不正です。');
  try{return await this.network.request(url,{...init,redirect:'error',signal:AbortSignal.any([this.shutdown.signal,...(signal?[signal]:[])])},{purpose:'model',allowCloud:true,timeoutMs:20000,maxBytes:2_000_000});}
  catch{throw new ProviderAuthError('ChatGPTの認証サーバーに接続できません。',{kind:'transient',status:502});}
 }
 async json(url,init={},signal){
  const r=await this.request(url,init,signal);let body;try{body=await r.json();}catch{throw new ProviderAuthError('認証サーバーの応答を確認できません。',{status:502});}
  if(!r.ok){const revoked=body?.error==='invalid_grant';const e=new ProviderAuthError(revoked?'ChatGPTへの再ログインが必要です。':`ChatGPTの認証に失敗しました（HTTP ${r.status}）。`,{status:502,kind:r.status>=500||r.status===429?'transient':'auth'});e.invalidGrant=revoked;throw e;}return body;
 }
 async exchange(form,signal){return this.json(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,resource:CHATGPT_RESOURCE}).toString()},signal);}
 async identity(token,expected,signal){
  // Refresh JWKS once per sign-in/refresh validation. No token-selected endpoints.
  const keys=await this.json(JWKS,{},signal);return verifyIdentity(token,keys,{...expected,now:this.clock()});
 }
 async begin({accountId=null,consent=false}={}){
  require(consent===true,'OpenAIへのログインとChatGPTプランの使用に同意してください。',403);this.available();
  require(!this.pending||!['pending','exchanging'].includes(this.pending.status),'別のログインが進行中です。',409);
  const previous=accountId?this.account(accountId):null;require(previous||Object.keys(this.vault.accounts).length<16,'ChatGPTアカウントは16登録までです。');
  if(!this.vault.hostId)this.persist({...this.vault,hostId:'urn:uuid:'+randomUUID()});
  const p={id:randomUUID(),accountId,status:'pending',state:random(),nonce:random(),verifier:random(),clientId:previous?.clientId||null,subject:previous?.subject||null,expiresAt:this.clock()+this.attemptMs,cancel:new AbortController()};this.pending=p;
  p.server=http.createServer((req,res)=>{const task=this.callback(p,req,res).catch(()=>{if(!res.writableEnded){res.writeHead(500);res.end('Sign-in failed. Return to Tepora.');}this.finish(p,'error','ログインを完了できませんでした。');}).finally(()=>this.tasks.delete(task));this.tasks.add(task);});
  p.server.headersTimeout=10000;p.server.requestTimeout=15000;p.server.maxHeadersCount=30;
  let onAbort;
  try{await new Promise((resolve,reject)=>{onAbort=()=>reject(new ProviderAuthError('ログインを取り消しました。'));p.cancel.signal.addEventListener('abort',onAbort,{once:true});p.server.once('error',reject);p.server.listen(0,'127.0.0.1',()=>{if(p.cancel.signal.aborted)p.server.close();resolve();});});this.available();p.cancel.signal.throwIfAborted();}
  catch{this.finish(p,'error','ログイン用のローカルポートを開けません。');p.server.close();p.server.closeAllConnections();throw new ProviderAuthError('ログインを開始できませんでした。');}
  finally{p.cancel.signal.removeEventListener('abort',onAbort);}
  p.redirectUri=`http://127.0.0.1:${p.server.address().port}/auth/callback`;
  p.timer=setTimeout(()=>this.finish(p,'expired','ログインの期限が切れました。'),this.attemptMs);p.timer.unref?.();
  const params={client_id:p.clientId||'dynamic_agent_client',ext_agent_host_id:this.vault.hostId,response_type:'code',redirect_uri:p.redirectUri,scope:SCOPES,resource:CHATGPT_RESOURCE,state:p.state,nonce:p.nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(p.verifier).digest('base64url')};
  if(!p.clientId)params.agent_name_hint='Tepora';
  // ID-token hints deliberately stay out of browser JS and URLs returned to the UI.
  p.authorizationUrl=AUTHORIZE+'?'+new URLSearchParams(params);this.emit();return {id:p.id,authorizationUrl:p.authorizationUrl,expiresAt:p.expiresAt};
 }
 finish(p,status,error=null){
  if(!['pending','exchanging'].includes(p.status))return;p.status=status;p.error=error;clearTimeout(p.timer);p.cancel.abort();p.server?.close();p.server?.closeIdleConnections();
  delete p.state;delete p.nonce;delete p.verifier;delete p.authorizationUrl;this.emit();
 }
 cancel(id){const p=this.pending;if(p&&(!id||p.id===id))this.finish(p,'cancelled','ログインを取り消しました。');return this.snapshot();}
 async callback(p,req,res){
  const respond=(status,message)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(message);};
  if(req.method!=='GET'||req.url.length>8192||req.headers.host!==new URL(p.redirectUri).host)return respond(400,'Invalid callback.');
  const u=new URL(req.url,p.redirectUri);
  if(u.pathname!=='/auth/callback'||p!==this.pending||p.status!=='pending'||this.clock()>=p.expiresAt||['state','code','client_id','error'].some(k=>u.searchParams.getAll(k).length>1)||!equal(u.searchParams.get('state'),p.state))return respond(400,'Invalid or expired sign-in state.');
  // One-use consumption before I/O; an invalid unrelated callback cannot consume the attempt.
  p.status='exchanging';this.emit();
  try{
   require(!u.searchParams.has('error'),'ログインまたは利用権限の許可が取り消されました。');
   const returned=u.searchParams.get('client_id'),clientId=returned||p.clientId;
   require(issuedClient(clientId)&&(!p.clientId||!returned||returned===p.clientId),'OAuthクライアントの登録を確認できません。');
   const code=u.searchParams.get('code');require(typeof code==='string'&&code.length>0&&code.length<=4096,'認証コードがありません。');
   const raw=await this.exchange({grant_type:'authorization_code',client_id:clientId,code,code_verifier:p.verifier,redirect_uri:p.redirectUri},p.cancel.signal);
   const identity=await this.identity(raw.id_token,{clientId,nonce:p.nonce,subject:p.subject},p.cancel.signal);
   const tokens=tokenRecord(raw,null,this.clock());this.available();p.cancel.signal.throwIfAborted();
   const known=Object.values(this.vault.accounts).find(a=>a.clientId===clientId&&a.subject===identity.sub),id=p.accountId||known?.id||'chatgpt-'+randomUUID();
   require(!p.accountId||this.account(p.accountId).subject===identity.sub,'選択したアカウントが変更されています。');
   const email=typeof identity.email==='string'?identity.email.slice(0,200):'',label=(email||'ChatGPT')+' · '+id.slice(-6);
   const account={id,clientId,subject:identity.sub,email,label,...tokens};
   this.persist({...this.vault,accounts:{...this.vault.accounts,[id]:account}});this.invalidate(id);p.accountId=id;
   respond(200,'ChatGPTに接続しました。このタブを閉じてTeporaへ戻ってください。');this.finish(p,'connected');
  }catch(e){respond(400,'ログインを完了できませんでした。Teporaの接続画面を確認してください。');this.finish(p,'error',e instanceof ProviderAuthError?e.message:'ログインを完了できませんでした。');}
 }
 async acquire(id,signal){
  this.available();let a=this.account(id);require(a.connected&&a.refreshToken&&a.scopes?.includes('chatgpt.tokens.use.direct'),'ChatGPTへログインし直してください。');const life=this.life(id);
  const needsRefresh=a.expiresAt<=this.clock()+60000&&(!a.earliestRefreshAt||a.earliestRefreshAt<=this.clock());
  if(needsRefresh){
   if(!this.refreshes.has(id)){const job=this.refresh(a,life.signal).finally(()=>{if(this.refreshes.get(id)===job)this.refreshes.delete(id);});this.refreshes.set(id,job);}
   await waitFor(this.refreshes.get(id),signal);a=this.account(id);
  }
  life.signal.throwIfAborted();signal?.throwIfAborted();require(a.connected&&a.expiresAt>this.clock(),'ChatGPTの認証期限が切れています。');
  return {key:a.accessToken,signal:AbortSignal.any([this.shutdown.signal,life.signal,...(signal?[signal]:[])])};
 }
 async refresh(previous,signal){
  try{
   const raw=await this.exchange({grant_type:'refresh_token',client_id:previous.clientId,refresh_token:previous.refreshToken},signal);
   if(raw.id_token)await this.identity(raw.id_token,{clientId:previous.clientId,subject:previous.subject},signal);
   const next={...previous,...tokenRecord(raw,previous,this.clock())};this.available();signal.throwIfAborted();require(this.account(previous.id)===previous,'認証状態が変更されています。');
   this.persist({...this.vault,accounts:{...this.vault.accounts,[previous.id]:next}});this.emit();
  }catch(e){if((e.invalidGrant||e.kind==='auth')&&!signal.aborted&&this.vault.accounts[previous.id]===previous){this.clear(previous.id,'ChatGPTへの再ログインが必要です。');}throw e;}
 }
 clear(id,error=null){const a=this.account(id);this.invalidate(id);this.persist({...this.vault,accounts:{...this.vault.accounts,[id]:{id:a.id,clientId:a.clientId,subject:a.subject,email:a.email,label:a.label,connected:false,error}}});this.emit();}
 async disconnect(id){
  const a=this.account(id),refresh=a.refreshToken;if(this.pending?.accountId===id)this.cancel();this.clear(id);
  let revoked=!refresh;
  // Local credentials are withdrawn immediately; pending refresh can never resurrect them.
  if(refresh&&this.network.permitted('cloud','model'))try{
   const config=await this.json(DISCOVERY);const u=new URL(config.revocation_endpoint);
   require(config.issuer===CHATGPT_ISSUER&&u.origin===CHATGPT_ISSUER&&!u.username&&!u.password&&!u.hash&&!u.search,'失効処理の送信先を確認できません。');
   for(let attempt=0;attempt<2;attempt++){
    const r=await this.request(u.href,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:refresh,token_type_hint:'refresh_token',client_id:a.clientId}).toString()});
    revoked=r.status===200;await r.body?.cancel();if(revoked||r.status<500)break;
   }
  }catch{/* Never put revocation response text, credentials, or URLs into diagnostics. */}
  return {id,disconnected:true,remoteRevocation:revoked?'confirmed':'unconfirmed',note:revoked?'ログアウトしました。':'このPCの認証は削除しました。サーバー側の失効は未確認です。ChatGPTの設定からもアクセスを解除してください。'};
 }
 async models(id,{consent=false,signal}={}){
  require(consent===true,'モデル一覧を取得するためOpenAIへ接続します。',403);const auth=await this.acquire(id,signal);
  const data=await this.json(CHATGPT_RESOURCE+'/models',{headers:{Authorization:`Bearer ${auth.key}`}},auth.signal);
  require(Array.isArray(data.models),'ChatGPTのモデル一覧を確認できません。');const seen=new Set();
  const models=data.models.filter(m=>object(m)&&m.visibility==='list'&&typeof m.slug==='string'&&m.slug.length>0&&m.slug.length<=160&&!seen.has(m.slug)&&seen.add(m.slug)).slice(0,500).map(m=>({id:m.slug,name:typeof m.display_name==='string'?m.display_name.slice(0,200):m.slug}));
  return {accountId:id,models,verified:false,note:'このアカウントの表示用カタログです。実際の推論成功・品質の保証ではありません。'};
 }
 async close(){if(this.closed)return;this.cancel();this.closed=true;this.shutdown.abort();for(const c of this.lives.values())c.abort();this.network.listeners?.delete(this.onNetwork);this.pending?.server?.closeAllConnections();await Promise.allSettled([...this.tasks,...this.refreshes.values()]);}
}
