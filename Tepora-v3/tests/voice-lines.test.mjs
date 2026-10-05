/** The character's voice is part of the persona. It changes what the screen says and how the model is told to
 * answer, and it never touches how the character looks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VOICE_DEFAULT,VOICE_KEYS,VOICE_PROACTIVE_IDS,VOICE_SCENES,VOICE_TONES,VOICE_TONE_IDS,defaultVoice,validateVoice,voiceAddress,voiceLine,voiceSpeaks,voiceStyleForPrompt} from '../web/voice-lines.mjs';
import {awayRecap,countWord,greeting} from '../web/ambient.mjs';
import {characterVoice} from '../web/dialogue-state.mjs';
import {personaForPrompt,normalizePersonas,defaultPersonas} from '../core/persona.mjs';
import {Store} from '../core/store.mjs';
import {Harness} from '../core/harness.mjs';
import {Connectors} from '../core/connectors.mjs';
import {Requests} from '../core/requests.mjs';
import {Dialogue} from '../core/dialogue.mjs';
import {startServer} from '../core/server.mjs';

const at=(h,m=0)=>new Date(2026,9,5,h,m);
const wx=(code,temp)=>({current:{weather_code:code,temperature_2m:temp}});

test('the default voice says exactly what the screen has always said',()=>{
 const g=(h,w=null)=>greeting(at(h),w,'Tepora').text;
 assert.equal(g(9),'おはようございます。よく眠れましたか。');assert.equal(g(12),'こんにちは。ひと息ついていきませんか。');
 assert.equal(g(18),'おつかれさまです。今日はどんな一日でしたか。');assert.equal(g(23),'夜遅くまでおつかれさまです。そろそろ休みませんか。');assert.equal(g(3),'夜遅くまでおつかれさまです。そろそろ休みませんか。');
 assert.equal(g(12,wx(61,15)),'こんにちは。外は雨です。出かけるなら傘を。');assert.equal(g(12,wx(95,15)),'こんにちは。外は雷雨です。出かけるなら傘を。');
 assert.equal(g(12,wx(71,0)),'こんにちは。雪が降っています。足もとに気をつけて。');
 assert.equal(g(12,wx(0,31)),'こんにちは。31°まで上がっています。水分を少し多めに。');assert.equal(g(12,wx(0,3)),'こんにちは。3°と冷えています。あたたかくしてください。');
 assert.equal(g(12,wx(0,20)),'こんにちは。ひと息ついていきませんか。');
 const now=Date.now(),job=(status,extra={})=>({id:randomUUID(),kind:'work',status,endedAt:new Date(now+1000).toISOString(),...extra});
 assert.equal(awayRecap({jobs:[job('review')],since:now-5000,now}),'おかえりなさい。留守のあいだに、仕事がひとつ終わりました。');
 assert.equal(awayRecap({jobs:[],waiting:2,since:now-5000,now}),'おかえりなさい。確認がふたつ、お待ちです。');
 assert.equal(awayRecap({jobs:[job('running')],waiting:0,since:now-5000,now}),'おかえりなさい。仕事は、あとひとつ進めています。');
 assert.equal(awayRecap({jobs:[job('review'),job('review')],waiting:1,since:now-5000,now}),'おかえりなさい。留守のあいだに、仕事がふたつ終わりました。確認がひとつ、お待ちです。');
 assert.equal(awayRecap({jobs:[],waiting:0,since:now-31*60e3,now}),'おかえりなさい。留守のあいだ、静かでした。');assert.equal(awayRecap({jobs:[],waiting:0,since:now-60e3,now}),'');
 assert.equal(voiceLine(undefined,'waiting',{n:countWord(1)}),'確認していただきたいことが、ひとつあります。');
});

test('every tone has every line, and the placeholders are only the four that are filled',()=>{
 assert.deepEqual(VOICE_TONE_IDS,['polite','soft','casual','terse','night']);assert.deepEqual([...VOICE_PROACTIVE_IDS],['quiet','normal','chatty']);
 assert.equal(VOICE_SCENES.length,VOICE_KEYS.length);
 for(const id of VOICE_TONE_IDS){
  const pack=VOICE_TONES[id];assert.ok(pack.name&&pack.style.length>10,id);
  assert.deepEqual(Object.keys(pack.lines).sort(),[...VOICE_KEYS].sort(),`${id} covers every scene`);
  for(const [key,line] of Object.entries(pack.lines)){
   assert.ok(typeof line==='string'&&line.length<=60,`${id}.${key}`);
   for(const m of line.matchAll(/\{(\w+)\}/g))assert.ok(['n','t','label','kou'].includes(m[1]),`${id}.${key} uses {${m[1]}}`);
   const allowed=VOICE_SCENES.find(s=>s.key===key).vars||[];for(const m of line.matchAll(/\{(\w+)\}/g))assert.ok(allowed.includes(m[1]),`${id}.${key} may not use {${m[1]}}`);
  }
 }
 for(const id of VOICE_TONE_IDS)for(const [h,part] of [[9,'morning'],[12,'day'],[18,'evening'],[23,'night']])assert.ok(greeting(at(h),null,'x',{tone:id,lines:{}}).text.length>0,`${id} ${part}`);
});

test('a person can choose a tone, a call name and their own wording; their own wording wins',()=>{
 const soft={tone:'soft',callName:'ミカ',proactive:'normal',lines:{}};
 assert.equal(greeting(at(9),null,'x',soft).text,'ミカさん、おはようございます。今日もゆっくり始めましょうね。');
 assert.equal(voiceAddress({tone:'casual',callName:'ミカ'}),'ミカ、');assert.equal(voiceAddress({tone:'polite',callName:''}),'');assert.equal(voiceAddress(undefined),'');
 const own={...soft,lines:{'opening.morning':'朝だよ！','note.morning':'','waiting':'{n}つ、見てね'}};
 assert.equal(greeting(at(9),null,'x',own).text,'ミカさん、朝だよ！');
 assert.equal(voiceLine(own,'waiting',{n:'3'}),'3つ、見てね');assert.equal(voiceLine(own,'waiting',{}),'{n}つ、見てね','a value that is not given stays as typed');
 assert.equal(voiceLine({lines:{waiting:'{x} {n}'}},'waiting',{n:1,x:2}),'{x} 1','only the four known values are filled');
 assert.equal(voiceLine({tone:'nope'},'opening.day'),'こんにちは。','an unknown tone is the polite one');
 const chatty={...VOICE_DEFAULT,proactive:'chatty'};assert.match(greeting(at(12),null,'x',chatty).text,/いまは「[^」]+」の頃です。$/);
 assert.equal(awayRecap({jobs:[],waiting:1,since:Date.now()-1000,voice:{tone:'terse',callName:'ミカ',lines:{}}}),'ミカさん、確認が1あります。'.replace('1','ひとつ'));
 assert.ok(!greeting(at(9),null,'x',{tone:'terse',lines:{}}).text.includes('undefined'));
 // quiet stays silent about nothing, speaks about what needs the person
 assert.equal(awayRecap({jobs:[],waiting:0,since:Date.now()-31*60e3,voice:{proactive:'quiet',lines:{}}}),'');
 assert.match(awayRecap({jobs:[],waiting:2,since:Date.now()-1000,voice:{proactive:'quiet',lines:{}}}),/ふたつ/);
 assert.equal(voiceSpeaks({proactive:'quiet'},'greeting'),false);assert.equal(voiceSpeaks({proactive:'quiet'},'waiting'),true);assert.equal(voiceSpeaks({proactive:'normal'},'greeting'),true);assert.equal(voiceSpeaks(undefined,'greeting'),true);
});

test('a voice is validated: only known tones, short plain text, known lines',()=>{
 const v=validateVoice({tone:'night',callName:'  ミカ\u0000\u0007  ',proactive:'quiet',lines:{waiting:'  ひとつ、\nどうぞ ',season:''}},VOICE_DEFAULT);
 assert.deepEqual(v,{tone:'night',callName:'ミカ',proactive:'quiet',lines:{waiting:'ひとつ、 どうぞ',season:''}});
 assert.deepEqual(validateVoice({},v),v,'an empty patch changes nothing');assert.deepEqual(validateVoice({tone:'soft'},v).lines,v.lines,'lines are kept unless sent');assert.deepEqual(validateVoice({lines:{}},v).lines,{},'sending no lines clears them');
 for(const bad of [{tone:'shout'},{tone:7},{proactive:'always'},{callName:'x'.repeat(49)},{callName:7},{lines:{unknown:'x'}},{lines:{waiting:'x'.repeat(201)}},{lines:{waiting:7}},{lines:[]},{lines:{__proto__x:'x'}},{persona:'x'},{instructions:'x'},JSON.parse('{"__proto__":{"x":1}}')])assert.throws(()=>validateVoice(bad,VOICE_DEFAULT),/./,JSON.stringify(bad));
 assert.throws(()=>validateVoice(null),/Invalid voice/);assert.throws(()=>validateVoice('soft'),/Invalid voice/);
 assert.equal(validateVoice({callName:'x'.repeat(40)}.callName?{callName:'x'.repeat(24)}:{},VOICE_DEFAULT).callName.length,24);
 assert.equal(validateVoice({lines:{waiting:'x'.repeat(150)}},VOICE_DEFAULT).lines.waiting.length,100,'a long line is cut, not refused');
 assert.deepEqual(defaultVoice(),{tone:'polite',callName:'',proactive:'normal',lines:{}});assert.equal(characterVoice({personas:{character:{voice:v}}}),v);assert.equal(characterVoice({}),undefined);assert.equal(characterVoice({session:{character:'Tepora'}}),undefined);
});

test('the model is told the tone, the call name and how often to speak up; lines written for the screen never reach it',()=>{
 const voice={tone:'soft',callName:'ミカ',proactive:'quiet',lines:{waiting:'SCREEN ONLY SECRET LINE'}};
 const style=voiceStyleForPrompt(voice);
 assert.deepEqual(Object.keys(style).sort(),['callName','speakingFrequency','tone','toneStyle']);assert.equal(style.callName,'ミカさん');assert.equal(style.tone,'soft');
 assert.ok(!JSON.stringify(style).includes('SCREEN ONLY'));assert.deepEqual(voiceStyleForPrompt({tone:'polite',callName:'',proactive:'normal',lines:{}}),{tone:'polite',toneStyle:VOICE_TONES.polite.style});
 const persona=personaForPrompt({name:'Koharu',instructions:'be kind',voice});
 assert.deepEqual(Object.keys(persona).sort(),['instructions','name','style']);assert.ok(!JSON.stringify(persona).includes('SCREEN ONLY'));
 assert.deepEqual(personaForPrompt({name:'Builder',instructions:'build'}),{name:'Builder',instructions:'build'},'a worker persona has no voice');
 assert.equal(normalizePersonas(null),null);assert.deepEqual(normalizePersonas({revision:3,character:{name:'a',instructions:'b'},worker:{name:'c',instructions:'d'}}).character.voice,defaultVoice());
 assert.deepEqual(defaultPersonas('Mika').character.voice,defaultVoice());assert.equal(defaultPersonas('Mika').character.name,'Mika');
});

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){if(fn())return;await delay(10);}assert.fail('state timeout');}
test('the pinned persona the model receives carries the voice style, and a worker never receives the character\'s voice',async t=>{
 const seen=[],dir=await mkdtemp(path.join(os.tmpdir(),'tepora-voice-')),store=new Store(dir);store.settings={...store.settings,model:'fixture',concurrency:2};
 const h=new Harness(store,new Connectors(store),{runtimeFactory:()=>({chat:async messages=>{seen.push(structuredClone(messages));return {content:'ok'};}})}),d=new Dialogue(store,h,new Requests(store,h));
 t.after(async()=>{d.close();h.close();await until(()=>!h.active.size);store.close();await rm(dir,{recursive:true,force:true});});
 assert.deepEqual(d.personas().character.voice,defaultVoice());
 const next=d.configure({expectedRevision:0,character:{name:'Mika',instructions:'friendly',voice:{tone:'casual',callName:'ハル',proactive:'chatty',lines:{waiting:'SCREEN ONLY SECRET LINE'}}},worker:{name:'Builder',instructions:'build',voice:{tone:'night'}}});
 assert.equal(next.character.voice.tone,'casual');assert.equal(next.character.voice.lines.waiting,'SCREEN ONLY SECRET LINE');assert.ok(!('voice' in next.worker),'a worker persona has no voice even when one is sent');
 assert.throws(()=>d.configure({expectedRevision:1,character:{name:'Mika',instructions:'x',voice:{tone:'shout'}}}),/tone/);assert.throws(()=>d.configure({expectedRevision:1,character:{name:'Mika',instructions:'x',voice:{lines:{nope:'x'}}}}),/line/);
 assert.equal(d.personas().revision,1,'a refused voice changes nothing');
 const s=d.session(),sent=d.submit({requestId:randomUUID(),sessionId:s.id,sessionRevision:s.revision,input:'hello',contextConsent:d.context().id});
 await until(()=>store.get('job',sent.job.id).status==='completed');
 const system=seen.at(-1)[0].content,pinned=system.match(/Pinned user persona[^:]*: (\{.*?\})\.\n?/s);
 assert.ok(pinned,'the persona is pinned in the prompt');const persona=JSON.parse(pinned[1]);
 assert.equal(persona.name,'Mika');assert.equal(persona.style.tone,'casual');assert.equal(persona.style.callName,'ハル');assert.match(persona.style.toneStyle,/くだけた/);assert.ok(persona.style.speakingFrequency);
 assert.ok(!system.includes('SCREEN ONLY SECRET LINE'),'screen-only lines never reach the model');assert.ok(!JSON.stringify(sent.job.personaSnapshot.worker).includes('voice'));
});

test('the persona API keeps the voice apart from the avatar',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-voice-http-')),app=await startServer({dir,runtimeFactory:()=>({decide:async()=>null,chat:async()=>({role:'assistant',content:'fixture'})})});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const launch=await fetch(app.launchUrl,{redirect:'manual'}),cookie=launch.headers.get('set-cookie').split(';')[0],boot=await (await fetch(app.origin+'/api/bootstrap',{headers:{Cookie:cookie}})).json();
 const call=(p,method='GET',data)=>fetch(app.origin+p,{method,headers:{Cookie:cookie,'X-Tepora-CSRF':boot.csrf,'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});
 const personas=await (await call('/api/dialogue/personas')).json();assert.deepEqual(personas.character.voice,defaultVoice());assert.deepEqual(boot.dialogue.session.character.voice,defaultVoice());
 const saved=await call('/api/dialogue/personas','PUT',{expectedRevision:personas.revision,character:{name:'Mika',instructions:'hi',voice:{tone:'night',callName:'ミカ'}}});assert.equal(saved.status,200);
 assert.equal((await saved.json()).character.voice.tone,'night');assert.equal((await (await call('/api/dialogue')).json()).session.character.voice.callName,'ミカ');
 assert.equal((await call('/api/dialogue/personas','PUT',{expectedRevision:1,character:{name:'Mika',instructions:'hi',voice:{tone:'xx'}}})).status,400);
 // the avatar is untouched by voice changes, and the voice by avatar changes
 const avatar=await (await call('/api/avatar')).json();assert.equal(avatar.revision,0);assert.equal(avatar.body,'shiro');
 assert.equal((await call('/api/avatar','PATCH',{patch:{body:'kitsune',palette:'sakura'},expectedRevision:0})).status,200);
 assert.equal((await (await call('/api/dialogue/personas')).json()).character.voice.tone,'night');assert.equal((await (await call('/api/dialogue/personas')).json()).revision,1,'changing the avatar does not touch the persona');
 assert.equal((await call('/api/avatar','PATCH',{patch:{voice:{tone:'soft'}},expectedRevision:1})).status,400,'the avatar cannot carry a voice');
 assert.equal((await call('/api/avatar','PATCH',{patch:{tone:'soft'},expectedRevision:1})).status,400);
});
