/** Maintainer tool: refresh the pinned mesh-avatar-studio engine in web/vendor/mesh-avatar.
 * Runtime never downloads anything. This fetches the engine files at one exact commit of
 * https://github.com/shinshin86/mesh-avatar-studio (MIT), refuses any file whose SHA-256 differs from the
 * one pinned here, and records them in web/vendor/VENDOR.json. To update the engine, change COMMIT and the
 * hashes together after reviewing the diff.
 *   node scripts/vendor-mesh-avatar.mjs
 */
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),out=path.join(root,'web','vendor','mesh-avatar');
const COMMIT='8713e85a00e50f5cdf8fe33294b961d1d6506fc9';
const FILES={
 'createMeshAvatar.js':'d1cf0c8fd1b200d27b55eea853a85a5d498f82650703cfbf9473dc637c78525c',
 'renderer.js':'9946c5dac74d73dab30d85218341a0af30b7426092a4fec9653613143fa1a1f7',
 'rig.js':'dee9f60a3222ba6b812aeef29269d8fc9643629157d5276e9b282af0f1379370',
 'motion.js':'01f7603489c9e7119c40597c387e0fc4be9a38f10ff131d8be45d12bd5e6d717',
 'motions.js':'8f978c4e04b5e44cd4ab39689467f410633cdfa0aa2b841f64c12107f3f02cb5',
 'physics.js':'cab0a8e9115a14c1eb28be91afd2aa059c82f72a18c7e7585cf04110c3f2cb28',
 'sprites.js':'f300b3f5caae1da28b95e4a932885894055f2792ff29bed4d2ccd2cbac1ca407',
 'kana.js':'127013f29c92ec2547a3e3a3b985d05663f57b91edea6c0b5c4d49c05ef5b5e0'
};
const LICENSE_SHA='dccdf15e74130a2298f8d9c6038645e27f493deb6f64ff2ff3fa27e770554fbd';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const get=async url=>{const r=await fetch(url);if(!r.ok)throw new Error(`${url}: ${r.status}`);return Buffer.from(await r.arrayBuffer());};
const raw=file=>`https://raw.githubusercontent.com/shinshin86/mesh-avatar-studio/${COMMIT}/${file}`;

await mkdir(out,{recursive:true});
const manifestFiles={};
for(const [name,expected] of Object.entries(FILES)){
 const bytes=await get(raw(`src/engine/${name}`));
 if(sha(bytes)!==expected)throw new Error(`${name} does not match the pinned hash (${sha(bytes)}). Review the change before updating this script.`);
 await writeFile(path.join(out,name),bytes);manifestFiles[`mesh-avatar/${name}`]={package:'mesh-avatar-studio',source:`src/engine/${name}`,sha256:expected};
}
const license=await get(raw('LICENSE'));
if(sha(license)!==LICENSE_SHA)throw new Error('The licence text changed. Review it before updating this script.');
await writeFile(path.join(out,'LICENSE'),license);

const manifestPath=path.join(root,'web','vendor','VENDOR.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
manifest.purpose='Optional avatar rendering (3D models and mesh avatars), loaded only when the person chooses one.';
manifest.packages['mesh-avatar-studio']={version:`git ${COMMIT}`,source:'https://github.com/shinshin86/mesh-avatar-studio',license:'MIT',licenseFile:'mesh-avatar/LICENSE',copyright:'Copyright (c) 2026 Yuki Shindo'};
for(const key of Object.keys(manifest.files))if(key.startsWith('mesh-avatar/'))delete manifest.files[key];
Object.assign(manifest.files,manifestFiles);
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
console.log(`Vendored ${Object.keys(FILES).length} engine files at ${COMMIT.slice(0,10)} into ${path.relative(root,out)}`);
