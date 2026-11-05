import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Desktop,desktopBackend,helperCandidates,normalStatus} from '../core/computer/desktop.mjs';
import {computerTool,computerDescription,desktopApps,COMPUTER_DEFAULT} from '../core/computer/index.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const FAKE=path.join(root,'tests','fixtures','fake-desktop-helper.mjs');
const X11={DISPLAY:':0',XDG_SESSION_TYPE:'x11'};
const contract=JSON.parse(readFileSync(path.join(root,'core','computer','desktop-contract.json'),'utf8'));

test('the tool description is generated from the desktop backend, not hard-coded to macOS',()=>{
 for(const [platform,label]of [['darwin','macOS Accessibility'],['win32','Windows UI Automation'],['linux','Linux X11 (AT-SPI)']]){
  const d=computerDescription(desktopBackend(platform,X11));
  assert.ok(d.includes(`(and desktop apps (${label}))`),d.slice(0,120));assert.match(d,/target "desktop"/);
  assert.equal(desktopApps(desktopBackend(platform,X11)),`desktop apps (${label})`);
 }
 const wayland=computerDescription(desktopBackend('linux',{XDG_SESSION_TYPE:'wayland'}));
 assert.match(wayland,/^Operate a web browser like a person/);assert.doesNotMatch(wayland,/desktop apps|target "desktop"|macOS/);
 assert.doesNotMatch(computerDescription(desktopBackend('win32',{})),/macOS/);
});

