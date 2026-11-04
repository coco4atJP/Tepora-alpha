import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

for(const failure of ['mount','network','silent'])test(`bubblewrap ${failure} capability failure rejects execution without host or container fallback`,{skip:process.platform!=='linux'},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-bwrap-probe-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const marker=path.join(dir,'must-not-run');
 // Simulate an installed bwrap whose kernel permissions are insufficient. This
 // fixture checks admission only; agent-tools retains the real confinement test.
 await writeFile(path.join(dir,'bwrap'),`#!/bin/sh
case "$*" in
  *--unshare-net*) echo 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2; exit 1;;
esac
${failure==='mount'?"echo 'bwrap: Creating new namespace failed: Operation not permitted' >&2; exit 1":failure==='silent'?'exit 1':'exit 0'}
`,{mode:0o755});
 // A container executable being present must not turn a failed bwrap probe into
 // an automatic image pull or an execution with different isolation.
 await writeFile(path.join(dir,'docker'),`#!/bin/sh\necho unsafe > '${marker}'\nexit 0\n`,{mode:0o755});
 const moduleUrl=new URL('../core/sandbox.mjs',import.meta.url).href;
 const script=`
  import assert from 'node:assert/strict';
  import {detectSandbox,spawnSandboxed,wrapCommand} from ${JSON.stringify(moduleUrl)};
  const available=detectSandbox();
  assert.equal(available.bwrapNetwork,false);
  assert.equal(!!available.bwrap,${failure==='network'});
  assert.match(available.${failure==='network'?'bwrapNetworkError':'bwrapError'},/${failure==='silent'?'Command failed':'Operation not permitted'}/);
  assert.ok(available.docker);
  const options={cwd:${JSON.stringify(dir)},policy:{mode:'workspace',network:false,writable:[],engine:'auto',image:'node:22'}};
  assert.throws(()=>spawnSandboxed('echo unsafe > must-not-run',options),e=>e.status===409&&/bubblewrap/.test(e.message));
  if(${failure==='network'}){
   const plan=wrapCommand('true',{...options,policy:{...options.policy,network:true}});
   assert.equal(plan.sandbox,'bwrap');
   assert.ok(plan.args.includes('--ro-bind'));
   assert.equal(plan.args.includes('--unshare-net'),false);
  }
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH},encoding:'utf8',timeout:15000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
 await assert.rejects(stat(marker),{code:'ENOENT'});
});
