import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {VoiceDraft} from '../web/draft.mjs';
import {CompanionDraftContext,companionRole} from '../web/companion-state.mjs';
const appSource=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
const part=(start,end)=>appSource.slice(appSource.indexOf(start),end?appSource.indexOf(end,appSource.indexOf(start)):undefined);
const appFunctions=part('function cancelVoice(){','function paintMicrophone(')+part('async function finishSpeech(','\nconst actions=')+part('function showInputFiles(){','function showRequestStatus(){')+part('function invalidatePendingSubmit(){','function showTarget(){')+part('async function submitIntent(');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
async function until(fn){for(let n=0;n<80;n++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('Test action did not advance');}
function fixture(handler=()=>null){
 const calls=[],sheets=[],errors=[],elements=new Map();
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',selectionStart:0,selectionEnd:0,classList:{toggle(){}},setAttribute(){},focus(){}});return elements.get(id);};
 class RealtimeStub {constructor(){RealtimeStub.last=this;}async start(callbacks){this.callbacks=callbacks;}async stop(){this.callbacks.onFinal('Final utterance');}async cancel(){} }
 const state={companion:{revision:1,focusJobId:'main',returnStack:[]},jobs:[{id:'main',kind:'chat',revision:1}],providers:{profiles:[{id:'only-registry',model:'fixture',enabled:true}]},settings:{model:'',voiceEnabled:true,dictationEditing:false,asrStreamUrl:'http://127.0.0.1/local'}};
 const draft=new VoiceDraft(),draftContext=new CompanionDraftContext();
 let ctx;const sandbox={console,structuredClone,Error,JSON,TextDecoder,Uint8Array,crypto:{randomUUID},btoa:s=>Buffer.from(s,'binary').toString('base64'),state,draft,draftContext,companionRole,voice:null,voiceAnchor:null,voiceBusy:false,voiceEpoch:0,attachmentEpoch:0,submitEpoch:0,voiceSendEnabled:false,voiceSendConsent:null,pendingSpeech:'',capabilityUI:null,sending:false,sharedView:false,previewMode:false,pendingRequest:null,lastSubmitError:'',naturalIntent:false,naturalConsent:null,naturalProposal:null,attachedFiles:[],composerIntent:'continue',inputEngine:'builtin',RealtimeVoiceCapture:RealtimeStub,VoiceCapture:class {},lastRequestJobId:null,pendingArtifactJobId:null,replyHidden:true,$:el,settings:()=>state.settings,requestId:randomUUID,paintMicrophone(){},showRequestStatus(){},showTarget(){},showReply(){},scheduleRender(){},notice(){},upsert(){},acceptCompanion(value){state.companion=value;},clearDraftDestination(){draftContext.clear();},closeSheet(){},openSheet(...args){sheets.push(args);},onboarding:()=>({open(){throw Error('Registry-only setup must not require onboarding');}}),escape:String,icon:()=>'',btn:()=>'',bridge:{async request(path,method,value){calls.push({path,method,value:structuredClone(value)});const supplied=handler(path,method,value);if(supplied!==null&&supplied!==undefined)return supplied;if(path.startsWith('/api/requests/context'))return {id:'execution-route',remote:false,label:'Local fixture'};if(path==='/api/companion')return state.companion;if(path==='/api/requests'||path==='/api/companion/submit')return {job:state.jobs[0],companion:state.companion};return {};}}};
 sandbox.safe=fn=>async(...args)=>{try{return await fn(...args);}catch(e){errors.push(e);}};
 sandbox.document={createElement:()=>{const picker={files:[],addEventListener(){},click(){sandbox.picker=picker;}};return picker;}};
 ctx=vm.createContext(sandbox);vm.runInContext(appFunctions,ctx);
 const type=value=>{el('#composer-input').value=value;if(value)vm.runInContext('pinDraft()',ctx);draft.manual(value);};
 const run=code=>vm.runInContext(code,ctx),requests=()=>calls.filter(c=>c.path==='/api/requests'||c.path==='/api/companion/submit');
 return {ctx,state,draft,draftContext,type,run,calls,requests,sheets,errors,el,RealtimeStub};
}
test('registry-only explicit submission uses receipt route, actual chat context, and verbatim negation',async()=>{
 const f=fixture();f.type('Do not start something else. Correct this sentence.');await f.run('submitIntent()');
 assert.equal(f.requests().length,1);assert.equal(f.requests()[0].value.intent,'continue');assert.equal(f.requests()[0].value.targetJobId,'main');assert.match(f.requests()[0].value.input,/^Do not/);assert.match(f.calls[0].path,/role=chat.*targetJobId=main/);assert.ok(!f.calls.some(c=>/\/(steer|resume)$/.test(c.path)));
});
test('uncertain send locks attachment add/remove and retries exact old receipt despite new typing and engine',async()=>{
 let fail=true;const f=fixture(path=>path==='/api/requests'&&fail?Promise.reject(Object.assign(new Error('Lost response'),{status:500})):null);
 f.ctx.composerIntent='new';f.ctx.attachedFiles=[{id:'file1',name:'original.txt',bytes:5}];f.type('Original');
 await assert.rejects(f.run('submitIntent()'),/Lost/);const original=f.requests()[0].value;
 await assert.rejects(f.run("detachFile({dataset:{id:'file1'}})"),/前の送信/);await assert.rejects(f.run('attachFiles()'),/前の送信/);
 f.type('Fresh words');f.ctx.inputEngine='codex';fail=false;await f.run('submitIntent(false,true)');
 assert.deepEqual(f.requests()[1].value,original);assert.equal(f.el('#composer-input').value,'Fresh words');assert.equal(f.ctx.attachedFiles.length,0);
});
test('sending lock covers awaited context and Stop cancels before POST',async()=>{
 const hold=deferred();const f=fixture(path=>path.startsWith('/api/requests/context')?hold.promise:null);f.type('Do this');
 const first=f.run('submitIntent()');await until(()=>f.calls.length===1);await f.run('submitIntent()');assert.equal(f.calls.length,1);
 f.run('invalidatePendingSubmit();cancelVoice()');hold.resolve({id:'execution-route',remote:false});await assert.rejects(first,/中止/);assert.equal(f.requests().length,0);assert.equal(f.el('#composer-input').value,'Do this');
});
test('a file picker opened before a pending send cannot erase its uncertain receipt',async()=>{
 const hold=deferred();const f=fixture(path=>path==='/api/requests'?hold.promise:null);f.ctx.composerIntent='new';f.type('Original');
 const attach=f.run('attachFiles()');await until(()=>f.ctx.picker);const send=f.run('submitIntent()');await until(()=>f.requests().length===1);
 const observed=assert.rejects(send,/Lost/);hold.reject(Object.assign(new Error('Lost receipt'),{status:500}));await observed;
 const original=f.ctx.pendingRequest;f.ctx.picker.files=[{name:'late.txt',size:2,arrayBuffer:async()=>new TextEncoder().encode('hi').buffer}];f.ctx.picker.onchange();
 await assert.rejects(attach,/前の送信/);assert.strictEqual(f.ctx.pendingRequest,original);assert.equal(f.ctx.attachedFiles.length,0);
});
test('late recognition editing cannot enter a newer focus or offer stale append',async()=>{
 const hold=deferred();const f=fixture(path=>path==='/api/voice/edit'?hold.promise:null);f.state.settings.dictationEditing=true;
 f.run("pinDraft();voiceAnchor=draftContext.anchor(draft,{id:'old',start:0,end:0});");const old=f.run("finishSpeech('old spoken',voiceAnchor,voiceEpoch)");await until(()=>f.calls.length===1);
 f.run('cancelVoice();draftContext.clear();composerIntent="new";pinDraft()');hold.resolve({baseRevision:0,utteranceId:'old',edits:[{start:0,end:0,text:'old spoken'}]});await old;
 assert.equal(f.draft.content,'');assert.equal(f.ctx.pendingSpeech,'');assert.equal(f.requests().length,0);
});
test('default finalized speech edits draft and never executes',async()=>{
 const f=fixture();await f.run('recordToggle()');f.RealtimeStub.last.callbacks.onPartial('Partial');assert.equal(f.draft.content,'');assert.equal(f.requests().length,0);
 await f.run('recordToggle()');await until(()=>f.draft.content==='Final utterance');assert.equal(f.requests().length,0);
});
test('explicit voice opt-in sends one finalized utterance through the same receipt route; partial sends zero',async()=>{
 const f=fixture();f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};
 await f.run('recordToggle()');f.RealtimeStub.last.callbacks.onPartial('Do');f.RealtimeStub.last.callbacks.onPartial('Do something');assert.equal(f.requests().length,0);
 await f.run('recordToggle()');await until(()=>f.requests().length===1&&!f.ctx.sending);assert.equal(f.requests()[0].value.input,'Final utterance');assert.equal(f.requests()[0].value.targetJobId,'main');assert.equal(f.draft.content,'');
});
test('voice opt-in never dispatches after cancel/focus epoch change',async()=>{
 const f=fixture();f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};await f.run('recordToggle()');const stale=f.RealtimeStub.last.callbacks;
 f.run('cancelVoice();draftContext.clear();composerIntent="new";pinDraft()');stale.onFinal('Late old voice');await new Promise(r=>setImmediate(r));assert.equal(f.requests().length,0);assert.equal(f.draft.content,'');
});
test('voice automatic send cancelled during context lookup stays a draft',async()=>{
 const hold=deferred();const f=fixture(path=>path.startsWith('/api/requests/context')?hold.promise:null);f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};
 await f.run('recordToggle()');await f.run('recordToggle()');await until(()=>f.calls.some(c=>c.path.startsWith('/api/requests/context')));
 f.run('cancelVoice()');hold.resolve({id:'execution-route',remote:false});await until(()=>!f.ctx.sending);assert.equal(f.requests().length,0);assert.equal(f.draft.content,'Final utterance');assert.equal(f.ctx.pendingSpeech,'');
});
test('voice opt-in refuses attachment changes, edited dictation, and changed execution destination',async()=>{
 for(const change of ['attachment','editing','destination']){
  const f=fixture(path=>change==='destination'&&path.startsWith('/api/requests/context')?{id:'new-remote',remote:true}:null);f.ctx.voiceSendEnabled=true;f.ctx.voiceSendConsent={context:{id:'execution-route'}};await f.run('recordToggle()');
  if(change==='attachment')f.ctx.attachmentEpoch++;
  if(change==='editing'){f.state.settings.dictationEditing=true;f.ctx.bridge.request=async()=>({baseRevision:0,utteranceId:f.ctx.voiceAnchor.id,edits:[{start:0,end:0,text:'Edited'}]});}
  await f.run('recordToggle()');await new Promise(r=>setImmediate(r));assert.equal(f.requests().length,0,change);assert.ok(f.draft.content,change);
 }
});
