/** Build the development Rust HTTP host and its static JS bundle.
 * Node is a build tool here; the resulting binary never invokes it. */
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {browserBundle} from '../core/frontend.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const crate=path.join(root,'native-service'),out=path.join(root,'dist','native');
const release=process.argv.includes('--release'),cargo=process.env.CARGO||'cargo';
const args=['build','--locked','--manifest-path',path.join(crate,'Cargo.toml')];
if(release)args.push('--release');
const build=spawnSync(cargo,args,{stdio:'inherit'});
if(build.error)throw new Error('Install the official Rust toolchain before building the native service.',{cause:build.error});
if(build.status!==0)process.exit(build.status||1);
await mkdir(out,{recursive:true});
await writeFile(path.join(out,'app.bundle.js'),await browserBundle(path.join(root,'web')));
const info=spawnSync('rustc',['-vV'],{encoding:'utf8'}),host=process.env.CARGO_BUILD_TARGET||info.stdout?.match(/^host: (.+)$/m)?.[1];
// Metadata also resolves dev dependencies, which a normal build need not cache.
// Keep the full locked graph for notices; honor Cargo's inherited offline policy.
const metadata=spawnSync(cargo,['metadata','--locked','--format-version','1','--filter-platform',host,'--manifest-path',path.join(crate,'Cargo.toml')],{encoding:'utf8',maxBuffer:32*1024*1024});
if(metadata.status!==0)throw new Error('Cannot collect native dependency notices: '+metadata.stderr);
const resolved=JSON.parse(metadata.stdout),notices=['Tepora native service — third-party dependency notices\n'];
for(const pkg of resolved.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name))){
 const folder=path.dirname(pkg.manifest_path);notices.push('\n=== '+pkg.name+' '+pkg.version+' ('+(pkg.license||'see license file')+') ===\n'+(pkg.repository||'')+'\n');
 const files=(await readdir(folder)).filter(name=>/^(licen[cs]e|copying|copyright)([._-]|$)/i.test(name));
 if(pkg.license_file&&!files.includes(pkg.license_file))files.push(pkg.license_file);
 for(const name of files){try{notices.push('\n--- '+name+' ---\n'+await readFile(path.join(folder,name),'utf8'));}catch(error){if(error.code!=='EISDIR')throw error;}}
}
// This adaptation is local source, so it does not appear in Cargo metadata.
// A binary distribution must carry its retained notice as well as crate notices.
const v8NoticePath='src/workspace/display_avatar/V8-LICENSE.txt';
let v8Notice;
try {v8Notice=await readFile(path.join(crate,v8NoticePath),'utf8');}
catch(cause){throw new Error('Required V8 date-parser license notice is missing or unreadable: '+v8NoticePath,{cause});}
if(!v8Notice.trim())throw new Error('Required V8 date-parser license notice is empty: '+v8NoticePath);
notices.push('\n=== V8 DateParser adaptation (BSD-3-Clause; V8 tag 12.4.254) ===\nhttps://github.com/v8/v8/tree/12.4.254/src/date\n\n--- V8-LICENSE.txt ---\n'+v8Notice);
await writeFile(path.join(out,'THIRD-PARTY-LICENSES.txt'),notices.join('\n'));
console.log('Built developmental native service and static bundle. Normal launch remains unchanged.');
