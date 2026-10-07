import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {Capabilities} from '../core/capabilities.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';
import {ComputerUse,renderObservation} from '../core/computer/index.mjs';
import {findBrowser,keyEvents} from '../core/computer/browser.mjs';
import {shortlist,checkAll,matchField,runGoal} from '../core/computer/decide.mjs';
import {scriptedModel,toolResults} from './helpers/scripted-model.mjs';
import {decisionModel} from './helpers/decision-model.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=20000){const start=Date.now();for(;;){const v=await fn();if(v)return v;if(Date.now()-start>timeout)throw new Error('Condition timed out');await wait(20);}}
const FORM=`<!doctype html><html><head><title>申込フォーム</title></head><body><h1>申込</h1>
<label>お名前 <input id=n></label><label>都市 <select id=c><option>大阪</option><option>東京</option></select></label>
<label><input type=checkbox id=agree> 規約に同意する</label>
<button onclick="document.getElementById('s').textContent=document.getElementById('agree').checked?'送信済み: '+document.getElementById('n').value+' / '+document.getElementById('c').value:'同意が必要です'">送信</button>
<p id=s>未送信</p><div style="height:3000px"></div><a href="/far">ページ下のリンク</a></body></html>`;
async function site(t){
 const server=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(FORM);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 return `http://127.0.0.1:${server.address().port}/`;
}
async function harness(t,handler,{decision=null}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-cu-'));const store=new Store(dir),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network);
 const model=await scriptedModel(handler);
 registry.save({profiles:[{id:'local',protocol:'chat-completions',baseUrl:model.url,model:'m',domain:'device',capabilities:{tools:true}}],routes:{main:{primary:'local'}}},0);
 const capabilities=new Capabilities(store,network);
 if(decision)capabilities.save({profiles:[{id:'d1',name:'decision',protocol:'system-one',baseUrl:decision,model:'d1:test',domain:'device'}],routes:{decision:'d1'}},capabilities.get().revision);
 const computer=new ComputerUse(store,network,{dataDir:dir,registry});
 const rt=new AgentRuntime(store,{registry,network,capabilities,computer,workRoot:path.join(dir,'work'),autoStart:false});
 t.after(async()=>{await rt.close();await computer.close();capabilities.close();store.close();await model.close();await rm(dir,{recursive:true,force:true});});
 return {rt,computer,model,store,dir};
}
const browser=findBrowser();

test('decision shortlist, local checks and key events (no browser needed)',()=>{
 const obs={url:'https://x/',title:'t',text:'未送信',scroll:{y:0,height:4000,viewport:900},elements:[
  {ref:'e1',role:'textbox',name:'お名前',value:'',inView:true},{ref:'e2',role:'combobox',name:'都市',value:'大阪',options:['大阪','東京'],inView:true},
  {ref:'e3',role:'checkbox',name:'規約に同意する',checked:false,inView:true},{ref:'e4',role:'button',name:'送信',inView:true},{ref:'e5',role:'link',name:'ページ下のリンク',inView:false}]};
 const c=shortlist(obs,{goal:'名前を入れて送信する',inputs:{'お名前':'山田','都市':'東京'}},[]);
 assert.deepEqual(c.slice(0,2).map(x=>x.id),['fill_e1','fill_e2']);assert.equal(c.find(x=>x.id==='fill_e2').op,'select');
 assert.ok(c.some(x=>x.id==='click_e4'));assert.ok(c.some(x=>x.id==='scroll_down'));assert.deepEqual(c.slice(-3).map(x=>x.id),['wait','done','blocked']);assert.ok(c.length<=16);
 assert.equal(matchField(obs.elements,'名前').el.ref,'e1');assert.equal(checkAll(obs,[{text_includes:'未送信'}]),true);assert.equal(checkAll(obs,[{field:'都市',equals:'東京'}]),false);
 assert.equal(keyEvents('Control+A')[0].modifiers,2);assert.equal(keyEvents('Enter')[0].text,'\r');assert.throws(()=>keyEvents('Hyper+Q'),/Unknown key|Unknown/);
});

test('runGoal stops on low confidence, on an action that changes nothing, and when going in circles',async()=>{
 const obs={title:'t',text:'',elements:[{ref:'a1',role:'button',name:'OK',inView:true}]};
 const surface={observe:async()=>obs,act:async()=>{},settle:async()=>{}};
 const unsure=await runGoal(surface,{goal:'press OK'},{choose:async(s,c)=>({choice:'click_a1',probabilities:{click_a1:0.4,wait:0.35,done:0.15,blocked:0.1}})});
 assert.equal(unsure.status,'uncertain');assert.match(unsure.detail,/click button "OK" \(0\.40\)/);
 // An action that changed nothing is not offered again; with nothing else to do the model reports blocked.
 const offered=[];
 const stuck=await runGoal(surface,{goal:'press OK'},{choose:async(s,c)=>{offered.push(Object.keys(c));return c.click_a1?{choice:'click_a1',probabilities:{click_a1:0.95,wait:0.05}}:{choice:'blocked',probabilities:{blocked:0.9,wait:0.1}};}});
 assert.equal(stuck.status,'blocked');assert.equal(stuck.steps[0].changed,false);assert.deepEqual(offered[1],['wait','done','blocked']);
 let on=false;const toggle={observe:async()=>({title:'t',text:'',elements:[{ref:'a1',role:'checkbox',name:'X',checked:on,inView:true}]}),act:async()=>{on=!on;},settle:async()=>{}};
 const circles=await runGoal(toggle,{goal:'set X'},{choose:async(s,c)=>'click_a1' in c?{choice:'click_a1',probabilities:{click_a1:0.95,blocked:0.05}}:{choice:'blocked',probabilities:{blocked:0.95,wait:0.05}}});
 assert.equal(circles.status,'blocked');assert.ok(circles.steps.length<=5,`${circles.steps.length} steps`);
});

