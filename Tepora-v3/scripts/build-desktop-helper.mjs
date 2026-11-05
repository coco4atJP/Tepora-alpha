/** Build tepora-desktop-helper (Windows UI Automation / Linux X11 AT-SPI desktop control) and its dependency
 * notices. macOS keeps its Swift helper, so there is nothing to build there.
 * CLI: node scripts/build-desktop-helper.mjs [--release] [--target <triple>] [--install <dir>] */
import {spawnSync} from 'node:child_process';
import {copyFile,mkdir,readFile,readdir,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const HELPER_CRATE=path.join(root,'desktop-helper');
/** Only Windows and Linux use the Rust helper. */
export const helperTarget=triple=>/windows|linux/.test(triple);
export async function buildDesktopHelper({release=true,target='',cargo=process.env.CARGO||'cargo'}={}){
 const manifest=path.join(HELPER_CRATE,'Cargo.toml'),args=['build','--locked','--manifest-path',manifest];
 if(release)args.push('--release');if(target)args.push('--target',target);
 const build=spawnSync(cargo,args,{stdio:'inherit'});
 if(build.error)throw new Error('Install the official Rust toolchain before building the desktop helper.',{cause:build.error});
 if(build.status!==0)throw new Error('The desktop helper failed to build.');
 const file=(target?target.includes('windows'):process.platform==='win32')?'tepora-desktop-helper.exe':'tepora-desktop-helper';
 return path.join(HELPER_CRATE,'target',...(target?[target]:[]),release?'release':'debug',file);
}
/** Third-party notices for exactly the crates linked for `triple` (the Windows and Linux graphs differ). */
export async function desktopHelperNotices(triple,{cargo=process.env.CARGO||'cargo'}={}){
 const metadata=spawnSync(cargo,['metadata','--locked','--format-version','1','--filter-platform',triple,'--manifest-path',path.join(HELPER_CRATE,'Cargo.toml')],{encoding:'utf8',maxBuffer:32*1024*1024});
 if(metadata.status!==0)throw new Error('Cannot collect desktop helper dependency notices: '+metadata.stderr);
 const resolved=JSON.parse(metadata.stdout),byId=new Map(resolved.packages.map(p=>[p.id,p]));
 // Normal (non-dev, non-build) dependencies reachable from the helper for this platform.
 const nodes=new Map(resolved.resolve.nodes.map(n=>[n.id,n])),linked=new Set(),stack=[resolved.resolve.root];
 while(stack.length){const id=stack.pop();if(linked.has(id))continue;linked.add(id);
  for(const d of nodes.get(id)?.deps||[])if(d.dep_kinds.some(k=>k.kind===null||k.kind==='normal'))stack.push(d.pkg);}
 const notices=['Tepora desktop helper ('+triple+') — third-party dependency notices\n'];
 for(const pkg of [...linked].map(id=>byId.get(id)).filter(p=>p?.source).sort((a,b)=>a.name.localeCompare(b.name))){
  const folder=path.dirname(pkg.manifest_path);notices.push('\n=== '+pkg.name+' '+pkg.version+' ('+(pkg.license||'see license file')+') ===\n'+(pkg.repository||'')+'\n');
  const files=(await readdir(folder)).filter(name=>/^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(name));
  if(pkg.license_file&&!files.includes(pkg.license_file))files.push(pkg.license_file);
  for(const name of files){try{notices.push('\n--- '+name+' ---\n'+await readFile(path.join(folder,name),'utf8'));}catch(error){if(error.code!=='EISDIR')throw error;}}
 }
 return {text:notices.join('\n'),packages:[...linked].map(id=>byId.get(id)).filter(p=>p?.source).map(p=>({name:p.name,version:p.version,license:p.license}))};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:'';};
 const bin=await buildDesktopHelper({release:argv.includes('--release'),target:opt('--target')});
 const install=opt('--install');
 if(install){await mkdir(install,{recursive:true});const dest=path.join(install,path.basename(bin));await copyFile(bin,dest);await chmod(dest,0o755);console.log('Installed '+dest);}
 else console.log('Built '+bin);
}