test('every helper role is one decide.mjs can act on (the shared contract matches ax-helper.swift)',()=>{
 const swift=readFileSync(path.join(root,'core','computer','ax-helper.swift'),'utf8');
 const table=swift.slice(swift.indexOf('let roles: [String: String] = ['),swift.indexOf(']\n',swift.indexOf('let roles: [String: String] = [')));
 const swiftRoles=Object.fromEntries([...table.matchAll(/"(AX\w+)": "(\w+)"/g)].map(m=>[m[1],m[2]]));
 assert.deepEqual(contract.mac,swiftRoles);
 const decide=readFileSync(path.join(root,'core','computer','decide.mjs'),'utf8');
 const set=name=>new Set(JSON.parse(decide.match(new RegExp(`const ${name}=new Set\\((\\[[^\\]]*\\])\\)`))[1].replace(/'/g,'"')));
 const usable=new Set([...set('CLICKABLE'),...set('FIELD')]);
 // color wells have no generic action on macOS either; every other role can be clicked or filled.
 assert.deepEqual(contract.roles.filter(r=>!usable.has(r)),['color']);
 for(const table of ['mac','uia','atspi'])for(const [native,role]of Object.entries(contract[table]))assert.ok(contract.roles.includes(role),`${table} ${native} → ${role}`);
 assert.deepEqual(contract.commands.toSorted(),['choose','click','key','matches','observe','open','press','screenshot','scroll','setText','status','type','windows']);
});

test('the Rust helper is looked up next to the bundled runtime first, then in a local cargo build',()=>{
 const crate=path.join(root,'desktop-helper');
 assert.deepEqual(helperCandidates('linux',{execPath:'/opt/tepora/node-runtime',crate}),[path.join(path.dirname('/opt/tepora/node-runtime'),'tepora-desktop-helper'),path.join(crate,'target','release','tepora-desktop-helper'),path.join(crate,'target','debug','tepora-desktop-helper')]);
 assert.ok(helperCandidates('win32',{execPath:'/opt/tepora/node-runtime.exe',crate}).every(f=>f.endsWith('tepora-desktop-helper.exe')));
});

test('status is one shape for the Swift and Rust helpers',()=>{
 assert.deepEqual(normalStatus({trusted:true,screen:false},desktopBackend('darwin',{})),{backend:'macos',accessibility:true,capture:false,input:true,problem:null,trusted:true,screen:false});
 assert.deepEqual(normalStatus({backend:'linux-x11',accessibility:false,input:true,capture:true,problem:'AT-SPI bus not found'},desktopBackend('linux',X11)),{backend:'linux-x11',accessibility:false,capture:true,input:true,problem:'AT-SPI bus not found',trusted:false,screen:true});
});

test('an unsupported session refuses to start a helper with its reason',async()=>{
 const d=new Desktop({binDir:'/tmp/tepora-unused-desktop-fixture',platform:'linux',env:{XDG_SESSION_TYPE:'wayland'}});
 await assert.rejects(d.status(),e=>e.status===409&&/Wayland/.test(e.message));
 assert.equal(d.alive,false);
});

test('Windows/Linux desktop actions travel the shared JSON-lines protocol to the helper',async t=>{
 const desktop=new Desktop({binDir:'/tmp/tepora-unused-desktop-fixture',platform:'linux',env:X11,command:[process.execPath,FAKE]});
 t.after(()=>desktop.close());desktop.settle=async()=>{};
 const tool=computerTool({config:()=>({...COMPUTER_DEFAULT}),desktopClient:()=>desktop,chooser:()=>null});
 const ctx={session:{id:'fixture'}},run=a=>tool.run({target:'desktop',...a},ctx);
 assert.deepEqual(await desktop.status(),{backend:'linux-x11',accessibility:true,capture:false,input:true,problem:null,trusted:true,screen:false});
 assert.match((await run({action:'windows'})).text,/Fixture \(pid 42\): "Main" \[front\]/);
 const observed=await run({action:'observe',app:'fixture'});
 assert.match(observed.text,/e1 button "Save"/);assert.match(observed.text,/e2 password "PIN" value="••••"/);assert.doesNotMatch(observed.text,/hunter/);
 await run({action:'click',ref:'e1'});await run({action:'click',x:10,y:20});
 await run({action:'type',ref:'e2',text:'1234',submit:true});await run({action:'type',text:'hi'});
 await run({action:'select',ref:'e3',option:'Two'});await run({action:'key',keys:'Mod+L'});await run({action:'scroll'});
 await run({action:'open',app:'Fixture'});
 await assert.rejects(run({action:'click',ref:'e404'}),/No element e404/);
 const {sent}=await desktop.call('sent');
 const acts=sent.filter(r=>!['windows','observe','status'].includes(r.cmd));
 assert.deepEqual(acts,[
  {cmd:'press',pid:42,ref:'e1'},{cmd:'click',pid:42,x:10,y:20,title:''},
  {cmd:'setText',pid:42,ref:'e2',text:'1234'},{cmd:'key',pid:42,combo:'Enter'},{cmd:'type',pid:42,text:'hi'},
  {cmd:'choose',pid:42,ref:'e3',option:'Two'},{cmd:'key',pid:42,combo:'Mod+L'},{cmd:'scroll',pid:42,ref:'',dy:600},
  {cmd:'open',what:'Fixture'},{cmd:'press',pid:42,ref:'e404'},
 ]);
 assert.ok(sent.filter(r=>r.cmd==='observe').every(r=>r.pid===42&&r.title===''));
});

test('the built Rust helper speaks the contract and gives the same unsupported reasons (skipped until built)',async t=>{
 const {existsSync}=await import('node:fs'),{spawnSync}=await import('node:child_process');
 const bin=helperCandidates(process.platform).slice(1).find(f=>existsSync(f));
 if(!bin||process.platform!=='linux')return t.skip('build desktop-helper on Linux to run this');
 assert.equal(spawnSync(bin,['--contract'],{encoding:'utf8'}).stdout.trim(),contract.commands.join(' '));
 const ask=env=>spawnSync(bin,[],{env:{PATH:process.env.PATH||'',...env},encoding:'utf8',timeout:10000,input:'{"id":1,"cmd":"status"}\nnot json\n{"id":2,"cmd":"observe","pid":1}\n{"id":3,"cmd":"bogus"}\n'}).stdout.trim().split('\n').map(l=>JSON.parse(l));
 for(const env of [{},{XDG_SESSION_TYPE:'wayland',WAYLAND_DISPLAY:'wayland-0'}]){
  const [status,observe,bogus]=ask(env),js=desktopBackend('linux',env);
  assert.equal(status.ok,true);assert.equal(status.result.backend,'linux-x11');assert.equal(status.result.problem,js.message);
  assert.deepEqual([observe.id,observe.ok,observe.error],[2,false,js.message]);assert.deepEqual([bogus.id,bogus.ok],[3,false]);
 }
});
