import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
function fixture(handler){
 const input={value:'元の依頼'},calls=[],sheets=[];
 const destination={intent:'continue',targetJobId:'one',companionRevision:1,jobRevision:0,engine:'builtin'};
 const ctx=vm.createContext({console,structuredClone,JSON,Error,sending:false,voice:null,voiceBusy:false,sharedView:false,previewMode:false,pendingRequest:null,lastSubmitError:'',submitEpoch:0,voiceEpoch:0,naturalIntent:true,naturalConsent:{id:'classifier-dest'},naturalProposal:null,attachedFiles:[],composerIntent:'continue',inputEngine:'builtin',state:{companion:{revision:1,focusJobId:'one'},jobs:[{id:'one',revision:0,kind:'chat'}],providers:{profiles:[{model:'fixture'}]}},draft:{revision:0,manual(){this.revision++}},draftContext:{destination},$:()=>input,pinDraft:()=>destination,settings:()=>({model:'fixture'}),requestId:()=> 'independent-ui-request-0001',companionRole:()=> 'chat',cancelVoice(){},showRequestStatus(){},showTarget(){},showInputFiles(){},showReply(){},scheduleRender(){},notice(){},upsert(){},acceptCompanion(){},clearDraftDestination(){},closeSheet(){},openSheet(...args){sheets.push(args)},escape:String,btn:()=>'',bridge:{async request(...args){calls.push(args);return handler(...args);}}});
 vm.runInContext(source.slice(source.indexOf('function invalidatePendingSubmit()'),source.indexOf('\nfunction composerLocked()'))+source.slice(source.indexOf('async function submitIntent(')),ctx);
 return {ctx,input,calls,sheets};
}
const proposal={id:'proposal-1',action:'side',input:'元の依頼',focusRevision:1,executionDestination:'execution-dest',summary:'side'};
function contexts(p){return p==='/api/companion/context'?{id:'classifier-dest'}:p.startsWith('/api/requests/context')?{id:'execution-dest',remote:false}:null;}
async function until(fn){for(let n=0;n<50;n++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('fixture did not advance');}
test('independent UI Stop during delayed classifier cannot dispatch a new side job',async()=>{
 let release;const hold=new Promise(r=>release=r);const f=fixture(p=>p==='/api/companion/propose'?hold:contexts(p));
 const pending=vm.runInContext('submitIntent()',f.ctx);await until(()=>f.calls.some(c=>c[0]==='/api/companion/propose'));
 vm.runInContext('invalidatePendingSubmit()',f.ctx);release(proposal);
 await assert.rejects(pending,/中止/);assert.ok(!f.calls.some(c=>c[0]==='/api/companion/submit'));assert.equal(f.input.value,'元の依頼');
});
test('independent UI ambiguity preserves draft without execution',async()=>{
 const f=fixture(p=>p==='/api/companion/propose'?{...proposal,action:'clarify',question:'どちら？'}:contexts(p));
 await vm.runInContext('submitIntent()',f.ctx);assert.ok(!f.calls.some(c=>c[0]==='/api/companion/submit'));assert.equal(f.input.value,'元の依頼');assert.equal(f.ctx.naturalProposal.action,'clarify');
});
test('independent UI clear natural request dispatches once without an extra confirmation',async()=>{
 const f=fixture(p=>p==='/api/companion/propose'?proposal:p==='/api/companion/submit'?{job:{id:'side',kind:'chat'},companion:{revision:2,focusJobId:'side'}}:contexts(p));
 await vm.runInContext('submitIntent()',f.ctx);assert.equal(f.calls.filter(c=>c[0]==='/api/companion/submit').length,1);assert.equal(f.sheets.length,0);
});
test('independent UI remote file consent uses actual execution context',async()=>{
 const f=fixture(p=>p==='/api/companion/propose'?proposal:p.startsWith('/api/requests/context')?{id:'execution-dest',remote:true,label:'Fixture destination',note:'Fixture disclosure'}:contexts(p));f.ctx.attachedFiles=[{id:'file',name:'notes.txt'}];
 await vm.runInContext('submitIntent()',f.ctx);assert.ok(!f.calls.some(c=>c[0]==='/api/companion/submit'));assert.match(f.sheets[0][0],/ファイル/);assert.equal(f.ctx.pendingRequest.context.id,'execution-dest');
});
test('independent UI hiding during delayed automatic voice send prevents dispatch',async()=>{
 let release;const hold=new Promise(r=>release=r);const f=fixture(p=>p==='/api/companion/propose'?hold:contexts(p));
 Object.assign(f.ctx,{voiceSendEnabled:true,voiceEpoch:5,attachmentEpoch:0});f.ctx.cancelVoice=()=>{f.ctx.voiceEpoch++};
 const pending=vm.runInContext("submitIntent(false,false,{epoch:5,destination:draftContext.destination,revision:draft.revision,attachmentEpoch:0,contextId:'execution-dest'})",f.ctx);
 await until(()=>f.calls.some(c=>c[0]==='/api/companion/propose'));let onHidden;f.ctx.document={hidden:true,addEventListener:(name,fn)=>{onHidden=fn}};vm.runInContext(source.split('\n').find(line=>line.startsWith("document.addEventListener('visibilitychange'")),f.ctx);onHidden();release(proposal);
 await assert.rejects(pending,/中止/);assert.ok(!f.calls.some(c=>c[0]==='/api/companion/submit'));assert.equal(f.input.value,'元の依頼');
});
test('independent UI opted-in automatic voice request survives its own capture teardown',async()=>{
 const f=fixture(p=>p==='/api/companion/propose'?proposal:p==='/api/companion/submit'?{job:{id:'side',kind:'chat'},companion:{revision:2,focusJobId:'side'}}:contexts(p));
 Object.assign(f.ctx,{voiceSendEnabled:true,voiceEpoch:5,attachmentEpoch:0});f.ctx.cancelVoice=()=>{f.ctx.voiceEpoch++};
 await vm.runInContext("submitIntent(false,false,{epoch:5,destination:draftContext.destination,revision:draft.revision,attachmentEpoch:0,contextId:'execution-dest'})",f.ctx);
 assert.equal(f.calls.filter(c=>c[0]==='/api/companion/submit').length,1);
});
for(const mutation of ['draft-edit','disable'])test('independent UI automatic request cancels on '+mutation,async()=>{
 let release;const hold=new Promise(r=>release=r);const f=fixture(p=>p==='/api/companion/propose'?hold:contexts(p));
 Object.assign(f.ctx,{voiceSendEnabled:true,voiceEpoch:5,attachmentEpoch:0});f.ctx.cancelVoice=()=>{f.ctx.voiceEpoch++};
 const pending=vm.runInContext("submitIntent(false,false,{epoch:5,destination:draftContext.destination,revision:draft.revision,attachmentEpoch:0,contextId:'execution-dest'})",f.ctx);await until(()=>f.calls.some(c=>c[0]==='/api/companion/propose'));
 if(mutation==='draft-edit')f.ctx.draft.revision++;else f.ctx.voiceSendEnabled=false;release(proposal);await assert.rejects(pending,/中止/);assert.ok(!f.calls.some(c=>c[0]==='/api/companion/submit'));
});
