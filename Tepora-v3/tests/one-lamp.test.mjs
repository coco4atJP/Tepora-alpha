/** 一灯: colour that means "this is calling you", window light and lamp, work as lights, approvals as
 * seals, and the idle screen as a screensaver with wallpapers and a photo frame. Pure modules only;
 * the pointer handling of seals and the slideshow are exercised in the browser checks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {SEASONS,seasonOf,seasonLine} from '../web/seasons.mjs';
import {skyOf,sunTimes,daylightState,daylightVars} from '../web/daylight.mjs';
import {weatherLine,weatherNotable,deckWidgets,awayRecap,countWord,ambientCards} from '../web/ambient.mjs';
import {lightJobs,assignLightSlots,LIGHT_SLOTS} from '../web/lights.mjs';
import {createArmGate,sealHTML,stampHTML,SEAL_HOLD_MS} from '../web/seal.mjs';
import {approvalFriction,describeApproval} from '../web/approval-format.mjs';
import {backdropFor,lampPalette,starField,WALLPAPER_LABELS} from '../web/wallpaper.mjs';
import {shuffledOrder,framePhotos,fitWithin} from '../web/frame.mjs';
import {sampleFramePhotos} from '../web/frame-settings.mjs';
import {AMBIENT_DEFAULT,DISPLAY_DEFAULT,WALLPAPERS,validateDisplay} from '../web/display-model.mjs';
import {inboxItems,inboxHTML,approvalSlip} from '../web/inbox.mjs';

test('七十二候: 72 rows in calendar order, three per 節気, and every date of the year finds its row',()=>{
 assert.equal(SEASONS.length,72);
 const keys=SEASONS.map(s=>s.key);assert.deepEqual(keys,[...keys].sort((a,b)=>a-b));
 const perSekki=new Map();for(const s of SEASONS)perSekki.set(s.sekki,(perSekki.get(s.sekki)||0)+1);
 assert.equal(perSekki.size,24);for(const [name,count] of perSekki)assert.equal(count,3,name);
 assert.equal(new Set(SEASONS.map(s=>s.kou)).size,72);
 for(let m=0;m<12;m++)for(let d=1;d<=new Date(2026,m+1,0).getDate();d++)assert.ok(seasonOf(new Date(2026,m,d)).kou,`${m+1}/${d}`);
});
test('known dates fall in the rows the calendars print',()=>{
 const at=(m,d)=>seasonLine(new Date(2026,m-1,d));
 assert.equal(at(10,5),'秋分 ・ 水始めて涸る');assert.equal(at(10,7),'秋分 ・ 水始めて涸る');assert.equal(at(10,8),'寒露 ・ 鴻雁来る');
 assert.equal(at(2,4),'立春 ・ 東風凍を解く');assert.equal(at(2,3),'大寒 ・ 鶏始めて乳す');
 assert.equal(at(1,1),'冬至 ・ 雪下りて麦のびる');assert.equal(at(1,4),'冬至 ・ 雪下りて麦のびる');assert.equal(at(1,5),'小寒 ・ 芹乃ち栄う');
 assert.equal(at(12,31),'冬至 ・ 麋角解つる');assert.equal(at(6,21),'夏至 ・ 乃東枯る');assert.equal(at(7,23),'大暑 ・ 桐始めて花を結ぶ');
});

test('weather codes become light: clear, partly, cloud, fog, snow or rain',()=>{
 for(const [code,sky] of [[0,'clear'],[1,'clear'],[2,'partly'],[3,'cloud'],[45,'fog'],[48,'fog'],[51,'rain'],[63,'rain'],[73,'snow'],[81,'rain'],[86,'snow'],[95,'rain'],[null,'clear'],[undefined,'clear']])assert.equal(skyOf(code),sky,String(code));
});
test('the window light follows the hour, softens under cloud and disappears in rain and at night',()=>{
 const at=(h,weather=null)=>daylightState({now:new Date(2026,9,5,h,0),weather});
 assert.ok(at(8).sun.x<at(12).sun.x&&at(12).sun.x<at(17).sun.x,'the patch crosses the room');
 assert.ok(at(8).sun.skew<at(17).sun.skew);
 assert.equal(at(12).sun.opacity,1);assert.equal(at(23).sun.opacity,0);assert.equal(at(3).sun.opacity,0);
 const cloud={current:{weather_code:3}},rain={current:{weather_code:63}};
 assert.ok(at(12,cloud).sun.opacity<at(12).sun.opacity&&at(12,cloud).sun.blur>at(12).sun.blur);
 assert.equal(at(12,rain).sun.opacity,0);
 assert.ok(at(12,rain).lamp.pool>at(12).lamp.pool,'a dark day brings the lamp up');
 assert.ok(at(22).lamp.pool>=.5&&at(22).lamp.halo>=.5);assert.ok(at(12).lamp.pool<.05);
 assert.equal(at(12,rain).tint,'rgba(118,140,165,.09)');
});
test('sunrise and sunset from the weather are used only when they are plausible',()=>{
 const day=new Date(2026,9,5,12),sample=(d,rise,set)=>({daily:{sunrise:[new Date(2026,9,d,...rise).toISOString()],sunset:[new Date(2026,9,d,...set).toISOString()]}});
 assert.deepEqual(sunTimes(day,null),{rise:6,set:18});
 const real=sunTimes(day,sample(5,[5,42],[17,21]));assert.ok(Math.abs(real.rise-5.7)<.01&&Math.abs(real.set-(17+21/60))<.01);
 assert.deepEqual(sunTimes(day,sample(4,[5,42],[17,21])),{rise:6,set:18},"yesterday's data does not move the sun");
 assert.deepEqual(sunTimes(day,sample(5,[1,0],[23,59])),{rise:6,set:18},'implausible values are ignored');
});
test('daylight variables are plain strings that do not change within a minute',()=>{
 const a=daylightVars(daylightState({now:new Date(2026,9,5,15,0,5)})),b=daylightVars(daylightState({now:new Date(2026,9,5,15,0,40)}));
 assert.deepEqual(a,b);for(const value of Object.values(a))assert.equal(typeof value,'string');
 assert.match(a['--sun-color'],/^rgba\(\d+,\d+,\d+,\.96\)$/);
});

const hours=(now,rain)=>({time:Array.from({length:12},(_,i)=>new Date(now+i*3600e3).toISOString()),temperature_2m:Array(12).fill(19),precipitation_probability:rain});
test('the weather is one line, and its card returns only when it changes what you would do',()=>{
 const now=Date.UTC(2026,9,5,3,0),calm={current:{temperature_2m:19,weather_code:2},hourly:hours(now,Array(12).fill(10)),daily:{}};
 assert.deepEqual(weatherLine(calm,now),{temp:19,label:'晴れ時々くもり',hint:''});
 assert.equal(weatherNotable(calm,now),false);
 const wet={...calm,hourly:hours(now,[10,10,10,10,60,70,...Array(6).fill(10)])};
 assert.equal(weatherNotable(wet,now),true);assert.match(weatherLine(wet,now).hint,/雨 60%/);
 assert.equal(weatherNotable({...calm,current:{temperature_2m:33,weather_code:0}},now),true);
 assert.equal(weatherNotable({...calm,current:{temperature_2m:3,weather_code:3}},now),true);
 assert.equal(weatherNotable({...calm,current:{temperature_2m:15,weather_code:63}},now),true);
 assert.equal(weatherNotable(null,now),false);assert.equal(weatherLine(null,now),null);
});
test('the deck keeps news, music and pictures; work is shown as lights and an ordinary day of weather as one line',()=>{
 const calm={current:{temperature_2m:19,weather_code:2},hourly:{time:[],temperature_2m:[]},daily:{}};
 assert.deepEqual(deckWidgets(['weather','news','media','work','artifact'],{weather:calm}),['news','media','artifact']);
 assert.deepEqual(deckWidgets(['work','weather','news'],{weather:{current:{temperature_2m:19,weather_code:95},hourly:{},daily:{}}}),['weather','news']);
 assert.deepEqual(ambientCards({widgets:['weather','work'],weather:calm,jobs:[{id:'j',title:'T',status:'running'}]}).map(c=>c.id),['weather','work'],'the card builder itself is unchanged');
});
test('on return the character says what happened, and only when something did',()=>{
 const since=Date.UTC(2026,9,5,0,0),now=since+3*3600e3;
 const jobs=[{id:'a',kind:'work',status:'review',endedAt:new Date(since+3600e3).toISOString()},{id:'b',kind:'work',status:'completed',endedAt:new Date(since-3600e3).toISOString()},{id:'c',kind:'work',status:'running'},{id:'d',kind:'chat',characterSessionId:'s',status:'running'}];
 assert.equal(awayRecap({jobs,waiting:1,since,now}),'おかえりなさい。留守のあいだに、仕事がひとつ終わりました。確認がひとつ、お待ちです。');
 assert.equal(awayRecap({jobs,waiting:0,since,now}),'おかえりなさい。留守のあいだに、仕事がひとつ終わりました。仕事は、あとひとつ進めています。');
 assert.equal(awayRecap({jobs:[],waiting:0,since,now:since+10*60e3}),'','a short absence with nothing to say stays quiet');
 assert.equal(awayRecap({jobs:[],waiting:0,since,now:since+40*60e3}),'おかえりなさい。留守のあいだ、静かでした。');
 assert.equal(awayRecap({jobs:[],waiting:0,since:0,now}),'');
 assert.equal(countWord(2),'ふたつ');assert.equal(countWord(7),'7件');
});

test('running work becomes lights; what needs the person does not, and the oldest comes first',()=>{
 const jobs=[{id:'b',status:'running',createdAt:'2026-10-05T02:00:00Z'},{id:'a',status:'queued',createdAt:'2026-10-05T01:00:00Z'},{id:'w',status:'waiting_approval',createdAt:'2026-10-05T00:30:00Z'},
  {id:'p',status:'running',pendingApprovals:1,createdAt:'2026-10-05T00:40:00Z'},{id:'r',status:'review'},{id:'f',status:'failed'},{id:'q',status:'paused',pendingQuestionId:'x'}];
 assert.deepEqual(lightJobs(jobs).map(j=>j.id),['a','b']);
});
test('a light keeps its place while others come and go',()=>{
 let slots=assignLightSlots(new Map(),['a','b','c']);assert.deepEqual([...slots],[['a',0],['b',1],['c',2]]);
 slots=assignLightSlots(slots,['a','c','d']);
 assert.equal(slots.get('a'),0);assert.equal(slots.get('c'),2);assert.equal(slots.get('d'),1,'a new job takes the free place');
 assert.equal(assignLightSlots(new Map(),Array.from({length:8},(_,i)=>`j${i}`)).size,LIGHT_SLOTS.length);
});

test('the friction of a seal follows where an operation reaches',()=>{
 for(const [name,args,tone,friction] of [
  ['run_command',{executable:'node'},'host','hold'],
  ['generate_media',{kind:'image',domain:'cloud',prompt:'x',recipient:'r'},'cost','hold'],
  ['generate_media',{kind:'image',domain:'device',prompt:'x',recipient:'r'},'send','tap'],
  ['mcp_call',{tool:'t',server:'s'},'tool','tap'],['computer_open',{url:'https://example.com'},'screen','tap'],['codex_operation',{command:'ls'},'host','hold']
 ]){const d=describeApproval({name,args});assert.equal(d.tone,tone,name);assert.equal(approvalFriction(d.tone),friction,name);assert.ok(d.scope,name);}
});
test('without a pointer a held seal needs two deliberate activations',()=>{
 let t=1000;const gate=createArmGate({now:()=>t,ms:4000,gap:350});
 assert.equal(gate.activate('approve:a'),'armed');
 t+=100;assert.equal(gate.activate('approve:a'),'armed','key repeat or a double tap does not count');
 t+=500;assert.equal(gate.activate('approve:a'),'commit');
 assert.equal(gate.activate('approve:a'),'armed','a decided seal starts over');
 t+=5000;assert.equal(gate.activate('approve:a'),'armed','the first activation expires');
 t+=600;assert.equal(gate.activate('approve:b'),'armed','another seal never inherits it');
});
test('seal markup says how it is pressed, escapes what it is given and never fires by a plain click',()=>{
 const held=sealHTML({action:'approve',id:'a"b',hold:true,label:'許可する: <x>'});
 assert.match(held,/data-hold="1"/);assert.match(held,/seal-ring/);assert.match(held,/長押しで許可/);assert.doesNotMatch(held,/<x>/);assert.match(held,/&quot;/);
 const tap=sealHTML({action:'approve',id:'c',hold:false});
 assert.match(tap,/data-hold="0"/);assert.doesNotMatch(tap,/seal-ring/);assert.match(tap,/タップで許可/);
 assert.doesNotMatch(held+tap,/data-action=/);
 assert.match(stampHTML(),/tp-rough/);assert.equal(SEAL_HOLD_MS,700);
});
test('the inbox shows an approval as a slip: scope, a held seal for risky work, a tap for the rest, the exact request kept',()=>{
 const risky={id:'r1',jobId:'j',name:'run_command',args:{executable:'node',args:['x.js']},status:'pending',createdAt:'2026-10-05T01:00:00Z'};
 const light={id:'t1',jobId:'j',name:'mcp_call',args:{tool:'calendar.list',server:'cal'},status:'pending',createdAt:'2026-10-05T01:01:00Z'};
 const html=inboxHTML(inboxItems({approvals:[risky,light],jobs:[{id:'j',title:'Work',kind:'work',status:'waiting_approval'}]}));
 assert.match(html,/data-seal="approve" data-id="r1" data-hold="1"/);assert.match(html,/data-seal="approve" data-id="t1" data-hold="0"/);
 assert.match(html,/slip-scope">このPC</);assert.match(html,/slip-scope">外部の道具</);
 assert.match(html,/見送る/);assert.match(html,/data-action="deny"/);assert.doesNotMatch(html,/data-action="approve"/);
 assert.equal((html.match(/依頼の中身をそのまま見る/g)||[]).length,2);assert.match(html,/data-action="approve-all"/);
 const card=approvalSlip(risky,{tag:'section',kind:'approval-card inbox-item',showJob:false});
 assert.match(card,/^<section class="approval-card inbox-item slip tone-host"/);assert.match(card,/aria-label="承認が必要な操作"/);assert.doesNotMatch(card,/Work/);
});

test('what is behind the screen: room by day, the chosen wallpaper when idle, never personal photos when shared',()=>{
 assert.equal(backdropFor({ambient:false,wallpaper:'stars'}),'room');assert.equal(backdropFor({ambient:false,wallpaper:'plain'}),'plain');
 assert.equal(backdropFor({ambient:true,wallpaper:'drift'}),'drift');assert.equal(backdropFor({ambient:true,wallpaper:'photos',photoCount:3}),'photos');
 assert.equal(backdropFor({ambient:true,wallpaper:'photos',photoCount:0}),'room','no photos: the room');
 assert.equal(backdropFor({ambient:true,wallpaper:'photos',photoCount:3,shared:true}),'room');
 assert.equal(backdropFor({ambient:true,wallpaper:'room',photoCount:3,frameNow:true}),'photos');
 assert.equal(backdropFor({ambient:true,wallpaper:'room',photoCount:0,frameNow:true}),'room');
 assert.deepEqual(Object.keys(WALLPAPER_LABELS),[...WALLPAPERS]);
});
test('the lamp palette is for the night, the night sky and photos; the home stage is never the lamp',()=>{
 assert.equal(lampPalette({ambient:true,backdrop:'room',night:true,nightDim:true}),true);
 assert.equal(lampPalette({ambient:true,backdrop:'room',night:true,nightDim:false}),false);
 assert.equal(lampPalette({ambient:true,backdrop:'room',night:false}),false);
 assert.equal(lampPalette({ambient:true,backdrop:'stars'}),true);assert.equal(lampPalette({ambient:true,backdrop:'photos'}),true);
 assert.equal(lampPalette({ambient:false,backdrop:'stars',night:true}),false);
});
test('the night sky is the same sky every time',()=>{
 const a=starField(96,11);assert.deepEqual(a,starField(96,11));assert.equal(a.length,96);assert.notDeepEqual(a,starField(96,12));
 for(const s of a)assert.ok(s.x>=0&&s.x<=100&&s.y>=0&&s.y<=92&&s.size>0&&s.alpha>0&&s.alpha<=1);
});

test('photo order: as added, or a shuffle that shows every photo once',()=>{
 assert.deepEqual(shuffledOrder(5,{shuffle:false}),[0,1,2,3,4]);
 const a=shuffledOrder(20,{seed:3});assert.deepEqual(a,shuffledOrder(20,{seed:3}));
 assert.deepEqual([...a].sort((x,y)=>x-y),Array.from({length:20},(_,i)=>i));assert.notDeepEqual(a,shuffledOrder(20,{seed:4}));
 assert.deepEqual(shuffledOrder(0,{}),[]);
});
test('the frame list is stored photos first, then made images when asked; preview photos keep their own url',()=>{
 const photos=[{id:'a-1',name:'ねこ'},{id:'p',name:'プレビュー',url:'blob:x'}],created=[{src:'/api/media/assets/m',title:'つくった'}];
 assert.deepEqual(framePhotos({photos,created,includeCreated:true}).map(p=>p.url),['/api/frame/photos/a-1','blob:x','/api/media/assets/m']);
 assert.deepEqual(framePhotos({photos,created,includeCreated:false}).map(p=>p.id),['a-1','p']);
 assert.equal(framePhotos({photos:[{id:'a/b?c'}]})[0].url,'/api/frame/photos/a%2Fb%3Fc');
});
test('large pictures are scaled to a size a screen can use and small ones are left alone',()=>{
 assert.deepEqual(fitWithin(6400,3200,3200),{width:3200,height:1600,scaled:true});
 assert.deepEqual(fitWithin(3000,2000,3200),{width:3000,height:2000,scaled:false});
 assert.deepEqual(fitWithin(2000,6400,3200),{width:1000,height:3200,scaled:true});
});
test('sample photos for the offline preview are drawn locally',()=>{
 const samples=sampleFramePhotos();assert.equal(samples.length,4);
 for(const p of samples){assert.match(p.url,/^data:image\/svg\+xml/);assert.ok(p.name&&p.id.startsWith('sample:'));}
});

test('wallpaper and photo frame settings are validated, default sensibly and migrate older preferences',()=>{
 assert.equal(AMBIENT_DEFAULT.wallpaper,'room');assert.equal(AMBIENT_DEFAULT.keepAwake,false);assert.equal(AMBIENT_DEFAULT.frameSeconds,30);
 const ok=validateDisplay({ambient:{...AMBIENT_DEFAULT,wallpaper:'photos',keepAwake:true,frameSeconds:300,frameFit:'mat',frameClock:'large'}});
 assert.equal(ok.ambient.wallpaper,'photos');assert.equal(ok.ambient.frameSeconds,300);assert.equal(ok.ambient.frameFit,'mat');
 for(const bad of [{wallpaper:'video'},{keepAwake:'yes'},{frameSeconds:7},{frameFit:'stretch'},{frameClock:'huge'},{frameShuffle:1},{frameMotion:'on'},{frameCreated:null},{unknown:true}])
  assert.throws(()=>validateDisplay({ambient:{...AMBIENT_DEFAULT,...bad}}),/Invalid|cannot change/,JSON.stringify(bad));
 const old={...DISPLAY_DEFAULT,ambient:{idleMinutes:10,rotateSeconds:20,nightDim:false}};
 const migrated=validateDisplay({theme:'dark'},old);
 assert.equal(migrated.ambient.wallpaper,'room');assert.equal(migrated.ambient.idleMinutes,10);assert.equal(migrated.ambient.nightDim,false);
});

test('the browser bundle includes every new module, in dependency order, without name clashes',async()=>{
 const {browserBundle,BUNDLE_ORDER}=await import('../core/frontend.mjs');
 const code=await browserBundle(new URL('../web',import.meta.url).pathname);
 for(const name of ['seasons','daylight','wallpaper','frame','lights','seal','frame-settings'])assert.ok(BUNDLE_ORDER.includes(name),name);
 assert.ok(BUNDLE_ORDER.indexOf('seal')<BUNDLE_ORDER.indexOf('inbox')&&BUNDLE_ORDER.indexOf('status')<BUNDLE_ORDER.indexOf('lights')&&BUNDLE_ORDER.indexOf('frame-settings')<BUNDLE_ORDER.indexOf('app'));
 for(const symbol of ['function seasonOf','function daylightState','function createLights','function bindSeals','function createPhotoFrame','function createFrameSettings'])assert.ok(code.includes(symbol),symbol);
});
