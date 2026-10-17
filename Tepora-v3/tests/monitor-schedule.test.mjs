import test from 'node:test';
import assert from 'node:assert/strict';
import {ambientCards,applyScheduleView} from '../web/ambient.mjs';

const card=(items,shared=false)=>ambientCards({widgets:['schedule'],schedule:{items},shared})[0];
const one=(id,at,text=id,extra={})=>({id,at,text,mode:'remind',every:null,...extra});
test('schedule card projects real schedule documents in next-occurrence order without mutating them',()=>{
 const items=[one('later','2026-10-18T12:00:00Z','Later <script>',{every:60}),one('soon','2026-10-18T09:00:00Z','Soon reminder'),one('work','2026-10-18T10:00:00Z','Scheduled work',{mode:'task'}),one('retry','2026-10-18T11:00:00Z','Retry work',{lastError:'private failure'}),one('fifth','2026-10-18T13:00:00Z','Fifth task')];
 const before=structuredClone(items),html=card(items).html;
 assert.ok(html.indexOf('Soon reminder')<html.indexOf('Scheduled work'));
 assert.ok(html.indexOf('Scheduled work')<html.indexOf('Retry work'));
 assert.match(html,/Later &lt;script&gt;/);assert.doesNotMatch(html,/<script>|private failure|Fifth task/);
 assert.match(html,/通知/);assert.match(html,/仕事/);assert.match(html,/定期/);assert.match(html,/60分ごと/);assert.match(html,/再試行待ち/);
 assert.deepEqual(items,before,'displaying the schedule cannot mutate execution state');
});
test('shared schedule card omits task text and dates; empty and invalid lists are honest',()=>{
 const html=card([one('private','2026-10-18T09:00:00Z','Private reminder')],true).html;
 assert.match(html,/1件/);assert.doesNotMatch(html,/Private reminder|2026|09:00/);
 assert.match(card([],true).html,/予定はありません/);
 assert.match(card([one('invalid','invalid-date')]).html,/ありません/);
 assert.doesNotMatch(card([]).html,/open-routines/);
});
test('committed schedule deltas add, update and remove exactly one row without changing unrelated identities',()=>{
 const first=one('first','2026-10-18T09:00:00Z'),second=one('second','2026-10-18T10:00:00Z');
 const original=[first],added=applyScheduleView(original,{id:second.id,item:second});
 assert.deepEqual(added,[second,first]);assert.equal(added[1],first);assert.deepEqual(original,[first]);
 const advanced={...second,at:'2026-10-18T11:00:00Z',fired:1};
 const updated=applyScheduleView(added,{id:second.id,item:advanced});
 assert.deepEqual(updated,[advanced,first]);assert.equal(updated[1],first);
 assert.deepEqual(applyScheduleView(updated,{id:second.id,item:null}),[first]);
 assert.equal(applyScheduleView(updated,{id:second.id,item:{...advanced,id:'foreign'}}),updated);
 assert.equal(applyScheduleView(updated,{id:second.id}),updated);
 assert.equal(applyScheduleView(updated,{item:null}),updated);
});
