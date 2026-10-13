import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {runGoal,checkAll,fingerprint} from '../core/computer/decide.mjs';
import {computerTool,COMPUTER_DEFAULT} from '../core/computer/index.mjs';
import {Desktop} from '../core/computer/desktop.mjs';
import {Page} from '../core/computer/browser.mjs';

// Deterministic host/transport boundaries; these do not simulate OS permission dialogs.
const screen=(patch={})=>({url:'https://fixture.invalid/form',title:'Fixture',text:'Pending',elements:[{ref:'e1',role:'button',name:'Save',inView:true}],...patch});
const choose=choice=>async()=>({choice,probabilities:{[choice]:1},method:'fixture'});

test('completion requires every condition, including conditions in the same object',()=>{
 const obs=screen({url:'https://fixture.invalid/checkout',text:'Payment pending',elements:[{ref:'e1',role:'checkbox',name:'Terms',value:'yes',checked:false}]});
 assert.equal(checkAll(obs,[{url_includes:'/checkout',text_includes:'Payment complete'}]),false);
 assert.equal(checkAll(obs,[{field:'e1',equals:'yes',checked:true}]),false);
 assert.equal(checkAll(obs,[{url_includes:'/checkout',text_includes:'Payment pending'},{field:'e1',equals:'yes',checked:false}]),true);
 assert.equal(checkAll(screen(),[{field:'e1',equals:''}]),false,'an unobserved value is not proof of an empty field');
});

test('malformed completion checks fail before observing or acting',async()=>{
 for(const checks of [[{}],[null],[{equals:'yes'}],[{text_includes:''}],[{field:'e1',checked:'false'}],[{unknown:'value'}]]){
  let observed=0;
  await assert.rejects(runGoal({observe:async()=>{observed++;return screen();}}, {goal:'Save',checks},{choose:choose('done')}),/completion check/i);
  assert.equal(observed,0);
 }
});

test('scroll progress continues until a bottom-of-page completion marker is visible',async()=>{
 let y=0;
 const observe=()=>screen({text:y===9400?'End of report':`Section at ${y}`,scroll:{y,height:10000,viewport:600},elements:[{ref:'e1',role:'button',name:'Save',inView:y===0}]});
 const initial=observe();
 const result=await runGoal({observe:async()=>observe(),act:async c=>{assert.equal(c.op,'scroll');y=Math.min(9400,y+c.dy);}},
  {goal:'Scroll to the bottom',checks:[{text_includes:'End of report'}]},{choose:choose('scroll_down'),maxSteps:20});
 assert.equal(result.status,'completed');assert.equal(y,9400);assert.equal(result.steps.length,16);
 assert.notEqual(fingerprint(initial),fingerprint(observe()));
});

test('desktop open launches an app before waiting for its first window',async()=>{
 const desktop=new Desktop({binDir:'/tmp/tepora-unused-desktop-fixture'});let opened=false,attempts=0;
 desktop.open=async()=>{opened=true;};
 desktop.windows=async()=>{assert.equal(opened,true);return ++attempts<2?[]:[{pid:321,app:'Fixture Editor',title:'New'}];};
 desktop.settle=async()=>{};desktop.observe=async t=>screen({app:t.app});
 const tool=computerTool({config:()=>({...COMPUTER_DEFAULT}),desktopClient:()=>desktop});
 const result=await tool.run({action:'open',target:'desktop',app:'Fixture Editor'},{session:{id:'open-fixture'}});
 assert.match(result.text,/Opened Fixture Editor/);assert.equal(attempts,2);
});

test('CDP confirm waits for an explicit response to the observed dialog id',async()=>{
 let onEvent;const calls=[];
 const conn={send:async(method,params={})=>{calls.push({method,params});return method==='Target.attachToTarget'?{sessionId:'fixture'}:{};},on:fn=>{onEvent=fn;return ()=>{};}};
 const page=new Page({conn},'dialog-fixture');await page.attach('tab');
 onEvent({sessionId:'fixture',method:'Page.javascriptDialogOpening',params:{type:'confirm',message:'Delete this draft?'}});
 assert.equal(calls.filter(c=>c.method==='Page.handleJavaScriptDialog').length,0);
 const obs=await page.observe();assert.equal(obs.dialogs[0].pending,true);
 assert.equal(calls.filter(c=>c.method==='Runtime.evaluate').length,0);
 await assert.rejects(page.respondDialog('stale',true),/dialog/i);
 await page.respondDialog(obs.dialogs[0].id,false);
 assert.deepEqual(calls.find(c=>c.method==='Page.handleJavaScriptDialog').params,{accept:false});
 await assert.rejects(page.respondDialog(obs.dialogs[0].id,true),/dialog/i);
});

test('a pending modal blocks the goal before making another model request',async()=>{
 const result=await runGoal({observe:async()=>screen({dialogs:[{id:'d1',type:'confirm',message:'Continue?',pending:true}]})},
  {goal:'Save'},{choose:async()=>assert.fail('chooser called while a modal is pending')});
 assert.equal(result.status,'blocked');assert.match(result.detail,/dialog/);
});

test('cancellation during the fresh observation prevents the next action',async()=>{
 const controller=new AbortController();let observations=0,actions=0;
 const surface={observe:async()=>{if(++observations===2)controller.abort();return screen();},act:async()=>{actions++;}};
 await assert.rejects(runGoal(surface,{goal:'Save'},{choose:choose('click_e1'),signal:controller.signal}),{name:'AbortError'});
 assert.equal(actions,0);
});

test('cancellation between CDP action commands prevents the mouse press',async()=>{
 const controller=new AbortController(),calls=[];
 const page=new Page({conn:{send:async method=>{calls.push(method);controller.abort();return {};}}},'cancel-fixture');
 page.signal=controller.signal;
 await assert.rejects(page.mouse(10,10),{name:'AbortError'});
 assert.deepEqual(calls,['Input.dispatchMouseEvent']);
});

test('long and whitespace-sensitive fields verify through exact local readback',async()=>{
 const expected='Review note:\n  '+'x'.repeat(250)+'  ';let actual='',fills=0;
 const surface={observe:async()=>screen({elements:[{ref:'e1',role:'textbox',name:'Note',value:actual.slice(0,200),valueTruncated:actual.length>200,inView:true}]}),
  matches:async checks=>checks.map(c=>actual===c.value),act:async c=>{assert.equal(c.op,'fill');actual=c.value;fills++;}};
 const result=await runGoal(surface,{goal:'Fill the note',inputs:{Note:expected},checks:[{field:'Note',equals:expected}]},{choose:choose('fill_e1')});
 assert.equal(result.status,'completed');assert.equal(fills,1);
 assert.equal(checkAll(screen({elements:[{ref:'e1',role:'textbox',value:expected.slice(0,200),valueTruncated:true}]}),[{field:'e1',equals:expected.slice(0,200)}]),false);
});

test('browser readback compares the full DOM value without returning it',async()=>{
 const actual='Note:\n  '+'x'.repeat(250)+'  ',page=new Page({},'readback-fixture');
 page.eval=async expression=>vm.runInNewContext(expression,{document:{querySelector:()=>({tagName:'TEXTAREA',value:actual}),querySelectorAll:()=>[]}});
 assert.deepEqual(Array.from(await page.matches([{ref:'e1',value:actual},{ref:'e1',value:actual.slice(0,200)},{ref:'e1',value:actual.trim()}])),[true,false,false]);
});
