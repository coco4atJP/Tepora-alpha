import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {missingFiles,claimPathPatterns} from '../core/agent/runtime.mjs';
import {agentFixture} from './helpers/agent-fixture.mjs';
import {toolResults} from './helpers/scripted-model.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=8000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(15);}}

test('paths are read from Japanese and English text; URLs, versions and abbreviations are not paths',()=>{
 const s={cwd:'/nonexistent-tepora'};
 assert.deepEqual(missingFiles(s,'Saved `notes/first.txt` and notes/second.txt. v1.2 done, see https://a.com/x.html. Node.js is fine.',[{kind:'task',text:'notes/first.txtに『最初』、notes/second.txtに『次』を書いて。config.ini の port を変えて'}]),['notes/first.txt','notes/second.txt','config.ini']);
 assert.deepEqual(missingFiles(s,'Done, e.g. answer.txt',[{kind:'task',text:'result.jsonへJSONを書いて'}]),['result.json'],'a bare name only in the report is not treated as a claim');
 assert.deepEqual(missingFiles({cwd:null},'notes/a.txt',[]),[]);
});

test('a work agent that claims files it never wrote is sent back, then writes them',async t=>{
 const f=await agentFixture(t,body=>{
  const notices=body.messages.filter(m=>m.role==='user'&&String(m.content).includes('do not exist in your working folder'));
  if(!notices.length)return {content:'notes/first.txt と notes/second.txt を作成しました。'};
  const done=toolResults(body).length;
  if(done===0)return {calls:[{name:'write',args:{path:'notes/first.txt',content:'最初の下書き'}},{name:'write',args:{path:'notes/second.txt',content:'次の下書き'}}]};
  return {content:'2つのファイルを書きました。'};
 });
 const s=await f.rt.spawn(null,{task:'notes/first.txtに『最初の下書き』、notes/second.txtに『次の下書き』を書いてください。',title:'claims'});
 const end=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;});
 assert.equal(await readFile(path.join(end.cwd,'notes/second.txt'),'utf8'),'次の下書き');
 const ev=f.rt.sessions.entries(s.id,{types:['event']}).map(e=>e.event);
 assert.ok(ev.includes('missing-files'),ev.join(','));
});

test('write will not overwrite a file the agent has not read, and names a folder given as a file',async t=>{
 const {fsTools}=await import('../core/tools/fs.mjs');const {mkdtemp,writeFile:put,rm}=await import('node:fs/promises');const os=await import('node:os');
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-write-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await put(path.join(dir,'config.ini'),'host = 127.0.0.1\nport = 8080\n');await new Promise(r=>setTimeout(r,1100));
 const tools=Object.fromEntries(fsTools().map(x=>[x.name,x])),ctx={cwd:dir,files:new Map(),sandbox:{mode:'off'},session:{createdAt:new Date().toISOString()}};
 await assert.rejects(tools.write.run({path:'config.ini',content:'port=9090'},ctx),/already existed before this task .* you have not read it/);
 await put(path.join(dir,'made-by-exec.txt'),'x');await tools.write.run({path:'made-by-exec.txt',content:'y'},ctx);
 assert.equal(await readFile(path.join(dir,'made-by-exec.txt'),'utf8'),'y','a file that appeared during the task (its own command made it) can be rewritten');
 await assert.rejects(tools.write.run({path:'.',content:'x'},ctx),/is a folder, not a file/);
 await tools.read.run({path:'config.ini'},ctx);
 await tools.write.run({path:'config.ini',content:'host = 127.0.0.1\nport = 9090\n'},ctx);
 await tools.write.run({path:'new.txt',content:'a'},ctx);await tools.write.run({path:'new.txt',content:'b'},ctx);
 assert.equal(await readFile(path.join(dir,'new.txt'),'utf8'),'b','a file it wrote itself can be rewritten');
});

