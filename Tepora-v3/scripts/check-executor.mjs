/** Optional real-container smoke test. Never part of default CI; never installs/pulls images. */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DockerExecutor,PINNED_IMAGE} from '../core/executor.mjs';
const args=process.argv.slice(2),image=args[args.indexOf('--image')+1];
if(!args.includes('--approve-image')||!args.includes('--image')||!PINNED_IMAGE.test(image||'')){
 console.error('Usage: node scripts/check-executor.mjs --image repository@sha256:<digest> --approve-image\nThis runs the explicitly approved preinstalled image. No install or image pull.');process.exit(2);
}
const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-boundary-smoke-')),sentinel=path.join(dir,'core-sentinel.txt');
await writeFile(sentinel,randomUUID());process.env.TEPORA_CONTAINMENT_SENTINEL=randomUUID();
try{
 const executor=new DockerExecutor(),probe=await executor.probe(image);if(!probe.available)throw Error(probe.reason);
 const code=`const fs=await import('node:fs');const os=await import('node:os');let hostReadable=false,rootWritable=false;try{fs.readFileSync(input.sentinel);hostReadable=true;}catch{}try{fs.writeFileSync('/tepora-root-write-test','x');rootWritable=true;}catch{}fs.writeFileSync('/tmp/tepora-test','temporary');return {uid:process.getuid?.(),hostReadable,rootWritable,secretPresent:!!process.env.TEPORA_CONTAINMENT_SENTINEL,interfaces:Object.keys(os.networkInterfaces()),temporaryWritable:fs.readFileSync('/tmp/tepora-test','utf8')==='temporary'};`;
 const response=await executor.execute({protocol:'tepora-executor-v1',capsule:{goal:'Boundary smoke test only'},input:{sentinel},code},{image});const r=response.result;
 if(response.protocol!=='tepora-executor-v1'||response.cleanupConfirmed!==true||!Number.isInteger(r.uid)||r.uid<=0||r.hostReadable||r.rootWritable||r.secretPresent||r.interfaces.some(x=>x!=='lo')||!r.temporaryWritable)throw Error('Containment smoke check failed: '+JSON.stringify(response));
 console.log(JSON.stringify({passed:true,image,checks:r,cleanupConfirmed:true,limits:'Smoke test only. Not proof against a kernel/daemon/image compromise; not a root VM.'},null,2));
}finally{delete process.env.TEPORA_CONTAINMENT_SENTINEL;await rm(dir,{recursive:true,force:true});}
