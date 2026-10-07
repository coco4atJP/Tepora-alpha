import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxItems,inboxHTML} from '../web/inbox.mjs';
import {ambientCards,greeting} from '../web/ambient.mjs';

const at=n=>new Date(Date.UTC(2026,9,4,9,n)).toISOString();
const approval=(id,args={executable:'node',args:['x.js']})=>({id,jobId:'w',name:'run_command',args,status:'pending',createdAt:at(1)});

test('あなたの番 orders blocking items first and includes proposals that wait for a yes',()=>{
 const jobs=[{id:'w',title:'Work',kind:'work',status:'review',endedAt:at(2)},{id:'f',title:'Failed',kind:'work',status:'failed',note:'timeout',endedAt:at(3)},{id:'c',title:'Turn',kind:'chat',characterSessionId:'s',status:'failed'}];
 const items=inboxItems({approvals:[approval('a')],jobs,routines:[{id:'r',title:'Morning',status:'proposed',createdAt:at(4)},{id:'r2',title:'On',status:'active'}],plans:[]});
 assert.deepEqual(items.map(i=>i.kind),['approval','review','trouble','proposal']);
 assert.ok(!items.some(i=>i.id==='c'),'internal character turns never ask the person');
});
test('inbox markup stays plain: exact request on demand, batch only for several approvals, no duplicate labels',()=>{
 const one=inboxHTML(inboxItems({approvals:[approval('a',{executable:'<b>',args:[]})],jobs:[]}));
 assert.match(one,/依頼の中身をそのまま見る/);assert.match(one,/&lt;b&gt;/);assert.doesNotMatch(one,/<b>/);
 assert.doesNotMatch(one,/approve-all/);assert.doesNotMatch(one,/onclick|javascript:/i);
 const two=inboxHTML(inboxItems({approvals:[approval('a'),approval('b')],jobs:[]}));
 assert.match(two,/data-action="approve-all"/);assert.match(two,/data-action="deny-all"/);
 assert.equal(inboxHTML([]),'<p class="inbox-empty">いまは、ありません。</p>');
});
test('monitor cards appear only when they have something to show',()=>{
 const widgets=['weather','news','media','work','artifact'];
 assert.deepEqual(ambientCards({widgets}),[]);
 const weather={current:{temperature_2m:19,weather_code:2},hourly:{time:[],temperature_2m:[]},daily:{}};
 const jobs=[{id:'j',title:'Secret plan',status:'running'}];
 const cards=ambientCards({widgets,weather,news:{items:[{title:'Headline',url:'https://example.com/a'}]},jobs,images:[{src:'/api/media/assets/x',title:'Picture'}]});
 assert.deepEqual(cards.map(c=>c.id),['weather','news','work','photos']);
 const shared=ambientCards({widgets,jobs,images:[{src:'/x',title:'Private picture'}],shared:true});
 assert.deepEqual(shared.map(c=>c.id),['work']);assert.doesNotMatch(shared[0].html,/Secret plan/);
});
test('greeting mentions the weather only when it changes what you would do',()=>{
 const noon=new Date(2026,9,4,13,0);
 assert.doesNotMatch(greeting(noon,{current:{temperature_2m:19,weather_code:2}}).text,/19°|晴れ/);
 assert.match(greeting(noon,{current:{temperature_2m:16,weather_code:63}}).text,/傘/);
 assert.match(greeting(noon,{current:{temperature_2m:33,weather_code:0}}).text,/33°/);
});
