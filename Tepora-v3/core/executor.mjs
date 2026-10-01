import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {invariant} from './policy.mjs';

export const PINNED_IMAGE=/^[a-z0-9][a-z0-9./:_-]{0,240}@sha256:[a-f0-9]{64}$/;
// The host never evaluates this program. Only the explicitly configured image runs it.
export const CONTAINER_RUNNER=`let s='';for await(const c of process.stdin){s+=c;if(s.length>1000000)throw Error('Input limit');}const p=JSON.parse(s);const fn=new (Object.getPrototypeOf(async function(){}).constructor)('capsule','input',p.code);const result=await fn(p.capsule,p.input);process.stdout.write(JSON.stringify({protocol:'tepora-executor-v1',result}));`;
export function dockerArguments(image,name){
 invariant(PINNED_IMAGE.test(image),'An installed image pinned by sha256 digest is required');
 invariant(/^tepora-[a-f0-9-]{36}$/.test(name),'Invalid container name');
 return ['run','--rm','--pull=never','--name',name,'--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65534:65534','--pids-limit=64','--memory=256m','--cpus=1','--tmpfs=/tmp:rw,noexec,nosuid,size=67108864','--workdir=/tmp','--env=HOME=/tmp','--log-driver=none','--entrypoint=node','-i',image,'--input-type=module','-e',CONTAINER_RUNNER];
}
/** Bounded stdio. No inherited secrets, shell, host working directory or mounts. */
export function processEnvelope(executable,args,payload,{signal,timeout=30000,maxBytes=1000000,raw=false}={}){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{shell:false,windowsHide:true,env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT},stdio:['pipe','pipe','pipe']});
  let out=[],err=[],bytes=0,error,done=false;
  const stop=e=>{error=e;child.kill('SIGKILL');};
  const abort=()=>stop(signal.reason||new Error('Executor cancelled'));
  const timer=setTimeout(()=>stop(new Error('Executor timed out')),timeout);
  signal?.addEventListener('abort',abort,{once:true});
  const finish=(e,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);e?reject(e):resolve(value);};
  child.on('error',e=>finish(e));child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>maxBytes)stop(new Error('Executor output limit exceeded'));else out.push(b);});
  child.stderr.on('data',b=>{if(Buffer.concat(err).length<4000)err.push(b.subarray(0,1000));});
  child.on('close',code=>{if(error)return finish(error);if(raw)return finish(null,{exitCode:code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()});if(code!==0)return finish(new Error(`Executor exited ${code}: ${Buffer.concat(err).toString().slice(0,2000)}`));
   try{finish(null,JSON.parse(Buffer.concat(out).toString()));}catch{finish(new Error('Executor did not return one valid protocol envelope'));}});
  child.stdin.end(JSON.stringify(payload));
 });
}
export class DockerExecutor {
 constructor({run=processEnvelope}={}){this.run=run;}
 descriptor(){return {kind:'docker',isolation:'container',network:'none',mounts:[],root:false,verified:false};}
 async probe(image){
  if(!PINNED_IMAGE.test(image))return {available:false,reason:'A preinstalled, explicitly approved digest-pinned Node image is required.'};
  try{
   const result=await this.run('docker',['image','inspect','--format','{{json .Id}}',image],null,{timeout:5000,maxBytes:4000});
   return {available:typeof result==='string'&&/^sha256:[a-f0-9]{64}$/.test(result),reason:'Image inspected; actual containment is not verified until a real execution is tested.'};
  }catch{return {available:false,reason:'Docker or the pinned image is unavailable. No host fallback and no automatic pull.'};}
 }
 async execute(payload,{signal,image,containerName}){
  const name=containerName||`tepora-${randomUUID()}`;
  let response,error,cleanupConfirmed=false;
  try{response=await this.run('docker',dockerArguments(image,name),payload,{signal});}catch(e){error=e;}
  try{const cleanup=await this.run('docker',['rm','-f',name],null,{timeout:5000,maxBytes:4000,raw:true});cleanupConfirmed=cleanup.exitCode===0||/No such container/i.test(cleanup.stderr||'');}catch{}
  if(error){error.cleanupConfirmed=cleanupConfirmed;throw error;}
  return {...response,cleanupConfirmed};
 }
}
