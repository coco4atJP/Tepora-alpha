/** Isolated synthetic application-write benchmark; not physical NAND wear. */
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {NativeState} from '../core/native-state.mjs';
const AlternateCore=process.env.BENCH_NATIVE_BINARY?createRequire(import.meta.url)(path.resolve(process.env.BENCH_NATIVE_BINARY)).StateCore:null;
const open=file=>{if(!AlternateCore)return new NativeState(file);const s=Object.create(NativeState.prototype);s.core=new AlternateCore(file);return s;};
const iterations=Number(process.env.ITERATIONS||1000);
const indexedDocuments=Number(process.env.INDEXED_DOCUMENTS||2);
if(!Number.isSafeInteger(iterations)||iterations<1||!Number.isSafeInteger(indexedDocuments)||indexedDocuments<2)throw new Error('Expected positive iterations and at least two indexed documents');
const io=()=>{try{return Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\n').map(line=>{const [k,v]=line.split(':');return [k,Number(v.trim())];}));}catch{return null;}};
const results=[];
const workloads=['unchanged-kv','changed-kv','unchanged-document','changed-document','unchanged-job','job-progress','alternating-jobs','durable-events'];
for(const workload of workloads.filter(name=>!process.env.WORKLOAD||process.env.WORKLOAD.split(',').includes(name))){
 const dir=mkdtempSync(path.join(tmpdir(),'tepora-write-bench-')),file=path.join(dir,'state.sqlite'),s=open(file);
 try{
  s.call('kv.set',{key:'settings',value:{theme:'dark'}});
  s.call('document.put',{kind:'session',doc:{id:'session',status:'idle'}});
  if(indexedDocuments>2){s.exec('BEGIN');try{const insert=s.prepare('INSERT INTO content_search(kind,id,terms) VALUES(?,?,?)');for(let i=0;i<indexedDocuments-2;i++)insert.run('job',`seed-${i}`,'seed');s.exec('COMMIT');}catch(e){s.exec('ROLLBACK');throw e;}}
  for(const id of ['a','b'])s.call('document.put',{kind:'job',doc:{id,title:'same',step:0},terms:'same'});
  // Disable automatic checkpoint only in this fixture to measure appended WAL
  // bytes directly. Production journal/synchronous/checkpoint settings stay put.
  s.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0');
  const before=io(),changes=s.prepare('SELECT total_changes() AS n').get().n,start=performance.now(),cpuBefore=process.cpuUsage();
  for(let i=0;i<iterations;i++){
   if(workload==='unchanged-kv')s.call('kv.set',{key:'settings',value:{theme:'dark'}});
   else if(workload==='changed-kv')s.call('kv.set',{key:'settings',value:{theme:'dark',step:i}});
   else if(workload==='unchanged-document')s.call('document.put',{kind:'session',doc:{id:'session',status:'idle'}});
   else if(workload==='changed-document')s.call('document.put',{kind:'session',doc:{id:'session',text:'x'.repeat(4096),step:i}});
   else if(workload==='durable-events')s.call('event.append',{type:i===iterations-1?'job.error':'job.progress',data:{id:'b',step:i},at:'2026-01-01T00:00:00.000Z'});
   else s.call('document.put',{kind:'job',doc:{id:workload==='alternating-jobs'?(i%2?'b':'a'):'b',title:'same',step:workload==='job-progress'?i+1:0},terms:'same'});
  }
  const elapsedMs=performance.now()-start,cpu=process.cpuUsage(cpuBefore),after=io();
  results.push({workload,iterations,elapsedMs:Math.round(elapsedMs),cpuUserMicros:cpu.user,cpuSystemMicros:cpu.system,sqliteTotalChanges:s.prepare('SELECT total_changes() AS n').get().n-changes,walBytes:statSync(file+'-wal').size,procIo:before&&Object.fromEntries(['wchar','syscw','write_bytes'].map(k=>[k,after[k]-before[k]]))});
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({indexedDocuments,label:process.argv[2]||'current',meaning:'Synthetic logical/OS writes; not NAND bytes or SSD lifetime',results},null,2));