test('browser: direct actions through the computer tool, headless',{skip:!browser},async t=>{
 const url=await site(t);
 const f=await harness(t,body=>{
  const r=toolResults(body);
  const steps=[{action:'open',url},{action:'type',ref:'e1',text:'山田太郎'},{action:'select',ref:'e2',option:'東京'},{action:'click',ref:'e3'},{action:'click',ref:'e4'},{action:'screenshot'}];
  if(r.length<steps.length)return {calls:[{name:'computer',args:steps[r.length]}]};
  return {content:r.map(x=>x.content.split('\n')[0]).join(' | ')+' || '+(/送信済み: 山田太郎 \/ 東京/.test(r[4].content)?'OK':'NG')};
 });
 const s=await f.rt.spawn(null,{task:'申込フォームに入力して送信する',toolset:'worker'});
 f.rt.send?.(s.id,{text:'go',kind:'message'});f.rt.wake(s.id);
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;},60000);
 assert.match(done.result,/\|\| OK$/,done.result);
 const shot=f.rt.sessions.entries(s.id,{types:['tool']}).find(e=>e.images?.length);assert.equal(shot.images[0].mime,'image/jpeg');assert.ok(shot.images[0].width>=800);
 assert.equal(f.computer.browser.pages.has(s.id),false,'the tab is released when the work is done');
});

test('browser: "do" — the decision model operates the form until the local check passes',{skip:!browser},async t=>{
 const url=await site(t);
 const d=await decisionModel((q,state,name)=>{
  const keys=Object.keys(q.criteria||{}),s=JSON.parse(state);
  if(keys.includes('fill_e1'))return 'fill_e1';if(keys.includes('fill_e2'))return 'fill_e2';
  const box=s.controls.find(c=>c.name==='規約に同意する');if(box&&!box.checked)return `click_${box.ref}`;
  if(/送信済み/.test(s.visible_text))return 'done';
  return keys.find(k=>q.criteria[k].includes('"送信"'))||'blocked';
 });t.after(d.close);
 const f=await harness(t,body=>{
  const r=toolResults(body);
  if(!r.length)return {calls:[{name:'computer',args:{action:'open',url}}]};
  if(r.length===1)return {calls:[{name:'computer',args:{action:'do',goal:'名前と都市を入れ、規約に同意して送信する',done_when:'「送信済み」と表示される',inputs:{'お名前':'鈴木花子','都市':'東京'},checks:[{text_includes:'送信済み: 鈴木花子 / 東京'}]}}]};
  return {content:r[1].content};
 },{decision:d.url});
 const s=await f.rt.spawn(null,{task:'フォームを送信'});f.rt.wake(s.id);
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;},60000);
 assert.match(done.result,/^completed \(verified\)/,done.result);
 assert.match(done.result,/type the supplied text for "お名前"[\s\S]*choose the supplied option "東京"[\s\S]*click checkbox "規約に同意する" \(currently unchecked\)[\s\S]*click button "送信"/);
 assert.ok(d.requests.every(r=>Object.keys(r.questions.action.criteria).length<=16));
});

test('browser: "do" without a decision model — the agent\'s own model chooses from the same shortlist',{skip:!browser},async t=>{
 const url=await site(t);
 const f=await harness(t,body=>{
  if(body.messages[0].content.includes('You choose the next user-interface action')){
   const u=body.messages[1].content,ids=[...u.matchAll(/^(\w+): /gm)].map(m=>m[1]),state=JSON.parse(/\n(\{[\s\S]*\})\n\nOptions:/.exec(u)[1]);
   if(/送信済み/.test(state.visible_text))return {content:'done'};
   const desc=i=>u.split('\n').find(l=>l.startsWith(i+':'))||'',box=state.controls.find(c=>c.name==='規約に同意する');
   return {content:ids.find(i=>i.startsWith('fill_'))||(box&&!box.checked?ids.find(i=>/checkbox "規約/.test(desc(i))):null)||ids.find(i=>/"送信"/.test(desc(i)))||'blocked'};
  }
  const r=toolResults(body);
  if(!r.length)return {calls:[{name:'computer',args:{action:'do',url,goal:'名前を入れて同意し送信',inputs:{'お名前':'佐藤'},checks:[{text_includes:'送信済み: 佐藤'}]}}]};
  return {content:r[0].content};
 });
 const s=await f.rt.spawn(null,{task:'送信'});f.rt.wake(s.id);
 const done=await until(()=>{const x=f.rt.sessions.get(s.id);return x.status==='done'&&x;},60000);
 assert.match(done.result,/^completed \(verified\)/,done.result);assert.match(done.result,/chat model/);
});

test('observation text lists controls in view and the screen text',()=>{
 const text=renderObservation({url:'https://e.x/',title:'T',text:'こんにちは',scroll:{y:0,height:2000,viewport:900},elements:[{ref:'e1',role:'button',name:'送る',inView:true},{ref:'e2',role:'link',name:'下',inView:false,href:'/x'}]});
 assert.match(text,/Screen: T — https:\/\/e\.x\//);assert.match(text,/e1 button "送る"/);assert.doesNotMatch(text,/e2 link/);assert.match(text,/1 more off screen/);assert.match(text,/こんにちは/);
});
