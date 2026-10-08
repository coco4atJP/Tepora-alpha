/** Interleaved same-process KV negative control; synthetic isolated databases only. */
import {NativeState} from '../core/native-state.mjs';
import {createRequire} from 'node:module';import {mkdtempSync,rmSync,statSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
if(!process.env.BENCH_NATIVE_BINARY)throw new Error('Set BENCH_NATIVE_BINARY to a separately built baseline N-API binary');
const require=createRequire(import.meta.url),base=require(path.resolve(process.env.BENCH_NATIVE_BINARY)).StateCore;
for(const change of [false,true]){
 const dirs=[mkdtempSync(path.join(tmpdir(),'pairedkv-')),mkdtempSync(path.join(tmpdir(),'pairedkv-'))];const old=Object.create(NativeState.prototype);old.core=new base(path.join(dirs[0],'s.sqlite'));const next=new NativeState(path.join(dirs[1],'s.sqlite')),dbs=[old,next],timings=[[],[]];
 try{for(const s of dbs){s.call('kv.set',{key:'settings',value:{step:0}});s.exec('PRAGMA wal_checkpoint(TRUNCATE);PRAGMA wal_autocheckpoint=0');}
 for(let block=0;block<10;block++)for(const index of (block%2?[1,0]:[0,1])){const cpu=process.cpuUsage(),start=performance.now();for(let i=0;i<500;i++)dbs[index].call('kv.set',{key:'settings',value:{step:change?block*500+i+1:0}});const c=process.cpuUsage(cpu);timings[index].push({ms:performance.now()-start,cpu:c.user+c.system});}
 console.log(JSON.stringify({change,operations:5000,timings,wal:dirs.map(d=>statSync(path.join(d,'s.sqlite-wal')).size)}));
 }finally{for(const s of dbs)s.close();for(const d of dirs)rmSync(d,{recursive:true,force:true});}
}
