/** Fail packaging on an unsealed/tampered app or an unusable hardened Node sidecar. */
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

export function verifyBundleSignature(app){
 execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],{stdio:'pipe',timeout:60000});
}

export function verifyMacOSBundle(app){
 verifyBundleSignature(app);
 const contents=path.join(app,'Contents'),node=path.join(contents,'MacOS','node-runtime'),addon=path.join(contents,'Resources','v3','core','native','tepora_core.node');
 for(const binary of [node,addon])execFileSync('/usr/bin/codesign',['--verify','--strict',binary],{stdio:'pipe',timeout:30000});
 // Exercise the re-signed V8 runtime and load the actual SQLite owner without opening user data.
 const output=execFileSync(node,['--input-type=commonjs','--eval',"require(process.argv[1]); let n=0; for(let i=0;i<100000;i++)n+=Math.sqrt(i); if(!Number.isFinite(n))process.exit(1); console.log('signed Node and Rust addon loaded');",addon],{encoding:'utf8',timeout:30000});
 return output.trim();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 if(process.platform!=='darwin')console.log('macOS bundle verification: not applicable on this platform.');
 else{
  const app=path.resolve(process.argv[2]||fileURLToPath(new URL('../desktop/target/release/bundle/macos/Tepora V3 Beta.app',import.meta.url)));
  console.log(verifyMacOSBundle(app));console.log(`Verified sealed macOS bundle: ${app}`);
 }
}
