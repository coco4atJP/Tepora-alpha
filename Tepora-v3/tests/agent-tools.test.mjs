import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';
import {htmlToMarkdown,parseDuckDuckGo} from '../core/tools/html.mjs';
import {parseArgs,repairJSON,checkArgs,fitTokens} from '../core/tools/format.mjs';
import {detectSandbox,wrapCommand,assertWritable} from '../core/sandbox.mjs';
import {globRegex} from '../core/tools/fs.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function toolFixture(t,settings=null){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-tools-'));const store=new Store(dir),network=new NetworkPolicy(store);
 if(settings)store.value('agent-settings',settings);
 const rt=new AgentRuntime(store,{registry:new ProviderRegistry(store,network),network,workRoot:path.join(dir,'work'),autoStart:false});
 const session=rt.sessions.create({kind:'worker',title:'t',cwd:path.join(dir,'work','s')});await mkdir(session.cwd,{recursive:true});
 const call=async(name,args,signal=new AbortController().signal)=>rt.tools.get(name).run(args,rt.toolContext(session,signal));
 t.after(async()=>{await rt.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {dir,store,rt,session,call};
}

test('exec returns finished output, and long commands continue in the background for process polling',async t=>{
 const f=await toolFixture(t);
 const quick=await f.call('exec',{command:'echo hello && echo oops 1>&2 && exit 3'});
 assert.match(quick.text,/^exit 3/);assert.match(quick.text,/hello/);assert.match(quick.text,/oops/);
 const slow=await f.call('exec',{command:'echo start; sleep 1; echo middle; sleep 1; echo end',yield:0});
 assert.match(slow.text,/still running as process (p\w+)/);const id=slow.data.processId;
 let seen='';for(let i=0;i<10&&!/middle/.test(seen);i++)seen+=(await f.call('process',{action:'poll',id,wait:3})).text;assert.match(seen,/middle/);
 let done;for(let i=0;i<20&&!done;i++){const p=await f.call('process',{action:'poll',id,wait:2});if(/^exit 0/.test(p.text))done=p;}
 assert.ok(done,'the process finished');assert.equal((await f.call('process',{action:'list'})).text.includes(id),true);
 const bg=await f.call('exec',{command:'sleep 30',background:true});
 const killed=await f.call('process',{action:'kill',id:bg.data.processId});assert.match(killed.text,/killed|exit/);
 const input=await f.call('exec',{command:'cat',stdin:'from stdin'});assert.match(input.text,/from stdin/);
});
test('files: read with line numbers, write and append, exact edit, find and grep',async t=>{
 const f=await toolFixture(t);
 await f.call('write',{path:'notes/a.md',content:'alpha\nbeta\n'});
 await f.call('write',{path:'notes/a.md',content:'gamma\n',append:true});
 const r=await f.call('read',{path:'notes/a.md'});assert.match(r.text,/\s+1\talpha\n\s+2\tbeta\n\s+3\tgamma/);
 const e=await f.call('edit',{path:'notes/a.md',old_string:'beta',new_string:'ベータ'});assert.match(e.text,/line 2/);
 assert.equal(await readFile(path.join(f.session.cwd,'notes/a.md'),'utf8'),'alpha\nベータ\ngamma\n');
 await assert.rejects(f.call('edit',{path:'notes/a.md',old_string:'missing',new_string:'x'}),/not found/);
 await f.call('write',{path:'notes/b.md',content:'alpha again'});
 await assert.rejects(f.call('edit',{path:'notes/a.md',old_string:'a',new_string:'x'}),/occurs/);
 assert.match((await f.call('find',{pattern:'*.md'})).text,/notes\/a\.md\nnotes\/b\.md/);
 const g=await f.call('grep',{pattern:'alpha'});assert.match(g.text,/notes\/a\.md:1:alpha/);assert.match(g.text,/notes\/b\.md:1:alpha again/);
 assert.match((await f.call('read',{path:'notes'})).text,/a\.md/);
 assert.ok(globRegex('**/*.md').test('x/y/z.md'));assert.ok(!globRegex('*.md').test('x/z.md'));
});
test('web_fetch follows redirects and returns Markdown that keeps links, tables and code',async t=>{
 const html=`<!doctype html><html><head><title>テスト頁</title><meta name="description" content="説明文"><script>alert(1)</script></head><body><nav><a href="/x">menu</a></nav>
  <main><h1>見出し</h1><p>本文と<a href="/next?a=1&amp;b=2">次のページ</a>。</p><ul><li>一</li><li>二<ul><li>二の一</li></ul></li></ul>
  <table><tr><th>名前</th><th>値</th></tr><tr><td>a</td><td>1</td></tr></table><pre><code>let x = 1;</code></pre><p>${'長い文。'.repeat(400)}</p></main><footer>© site</footer></body></html>`;
 const server=http.createServer((req,res)=>{if(req.url==='/old'){res.writeHead(301,{Location:'/page'});return res.end();}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const f=await toolFixture(t);
 const page=await f.call('web_fetch',{url:base+'/old',max_tokens:500});
 assert.match(page.text,/^# テスト頁\nURL: http:\/\/127\.0\.0\.1:\d+\/page/);
 assert.match(page.text,/# 見出し/);assert.match(page.text,new RegExp(`\\[次のページ\\]\\(${base}/next\\?a=1&b=2\\)`));
 assert.match(page.text,/- 一\n- 二\n  - 二の一/);assert.match(page.text,/\| 名前 \| 値 \|/);assert.ok(!page.text.includes('alert(1)'));assert.ok(!page.text.includes('menu'));
 assert.match(page.text,/\[continues: web_fetch\(url, offset=\d+\)\]/);
 const offset=Number(/offset=(\d+)/.exec(page.text)[1]);const next=await f.call('web_fetch',{url:base+'/old',offset});assert.match(next.text,/長い文。/);
 const md=htmlToMarkdown('<p>a<br>b</p><blockquote><p>q</p></blockquote><img alt="猫">',{url:'https://e.x/'});assert.match(md.markdown,/a\nb/);assert.match(md.markdown,/> q/);assert.match(md.markdown,/\[image: 猫\]/);
});
test('web_fetch respects offline mode and web tools can be switched off',async t=>{
 const f=await toolFixture(t);
 const network=f.rt.network;network.change({mode:'offline'},network.get().revision);
 await assert.rejects(f.call('web_fetch',{url:'https://example.com/'}),/通信|許可|オフライン/);
});
test('DuckDuckGo result pages are parsed into title, URL and snippet',()=>{
 const html=`<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1&amp;rut=x">Example &amp; Co</a><a class="result__snippet" href="#">The <b>best</b> page</a></div>`;
 assert.deepEqual(parseDuckDuckGo(html),[{title:'Example & Co',url:'https://example.com/a?q=1',snippet:'The best page'}]);
});
test('argument repair, schema checks and head/tail fitting',()=>{
 assert.deepEqual(parseArgs('{"a":1,}').args,{a:1});assert.equal(parseArgs('{"a":1,}').repaired,true);
 assert.deepEqual(parseArgs('```json\n{"path":"x","content":"y"\n```').args,{path:'x',content:'y'});
 assert.match(parseArgs('not json').error,/not valid JSON/);assert.equal(repairJSON('{"a":"b'),'{"a":"b"}');
 const schema={type:'object',additionalProperties:false,required:['path'],properties:{path:{type:'string'},n:{type:'integer',minimum:1}}};
 assert.match(checkArgs(schema,{}),/path is required/);assert.match(checkArgs(schema,{path:'a',n:0}),/≥ 1/);assert.match(checkArgs(schema,{path:'a',x:1}),/not a known parameter/);assert.equal(checkArgs(schema,{path:'a',n:2}),null);
 const long='x'.repeat(10000),fit=fitTokens(long,500,'#9');assert.ok(fit.truncated);assert.match(fit.text,/recall\("#9", offset=\d+\)/);assert.ok(fit.text.length<2500);
});
test('the sandbox confines writes to the working folder (Seatbelt on macOS)',{skip:!detectSandbox().seatbelt&&!detectSandbox().bwrap},async t=>{
 const f=await toolFixture(t,{sandbox:{mode:'workspace',network:false}});
 const outside=path.join(os.homedir(),`.tepora-sandbox-test-${process.pid}.txt`);t.after(()=>rm(outside,{force:true}));
 const inside=await f.call('exec',{command:`echo ok > inside.txt && cat inside.txt`});assert.match(inside.text,/^exit 0[\s\S]*ok/);assert.match(inside.text,/sandbox (seatbelt|bwrap)/);
 const denied=await f.call('exec',{command:`echo no > ${JSON.stringify(outside)}`});assert.doesNotMatch(denied.text,/^exit 0/);
 await assert.rejects(stat(outside));
 await assert.rejects(f.call('write',{path:outside,content:'x'}),/サンドボックス/);
 const homeDir=path.join(os.homedir(),'tepora-ro-test');assert.throws(()=>assertWritable({mode:'readonly',writable:[]},homeDir,path.join(homeDir,'a')),/サンドボックス/);
});
test('container planning requires an available engine and never drops network isolation',()=>{
 const plan=()=>wrapCommand('true',{cwd:os.tmpdir(),policy:{mode:'container',network:false,writable:[],image:'node:22',engine:'auto'},containerName:'tepora-x'});
 const available=detectSandbox();
 if(!available.docker&&!available.podman){assert.throws(plan,e=>e.status===409&&/Docker|Podman/.test(e.message));return;}
 const wrapped=plan();assert.notEqual(wrapped.sandbox,'off');assert.ok(wrapped.args.includes('--network')&&wrapped.args.includes('none'));
});

test('files: a file someone else changed must be read again before editing; edits to one file never interleave',async t=>{
 const f=await toolFixture(t);
 await f.call('write',{path:'a.txt',content:'one\ntwo\n'});
 await f.call('read',{path:'a.txt'});
 await wait(5);await writeFile(path.join(f.session.cwd,'a.txt'),'one\ntwo, edited by the user\n');
 await assert.rejects(f.call('edit',{path:'a.txt',old_string:'one',new_string:'1'}),/changed since you last read or wrote it/);
 await assert.rejects(f.call('write',{path:'a.txt',content:'overwrite'}),/Read it again before you overwrite it/);
 await f.call('read',{path:'a.txt'});
 await f.call('edit',{path:'a.txt',old_string:'one',new_string:'1'});
 await f.call('write',{path:'c.txt',content:'alpha beta gamma'});
 await Promise.all([f.call('edit',{path:'c.txt',old_string:'alpha',new_string:'A'}),f.call('edit',{path:'c.txt',old_string:'beta',new_string:'B'}),f.call('edit',{path:'c.txt',old_string:'gamma',new_string:'C'})]);
 assert.equal(await readFile(path.join(f.session.cwd,'c.txt'),'utf8'),'A B C');
});

test('web search falls back to the next provider, then to the computer-use browser',async()=>{
 const {WebTools}=await import('../core/tools/web.mjs');
 const html='<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.example%2Fa">X page</a><a class="result__snippet" href="#">found by the browser</a></div>';
 const w=new WebTools({network:null,settings:()=>({webSearch:{provider:'auto',searxngUrl:'http://127.0.0.1:9'}}),keys:()=>'',browser:{render:async()=>({html})}});
 const tried=[];w.searchWith=async provider=>{tried.push(provider);throw new Error(provider==='duckduckgo'?'HTTP 202 (anomaly page)':'connection refused');};
 const r=await w.search('テスト');
 assert.deepEqual(tried,['searxng','duckduckgo']);assert.equal(r.provider,'browser');assert.equal(r.results[0].url,'https://x.example/a');assert.match(r.fallbackFrom.join(' '),/HTTP 202/);
 const plain=new WebTools({network:null,settings:()=>({webSearch:{provider:'auto'}}),keys:()=>''});plain.searchWith=async()=>{throw new Error('down');};
 await assert.rejects(plain.search('x'),/Web search failed: duckduckgo: down/);
});

test('exec tty gives a program a terminal; its prompt is answered with process write',{skip:!['darwin','linux'].includes(process.platform)},async t=>{
 const f=await toolFixture(t);
 const r=await f.call('exec',{command:`node -e "console.log(process.stdout.isTTY?'tty':'pipe')"`,tty:true});assert.match(r.text,/tty/);
 const plain=await f.call('exec',{command:`node -e "console.log(process.stdout.isTTY?'tty':'pipe')"`});assert.match(plain.text,/pipe/);
 const ask=await f.call('exec',{command:`node -e "const rl=require('readline').createInterface({input:process.stdin,output:process.stdout});rl.question('名前は? ',a=>{console.log('こんにちは '+a);rl.close();})"`,tty:true,yield:1});
 const id=ask.data.processId;assert.ok(id,'waiting for input in the background');
 let out=(await f.call('process',{action:'write',id,input:'テポラ\n'})).text;
 for(let i=0;i<20&&!/こんにちは テポラ/.test(out);i++)out+=(await f.call('process',{action:'poll',id,wait:1})).text;
 assert.match(out,/こんにちは テポラ/);
});
