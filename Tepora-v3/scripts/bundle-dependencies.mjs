/** Copy only lockfile-resolved production modules, including licenses; never install at runtime. */
import {readFile,cp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
export async function bundleDependencies(root,destination){
 const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
 const entries=Object.entries(lock.packages||{}).filter(([name,p])=>name.startsWith('node_modules/')&&!p.dev&&!p.devOptional);
 if(!entries.some(([name])=>name==='node_modules/@earendil-works/pi-ai'))throw Error('Pinned pi-ai production dependency is missing from the lockfile.');
 await rm(path.join(destination,'node_modules'),{recursive:true,force:true});await mkdir(destination,{recursive:true});
 for(const [name,pkg] of entries){
  if(pkg.os&&!pkg.os.includes(process.platform)||pkg.cpu&&!pkg.cpu.includes(process.arch))continue;
  if(name.includes('..')||path.isAbsolute(name))throw Error('Invalid locked dependency path');
  try{await cp(path.join(root,name),path.join(destination,name),{recursive:true,filter:src=>!src.endsWith('.map')});}
  catch(e){if(!pkg.optional||e.code!=='ENOENT')throw e;}
 }
 await cp(path.join(root,'package.json'),path.join(destination,'package.json'));
 return entries.length;
}
