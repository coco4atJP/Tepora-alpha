import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,deferred,until} from './helpers/dialogue-ui-fixture.mjs';
test('uncertain send locks attachment add/remove and retries exact old receipt despite new typing and detail focus',async()=>{
 let fail=true;const f=fixture(path=>path==='/api/agent/input'&&fail?Promise.reject(Object.assign(new Error('Lost response'),{status:500})):null);
 f.ctx.attachedFiles=[{id:'file1',name:'original.txt',bytes:5}];f.type('Original');
 await assert.rejects(f.run('submitDialogue()'),/Lost/);const original=f.requests()[0].value;
 await assert.rejects(f.run("detachFile({dataset:{id:'file1'}})"),/前の送信/);await assert.rejects(f.run('attachFiles()'),/前の送信/);
 f.type('Fresh words');f.state.companion={revision:2,focusJobId:'other',returnStack:[]};fail=false;await f.run('submitDialogue(false,true)');
 assert.deepEqual(f.requests()[1].value,original);assert.equal(f.el('#composer-input').value,'Fresh words');assert.equal(f.ctx.attachedFiles.length,0);
});
test('a file picker opened before a pending send cannot erase its uncertain receipt',async()=>{
 const hold=deferred();const f=fixture(path=>path==='/api/agent/input'?hold.promise:null);f.type('Original');
 const attach=f.run('attachFiles()');await until(()=>f.ctx.picker);const send=f.run('submitDialogue()');await until(()=>f.requests().length===1);
 const observed=assert.rejects(send,/Lost/);hold.reject(Object.assign(new Error('Lost receipt'),{status:500}));await observed;
 const original=f.ctx.pendingRequest;f.ctx.picker.files=[{name:'late.txt',size:2,arrayBuffer:async()=>new TextEncoder().encode('hi').buffer}];f.ctx.picker.onchange();
 await assert.rejects(attach,/前の送信/);assert.strictEqual(f.ctx.pendingRequest,original);assert.equal(f.ctx.attachedFiles.length,0);
});
test('late recognition editing cannot enter a newer draft epoch or offer stale append',async()=>{
 const hold=deferred();const f=fixture(path=>path==='/api/voice/edit'?hold.promise:null);f.state.settings.dictationEditing=true;
 f.run("pinDraft();voiceAnchor=draftContext.anchor(draft,{id:'old',start:0,end:0});");const old=f.run("finishSpeech('old spoken',voiceAnchor,voiceEpoch)");await until(()=>f.calls.length===1);
 f.run('cancelVoice();draftContext.clear();pinDraft()');hold.resolve({baseRevision:0,utteranceId:'old',edits:[{start:0,end:0,text:'old spoken'}]});await old;
 assert.equal(f.draft.content,'');assert.equal(f.ctx.pendingSpeech,'');assert.equal(f.requests().length,0);
});
test('default finalized speech edits draft and never executes',async()=>{
 const f=fixture();await f.run('recordToggle()');f.RealtimeStub.last.callbacks.onPartial('Partial');assert.equal(f.draft.content,'');assert.equal(f.requests().length,0);
 await f.run('recordToggle()');await until(()=>f.draft.content==='Final utterance');assert.equal(f.requests().length,0);
});
test('explicit voice opt-in sends one finalized utterance through the same receipt route; partial sends zero',async()=>{
 const f=fixture();f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};
 await f.run('recordToggle()');f.RealtimeStub.last.callbacks.onPartial('Do');f.RealtimeStub.last.callbacks.onPartial('Do something');assert.equal(f.requests().length,0);
 await f.run('recordToggle()');await until(()=>f.requests().length===1&&!f.ctx.sending);assert.equal(f.requests()[0].value.text,'Final utterance');assert.equal(f.requests()[0].value.source,'voice');assert.equal(f.draft.content,'');
});
test('voice opt-in never dispatches after cancel/draft epoch change',async()=>{
 const f=fixture();f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};await f.run('recordToggle()');const stale=f.RealtimeStub.last.callbacks;
 f.run('cancelVoice();draftContext.clear();pinDraft()');stale.onFinal('Late old voice');await new Promise(r=>setImmediate(r));assert.equal(f.requests().length,0);assert.equal(f.draft.content,'');
});
test('voice opt-in refuses attachment changes and edited dictation',async()=>{
 for(const change of ['attachment','editing']){
  const f=fixture();f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};await f.run('recordToggle()');
  if(change==='attachment')f.ctx.attachmentEpoch++;
  if(change==='editing'){f.state.settings.dictationEditing=true;f.ctx.bridge.request=async()=>({baseRevision:0,utteranceId:f.ctx.voiceAnchor.id,edits:[{start:0,end:0,text:'Edited'}]});}
  await f.run('recordToggle()');await new Promise(r=>setImmediate(r));assert.equal(f.requests().length,0,change);assert.ok(f.draft.content,change);
 }
});
