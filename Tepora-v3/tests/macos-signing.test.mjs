import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {verifyBundleSignature} from '../scripts/verify-macos-bundle.mjs';

test('macOS bundle verification accepts a sealed app and rejects changed resources',{skip:process.platform!=='darwin'},async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-signing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=path.join(dir,'Fixture.app'),contents=path.join(app,'Contents');
 await mkdir(path.join(contents,'MacOS'),{recursive:true});await mkdir(path.join(contents,'Resources'));
 await copyFile('/usr/bin/true',path.join(contents,'MacOS','fixture'));
 await writeFile(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.tepora.signing-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 const resource=path.join(contents,'Resources','sealed.txt');await writeFile(resource,'original');
 execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',app],{stdio:'pipe',timeout:30000});
 assert.doesNotThrow(()=>verifyBundleSignature(app));
 await writeFile(resource,'tampered');
 assert.throws(()=>verifyBundleSignature(app),/codesign|resource|invalid/i);
});
