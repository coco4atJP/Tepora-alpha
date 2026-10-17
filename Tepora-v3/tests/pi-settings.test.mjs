import test from 'node:test';
import assert from 'node:assert/strict';
import {createPiSettings} from '../web/pi-settings.mjs';

// Exercise the production controller with inert DOM controls; no browser, account or network.
const account='pi-11111111-1111-4111-8111-111111111111';
const baseline={id:'old-model',name:'Old model',api:'openai-completions',protocol:'chat-completions',baseUrl:'https://provider.invalid/v1',contextTokens:64000,maxTokens:8192,available:true};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function select(html=''){
 let value='',rows=[];return {get value(){return value;},set value(next){value=rows.some(row=>row.id===next)?next:'';},set innerHTML(next){rows=[...next.matchAll(/<option value="([^"]*)"([^>]*)>/g)].map(m=>({id:m[1],selected:/\bselected\b/.test(m[2])}));value=(rows.find(row=>row.selected)||rows[0])?.id||'';},get innerHTML(){return html;},init(next){this.innerHTML=next;return this;}}.init(html);
}
async function fixture(t,{connected=true}={}){
 const previous=globalThis.document,listeners={},nodes=new Map(),calls=[],notices=[];
 let html='',form;
 globalThis.document={querySelector:q=>nodes.get(q)||null,addEventListener:(kind,callback)=>{listeners[kind]=callback;}};
 t.after(()=>{globalThis.document=previous;});
 const profile={id:'profile',name:'Fixture',engine:'pi-ai',piProvider:'fixture',model:baseline.id,baseUrl:baseline.baseUrl,accountId:account,authMode:'pi-key',maxTokens:8192};
 const bridge={async request(url,method,body){calls.push({url,method,body});
  if(url==='/api/pi/providers')return {providers:[{id:'fixture',name:'Fixture',modelCount:1,apiKeyLogin:true,available:true}]};
  if(url==='/api/providers')return {revision:1,profiles:[profile],routes:{main:{primary:profile.id,fallbacks:[]}}};
  if(url==='/api/pi/auth')return {version:'1.3.0',supported:true,accounts:[{id:account,provider:'fixture',label:'Account',type:'api_key',connected}]};
  if(url.startsWith('/api/pi/models?'))return {models:url.includes('accountId=')?[baseline]:[{...baseline,id:'manual-model'}]};
  if(url==='/api/pi/models/refresh')return {models:[{...baseline,id:'new-model'}],note:'Synthetic saved snapshot'};
  throw Error('Unexpected fixture request '+url);
 }};
 const settings=createPiSettings({bridge,notice:message=>notices.push(message),onSaved:()=>{},openSheet(title,next){html=next;
  const getOptions=id=>next.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1]||'';
  const model=select(getOptions('pi-model'));model.id='pi-model';
  const accountSelect=select(getOptions('pi-account'));accountSelect.id='pi-account';
  const submit={disabled:false},refresh={dataset:{action:'pi-model-refresh'},isConnected:true,disabled:/data-action="pi-model-refresh" disabled/.test(next)};refresh.closest=()=>refresh;
  form={elements:{id:{},accountId:accountSelect,model,baseUrl:{value:profile.baseUrl},maxTokens:{value:'8192'}},querySelector:()=>submit};
  nodes.set('#pi-profile-form',form);nodes.set('#pi-account',accountSelect);nodes.set('#pi-model',model);nodes.set('#pi-model-note',{textContent:''});nodes.set('#pi-model-refresh-consent',{checked:false});nodes.set('#pi-model-refresh-note',{textContent:''});nodes.set('[data-action="pi-model-refresh"]',refresh);
 }});
 await settings.open({id:profile.id});
 return {calls,notices,nodes,form,html,click:()=>listeners.click({target:nodes.get('[data-action="pi-model-refresh"]')}),change:target=>listeners.change({target})};
}
test('explicit refresh requires consent, preserves edits and never silently changes model',async t=>{
 const f=await fixture(t);f.click();await tick();assert.equal(f.calls.some(call=>call.method==='POST'),false);assert.match(f.notices[0],/許可/);
 f.nodes.get('#pi-model-refresh-consent').checked=true;f.form.elements.baseUrl.value='https://custom.invalid/v1';f.form.elements.maxTokens.value='777';f.click();await tick();
 const posted=f.calls.find(call=>call.method==='POST');assert.deepEqual(posted.body,{provider:'fixture',accountId:account,consent:true});
 assert.equal(f.form.elements.baseUrl.value,'https://custom.invalid/v1');assert.equal(f.form.elements.maxTokens.value,'777');assert.equal(f.form.elements.model.value,'');assert.equal(f.form.querySelector().disabled,true);
 f.form.elements.model.value='new-model';f.change(f.form.elements.model);await tick();assert.equal(f.form.querySelector().disabled,false);
});
test('selecting manual-key authentication requests only its baseline catalog',async t=>{
 const f=await fixture(t);f.form.elements.accountId.value='';f.change(f.form.elements.accountId);await tick();
 assert.equal(f.calls.at(-1).url,'/api/pi/models?provider=fixture');assert.equal(f.form.elements.model.value,'manual-model');assert.equal(f.nodes.get('[data-action="pi-model-refresh"]').disabled,true);
});
test('re-editing a disconnected profile retains its account and disables refresh',async t=>{
 const f=await fixture(t,{connected:false});assert.equal(f.form.elements.accountId.value,account);assert.match(f.html,/未接続/);assert.equal(f.nodes.get('[data-action="pi-model-refresh"]').disabled,true);
});
