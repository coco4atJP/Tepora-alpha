import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxItems,inboxHTML} from '../web/inbox.mjs';
import {ambientCards,deckWidgets,greeting,renderPinnedCards} from '../web/ambient.mjs';
import {MONITOR_SCENES,WIDGETS,monitorConfig,validateDisplay} from '../web/display-model.mjs';

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
test('smart monitor display model validates layouts, clock styles, scenes, pinned widgets and expanded widget set',()=>{
 assert.equal(WIDGETS.length,12);
 const base=validateDisplay({});
 assert.deepEqual(monitorConfig(base).pinnedWidgets,[]);
 assert.equal(monitorConfig(base).layout,'companion-split');
 const workScene=MONITOR_SCENES.work;
 const configured=validateDisplay({
  scene:'work',
  layout:workScene.layout,
  clockStyle:workScene.clockStyle,
  clockSize:workScene.clockSize,
  clockSeconds:true,
  widgets:workScene.widgets,
  pinnedWidgets:workScene.pinnedWidgets,
  weatherMode:'always',
  workCard:true,
  focusMinutes:45,
  pinnedNote:'午後3時にレビュー'
 });
 const mcfg=monitorConfig(configured);
 assert.equal(mcfg.scene,'work');
 assert.equal(mcfg.layout,'dashboard-bento');
 assert.equal(mcfg.clockStyle,'modern');
 assert.equal(mcfg.clockSeconds,true);
 assert.deepEqual(mcfg.pinnedWidgets,['focus','work','schedule','system']);
 assert.equal(mcfg.weatherMode,'always');
 assert.equal(mcfg.workCard,true);
 assert.equal(mcfg.focusMinutes,45);
 assert.equal(mcfg.pinnedNote,'午後3時にレビュー');
 assert.throws(()=>validateDisplay({layout:'grid-99'}),/Invalid stage layout/);
 assert.throws(()=>validateDisplay({pinnedWidgets:['clock']}),/Invalid pinned widgets/);
 assert.throws(()=>validateDisplay({pinnedWidgets:['weather','news','media','work','focus']}),/Invalid pinned widgets/);
});
test('deckWidgets respects weatherMode:always, workCard:true, and excludes pinned widgets from the rotating carousel',()=>{
 const calm={current:{temperature_2m:19,weather_code:2},hourly:{time:[],temperature_2m:[]},daily:{}};
 const all=['weather','news','work','focus','almanac'];
 assert.deepEqual(deckWidgets(all,{weather:calm}),['news','focus','almanac']);
 assert.deepEqual(deckWidgets(all,{weather:calm,weatherMode:'always',workCard:true}),['weather','news','work','focus','almanac']);
 assert.deepEqual(deckWidgets(all,{weather:calm,weatherMode:'always',workCard:true,pinned:['focus','weather']}),['news','work','almanac']);
});
test('new smart monitor widgets (focus, schedule, memo, system, almanac) render cleanly and support pinned grid',()=>{
 const widgets=['focus','schedule','memo','system','almanac'];
 const cards=ambientCards({
  widgets,
  focus:{minutes:25,remainingSeconds:1500,running:false,completed:2},
  schedule:{items:[{id:'sch_1',text:'朝のブリーフィング',at:'2026-10-18T08:30:00.000Z',every:1440,mode:'remind'},{id:'sch_2',text:'リリース確認',at:'2026-10-18T12:00:00.000Z',mode:'task'}]},
  memo:{note:'牛乳を買う\n資料を送る',memory:null},
  system:{model:'qwen3-8b',ready:true,safety:'protected',todayRequests:12,activeJobs:1,memoryCount:8},
  almanac:{now:new Date(2026,9,8,10,0),sun:{rise:5.75,set:17.35}}
 });
 assert.deepEqual(cards.map(c=>c.id),['focus','schedule','memo','system','almanac']);
 const grid=renderPinnedCards(cards.slice(0,4));
 assert.match(grid,/data-card="focus"/);
 assert.match(grid,/25:00/);
 assert.match(grid,/朝のブリーフィング/);
 assert.match(grid,/牛乳を買う/);
 assert.match(grid,/qwen3-8b/);
 const almanacCard=cards.find(c=>c.id==='almanac');
 assert.match(almanacCard.html,/寒露/);
 assert.match(almanacCard.html,/鴻雁来る/);
});
test('all scene presets are valid display-only patches and note limits use UTF-16 in both hosts',()=>{
 for(const scene of Object.values(MONITOR_SCENES))assert.doesNotThrow(()=>validateDisplay(scene.patch));
 assert.equal(validateDisplay({pinnedNote:'😀'.repeat(120)}).pinnedNote.length,240);
 assert.throws(()=>validateDisplay({pinnedNote:'😀'.repeat(121)}),/Invalid pinned note/);
 assert.throws(()=>validateDisplay({pinnedWidgets:['focus','focus']}),/Invalid pinned widgets/);
 assert.throws(()=>validateDisplay({focusMinutes:91}),/Invalid focus timer minutes/);
 assert.throws(()=>validateDisplay({allowNetwork:true}),/Display cannot change/);
});
