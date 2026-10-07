/** Maintainer tool: refresh the pinned VRM rendering libraries in web/vendor.
 * Runtime never downloads anything. This script fetches exact npm tarballs, verifies their
 * registry integrity, rewrites bare "three" imports to relative files, and records hashes.
 *   node scripts/vendor-vrm.mjs
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'web','vendor');
const PACKAGES={
 three:{version:'0.186.1',integrity:'sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA=='},
 '@pixiv/three-vrm':{version:'3.5.5',integrity:'sha512-RPXy7jYAXs704NIpZlosB0U2ENu21G9DrqGWdQgRe8dShaCo1ugpj+6BVPRCy91nt+MPMA96j5rbsSzEl0HlQA=='}
};
const FILES=[
 ['three','build/three.core.js','three.core.js',s=>s],
 ['three','build/three.module.js','three.module.js',s=>s],
 ['three','examples/jsm/loaders/GLTFLoader.js','GLTFLoader.js',s=>s.replace("} from 'three';","} from './three.module.js';").replace("'../utils/BufferGeometryUtils.js'","'./BufferGeometryUtils.js'").replace("'../utils/SkeletonUtils.js'","'./SkeletonUtils.js'")],
 ['three','examples/jsm/utils/BufferGeometryUtils.js','BufferGeometryUtils.js',s=>s.replace("} from 'three';","} from './three.module.js';")],
 ['three','examples/jsm/utils/SkeletonUtils.js','SkeletonUtils.js',s=>s.replace("} from 'three';","} from './three.module.js';")],
 ['@pixiv/three-vrm','lib/three-vrm.module.min.js','three-vrm.module.min.js',s=>s.replaceAll('from"three"','from"./three.module.js"')]
];
const sha=b=>createHash('sha256').update(b).digest('hex');
const temp=await mkdtemp(path.join(os.tmpdir(),'tepora-vendor-'));
try{
 const extracted={};
 for(const [name,{version,integrity}] of Object.entries(PACKAGES)){
  const packed=JSON.parse(execFileSync('npm',['pack',`${name}@${version}`,'--json','--pack-destination',temp],{encoding:'utf8',shell:process.platform==='win32'}))[0];
  if(packed.integrity!==integrity)throw new Error(`${name}@${version} integrity changed: ${packed.integrity}`);
  const dir=path.join(temp,name.replace(/[@/]/g,'_'));await mkdir(dir,{recursive:true});
  execFileSync('tar',['-xzf',path.join(temp,packed.filename),'-C',dir]);extracted[name]=path.join(dir,'package');
 }
 await mkdir(out,{recursive:true});const manifest={purpose:'Optional VRM avatar rendering, loaded only when the user selects a local VRM model.',packages:{},files:{}};
 for(const [name,{version,integrity}] of Object.entries(PACKAGES))manifest.packages[name]={version,integrity,license:'MIT'};
 for(const [pkg,source,target,transform] of FILES){
  const original=await readFile(path.join(extracted[pkg],source),'utf8'),rewritten=transform(original);
  if(/from\s*["']three["']/.test(rewritten))throw new Error(`${target} still imports the bare "three" specifier`);
  await writeFile(path.join(out,target),rewritten);manifest.files[target]={package:pkg,source,sha256:sha(rewritten)};
 }
 await writeFile(path.join(out,'LICENSE-three.txt'),await readFile(path.join(extracted.three,'LICENSE')));
 await writeFile(path.join(out,'LICENSE-three-vrm.txt'),await readFile(path.join(extracted['@pixiv/three-vrm'],'LICENSE')));
 await writeFile(path.join(out,'VENDOR.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(`Vendored ${FILES.length} files into ${path.relative(root,out)}`);
}finally{await rm(temp,{recursive:true,force:true});}
