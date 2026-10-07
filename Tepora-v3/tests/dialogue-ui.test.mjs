import {AVATAR_DEFAULT,avatarNeeds,defaultAvatar,exportAvatar,importAvatarPreset,validateAvatar} from '../web/avatar/model.mjs';
import {defaultVoice,validateVoice} from '../web/voice-lines.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {DialogueDraftContext,characterName,questionIsCurrent,currentReplyQuestion,dialogueMessagePresentation,latestCharacterReply} from '../web/dialogue-state.mjs';
import {fixture,appSource,part} from './helpers/dialogue-ui-fixture.mjs';
function pendingQuestion(f){
 const question={id:'q-one',kind:'worker-question',role:'tool',source:'worker',questionId:'q-one',jobId:'main',jobRevision:1,questionStatus:'pending',content:'Which region?',at:'2026-09-30T00:00:00.000Z'};
 Object.assign(f.state.jobs[0],{status:'paused',pendingQuestionId:'q-one'});f.state.dialogue.messages.push(question);return question;
}
test('character draft identity contains only session and explicit question, never detail focus',()=>{
 const c=new DialogueDraftContext(),session={id:'session',revision:1};const pinned=c.pin(session);
 assert.deepEqual(pinned,{sessionId:'session',reply:null});assert.strictEqual(c.pin({...session,revision:2}),pinned);assert.equal(Object.isFrozen(pinned),true);
});
test('detail navigation preserves conversation, unsent draft, voice capture, and autosend opt-in',async()=>{
 const f=fixture();f.type('Keep talking to Character');await f.run('recordToggle()');const destination=f.draftContext.destination,capture=f.ctx.voice,anchor=f.ctx.voiceAnchor,epoch=f.ctx.voiceEpoch;
 f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={sessionId:'session-one',context:{id:'execution-route'}};
 await f.run("navigateFocus('other')");
 assert.equal(f.state.companion.focusJobId,'other');assert.equal(characterName(f.state.dialogue),'Character');assert.equal(f.draft.content,'Keep talking to Character');assert.strictEqual(f.draftContext.destination,destination);assert.strictEqual(f.ctx.voice,capture);assert.strictEqual(f.ctx.voiceAnchor,anchor);assert.equal(f.ctx.voiceEpoch,epoch);assert.equal(f.ctx.voiceSendEnabled,true);
});
test('opening job details never rebinds the draft or stops microphone capture',async()=>{
 const f=fixture();f.type('Persistent');await f.run('recordToggle()');const anchor=f.ctx.voiceAnchor,destination=f.draftContext.destination;
 f.ctx.previewMode=true;f.ctx.statuses={running:'Running'};f.ctx.verificationHTML=()=>'';f.ctx.approvalBox=()=>'';f.ctx.todoHTML=()=>'';f.ctx.routeLine=()=>'';f.ctx.jobActions=()=>'';f.load('function taskSheet(','const TOOL_WORDS=');
 f.run("taskSheet('main')");assert.equal(f.sheets.length,1);assert.strictEqual(f.ctx.voiceAnchor,anchor);assert.strictEqual(f.draftContext.destination,destination);assert.equal(f.draft.content,'Persistent');
});
test('foreground accepts another utterance while worker jobs remain busy',async()=>{
 const f=fixture();f.type('First');await f.run('submitDialogue()');f.type('Also, another thought');await f.run('submitDialogue()');
 assert.equal(f.requests().length,2);assert.equal(f.state.jobs[0].status,'running');assert.notEqual(f.requests()[0].value.requestId,f.requests()[1].value.requestId);assert.equal(f.requests()[1].value.text,'Also, another thought');
});
test('worker reports retain sole character speaker and quoted pinned worker provenance',()=>{
 const f=fixture();f.state.jobs[0].personaSnapshot={worker:{name:'Original worker'}};f.state.dialogue.personas.worker.name='New worker';
 const report={kind:'worker-report',role:'tool',jobId:'main',content:'Claimed completed output',status:'review'};const p=dialogueMessagePresentation(report,f.state.dialogue,f.state.jobs);
 assert.equal(p.speaker,'Character');assert.match(p.source,/Original worker/);assert.match(p.status,/確認待ち/);assert.match(p.caution,/まだ確認されていません/);assert.equal(dialogueMessagePresentation({...report,status:'completed'},f.state.dialogue,f.state.jobs).status,'処理終了');assert.equal(dialogueMessagePresentation({...report,status:'completed',verificationStatus:'accepted-by-user'},f.state.dialogue,f.state.jobs).status,'ユーザー確認済み');
});
test('worker outputs are never used as the character TTS reply',()=>{
 const dialogue={messages:[{role:'assistant',kind:'character',content:'Character says hello'},{role:'assistant',kind:'worker-report',content:'Untrusted report'}]};assert.equal(latestCharacterReply(dialogue),'Character says hello');
});
test('transcript persists across detail focus, escapes untrusted text, and hides in shared view',async()=>{
 const f=fixture();f.state.dialogue.messages=[{id:'one',role:'assistant',kind:'character',content:'Hello <script>alert(1)</script>',jobId:'internal'},{id:'report',kind:'worker-report',role:'tool',jobId:'main',status:'review',content:'Worker <img onerror=bad>'}];f.load('function showDialogue(){','function showReply(){');
 f.run('showDialogue()');const rendered=f.el('#dialogue-transcript').innerHTML;assert.match(rendered,/&lt;script&gt;/);assert.doesNotMatch(rendered,/<script>/);assert.match(rendered,/worker-quotation/);assert.doesNotMatch(rendered,/data-id="internal"/);
 await f.run("navigateFocus('other')");f.run('showDialogue()');assert.equal(f.el('#dialogue-transcript').innerHTML,rendered);assert.equal(f.el('#character-name').textContent,'Character');
 f.ctx.sharedView=true;f.run('showDialogue()');assert.doesNotMatch(f.el('#dialogue-transcript').innerHTML,/Hello|Worker|onerror/);assert.equal(f.el('#character-name').textContent,'会話は非公開');
});
test('worker notifications do not change voice or draft, and late snapshot cannot reopen answered question',async()=>{
 const f=fixture(),q=pendingQuestion(f);f.type('Keep this');await f.run('recordToggle()');const voice=f.ctx.voice,epoch=f.ctx.voiceEpoch;
 f.ctx.snapshot={session:f.state.dialogue.session,messages:[{...q,questionStatus:'answered'},{id:'later',role:'assistant',content:'New answer',at:'2026-09-30T00:01:00.000Z'}],personas:f.state.dialogue.personas};f.run('acceptDialogue(snapshot)');
 f.ctx.snapshot={session:f.state.dialogue.session,messages:[{...q,questionStatus:'pending'}],personas:f.state.dialogue.personas};f.run('acceptDialogue(snapshot)');
 assert.equal(f.state.dialogue.messages.find(m=>m.id==='q-one').questionStatus,'answered');assert.ok(f.state.dialogue.messages.find(m=>m.id==='later'));assert.equal(f.draft.content,'Keep this');assert.equal(f.ctx.voiceEpoch,epoch);assert.strictEqual(f.ctx.voice,voice);
});
test('persona revision change cancels autosend but leaves typed draft intact',async()=>{
 const f=fixture();f.type('Keep this');await f.run('recordToggle()');f.ctx.voiceSendEnabled=true;f.ctx.snapshot={session:{...f.state.dialogue.session,revision:2},messages:[]};f.run('acceptDialogue(snapshot)');
 assert.equal(f.draft.content,'Keep this');assert.equal(f.ctx.voice,null);assert.equal(f.ctx.voiceSendEnabled,false);
});
test('character job internals are hidden from work list; historical jobs stay visible',()=>{
 const f=fixture();f.state.jobs.push({id:'turn',title:'INTERNAL TURN',kind:'chat',characterSessionId:'session-one',status:'running'},{id:'legacy',title:'HISTORICAL CHAT',kind:'chat',status:'paused'});
 f.ctx.statuses={};f.run(part('const workJobs=','const settings='));f.load('function taskRows(){','function artifactSurface(){');const html=f.run('taskRows()');
 assert.doesNotMatch(html,/INTERNAL TURN/);assert.match(html,/HISTORICAL CHAT/);assert.equal(f.run('activeJobs().length'),1);
});
test('normal UI offers no manual continue/new/side routing or agent selector',()=>{
 assert.doesNotMatch(appSource,/data-action="(?:agent-select|composer-intent|natural-intent)"/);assert.doesNotMatch(appSource,/\/api\/companion\/(?:propose|submit|context)/);assert.doesNotMatch(appSource,/chooseComposerIntent|submitIntent\(/);
 assert.match(appSource,/id="dialogue-transcript"/);assert.match(appSource,/id="personas-form"/);assert.match(appSource,/name="characterInstructions"/);assert.match(appSource,/name="workerInstructions"/);assert.match(appSource,/以前の記憶は保持されていますが/);
});
for(const [lineEnding,eol] of [['LF','\n'],['CRLF','\r\n']])test(`preview dialogue and separate personas persist with revision checks and never run AI (${lineEnding})`,async()=>{
 // Exercise both Git checkout styles on every OS; normalize before converting this
 // fixed module into a VM script. JavaScript dot does not consume a CR terminator.
 const source=(await readFile(new URL('../web/bridge.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n').replace(/\n/g,eol);const store=new Map(),ctx=vm.createContext({location:{protocol:'file:'},window:{},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},structuredClone,JSON,Error,Date,Map,Set,TextEncoder,DISPLAY_DEFAULT:{},validateDisplay:x=>x,demoArtifact:()=>'',AVATAR_DEFAULT,avatarNeeds,defaultAvatar,exportAvatar,importAvatarPreset,validateAvatar,defaultVoice,validateVoice,URL:{...URL,createObjectURL:()=>'blob:x',revokeObjectURL(){}},Blob,setTimeout,clearTimeout,globalThis:{crypto:{randomUUID:()=> 'uuid'}}});
 vm.runInContext(source.replace(/\r\n/g,'\n').replace(/^import .*\n/gm,'').replace(/^export /gm,''),ctx);const before=await vm.runInContext("previewRequest('/api/dialogue','GET')",ctx);assert.equal(before.session.character.name,'Tepora');
 ctx.patch={expectedRevision:0,character:{name:'Mika',instructions:'character'},worker:{name:'Builder',instructions:'worker'}};await vm.runInContext("previewRequest('/api/dialogue/personas','PUT',patch)",ctx);const after=await vm.runInContext("previewRequest('/api/dialogue','GET')",ctx);assert.equal(after.session.character.name,'Mika');assert.equal(after.personas.worker.name,'Builder');assert.equal(after.session.revision,1);assert.deepEqual(after.personas.character.voice,{tone:'polite',callName:'',proactive:'normal',lines:{}},'a persona saved without a voice keeps the default voice');
 ctx.patch2={expectedRevision:1,character:{name:'Mika',instructions:'character',voice:{tone:'soft',callName:'ハル'}},worker:{name:'Builder',instructions:'worker'}};const voiced=await vm.runInContext("previewRequest('/api/dialogue/personas','PUT',patch2)",ctx);assert.equal(voiced.character.voice.tone,'soft');assert.equal(voiced.character.voice.callName,'ハル');assert.ok(!('voice' in voiced.worker));
 ctx.patch3={expectedRevision:2,character:{name:'Mika',instructions:'x',voice:{tone:'shout'}},worker:{name:'Builder',instructions:'worker'}};await assert.rejects(vm.runInContext("previewRequest('/api/dialogue/personas','PUT',patch3)",ctx),/tone/);
 ctx.patch={...ctx.patch,expectedRevision:0};
 await assert.rejects(vm.runInContext("previewRequest('/api/dialogue/personas','PUT',patch)",ctx),/更新/);await assert.rejects(vm.runInContext("previewRequest('/api/dialogue','POST',{input:'Do real work'})",ctx),/プレビュー/);
});
