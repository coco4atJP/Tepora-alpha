/** beta10 replaces opt-in mode classification with one character entry point. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,deferred,until,appSource} from './helpers/dialogue-ui-fixture.mjs';
test('Stop during delayed dialogue context cannot dispatch a worker or erase the draft',async()=>{
 const hold=deferred(),f=fixture(p=>p==='/api/dialogue/context'?hold.promise:null);f.type('Keep this draft');
 const pending=f.run('submitDialogue()');await until(()=>f.calls.length);f.run('invalidatePendingSubmit()');hold.resolve({id:'route'});
 await assert.rejects(pending,/中止/);assert.equal(f.requests().length,0);assert.equal(f.draft.content,'Keep this draft');
});
test('ordinary character request has no manual intent/target and dispatches once without extra dialog',async()=>{
 const f=fixture();f.type('Can you prepare this?');await f.run('submitDialogue()');
 assert.equal(f.requests().length,1);assert.equal(f.sheets.length,0);for(const name of ['intent','targetJobId','companionRevision','proposalId'])assert.equal(f.requests()[0].value[name],undefined);
 assert.equal(f.requests()[0].value.contextConsent,'execution-route');assert.ok(!f.calls.some(c=>c.path.startsWith('/api/companion/')));
});
test('remote attachment consent names the combined character/worker destination and reuses receipt',async()=>{
 const f=fixture(p=>p==='/api/dialogue/context'?{id:'remote-route',remote:true,label:'Character A and Worker B',note:'Both exact recipients'}:null);f.ctx.attachedFiles=[{id:'file',name:'notes.txt'}];f.type('Use the selected notes');
 await f.run('submitDialogue()');assert.equal(f.requests().length,0);assert.match(f.sheets[0][1],/Character A and Worker B/);assert.match(f.sheets[0][1],/notes.txt/);const id=f.ctx.pendingRequest.body.requestId;
 await f.run(`submitDialogue('${id}')`);assert.equal(f.requests().length,1);assert.equal(f.requests()[0].value.attachmentConsent,'remote-route');assert.equal(f.requests()[0].value.requestId,id);
});
test('route change while attachment consent is open requires fresh consent without sending',async()=>{
 let route='one';const f=fixture(p=>p==='/api/dialogue/context'?{id:route,remote:true,label:route}:null);f.ctx.attachedFiles=[{id:'file',name:'notes.txt'}];f.type('Notes');await f.run('submitDialogue()');const id=f.ctx.pendingRequest.body.requestId;route='two';
 await assert.rejects(f.run(`submitDialogue('${id}')`),/接続先/);assert.equal(f.requests().length,0);assert.equal(f.draft.content,'Notes');
});
test('automatic voice send cancels when hidden during delayed context',async()=>{
 const hold=deferred(),f=fixture(p=>p==='/api/dialogue/context'?hold.promise:null);f.type('Voice words');f.ctx.voiceSendEnabled=true;f.ctx.voiceEpoch=5;
 const pending=f.run("submitDialogue(false,false,{epoch:5,destination:draftContext.destination,revision:draft.revision,attachmentEpoch:0,contextId:'route'})");await until(()=>f.calls.length);
 let hidden;f.ctx.document={hidden:true,addEventListener:(name,fn)=>{hidden=fn;}};f.run(appSource.split('\n').find(line=>line.startsWith("document.addEventListener('visibilitychange'")));hidden();hold.resolve({id:'route'});
 await assert.rejects(pending,/中止/);assert.equal(f.requests().length,0);assert.equal(f.draft.content,'Voice words');
});
for(const mutation of ['edit','disable'])test('automatic voice dispatch cancels on '+mutation,async()=>{
 const hold=deferred(),f=fixture(p=>p==='/api/dialogue/context'?hold.promise:null);f.type('Voice words');f.ctx.voiceSendEnabled=true;f.ctx.voiceEpoch=5;
 const pending=f.run("submitDialogue(false,false,{epoch:5,destination:draftContext.destination,revision:draft.revision,attachmentEpoch:0,contextId:'route'})");await until(()=>f.calls.length);
 if(mutation==='edit')f.draft.manual('Newer words');else f.ctx.voiceSendEnabled=false;hold.resolve({id:'route'});await assert.rejects(pending,/中止/);assert.equal(f.requests().length,0);
});
