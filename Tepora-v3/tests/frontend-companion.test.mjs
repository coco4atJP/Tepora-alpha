import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionDraftContext,companionDestination,companionArtifacts,companionReply,companionRole,companionSideJob} from '../web/companion-state.mjs';
import {VoiceDraft} from '../web/draft.mjs';
import {btn,toolbtn} from '../web/ui.mjs';
const jobs=[{id:'main',kind:'work',revision:4,output:'Main only'},{id:'side',kind:'chat',revision:2,sideOfJobId:'main',output:'Side only'}];
const focus={revision:7,focusJobId:'main',returnStack:[]};
test('first input pins destination across remote focus, engine and job changes',()=>{
 const context=new CompanionDraftContext(),first=context.pin(focus,jobs,'continue','builtin');
 const second=context.pin({...focus,revision:8,focusJobId:'side'},jobs,'new','codex');
 assert.strictEqual(first,second);assert.deepEqual(first,{intent:'continue',targetJobId:'main',companionRevision:7,jobRevision:4,engine:'builtin'});
 const rebound=context.replace({...focus,revision:8,focusJobId:'side'},jobs,'side','builtin');
 assert.equal(rebound.targetJobId,'side');assert.equal(rebound.intent,'side');assert.equal(rebound.companionRevision,8);
});
test('voice edits require exact draft revision and destination epoch, including away and back',()=>{
 const context=new CompanionDraftContext(),draft=new VoiceDraft('original');context.pin(focus,jobs,'continue','builtin');
 const anchor=context.anchor(draft,{start:0,end:0});assert.equal(context.accepts(anchor,draft),true);
 draft.manual('newer');assert.equal(context.accepts(anchor,draft),false);
 const newer=context.anchor(draft,{start:0,end:0});context.replace(focus,jobs,'continue','builtin');assert.equal(context.accepts(newer,draft),false);
});
test('focused artifact and reply selection never falls back to a side lane or global message',()=>{
 const artifacts=[{id:'b',jobId:'side'}];assert.deepEqual(companionArtifacts(artifacts,'main'),[]);assert.deepEqual(companionArtifacts(artifacts,null),[]);
 assert.equal(companionReply(jobs,[{role:'assistant',jobId:'side',content:'Wrong lane'}],'main'),'Main only');
 assert.equal(companionReply([], [{role:'assistant',jobId:'side',content:'Wrong lane'}],'main'),'');
 assert.equal(companionReply(jobs,[],null),'');assert.equal(companionSideJob(jobs[1]),true);assert.equal(companionSideJob({parentJobId:'main'}),false);
});
test('explicit route role follows focused job or the actual new request kind',()=>{
 assert.equal(companionRole(companionDestination(focus,jobs,'continue'),jobs),'work');
 assert.equal(companionRole(companionDestination(focus,jobs,'new'),jobs),'chat');
 assert.equal(companionRole(companionDestination(focus,jobs,'side'),jobs,1),'work');
 assert.equal(companionRole(companionDestination(focus,jobs,'new','codex'),jobs),'work');
 assert.equal(companionDestination({revision:0,focusJobId:null},jobs,'continue').intent,'new');
});
test('reusable UI controls inside forms cannot implicitly submit a request',()=>{
 assert.match(btn('cancel','Cancel'),/^<button type="button"/);assert.match(toolbtn('close','Close','close'),/^<button type="button"/);
});