test('delegation safety net: a work request the character answers without tools is delegated by the harness, and the withheld reply never shows',async t=>{
 const {decisionModel}=await import('./helpers/decision-model.mjs');const {messageOf}=await import('../core/agent/ui-model.mjs');
 const d=await decisionModel((q,state)=>/memo\.txt/.test(state)?0.97:0.02);t.after(d.close);
 const f=await agentFixture(t,body=>{
  const sys=String(body.messages[0].content);
  if(sys.includes('work agent inside Tepora'))return toolResults(body).length?{content:'memo.txt を作りました。'}:{calls:[{name:'write',args:{path:'memo.txt',content:'牛乳と卵'}}]};
  const last=body.messages.at(-1),said=String(last.content);
  if(said.includes('The harness started a work agent'))return {content:'作業を始めました。'};
  if(said.includes('report from'))return {content:'NO_REPLY'};
  return {content:said.includes('memo.txt')?'ファイルは作れません。':'こんにちは！'};
 },{decision:d.url});
 const deltas=[];f.store.listeners.add(e=>{if(e.type==='agent.delta')deltas.push(e.data.text);});
 const main=f.rt.main();
 f.rt.send(main.id,{text:'こんにちは'});
 await until(()=>f.events.find(e=>e.type==='agent.reply'&&e.data.text==='こんにちは！'));
 f.rt.send(main.id,{text:'memo.txt に「牛乳と卵」と書いておいて'});
 await until(()=>f.events.find(e=>e.type==='agent.reply'&&e.data.text==='作業を始めました。'));
 assert.ok(!f.events.some(e=>e.type==='agent.reply'&&/作れません/.test(e.data.text)),'the withheld reply is not delivered');
 assert.ok(deltas.every(t=>!/作れません/.test(t||'')),'nor streamed to the screen');
 const shown=f.rt.sessions.entries(main.id).map(e=>messageOf(e,main)).filter(Boolean).map(m=>m.content);
 assert.ok(!shown.some(c=>/作れません/.test(c)),shown.join(' | '));
 const worker=await until(()=>f.rt.sessions.list({kind:'worker'}).find(w=>w.status==='done'));
 assert.equal(await readFile(path.join(worker.cwd,'memo.txt'),'utf8'),'牛乳と卵');
 assert.ok(f.rt.sessions.entries(main.id,{types:['event']}).some(e=>e.event==='auto-delegated'));
});

test('claimed files are looked up in the folders the work used: one the task names, and those the tools touched',async t=>{
 const {mkdtemp,mkdir,writeFile:put,rm}=await import('node:fs/promises');const os=await import('node:os');
 const d=await mkdtemp(path.join(os.tmpdir(),'tepora-claims-'));t.after(()=>rm(d,{recursive:true,force:true}));
 await mkdir(path.join(d,'proj'));await mkdir(path.join(d,'sess'));await put(path.join(d,'proj','fib.py'),'x');
 const s={cwd:path.join(d,'sess')};
 assert.deepEqual(missingFiles(s,'fib.py と fib.txt を作りました（/private/tmp/.../fib.py）',[{kind:'task',text:`作業フォルダ（${path.join(d,'proj')}）で fib.py と fib.txt を作って`}]),['fib.txt'],'found in the named folder; an abbreviated path is not a claim');
 await put(path.join(d,'proj','out.md'),'y');
 assert.deepEqual(missingFiles(s,'out.md を書きました',[{kind:'task',text:'out.md を書いて'}],[{name:'exec',args:{cwd:path.join(d,'proj')},data:{}}]),[]);
});

test('native claimed roots handle spaces, home paths, successful tools and absent directories',async t=>{
 const {mkdtemp,mkdir,writeFile:put,rm}=await import('node:fs/promises');const os=await import('node:os');
 const d=await mkdtemp(path.join(os.tmpdir(),'tepora-claim-roots-'));t.after(()=>rm(d,{recursive:true,force:true}));
 const project=path.join(d,'project space'),session=path.join(d,'session');await mkdir(project);await mkdir(session);
 await put(path.join(project,'found.txt'),'exists');const s={cwd:session};
 for(const text of [`Use "${project}" for found.txt and absent.txt`,`作業フォルダ（${project}）で found.txt と absent.txt`,`Use \`${project}\` for found.txt and absent.txt`]){
  assert.deepEqual(missingFiles(s,'found.txt and absent.txt',[{kind:'task',text}]),['absent.txt'],text);
 }
 const homePath='~/'+path.relative(os.homedir(),project).split(path.sep).join('/');
 assert.deepEqual(missingFiles(s,'found.txt',[{kind:'task',text:`Use "${homePath}" for found.txt`}]),[]);
 assert.deepEqual(missingFiles(s,'found.txt',[{kind:'task',text:`Use "${path.join(d,'not-created')}" for found.txt`}]),['found.txt']);
 assert.deepEqual(missingFiles(s,'found.txt',[{kind:'task',text:'found.txt'}],[{args:{cwd:project},error:'failed'}]),['found.txt'],'failed tools cannot provide a root');
 assert.deepEqual(missingFiles(s,'found.txt',[{kind:'task',text:'found.txt'}],[{args:{path:path.join(project,'other.txt')},data:{}}]),[]);
 const relative=path.join('notes','missing.txt');
 assert.deepEqual(missingFiles(s,relative,[{kind:'task',text:relative}],[{args:{path:path.join(project,relative)},data:{}}]),[],'successful touched paths use native separators');
 assert.equal(missingFiles(s,'',[{kind:'task',text:Array.from({length:12},(_,i)=>`missing${i}.txt`).join(' ')}]).length,8);
 if(process.platform==='win32'){
  const absolute=path.join(d,'absent.txt');assert.deepEqual(missingFiles(s,absolute,[{kind:'task',text:absolute}]),[absolute]);
  assert.deepEqual(missingFiles(s,'found.txt',[{kind:'task',text:'C:project found.txt'}]),['found.txt'],'drive-relative text is not an absolute named root');
 }else{
  assert.deepEqual(missingFiles(s,'found.txt',[{kind:'task',text:String.raw`C:\project found.txt`}]),['found.txt'],'foreign drive paths do not add a native root');
 }
});

