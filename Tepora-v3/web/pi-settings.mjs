import {escape,btn,field,isTrustedForm} from './ui.mjs';
import {editableProvider} from './provider-presets.mjs';
/** SDK catalog and account UI. Login input never passes through chat, storage exports or logs. */
export function createPiSettings({bridge,openSheet,notice,previewMode,onSaved}){
 let providers=[],config=null,auth=null,models=[],selected=null,providerId='',generation=0,poll=null,authSignature='';
 const $=q=>document.querySelector(q);
 const options=(rows,value)=>rows.map(([id,label])=>`<option value="${escape(id)}" ${id===value?'selected':''}>${escape(label)}</option>`).join('');
 const def=()=>providers.find(p=>p.id===providerId);
 const current=()=>config?.profiles.find(p=>p.id===selected);
 const connectedAccount=id=>auth?.accounts.some(a=>a.id===id&&a.provider===providerId&&a.connected)===true;
 const fail=e=>notice(e.message);
 async function load(){const result=await Promise.all([bridge.request('/api/pi/providers'),bridge.request('/api/providers'),bridge.request('/api/pi/auth')]);providers=result[0].providers;config=result[1];auth=result[2];}
 function providerOptions(value){return options(providers.map(p=>[p.id,`${p.name} · ${p.modelCount}モデル${p.oauth?' · OAuth':''}${p.available?'':' · 未接続の方式'}`]),value);}
 function authOptions(value){return options([['','この接続専用のAPIキー'],...auth.accounts.filter(a=>a.provider===providerId&&(a.connected||a.id===value)).map(a=>[a.id,`${a.label} · ${a.type==='oauth'?'OAuth':'APIキー'}${a.connected?'':' · 未接続'}`])],value);}
 function modelOptions(query='',value=current()?.model){return options(models.filter(m=>(m.name+' '+m.id).toLowerCase().includes(query.toLowerCase())).map(m=>[m.id,`${m.name} · ${m.id}`]),value);}
 async function modelList(explicitAccountId){const form=$('#pi-profile-form'),chosen=explicitAccountId??(form?form.elements.accountId.value:current()?.accountId||'');const a=auth.accounts.some(x=>x.id===chosen&&x.provider===providerId)?chosen:'';const result=await bridge.request('/api/pi/models?provider='+encodeURIComponent(providerId)+(a?'&accountId='+encodeURIComponent(a):''));models=result.models;}
 function modelFields(){const form=$('#pi-profile-form');if(!form)return;const m=models.find(x=>x.id===form.elements.model.value),account=auth.accounts.find(a=>a.id===form.elements.accountId.value);if(!m)return;
  form.elements.baseUrl.readOnly=account?.type==='oauth';form.elements.baseUrl.value=m.baseUrl;form.elements.maxTokens.value=Math.min(current()?.maxTokens||8192,m.maxTokens||8192,131072);
  $('#pi-model-note').textContent=`${m.api} · 文脈 ${m.contextTokens?.toLocaleString()||'未記載'} · 画像 ${m.vision?'対応':'非対応'} · 推論 ${m.reasoning?'対応':'未記載'}`;
 }
 function drawEditor(){
  const p=current(),provider=def();
  openSheet(p?'pi-aiの接続を編集':'pi-aiでAIを接続',`<section id="pi-editor"><p class="small-text">pi-ai ${escape(auth.version)} · ${providers.length}プロバイダー · ${providers.filter(p=>p.oauth).length}種類のOAuth。カタログ掲載と実際の利用資格は別です。</p>
  <form id="pi-profile-form"><label>プロバイダー<select name="provider" id="pi-provider">${providerOptions(providerId)}</select></label><p class="small-text">${escape(provider.note)}</p>
  <div class="provider-toolbar">${btn('pi-auth-open','アカウント / OAuthを接続','connect','button secondary',`data-provider="${escape(providerId)}"`)}</div>
  <label>認証<select name="accountId" id="pi-account">${authOptions(p?.accountId||'')}</select></label>
  <label class="toggle-row"><span>選択したアカウントのモデル一覧を外部取得し、このPCに保存することを許可する</span><input type="checkbox" id="pi-model-refresh-consent"></label>
  <div class="provider-toolbar">${btn('pi-model-refresh','モデル一覧を取得・更新','','button secondary',connectedAccount(p?.accountId)?'':'disabled')}</div><p id="pi-model-refresh-note" class="small-text" role="status"></p>
  <label>モデルを絞り込む<input type="search" id="pi-model-search" placeholder="モデル名・IDで検索" autocomplete="off"></label>
  <label>モデル<select name="model" id="pi-model" required>${modelOptions()}</select></label><p id="pi-model-note" class="small-text"></p>
  <div class="form-grid">${field('接続ID','id',p?.id||'pi-'+providerId+'-'+Date.now().toString(36))}${field('表示名','name',p?.name||provider.name)}</div>
  ${field('APIベースURL（OAuthはSDK定義に固定）','baseUrl',p?.baseUrl||'')}
  <details><summary>接続先と実行予算</summary><label>信頼する範囲<select name="domain">${options([['cloud','クラウド'],['device','このPC'],['lan','指定したLAN推論機']],p?.domain||'cloud')}</select></label>
  ${field('LAN固定IP','pinnedAddress',p?.pinnedAddress||'')}<label><input type="checkbox" name="allowPlainHttp" ${p?.allowPlainHttp?'checked':''}> LANの平文HTTPを許可する</label>
  <div class="form-grid">${field('最大出力トークン','maxTokens',p?.maxTokens||8192,'','number')}${field('同時推論数','maxParallel',p?.maxParallel||4,'','number')}</div>
  <label>推論の強さ<select name="reasoningEffort">${options([['','モデルの既定値'],['minimal','最小'],['low','低'],['medium','中'],['high','高']],p?.reasoningEffort||'')}</select></label></details>
  <p class="small-text">保存だけでは推論しません。APIキーは保存後の「認証」から入力するか、上のアカウント接続で登録します。OAuth・API課金・別アカウント間の自動切替は行いません。</p>
  <button class="button" type="submit" ${provider.available&&models.some(m=>m.available)?'':'disabled'}>このモデルを登録</button></form></section>`,'pi-provider-edit');
  if(p)$('#pi-profile-form').elements.id.readOnly=true;
  modelFields();if(p)$('#pi-profile-form').elements.baseUrl.value=p.baseUrl;
 }
 async function open({id=null,provider=null,accountId=null}={}){clearTimeout(poll);generation++;await load();selected=id;providerId=current()?.piProvider||provider||providers.find(p=>p.id==='openai')?.id||providers[0].id;await modelList(accountId||current()?.accountId||'');drawEditor();if(accountId){$('#pi-account').value=accountId;modelFields();$('[data-action="pi-model-refresh"]').disabled=!connectedAccount(accountId);}}
 function link(url,label){return url?`<a class="button secondary" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`:'';}
 function promptHTML(p){if(!p?.prompt)return '';const q=p.prompt;return `<form id="pi-auth-prompt" data-attempt="${escape(p.id)}" data-prompt="${q.id}"><label>${escape(q.message)}${q.type==='select'?`<select name="value">${options(q.options.map(o=>[o.id,o.label+' '+(o.description||'')]),'')}</select>`:`<input name="value" type="${q.type==='secret'?'password':'text'}" placeholder="${escape(q.placeholder||'')}" autocomplete="off" spellcheck="false">`}</label><button class="button" type="submit">認証へ送信</button></form>`;}
 function drawAuth(){
  const p=auth.pending,busy=['pending','cancelling'].includes(p?.status),provider=def(),event=p?.event;
  const authLink=event?.type==='auth_url'?link(event.url,'認証ページを開く'):event?.type==='device_code'?`${link(event.verificationUri,'コードを入力するページを開く')}<p>確認コード: <strong>${escape(event.userCode)}</strong></p>`:'';
  openSheet('pi-aiのアカウント接続',`<section id="pi-auth-panel"><p class="small-text">${escape(auth.note)}</p><p class="small-text">SDKが実装するOAuthを表示します。第三者アプリでの使用条件と利用枠はサービスごとに異なります。Anthropic等のサブスクリプションは、提供元が認める利用範囲を確認してください。</p>
  <label>サービス<select id="pi-auth-provider" ${busy?'disabled':''}>${providerOptions(providerId)}</select></label>
  ${!busy?`<form id="pi-auth-start"><label>認証方式<select name="type">${options([...(provider.oauth?[['oauth',provider.oauth.name]]:[]),...(provider.apiKeyLogin?[['api_key','APIキー / クラウド設定']]:[])],'oauth')}</select></label><label class="toggle-row"><span>このサービスへの認証・利用条件を確認しました</span><input type="checkbox" name="consent" required></label><button class="button" type="submit" ${auth.supported&&(provider.oauth||provider.apiKeyLogin)?'':'disabled'}>接続を開始</button></form>`:`<p role="status">${p.status==='cancelling'?'認証の取消処理を待っています。':escape(p.provider)+' の認証を待っています。'}</p>${authLink}<p class="small-text">${escape(event?.instructions||event?.message||'')}</p>${promptHTML(p)}${btn('pi-auth-cancel','ログインを取り消す','','text-button')}`}
  ${p?.error?`<p role="status">${escape(p.error)}</p>`:''}
  <div class="provider-list">${auth.accounts.map(a=>`<article><div><strong>${escape(a.label)}</strong><small>${escape(a.provider)} · ${a.type==='oauth'?'OAuth':'APIキー'} · ${a.connected?'接続済み':'未接続'}</small></div><div>${a.connected?btn('pi-account-models','モデルを選ぶ','','button secondary',`data-account="${a.id}" data-provider="${escape(a.provider)}"`):''}${!busy?btn('pi-relogin','再接続','','text-button',`data-account="${a.id}" data-provider="${escape(a.provider)}" data-type="${a.type}"`):''}${a.connected?btn('pi-disconnect','ログアウト','','text-button',`data-account="${a.id}"`):''}</div></article>`).join('')||'<p class="small-text">まだ登録アカウントはありません。</p>'}</div>
  <p class="small-text">認証情報はこのPCの専用ファイルへ保存し、チャットやエクスポートへは含めません。OSキーチェーン暗号化は未対応です。ログアウトはこのPCの資格情報を削除します（サービス側の許可取消とは別です）。</p></section>`,'pi-auth');
  authSignature=JSON.stringify(auth);if(busy)schedulePoll();
 }
 function schedulePoll(){clearTimeout(poll);const g=generation;poll=setTimeout(async()=>{if(g!==generation||!$('#pi-auth-panel'))return;try{const next=await bridge.request('/api/pi/auth');if(g!==generation||!$('#pi-auth-panel'))return;
  if(JSON.stringify(next)!==authSignature){
   // Do not replace a live secret/code field while the user types. Update after prompt completion/cancellation.
   const unchangedPrompt=next.pending?.prompt?.id===auth.pending?.prompt?.id&&next.pending?.id===auth.pending?.id&&!!next.pending?.prompt;
   auth=next;if(!unchangedPrompt)drawAuth();else{authSignature=JSON.stringify(auth);schedulePoll();}
  }else if(['pending','cancelling'].includes(next.pending?.status))schedulePoll();
 }catch(e){fail(e);}},750);}
 async function authOpen(provider){if(previewMode)throw Error('プレビューでは実アカウントへログインしません。');clearTimeout(poll);generation++;await load();providerId=provider||providerId||'openai';drawAuth();}
 const actions={
  'pi-open':()=>open(), 'pi-auth-open':e=>authOpen(e.dataset.provider),
  'pi-account-models':e=>open({provider:e.dataset.provider,accountId:e.dataset.account}),
  'pi-model-refresh':async e=>{
   const form=$('#pi-profile-form'),accountId=form?.elements.accountId?.value,provider=providerId,g=generation;
   if(!accountId)throw Error('モデル一覧を取得するアカウントを選んでください。');
   if(!connectedAccount(accountId))throw Error('選択したアカウントに再接続してください。');
   if(!$('#pi-model-refresh-consent')?.checked)throw Error('モデル一覧の外部取得と保存を許可してください。');
   e.disabled=true;const value=form.elements.model.value,baseUrl=form.elements.baseUrl.value,maxTokens=form.elements.maxTokens.value;
   try{
    const result=await bridge.request('/api/pi/models/refresh','POST',{provider,accountId,consent:true});
    if(g!==generation||$('#pi-profile-form')!==form||providerId!==provider||form.elements.accountId.value!==accountId)return;
    models=result.models;$('#pi-model').innerHTML=modelOptions('',value);if(!models.some(m=>m.id===value))form.elements.model.value='';modelFields();form.elements.maxTokens.value=maxTokens;if(auth.accounts.find(a=>a.id===accountId)?.type!=='oauth')form.elements.baseUrl.value=baseUrl;form.querySelector('[type="submit"]').disabled=!models.find(m=>m.id===form.elements.model.value)?.available;$('#pi-model-refresh-note').textContent=result.note||'モデル一覧を保存しました。';
   }finally{if(e.isConnected)e.disabled=!connectedAccount(form.elements.accountId.value);}
  },
  'pi-auth-cancel':async()=>{auth=await bridge.request('/api/pi/auth/cancel','POST',{id:auth.pending?.id});drawAuth();},
  'pi-disconnect':async e=>{auth=await bridge.request('/api/pi/auth/disconnect','POST',{accountId:e.dataset.account});drawAuth();},
  'pi-relogin':async e=>{providerId=e.dataset.provider;auth=await bridge.request('/api/pi/auth/start','POST',{provider:providerId,type:e.dataset.type,accountId:e.dataset.account,consent:true});drawAuth();}
 };
 document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&actions[el.dataset.action])Promise.resolve().then(()=>actions[el.dataset.action](el)).catch(fail);});
 document.addEventListener('input',e=>{if(e.target.id==='pi-model-search'){const value=$('#pi-model').value;$('#pi-model').innerHTML=modelOptions(e.target.value,value);modelFields();}});
 document.addEventListener('change',e=>{(async()=>{
  if(e.target.id==='pi-provider'){providerId=e.target.value;selected=null;await modelList();drawEditor();}
  if(e.target.id==='pi-model'){modelFields();$('#pi-profile-form').querySelector('[type="submit"]').disabled=!models.find(m=>m.id===e.target.value)?.available;}
  if(e.target.id==='pi-account'){const value=$('#pi-model').value;await modelList();$('#pi-model').innerHTML=modelOptions('',value);modelFields();$('#pi-model-refresh-consent').checked=false;$('[data-action="pi-model-refresh"]').disabled=!connectedAccount(e.target.value);$('#pi-profile-form').querySelector('[type="submit"]').disabled=!models.some(m=>m.available);}
  if(e.target.id==='pi-auth-provider'){providerId=e.target.value;drawAuth();}
 })().catch(fail);});
 document.addEventListener('submit',e=>{const form=e.target,formId=form.getAttribute('id');if(!['pi-profile-form','pi-auth-start','pi-auth-prompt'].includes(formId))return;e.preventDefault();if(!isTrustedForm(form))return;
  (async()=>{const d=Object.fromEntries(new FormData(form));
   if(formId==='pi-auth-start'){auth=await bridge.request('/api/pi/auth/start','POST',{provider:providerId,type:d.type,consent:d.consent==='on'});drawAuth();return;}
   if(formId==='pi-auth-prompt'){const value=d.value;form.elements.value.value='';auth=await bridge.request('/api/pi/auth/respond','POST',{id:form.dataset.attempt,promptId:Number(form.dataset.prompt),value});drawAuth();return;}
   const model=models.find(m=>m.id===d.model);if(!model?.available)throw Error('利用できるモデルを選んでください。');const account=auth.accounts.find(a=>a.id===d.accountId),old=current();
   const p={...editableProvider(old||{}),id:d.id,name:d.name,engine:'pi-ai',piProvider:providerId,model:model.id,protocol:model.protocol,baseUrl:d.baseUrl,domain:d.domain,
    authMode:account?(account.type==='oauth'?'pi-oauth':'pi-key'):'api-key',accountId:account?.id,apiKeyEnv:'',capabilities:{text:true,tools:null,vision:model.vision,structured:null},
    maxTokens:Number(d.maxTokens),contextTokens:model.contextTokens||null,maxParallel:Number(d.maxParallel),pinnedAddress:d.pinnedAddress,allowPlainHttp:!!d.allowPlainHttp,enabled:old?.enabled!==false};
   if(d.reasoningEffort)p.reasoningEffort=d.reasoningEffort;else delete p.reasoningEffort;
   config=await bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:[...config.profiles.filter(x=>x.id!==selected).map(editableProvider),p],routes:config.profiles.length?config.routes:{main:{primary:p.id,fallbacks:[]}}}});
   await onSaved(config);notice('pi-ai経由の接続を保存しました。実際の利用資格は接続試験で確認してください。');
  })().catch(fail);
 });
 return {open,auth:authOpen};
}
