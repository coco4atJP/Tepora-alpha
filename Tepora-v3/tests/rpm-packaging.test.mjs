import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rpmConfig} from '../scripts/bundle-rpm.mjs';

test('RPM prerelease metadata preserves the compiled application version and final-release ordering',async()=>{
 const read=async file=>JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));
 const app=await read('../desktop/tauri.conf.json'),pkg=await read('../package.json');
 assert.equal(app.version,pkg.version);
 assert.deepEqual(rpmConfig(app.version),{version:'3.0.0',bundle:{linux:{rpm:{release:'0.beta.11.1'}}}});
 assert.equal(app.version,'3.0.0-beta.11');
 assert.deepEqual(rpmConfig('3.0.0'),{version:'3.0.0',bundle:{linux:{rpm:{release:'1'}}}});
 assert.equal(rpmConfig('3.1.0-rc-1+build.2').bundle.linux.rpm.release,'0.rc_1.1');
 assert.throws(()=>rpmConfig('invalid'),/Invalid application version/);
 const linux=await read('../desktop/tauri.linux.conf.json');
 assert.deepEqual(linux.bundle.targets,['deb','appimage']);
 assert.match(pkg.scripts['postdesktop:build'],/^node scripts\/bundle-rpm.mjs &&/);
 const workflow=await readFile(new URL('../../.github/workflows/tepora-v3-beta.yml',import.meta.url),'utf8');
 assert.match(workflow.replace(/\r\n/g,'\n'),/name: Bundle RPM with prerelease package metadata\n\s+if: runner.os == 'Linux'\n\s+run: node scripts\/bundle-rpm.mjs/);
 assert.doesNotMatch(workflow,/bundle: deb,rpm/);
});
