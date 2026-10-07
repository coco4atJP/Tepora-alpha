// Frozen-source differential only. No production dependency and no host process
// launch: filesystem/shell/child modules are supplied as inert controlled facts.
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {createHash} from 'node:crypto';
const here=path.dirname(new URL(import.meta.url).pathname);
const execSource=fs.readFileSync(path.join(here,'process-oracle/exec.mjs'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
const sandboxSource=fs.readFileSync(path.join(here,'process-oracle/sandbox.mjs'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
const invariant=(v,msg,status=400)=>{if(!v)throw Object.assign(new Error(msg),{status});};
const processFacts={platform:'linux',env:{SHELL:'/bin/sh',PATH:'/usr/bin:/bin'}};
const DateFacts=class extends Date{static now(){return 10000;}};
let child;
const factory=new Function('randomUUID','spawn','StringDecoder','mkdirSync','path','spawnSandboxed','loginShellPath','userShell','invariant','process','Date',execSource+';return {terminalText,ProcessManager,withTTY,execTools};');
const exec=factory(()=> '12345678-abcd-0000-0000-000000000000',()=>{throw Error('Unexpected process launch')},StringDecoder,()=>{},path,()=>{child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=()=>{};child.stdin.end=()=>{};child.plan={sandbox:'off'};return child;},()=>'/usr/bin:/bin',()=>({name:'sh'}),invariant,processFacts,DateFacts);
const catalog=exec.execTools({processes:null,settings:()=>({})}).map(({run,stub,summarize,ephemeralKey,...d})=>({group:'extra',readOnly:false,ephemeral:false,...d}));
fs.writeFileSync(path.join(here,'../src/agent/processes/catalog.json'),JSON.stringify(catalog,null,2)+'\n');
const terminal=['','a\ra\nlast\nlast','start\r10%\r20%\r\nline\nline\nline\n\n\n','\r\r','one\r\n\r\ntwo','x\nx',' \n \n','🌱\n🌱\n🌱','\ufeff\n\ufeff','\n\nend\rend','a\r\rb\r'];
const chunks=[
 [{stream:'out',bytes:[240,159]},{stream:'err',text:'stderr'},{stream:'out',bytes:[140,177]},{stream:'err',bytes:[226,130]}],
 [{text:'\x1b[31mred\x1b[0m\x1b]0;title\x07!\x1b(B\x1b='}],
 [{text:'\x1b['},{text:'31mred'}],
 [{repeat:'a',count:199999},{text:'🌱'},{repeat:'b',count:800023}],
 [{repeat:'🌱',count:600000},{text:'TAIL'}],
 [{bytes:[226,40,161,255,240,159,140]}],
];
const output=chunks.map(chunks=>{const manager=new exec.ProcessManager();const item=manager.start('fixture',{sessionId:'s',cwd:'/work',policy:{mode:'off'}});for(const chunk of chunks){const bytes=chunk.bytes?Buffer.from(chunk.bytes):Buffer.from(chunk.repeat?chunk.repeat.repeat(chunk.count):chunk.text);child[chunk.stream==='err'?'stderr':'stdout'].emit('data',bytes);}child.emit('close',0,null);return {chunks,total:item.total,dropped:item.dropped,head:item.head.length,tail:item.tail.length,reads:[0,1,199999,200000,200001,item.total-8,item.total,item.total+5].filter(x=>x>=0).map(from=>{const text=manager.output(item,from);return {from,length:text.length,hash:createHash('sha256').update(Buffer.from(text,'utf16le')).digest('hex'),first:Array.from({length:Math.min(24,text.length)},(_,i)=>text.charCodeAt(i)),last:Array.from({length:Math.min(24,text.length)},(_,i)=>text.charCodeAt(text.length-Math.min(24,text.length)+i))};})};});
const configurations=[{},[],{mode:'workspace',network:false,writable:['/work','/work','/extra']},{mode:'readonly',image:'a/b:tag',engine:'podman'},{mode:'bad'},{mode:'off',network:0},{writable:['relative']},{image:'bad;image'},{engine:'bad'},{unknown:true}];
function sandbox(facts){const p=facts.platform==='win32'?path.win32:path.posix;return new Function('existsSync','realpathSync','os','path','spawn','execFileSync','invariant','process',sandboxSource+';return {sandboxConfig,wrapCommand,seatbeltProfile,withTTY:undefined};')((v)=>v===facts.shell||v==='/usr/bin/sandbox-exec'&&facts.seatbelt,()=>{throw Error('No realpath in pure fixture')},{tmpdir:()=>'/tmp'},p,()=>{throw Error('No process launch')},(_,args)=>{const target=facts[args[0]];if(!target)throw Error('missing');return target+'\n';},invariant,{platform:facts.platform,env:{SHELL:facts.shell||'/bin/sh',ComSpec:'cmd.exe',PATH:'/usr/bin:/bin'}});}
const defaultFacts={platform:'linux',shell:'/bin/sh'};
const config=configurations.map(raw=>{try{return {raw,expected:sandbox(defaultFacts).sandboxConfig(raw)}}catch(e){return {raw,error:e.message,status:e.status}}});
const plans=[];
for(const facts of [defaultFacts,{...defaultFacts,bwrap:'/usr/bin/bwrap'},{platform:'darwin',shell:'/bin/zsh',seatbelt:true},{...defaultFacts,docker:'/usr/bin/docker',podman:'/usr/bin/podman'},{...defaultFacts,podman:'/usr/bin/podman'}])for(const mode of ['off','workspace','readonly','container']){const policy={mode,network:false,writable:['/extra'],image:'node:22',engine:'auto'},name=mode==='container'?'tepora-p123':null;try{plans.push({facts,policy,command:"printf '%s' \"a'b\"",cwd:'/work',name,expected:sandbox(facts).wrapCommand("printf '%s' \"a'b\"",{cwd:'/work',policy,containerName:name})});}catch(e){plans.push({facts,policy,command:'true',cwd:'/work',name,error:e.message,status:e.status});}}
const metadata=exec.execTools({processes:null,settings:()=>({})});
const metaCases=[{command:'echo "hello"',id:'p1'},{command:'🌱'.repeat(50)},{command:null,id:''},{command:0,id:'p2'}].map(args=>({args,summary:metadata[0].summarize(args),stub:metadata[0].stub(args,{data:{processId:'p123',exitCode:null}}),exitStub:metadata[0].stub(args,{data:{exitCode:7}}),ephemeral:metadata[1].ephemeralKey(args)}));
fs.writeFileSync(path.join(here,'../src/agent/processes/fixtures/source.json'),JSON.stringify({terminal:terminal.map(input=>({input,expected:exec.terminalText(input)})),output,config,plans,metadata:metaCases},null,2)+'\n');