// Pure grammar checks exercise Windows/UNC syntax on every host without probing a network share.
test('claim path grammar distinguishes POSIX, drive-absolute, UNC and drive-relative paths',()=>{
 const windows=claimPathPatterns(path.win32),posix=claimPathPatterns(path.posix);
 for(const root of [String.raw`C:\project space`,String.raw`C:/project space`,String.raw`\\server\share\project space`]){
  const match=[...`作業フォルダ（${root}）`.matchAll(windows.directoryPattern)];assert.equal(match.length,1);assert.equal(match[0][1],root);assert.ok(path.win32.isAbsolute(match[0][1]));
 }
 for(const absolute of [String.raw`C:\project\absent.txt`,String.raw`\\server\share\absent.txt`])assert.deepEqual([...absolute.matchAll(windows.filePattern)].map(m=>m[1]),[absolute]);
 assert.deepEqual([...String.raw`C:project`.matchAll(windows.directoryPattern)],[]);
 for(const foreign of [String.raw`C:\project`,'C:/project'])assert.deepEqual([...foreign.matchAll(posix.directoryPattern)],[]);
 assert.equal([...'/tmp/project'.matchAll(posix.directoryPattern)][0][2],'/tmp/project');
 assert.equal([..."'~/project space'".matchAll(posix.directoryPattern)][0][1],'~/project space');
});

test('Windows short-name claims preserve complete paths and match boundaries without probing UNC',()=>{
 const windows=claimPathPatterns(path.win32),posix=claimPathPatterns(path.posix);
 const scan=(text,patterns)=>[...text.replace(/https?:\/\/\S+/g,' ').matchAll(patterns.filePattern)].map(m=>m[1]);
 for(const name of [String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\absent.txt`,'C:/Users/RUNNER~1/AppData/Local/Temp/absent.txt',String.raw`\\server\share\PROJEC~1\ABSENT~1.TXT`,String.raw`~\PROJEC~1\ABSENT~1.TXT`,String.raw`.\PROJEC~1\ABSENT~1.TXT`,String.raw`\PROJEC~1\ABSENT~1.TXT`,'PROJEC~1/ABSENT~1.TXT','ABSENT~1.TXT']){
  assert.deepEqual(scan(name,windows),[name],name);assert.deepEqual(scan(name,posix),[],name);
 }
 for(const text of [String.raw`C:PROJEC~1\ABSENT~1.TXT`,String.raw`C:\PROJEC~1\ABSENT.TXT~1`,String.raw`C:\PROJEC~1\ABSENT~1.abcdefg`,'https://example.test/PROJEC~1/ABSENT~1.TXT'])assert.deepEqual(scan(text,windows),[],text);
 assert.deepEqual(scan('~/notes/absent.txt',posix),['~/notes/absent.txt']);
});

test('short-name claims use existing files and successful touched evidence on the host filesystem',async t=>{
 const {mkdtemp,mkdir,writeFile:put,rm}=await import('node:fs/promises');const os=await import('node:os');
 const d=await mkdtemp(path.join(os.tmpdir(),'tepora-short-claims-'));t.after(()=>rm(d,{recursive:true,force:true}));
 const project=path.join(d,'PROJEC~1');await mkdir(project);await put(path.join(project,'FOUND~1.TXT'),'exists');await put(path.join(project,'found.txt'),'exists');
 const s={cwd:d},missing=path.join(project,'ABSENT~1.TXT'),windows=process.platform==='win32';
 assert.deepEqual(missingFiles(s,missing),windows?[missing]:[]);
 assert.deepEqual(missingFiles(s,path.join(project,'FOUND~1.TXT')),[]);
 const relative=path.join('PROJEC~1','ABSENT~1.TXT'),inputs=[{kind:'task',text:relative}],touched=project+path.sep+'child'+path.sep+'..'+path.sep+'ABSENT~1.TXT';
 assert.deepEqual(missingFiles(s,'',inputs,[{args:{path:touched}}]),[]);
 assert.deepEqual(missingFiles(s,'',inputs,[{args:{path:touched},error:true}]),windows?[relative]:[]);
 assert.deepEqual(missingFiles(s,'ABSENT~1.TXT'),[],'report-only bare short names remain ignored');
 assert.deepEqual(missingFiles(s,'',[{kind:'task',text:`Use "${project}" for found.txt and absent.txt`}]),['absent.txt']);
});
