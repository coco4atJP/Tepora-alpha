import test from 'node:test';
import assert from 'node:assert/strict';
import {createExecutionUI,executionStatusHTML,executionCandidatesHTML} from '../web/execution-ui.mjs';
const candidate={id:'candidate-one',jobId:'job-one',jobRevision:2,status:'staged',expectedVersion:3,sha256:'exact-hash',title:'Untrusted <script>title</script>',content:'<script>performAction()</script>'};
const snapshot={revision:4,mode:'protected',image:'',availability:{available:false,reason:'not installed'},candidates:[candidate],runs:[]};
function fixture(handler){const calls=[],sheets=[],notices=[];let open=false,privateView=true;const ui=createExecutionUI({bridge:{request:async(path,method='GET',value)=>{calls.push({path,method,value});return await handler?.(path,method,value)||(path.includes('/candidates/')?candidate:snapshot);}},openSheet:(title,html,kind)=>{sheets.push({title,html,kind});open=true;},closeSheet:()=>{open=false;},notice:s=>notices.push(s),isOpen:()=>open,isPrivate:()=>privateView});return {ui,calls,sheets,notices,close:()=>{open=false;},share:()=>{privateView=false;}};}
test('executor status fails closed and staged candidates are escaped and filtered by task',()=>{
 assert.match(executionStatusHTML(snapshot),/利用不可/);assert.match(executionStatusHTML(snapshot),/自動で切り替えません/);assert.doesNotMatch(executionStatusHTML(snapshot),/実行環境を確認済み/);
 assert.match(executionCandidatesHTML(snapshot,'job-one'),/&lt;script&gt;/);assert.doesNotMatch(executionCandidatesHTML(snapshot,'job-one'),/<script>/);assert.doesNotMatch(executionCandidatesHTML(snapshot,'other-job'),/candidate-one/);
});
test('opening config never probes, approves, or promotes and confirmation checkboxes are unchecked',async()=>{
 const f=fixture();await f.ui.open();assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');const html=f.sheets.at(-1).html;assert.doesNotMatch(html,/name="(?:approveImage|acknowledgeHostRisk)"[^>]*checked/);assert.match(html,/自動ダウンロード・インストールは行いません/);
});
test('candidate preview does not execute HTML or promote; exact pinned version/hash go to confirmation',async()=>{
 const f=fixture();await f.ui.open('job-one');await f.ui.candidate(candidate.id);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.match(f.sheets.at(-1).html,/&lt;script&gt;performAction/);assert.doesNotMatch(f.sheets.at(-1).html,/<script>/);await f.ui.promote();
 assert.deepEqual(f.calls.at(-1),{path:'/api/execution/promote',method:'POST',value:{jobId:'job-one',candidateId:'candidate-one',expectedHash:'exact-hash',expectedVersion:3}});assert.equal(f.notices.length,1);
});
test('dismissed candidate or shared view cannot promote',async()=>{
 const f=fixture();await f.ui.open();await f.ui.candidate(candidate.id);f.close();await f.ui.promote();assert.equal(f.calls.filter(c=>c.method==='POST').length,0);f.share();await assert.rejects(f.ui.promote(),/非公開/);
});
test('late candidate response cannot reopen dismissed sheet',async()=>{
 let release;const f=fixture(path=>path.includes('/candidates/')?new Promise(r=>{release=r;}):null);await f.ui.open();const read=f.ui.candidate(candidate.id);f.close();release(candidate);await read;assert.equal(f.sheets.length,2);
});
test('configuration POST uses visible revision and only explicitly checked permissions',async()=>{
 const f=fixture();await f.ui.open();const fd=new FormData();fd.set('mode','protected');fd.set('image','');await f.ui.save({dataset:{revision:'4'}},fd);assert.deepEqual(f.calls.at(-1).value,{expectedRevision:4,mode:'protected',image:'',approveImage:false,acknowledgeHostRisk:false});assert.equal(f.calls.at(-1).method,'PUT');
});

test('config explains active work blocks changes and never implies automatic cancellation',async()=>{
 const f=fixture();await f.ui.open();const html=f.sheets.at(-1).html;assert.match(html,/進行中・待機中の仕事/);assert.match(html,/自動停止は行いません/);assert.doesNotMatch(html,/name="acknowledgeStop"/);
});

test('successful probe describes image presence only and preview limitations stay explicit',()=>{
 const html=executionStatusHTML({...snapshot,availability:{available:true,reason:'installed'}});assert.match(html,/イメージの存在を確認済み（隔離は未検証）/);assert.doesNotMatch(html,/実行環境を確認済み/);assert.match(html,/エスケープしたソース表示/);assert.match(html,/外部通信がないことは保証しません/);
});
