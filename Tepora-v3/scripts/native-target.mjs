/** A packaged addon and sidecar must run in the same process architecture.
 * Cross-compiling the desktop alone does not cross-compile the bundled Node. */
export function assertNodeTarget(target,{platform=process.platform,arch=process.arch}={}){
 const targetPlatform=target.includes('windows')?'win32':target.includes('apple-darwin')?'darwin':target.includes('linux')?'linux':null;
 const cpu=target.split('-')[0];
 const targetArch=cpu==='x86_64'?'x64':cpu==='aarch64'?'arm64':/i[3-6]86/.test(cpu)?'ia32':cpu.startsWith('arm')?'arm':null;
 if(targetPlatform!==platform||targetArch!==arch)throw new Error(`Rust target ${target} does not match Node ${platform}/${arch}. Use a matching Node executable and Rust target; cross-target Node sidecar packaging is not supported.`);
 return target;
}

/** Desktop packages ship for Windows, macOS and Linux (x64/arm64, glibc). */
export function assertPackagingTarget(target){
 const supported=/^(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-gnu)$/.test(target);
 if(!supported)throw new Error(`Native packaging supports Windows, macOS and Linux (x86_64/aarch64, glibc) only; got ${target}.`);
 return target;
}
