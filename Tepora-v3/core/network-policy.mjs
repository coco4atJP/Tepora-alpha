import path from 'node:path';
/** One application egress policy, shared by main/auxiliary inference and network tools.
 * Not an OS firewall. Existing external applications and a user's own proxy remain outside it.
 * The transport connects to the checked address, not a second DNS lookup (rebinding defence).
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import {Readable} from 'node:stream';
import {invariant} from './policy.mjs';

export const NETWORK_MODES=['online','trusted-lan','offline'];
export class NetworkBlocked extends Error {
 constructor(message='この通信は現在のモードで許可されていません。') {super(message);this.name='NetworkBlocked';this.status=403;this.blocked=true;}
}
const hostName=u=>u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
export function ipDomain(address) {
 const ip=address.toLowerCase();
 // IPv4-mapped/compatible IPv6, scoped link-local addresses and transitional routes are not trusted.
 if(ip.includes('%')||ip.startsWith('::ffff:')||ip.startsWith('2002:')||ip.startsWith('64:ff9b:'))return 'reserved';
 if(ip==='::1')return 'device';
 if(net.isIPv4(ip)) {
  const [a,b,c,d]=ip.split('.').map(Number);
  if(a===127)return 'device';
  if(a===10||a===172&&b>=16&&b<=31||a===192&&b===168)return 'lan';
  if(a===0||a>=224||a===169&&b===254||a===100&&b>=64&&b<=127||a===192&&b===0||a===192&&b===2||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a===255)return 'reserved';
  return 'cloud';
 }
 if(net.isIPv6(ip)) {
  if(/^(fc|fd)/.test(ip))return 'lan';
  if(ip.startsWith('fe')||ip.startsWith('ff')||ip==='::'||ip.startsWith('::')||ip.startsWith('2001:db8')||ip.startsWith('2001:0:')||ip.startsWith('2001:20'))return 'reserved';
  return ip.match(/^[23]/)?'cloud':'reserved';
 }
 return 'name';
}
export function normalURL(value,{query=false}={}) {
 let u;try{u=new URL(value);}catch{throw Object.assign(new Error('接続先URLが不正です。'),{status:400});}
 invariant(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.hash&&(query||!u.search),'資格情報・フラグメントを含まないHTTP(S) URLを指定してください。');
 invariant(!/[%\\]/.test(u.hostname),'Invalid hostname');
 return u;
}
export function insideEndpoint(url,base) {
 const u=new URL(url),b=new URL(base);
 const canonical=p=>{for(let i=0;i<4&&/%[a-fA-F0-9]{2}/.test(p);i++)p=decodeURIComponent(p);
  if(p.includes('\\')||p.includes('\0')||/%(?:2e|2f|5c|25)/i.test(p))throw new Error('Ambiguous API path');return path.posix.normalize(p).replace(/\/$/,'');};
 try{const target=canonical(u.pathname),prefix=canonical(b.pathname);return u.origin===b.origin&&(target===prefix||target.startsWith(prefix+'/'));}catch{return false;}
}
export function networkDefault(){return {schema:1,revision:0,mode:'online',internetTools:false};}
export class NetworkPolicy {
 constructor(store,{lookup=dns.lookup,transport=checkedRequest}={}) {
  this.store=store;this.lookup=lookup;this.transport=transport;this.active=new Map();this.listeners=new Set();this.closed=false;
 }
 get(){return this.store.value('network-policy')||{...networkDefault(),internetTools:this.store.settings.allowNetwork};}
 change(patch,expectedRevision) {
  const old=this.get();invariant(old.revision===expectedRevision,'通信設定が更新されています。開き直してください。',409);
  invariant(patch&&Object.keys(patch).every(k=>['mode','internetTools'].includes(k)),'通信設定以外は変更できません。');
  const next={...old,...patch,revision:old.revision+1};invariant(NETWORK_MODES.includes(next.mode)&&typeof next.internetTools==='boolean','Invalid network policy');
  this.store.value('network-policy',next);
  // Cancel in-flight requests BEFORE acknowledging a narrower policy to the caller.
  for(const [c,entry] of this.active) {
   if(!this.permitted(entry.domain,entry.purpose,next))c.abort(new NetworkBlocked('通信モードが変更されました。ローカル経路を再検討します。'));
  }
  for(const fn of this.listeners)fn(next,old);
  this.store.emit('network.updated',next);return next;
 }
 permitted(domain,purpose,policy=this.get()) {
  if(domain==='device')return purpose!=='download'||policy.mode==='online';
  if(policy.mode==='offline')return false;
  if(domain==='lan')return ['model','vision','worker'].includes(purpose);
  return policy.mode==='online'&&(purpose==='model'||purpose==='vision'||policy.internetTools);
 }
 assertUncontained(kind) {
  if(this.get().mode!=='online')throw new NetworkBlocked(`${kind}は通信を封じ込められないため、制限モードでは起動しません。ローカルのファイル処理・計算は継続できます。`);
 }
 async authorize(value,{profile=null,purpose='model',allowCloud=false,signal,asset=false}={}) {
  if(this.closed)throw new NetworkBlocked('Service is closing');
  const u=normalURL(value,{query:purpose==='web'||purpose==='feed'||asset===true}),host=hostName(u);
  const lexical=host==='localhost'?'device':ipDomain(host);
  let domain=profile?.domain||(lexical==='device'?'device':'cloud');
  if(profile&&!insideEndpoint(u,profile.baseUrl))throw new NetworkBlocked('登録した推論APIの範囲外へ接続しようとしました。');
  if(profile&&!profile.enabled)throw new NetworkBlocked('この接続先は無効です。');
  if(!this.permitted(domain,purpose))throw new NetworkBlocked();
  if(domain==='cloud'&&!profile&&!allowCloud)throw new NetworkBlocked('外部通信の同意がありません。');
  if(domain==='device') {
   if(lexical!=='device')throw new NetworkBlocked('同一PCの接続先はループバックに限定します。');
   // localhost never performs an external DNS lookup.
   return {url:u,address:host==='localhost'?'127.0.0.1':host,domain,purpose,profileId:profile?.id};
  }
  if(domain==='lan') {
   if(!profile||!['model','vision','worker'].includes(purpose))throw new NetworkBlocked('LANは登録した推論機のAPIだけ許可します。');
   const pin=profile.pinnedAddress;
   if(!pin||ipDomain(pin)!=='lan')throw new NetworkBlocked('LAN推論機のプライベートIPを固定してください。');
   if(lexical!=='name'&&host!==pin)throw new NetworkBlocked('登録したLANホストと固定IPが一致しません。');
   if(u.protocol==='http:'&&!profile.allowPlainHttp)throw new NetworkBlocked('LANの平文HTTPは明示的に許可してください。');
   return {url:u,address:pin,domain,purpose,profileId:profile.id};
  }
  if(u.protocol!=='https:')throw new NetworkBlocked('外部接続にはHTTPSが必要です。');
  if(lexical!=='name'&&lexical!=='cloud')throw new NetworkBlocked('外部URLからプライベート／予約済みIPへは接続しません。');
  const addresses=lexical==='name'?await abortable(this.lookup(host,{all:true,verbatim:true}),signal):[{address:host}];
  if(!addresses.length||addresses.some(x=>ipDomain(x.address)!=='cloud'))throw new NetworkBlocked('DNSが非公開／予約済みIPを返しました。');
  // Policy may have narrowed while DNS was in flight.
  if(!this.permitted(domain,purpose))throw new NetworkBlocked();
  return {url:u,address:addresses[0].address,domain,purpose,profileId:profile?.id};
 }
 async request(url,init={},scope={}) {
  init.signal?.throwIfAborted();
  if(init.body instanceof FormData||init.body instanceof Blob){
   const encoded=new Response(init.body),bytes=new Uint8Array(await encoded.arrayBuffer());
   if(bytes.byteLength>16*1024*1024)throw new NetworkBlocked('Request body exceeds budget');
   const headers=new Headers(init.headers||{});if(!headers.has('Content-Type'))headers.set('Content-Type',encoded.headers.get('Content-Type')||'application/octet-stream');
   init={...init,headers,body:bytes};
  }
  const controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,init.signal||new AbortController().signal,AbortSignal.timeout(scope.timeoutMs||180000)]);
  const admitted=await this.authorize(url,{...scope,signal});signal.throwIfAborted();
  if(!this.permitted(admitted.domain,admitted.purpose))throw new NetworkBlocked();
  this.active.set(controller,admitted);
  const done=()=>this.active.delete(controller);
  try {
   const result=await this.transport(admitted,{...init,signal,redirect:'error'},scope);
   // A redirect may NEVER change credential scope or bypass address validation.
   if(result.status>=300&&result.status<400){await result.body?.cancel();throw new NetworkBlocked('接続先からのリダイレクトは自動追跡しません。');}
   if(!result.body){done();return result;}
   const reader=result.body.getReader();let bytes=0;
   const body=new ReadableStream({
    async pull(target){try{const x=await reader.read();if(x.done){done();reader.releaseLock();target.close();return;}
      bytes+=x.value.byteLength;if(bytes>(scope.maxBytes||4_000_000))throw Object.assign(new Error('Response exceeds budget'),{status:502});target.enqueue(x.value);
     }catch(e){done();await reader.cancel().catch(()=>{});target.error(e);}},
    async cancel(reason){done();await reader.cancel(reason).catch(()=>{});}
   });
   return new Response(body,{status:result.status,headers:result.headers});
  }catch(e){done();throw e;}
 }
 fetch(scope){return (url,init)=>this.request(url,init,scope);}
 close(){this.closed=true;for(const c of this.active.keys())c.abort(new NetworkBlocked('Service closed'));this.active.clear();}
}

/** Node core-only HTTP implementation. Uses pinned socket destination and normal TLS hostname validation. */
export function checkedRequest({url,address},init={},scope={}) {
 return new Promise((resolve,reject)=>{
  const module=url.protocol==='https:'?https:http;
  const headers=new Headers(init.headers||{});headers.set('Host',url.host);headers.set('Accept-Encoding','identity');
  const request=module.request(url,{
   method:init.method||'GET',headers:Object.fromEntries(headers),agent:false,
   servername:net.isIP(hostName(url))?undefined:hostName(url),
   lookup:(_host,options,callback)=>{const entry={address,family:net.isIP(address)};callback(null,options?.all?[entry]:address,entry.family);},
   signal:init.signal
  },response=>{
   const h=new Headers();for(let i=0;i<response.rawHeaders.length;i+=2)h.append(response.rawHeaders[i],response.rawHeaders[i+1]);
   if([204,205,304].includes(response.statusCode)){response.resume();resolve(new Response(null,{status:response.statusCode,headers:h}));return;}
   resolve(new Response(Readable.toWeb(response),{status:response.statusCode,headers:h}));
  });
  request.setTimeout(scope.idleTimeoutMs||45000,()=>request.destroy(new Error('Network idle timeout')));
  request.on('error',reject);
  if(init.body!==undefined&&init.body!==null) {
   if(typeof init.body==='string'||Buffer.isBuffer(init.body)||init.body instanceof Uint8Array)request.write(init.body);
   else {request.destroy();reject(new Error('Checked transport accepts bytes or text only'));return;}
  }
  request.end();
 });
}

function abortable(promise,signal){
 if(!signal)return promise;signal.throwIfAborted();
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
