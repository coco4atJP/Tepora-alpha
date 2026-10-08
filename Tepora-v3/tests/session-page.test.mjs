/** Synthetic local SQLite paging parity. No provider, policy, or filesystem
 * approval probes. The service's Number/Math.min coercion is reproduced below. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeState} from '../core/native-state.mjs';
import {SessionStore} from '../core/agent/sessions.mjs';

function fixture(t,count=1000){
 const db=new NativeState(':memory:');t.after(()=>db.close());
 const sessions=new SessionStore({db,broadcast(){}});
 db.exec('BEGIN');
 for(let n=1;n<=count;n++)sessions.append('s',n%10===0?'tool':'input',n%10===0?{content:`tool ${n}`,unknown:{preserve:true}}:{text:`line ${n} 日本語`,unknown:{preserve:true}});
 db.exec('COMMIT');
 return {db,sessions};
}
const outcome=fn=>{try{return {value:fn()};}catch(e){return {error:e.message,status:e.status};}};
const params=(before,limit)=>{const u=new URL('http://localhost/');if(before!==undefined)u.searchParams.set('before',before);if(limit!==undefined)u.searchParams.set('limit',limit);return {before:Number(u.searchParams.get('before')||0),limit:Math.min(500,Number(u.searchParams.get('limit')||150))};};

test('session pages match old route slicing for all JavaScript query coercions',t=>{
 const {sessions}=fixture(t,12);
 for(const rawBefore of [undefined,'','0','1','501','1000','1001','-2','1.5','NaN','Infinity','-Infinity','9007199254740991','-9007199254740991','9007199254740992','-9007199254740992']){
  for(const rawLimit of [undefined,'','0','-0','1','50','500','9999','-1','-500','-1001','1.9','-1.9','0.5','-0.5','NaN','Infinity','-Infinity',' 20 ','0x10','9007199254740991','-9007199254740991','9007199254740992','-9007199254740992']){
   const {before,limit}=params(rawBefore,rawLimit);
   const old=()=>before?sessions.entries('s',{to:before-1}).slice(-limit):sessions.tail('s',limit);
   const next=()=>before?sessions.page('s',before,limit):sessions.tail('s',limit);
   assert.deepEqual(outcome(next),outcome(old),`${rawBefore} / ${rawLimit}`);
  }
 }
});

test('ordinary before-pages use the bounded core operation and retain full recall',t=>{
 const {db,sessions}=fixture(t),calls=[],call=db.call.bind(db);
 db.call=(op,payload)=>{calls.push({op,payload});return call(op,payload);};
 const page=sessions.page('s',1000,150);
 assert.equal(page.length,150);assert.equal(page[0].seq,850);assert.equal(page.at(-1).seq,999);
 assert.deepEqual(calls,[{op:'session.page',payload:{id:'s',to:999,limit:150}}]);
 assert.equal(sessions.entry('s',1).text,'line 1 日本語');
 assert.equal(sessions.entries('s').length,1000);
});

test('default HTTP host uses bounded paging and preserves public tool/checkpoint projection',async t=>{
 const [{startServer},{serviceCleanup},{mkdtemp},{default:path},{default:os}]=await Promise.all([
  import('../core/server.mjs'),import('./helpers/service-cleanup.mjs'),import('node:fs/promises'),import('node:path'),import('node:os')]);
 const cleanup=serviceCleanup(t),dir=cleanup.directory(await mkdtemp(path.join(os.tmpdir(),'tepora-page-')));
 let outbound=0;const denyNetwork=()=>{outbound++;throw new Error('No external network in paging fixture');};
 const app=cleanup.service(await startServer({dir,networkOptions:{lookup:denyNetwork,transport:denyNetwork},runtimeFactory:()=>({decide:async()=>null,chat:async()=>{throw new Error('No model in paging fixture');}})}));
 const sessions=app.agent.sessions,s=sessions.create({id:'page-fixture',kind:'worker',title:'Synthetic page'});
 app.store.db.exec('BEGIN');
 for(let n=1;n<=600;n++)sessions.append(s.id,n===590?'tool':n===580?'checkpoint':'input',n===590?{content:'x'.repeat(5000)}:n===580?{upTo:570,summary:'summary',text:'private checkpoint text',ledger:{keep:true}}:{text:`row ${n}`});
 app.store.db.exec('COMMIT');
 const calls=[],call=app.store.db.call.bind(app.store.db);
 app.store.db.call=(op,payload)=>{if(payload?.id===s.id)calls.push(op);return call(op,payload);};
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0];
 const res=await fetch(`${app.origin}/api/agent/sessions/${s.id}?before=601&limit=900`,{headers:{Cookie:cookie}});
 assert.equal(res.status,200);const body=await res.json();
 assert.equal(body.entries.length,500);assert.equal(body.entries[0].seq,101);assert.equal(body.entries.at(-1).seq,600);
 assert.equal(body.entries.find(e=>e.seq===590).content.length,4000);
 assert.equal(body.entries.find(e=>e.seq===580).summary,'summary');
 assert.equal(body.entries.find(e=>e.seq===580).ledger,undefined);assert.equal(body.entries.find(e=>e.seq===580).text,undefined);
 assert.ok(calls.includes('session.page'));assert.ok(!calls.includes('session.entries'));assert.equal(outbound,0);
});
