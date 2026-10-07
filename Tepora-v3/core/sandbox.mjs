import {existsSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {invariant} from './policy.mjs';

/** Protection is off by default. When a place needs it, one setting confines what commands can write
 * (and optionally their network): Seatbelt on macOS, bubblewrap on Linux, or a container anywhere.
 * File tools enforce the same writable roots inside the service. */
export const SANDBOX_MODES=['off','workspace','readonly','container'];
export const SANDBOX_DEFAULT=Object.freeze({mode:'off',network:true,writable:[],image:'node:22-bookworm-slim',engine:'auto'});
export function sandboxConfig(raw={},previous=SANDBOX_DEFAULT){
 invariant(raw&&typeof raw==='object'&&Object.keys(raw).every(k=>['mode','network','writable','image','engine'].includes(k)),'Invalid sandbox settings');
 const c={...SANDBOX_DEFAULT,...previous,...raw};
 invariant(SANDBOX_MODES.includes(c.mode),'Unknown sandbox mode');invariant(typeof c.network==='boolean','Invalid sandbox network');
 invariant(Array.isArray(c.writable)&&c.writable.length<=16&&c.writable.every(p=>typeof p==='string'&&path.isAbsolute(p)),'Writable paths must be absolute');
 invariant(typeof c.image==='string'&&/^[\w./:@-]{1,300}$/.test(c.image),'Invalid container image');
 invariant(['auto','docker','podman'].includes(c.engine),'Invalid container engine');
 return {mode:c.mode,network:c.network,writable:[...new Set(c.writable)],image:c.image,engine:c.engine};
}
const which=name=>{try{return execFileSync(process.platform==='win32'?'where':'which',[name],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split(/\r?\n/)[0].trim()||null;}catch{return null;}};
let detected=null;
export function detectSandbox({refresh=false}={}){
 if(detected&&!refresh)return detected;
 detected={platform:process.platform,
  seatbelt:process.platform==='darwin'&&existsSync('/usr/bin/sandbox-exec'),
  bwrap:process.platform==='linux'?which('bwrap'):null,
  docker:which('docker'),podman:which('podman')};
 return detected;
}
const real=p=>{try{return realpathSync(p);}catch{return path.resolve(p);}};
export function writableRoots(policy,cwd){
 if(policy.mode==='off')return null;
 const roots=[real(os.tmpdir()),'/tmp','/private/tmp'];
 if(policy.mode!=='readonly'&&cwd)roots.push(real(cwd));
 for(const p of policy.writable||[])roots.push(real(p));
 return [...new Set(roots)];
}
/** Used by write/edit/process tools so in-service file access matches the command sandbox. */
export function assertWritable(policy,cwd,file){
 const roots=writableRoots(policy,cwd);if(!roots)return;
 let target=path.resolve(file);try{target=real(path.dirname(target))+path.sep+path.basename(target);}catch{}
 invariant(roots.some(r=>target===r||target.startsWith(r+path.sep)),`サンドボックス（${policy.mode}）では ${file} に書き込めません。書き込めるのは作業フォルダと一時フォルダです。`,403);
}
export function userShell(){
 if(process.platform==='win32')return {file:process.env.ComSpec||'cmd.exe',args:c=>['/d','/s','/c',c],name:'cmd'};
 const shell=process.env.SHELL&&existsSync(process.env.SHELL)?process.env.SHELL:'/bin/sh';
 return {file:shell,args:c=>['-c',c],name:path.basename(shell)};
}
let loginPath=null;
/** Apps started from the Dock get a bare PATH; commands should see the user's login-shell PATH. */
export function loginShellPath(){
 if(loginPath!==null)return loginPath;
 loginPath=process.env.PATH||'';
 if(process.platform==='win32')return loginPath;
 try{
  const out=execFileSync(userShell().file,['-l','-c','printf "__P__%s__P__" "$PATH"'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const m=/__P__(.*)__P__/.exec(out);if(m?.[1])loginPath=[...new Set([...m[1].split(':'),...loginPath.split(':')].filter(Boolean))].join(':');
 }catch{}
 return loginPath;
}
const seatbeltQuote=p=>'"'+p.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
export function seatbeltProfile(policy,cwd){
 const roots=writableRoots(policy,cwd);
 return ['(version 1)','(allow default)','(deny file-write*)',
  `(allow file-write* ${roots.map(r=>`(subpath ${seatbeltQuote(r)})`).join(' ')} (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/stdout") (literal "/dev/stderr"))`,
  ...(policy.network?[]:['(deny network-outbound)','(allow network-outbound (remote unix-socket))'])].join('\n');
}
/** Returns how to spawn one shell command under the policy. Never silently drops a requested sandbox. */
export function wrapCommand(command,{cwd,policy=SANDBOX_DEFAULT,containerName=null}){
 const shell=userShell(),available=detectSandbox();
 if(policy.mode==='off')return {file:shell.file,args:shell.args(command),cwd,sandbox:'off'};
 if(policy.mode!=='container'){
  if(available.seatbelt)return {file:'/usr/bin/sandbox-exec',args:['-p',seatbeltProfile(policy,cwd),shell.file,...shell.args(command)],cwd,sandbox:'seatbelt'};
  if(available.bwrap){
   const binds=policy.mode==='readonly'?[]:[cwd,...policy.writable].filter(Boolean).flatMap(p=>['--bind',p,p]);
   return {file:available.bwrap,args:['--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp',...binds,...(policy.network?[]:['--unshare-net']),'--die-with-parent','--chdir',cwd,'/bin/sh','-c',command],cwd,sandbox:'bwrap'};
  }
 }
 const engine=policy.engine==='auto'?(available.docker?'docker':available.podman?'podman':null):available[policy.engine]?policy.engine:null;
 invariant(engine,policy.mode==='container'?'コンテナ（Docker/Podman）が見つかりません。':'このOSで使えるサンドボックスがありません。コンテナ（Docker/Podman）を入れるか、サンドボックスをオフにしてください。',409);
 const mount=policy.mode==='readonly'?`${cwd}:/workspace:ro`:`${cwd}:/workspace`;
 return {file:available[engine],args:['run','--rm','-i','--init',...(containerName?['--name',containerName]:[]),'--network',policy.network?'bridge':'none','-v',mount,
  ...policy.writable.flatMap(p=>['-v',`${p}:${p}`]),'-w','/workspace',policy.image,'sh','-c',command],cwd,sandbox:engine,container:containerName};
}
export function spawnSandboxed(command,{cwd,policy,env,containerName}){
 const plan=wrapCommand(command,{cwd,policy,containerName});
 const child=spawn(plan.file,plan.args,{cwd:plan.cwd,env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
 child.plan=plan;return child;
}
