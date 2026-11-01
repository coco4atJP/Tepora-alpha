import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,open,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installNativeBinary,isDestinationBusy} from '../scripts/install-native-binary.mjs';

test('native staging preserves a mapped old binary while publishing complete new bytes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'new'),binary=path.join(dir,'runtime');await writeFile(source,'new-code');await writeFile(binary,'old-code');
 const old=await open(binary,'r');t.after(()=>old.close());
 await installNativeBinary(source,binary);
 assert.equal(await readFile(binary,'utf8'),'new-code');assert.equal(await old.readFile('utf8'),'old-code');
 assert.deepEqual((await readdir(dir)).sort(),['new','runtime']);
 await assert.rejects(installNativeBinary(path.join(dir,'missing'),binary),{code:'ENOENT'});
 assert.equal(await readFile(binary,'utf8'),'new-code');assert.deepEqual((await readdir(dir)).sort(),['new','runtime']);
});

test('a busy Windows destination is published instead of failing the install',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-install-busy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'new'),binary=path.join(dir,'runtime');await writeFile(source,'new-code');await writeFile(binary,'old-code');
 const {rename:realRename}=await import('node:fs/promises');
 const busy=Object.assign(new Error('EPERM: operation not permitted, rename'),{code:'EPERM'});
 const calls=[];
 // Windows refuses to replace a destination that another handle still holds
 // open, so the first publish attempt fails the same way it does in CI.
 const renameFile=async (from,to)=>{
  calls.push([from,to]);
  if(calls.length===1)throw busy;
  return realRename(from,to);
 };
 await installNativeBinary(source,binary,{renameFile});
 assert.equal(await readFile(binary,'utf8'),'new-code');
 assert.deepEqual((await readdir(dir)).sort(),['new','runtime']);
 assert.equal(calls.length,3,'the busy destination is retired, the new bytes are published, and the old file is removed');
});

test('a failed busy-destination publish keeps the previous binary in place',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-install-restore-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'new'),binary=path.join(dir,'runtime');await writeFile(source,'new-code');await writeFile(binary,'old-code');
 const busy=Object.assign(new Error('EPERM: operation not permitted, rename'),{code:'EPERM'});
 const {rename:realRename}=await import('node:fs/promises');
 const trace=[];
 const renameFile=async(from,to)=>{
  trace.push([path.basename(from).slice(0,12),path.basename(to).slice(0,12)]);
  // The initial publish fails because the destination is in use, then the
  // publish of the new bytes fails after the old one was moved aside.
  if(trace.length===1||trace.length===3)throw busy;
  return realRename(from,to);
 };
 await assert.rejects(installNativeBinary(source,binary,{renameFile}),{code:'EPERM'});
 assert.equal(await readFile(binary,'utf8'),'old-code','a failed publish never removes the working binary');
 assert.deepEqual((await readdir(dir)).sort(),['new','runtime'],'the retired copy is not left behind');
 assert.equal(trace.length,4,'the old binary is moved aside and then restored');
});

test('a published install is not failed by a retired file that stays in use',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-install-leftover-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'new'),binary=path.join(dir,'runtime');await writeFile(source,'new-code');await writeFile(binary,'old-code');
 const busy=Object.assign(new Error('EPERM: operation not permitted, rename'),{code:'EPERM'});
 const {rename:realRename,rm:realRm}=await import('node:fs/promises');
 let renames=0;
 const renameFile=async(from,to)=>{renames+=1;if(renames===1)throw busy;return realRename(from,to);};
 // The retired old binary is still held open, so removing it fails on Windows.
 const remove=async(file,options)=>{
  if(file.includes('.retired'))throw busy;
  return realRm(file,options);
 };
 await installNativeBinary(source,binary,{renameFile,remove});
 assert.equal(await readFile(binary,'utf8'),'new-code','the new binary is published even when the old one cannot be removed');
});

test('only an in-use destination triggers the Windows publish fallback',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-native-install-codes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'new'),binary=path.join(dir,'runtime');await writeFile(source,'new-code');await writeFile(binary,'old-code');
 const {rename:realRename}=await import('node:fs/promises');
 let calls=0;
 const renameFile=async (from,to)=>{calls+=1;if(calls===1)throw Object.assign(new Error('EIO'),{code:'EIO'});return realRename(from,to);};
 await assert.rejects(installNativeBinary(source,binary,{renameFile}),{code:'EIO'});
 assert.equal(await readFile(binary,'utf8'),'old-code');
 assert.equal(calls,1,'an unrelated failure is not retried');
 assert.equal(isDestinationBusy(Object.assign(new Error('x'),{code:'EPERM'})),true);
 assert.equal(isDestinationBusy(Object.assign(new Error('x'),{code:'EACCES'})),true);
 assert.equal(isDestinationBusy(Object.assign(new Error('x'),{code:'EBUSY'})),true);
 assert.equal(isDestinationBusy(Object.assign(new Error('x'),{code:'EIO'})),false);
 assert.equal(isDestinationBusy(null),false);
});
