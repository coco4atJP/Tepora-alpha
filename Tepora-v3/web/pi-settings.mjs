import {escape,btn,field,isTrustedForm} from './ui.mjs';
import {editableProvider} from './provider-presets.mjs';
import {createAuthBrowser} from './auth-browser.mjs';
/** SDK catalog and account UI. Login input never passes through chat, storage exports or logs. */
export function createPiSettings({bridge,openSheet,notice,previewMode,onSaved,onBack}){
 let providers=[],config=null,auth=null,models=[],selected=null,providerId='',generation=0,poll=null,authSignature='',authKind='all';
 const $=q=>document.querySelector(q);
 const authBrowser=createAuthBrowser({bridge,endpoint:'/api/pi/auth/open',hostId:'pi-auth-browser',action:'pi-auth-browser',previewMode,visible:()=>!!$('#pi-auth-panel')});
 const options=(rows,value)=>rows.map(([id,label])=>`<option value="${escape(id)}" ${id===value?'selected':''}>${escape(label)}</option>`).join('');
 const def=()=>providers.find(p=>p.id===providerId);
 const current=()=>config?.profiles.find(p=>p.id===selected);
 const connectedAccount=id=>auth?.accounts.some(a=>a.id===id&&a.provider===providerId&&a.connected)===true;
 const fail=e=>notice(e.message);
 async function load(){const result=await Promise.all([bridge.request('/api/pi/providers'),bridge.request('/api/providers'),bridge.request('/api/pi/auth')]);providers=result[0].providers;config=result[1];auth=result[2];}
 function providerOptions(value){return options(providers.map(p=>[p.id,`${p.name}${p.available?'':'（この環境では利用不可）'}`]),value);}
 function authOptions(value){return options([['','APIキー（登録後に入力）'],...auth.accounts.filter(a=>a.provider===providerId&&(a.connected||a.id===value)).map(a=>[a.id,`${a.label}${a.connected?' · 認証済み':' · 未接続'}`])],value);}
 function modelOptions(query='',value=current()?.model){return options(models.filter(m=>(m.name+' '+m.id).toLowerCase().includes(query.toLowerCase())).map(m=>[m.id,m.name||m.id]),value);}
 async function modelList(explicitAccountId){const form=$('#pi-profile-form'),chosen=explicitAccountId??(form?form.elements.accountId.value:current()?.accountId||'');const a=auth.accounts.some(x=>x.id===chosen&&x.provider===providerId)?chosen:'';const result=await bridge.request('/api/pi/models?provider='+encodeURIComponent(providerId)+(a?'&accountId='+encodeURIComponent(a):''));models=result.models;}
 function modelFields(){const form=$('#pi-profile-form');if(!form)return;const m=models.find(x=>x.id===form.elements.model.value),account=auth.accounts.find(a=>a.id===form.elements.accountId.value);if(!m)return;
  form.elements.baseUrl.readOnly=account?.type==='oauth';form.elements.baseUrl.value=m.baseUrl;form.elements.maxTokens.value=Math.min(current()?.maxTokens||8192,m.maxTokens||8192,131072);
  $('#pi-model-note').textContent=`モデルID: ${m.id} · ${m.api} · 文脈 ${m.contextTokens?.toLocaleString()||'未記載'} · 画像 ${m.vision?'対応':'非対応'} · 推論 ${m.reasoning?'対応':'未記載'}`;
 }
 function drawEditor(){
  const p=current(),provider=def(),initialModel=models.find(m=>m.id===p?.model)||models[0];
  const initialTokens=Math.min(p?.maxTokens||8192,initialModel?.maxTokens||8192,131072);
  openSheet(p?'AIの接続を編集':'AIサービスをつなぐ',`<section id="pi-editor" class="connection-editor"><header class="connection-intro"><h3>サービスとモデルを選びましょう。</h3><p>登録だけではAIを呼び出しません。APIキーは、登録したあとに設定できます。</p></header>
  ${previewMode?'<p class="connection-preview-note">表示用のモデルを使う画面サンプルです。実際のログインやAIの呼び出しは行いません。</p>':''}
  <form id="pi-profile-form"><fieldset class="connection-step"><legend><span>1</span> どのサービスを使いますか？</legend><div class="form-grid"><label>AIサービス<select name="provider" id="pi-provider">${providerOptions(providerId)}</select></label>
  <label>接続方法<select name="accountId" id="pi-account">${authOptions(p?.accountId||'')}</select></label></div><div class="provider-toolbar">${btn('pi-auth-open',provider.oauth?'アカウントでログインする':'保存した認証を追加・管理','user','text-button',`data-provider="${escape(providerId)}"`)}</div></fieldset>
  <fieldset class="connection-step"><legend><span>2</span> 使うモデルを選びます</legend><div class="form-grid"><label>モデルを検索<input type="search" id="pi-model-search" placeholder="モデル名で絞り込み" autocomplete="off"></label>
  <label>使うモデル<select name="model" id="pi-model" required>${modelOptions()}</select></label></div><p id="pi-model-search-status" class="small-text" role="status"></p><p class="small-text">一覧にあっても、このアカウントで使えるとは限りません。登録後の接続テストで確認できます。</p>
  <details class="connection-model-refresh"><summary>一覧に使いたいモデルがないとき</summary><p class="small-text">認証済みのアカウントを選ぶと、サービスからモデル一覧を取得できます。</p><label class="toggle-row"><span>サービスにモデル一覧を問い合わせ、このPCに保存してよい</span><input type="checkbox" id="pi-model-refresh-consent"></label><div class="provider-toolbar">${btn('pi-model-refresh','モデル一覧を更新','','button secondary',connectedAccount(p?.accountId)?'':'disabled')}</div><p id="pi-model-refresh-note" class="small-text" role="status"></p></details></fieldset>
  <fieldset class="connection-step"><legend><span>3</span> 分かりやすい名前を付けます</legend>${field('このAIの名前','name',p?.name||provider.name,'例：いつもの会話用')}<p class="small-text">設定画面に表示する名前です。あとから変更できます。</p></fieldset>
  <details class="connection-advanced"><summary>詳しい接続設定</summary><p class="small-text">通常はそのままで使えます。URLや実行予算を指定したいときに開いてください。</p>
  ${field('接続ID','id',p?.id||'pi-'+providerId+'-'+Date.now().toString(36))}${field('APIベースURL（アカウント接続では固定）','baseUrl',p?.baseUrl||initialModel?.baseUrl||'')}<p id="pi-model-note" class="small-text"></p><p class="small-text">${escape(provider.note||'')} · pi-ai ${escape(auth.version)}</p>
  <label>信頼する範囲<select name="domain">${options([['cloud','クラウド'],['device','このPC'],['lan','指定したLAN推論機']],p?.domain||'cloud')}</select></label>
  ${field('LAN固定IP','pinnedAddress',p?.pinnedAddress||'')}<label><input type="checkbox" name="allowPlainHttp" ${p?.allowPlainHttp?'checked':''}> LANの平文HTTPを許可する</label>
  <div class="form-grid">${field('最大出力トークン','maxTokens',initialTokens,'','number')}${field('同時推論数','maxParallel',p?.maxParallel||4,'','number')}</div>
  <label>推論の強さ<select name="reasoningEffort">${options([['','モデルの既定値'],['minimal','最小'],['low','低'],['medium','中'],['high','高']],p?.reasoningEffort||'')}</select></label></details>
  <p class="small-text">別アカウントや、アカウント接続とAPIキー接続の間では、自動で切り替えません。</p>
  <div class="connection-form-footer"><button class="button" type="submit" ${provider.available&&models.some(m=>m.available)?'':'disabled'}>${p?'変更を保存':'このAIを登録'}</button></div></form></section>`,'pi-provider-edit');
  if(p)$('#pi-profile-form').elements.id.readOnly=true;
  modelFields();if(p)$('#pi-profile-form').elements.baseUrl.value=p.baseUrl;
 }
 async function open({id=null,provider=null,accountId=null}={}){clearTimeout(poll);generation++;authBrowser.reset();await load();selected=id;providerId=current()?.piProvider||provider||providers.find(p=>p.id==='openai')?.id||providers[0].id;await modelList(accountId||current()?.accountId||'');drawEditor();if(accountId){$('#pi-account').value=accountId;modelFields();$('[data-action="pi-model-refresh"]').disabled=!connectedAccount(accountId);}}
 function updateAuthBrowser(){const p=auth.pending,e=p?.event;authBrowser.update(p,e?.type==='auth_url'?e.url:e?.type==='device_code'?e.verificationUri:null);}
 async function startAuth(data){
  if(previewMode)throw Error('プレビューでは実アカウントへログインしません。');
  const g=generation,panel=$('#pi-auth-panel'),next=await bridge.request('/api/pi/auth/start','POST',data);
  if(g!==generation||$('#pi-auth-panel')!==panel)return;
  auth=next;authBrowser.started(auth.pending?.id);drawAuth();
 }
 function promptHTML(p){if(!p?.prompt)return '';const q=p.prompt;return `<form id="pi-auth-prompt" data-attempt="${escape(p.id)}" data-prompt="${q.id}"><label>${escape(q.message)}${q.type==='select'?`<select name="value">${options(q.options.map(o=>[o.id,o.label+' '+(o.description||'')]),'')}</select>`:`<input name="value" type="${q.type==='secret'?'password':'text'}" placeholder="${escape(q.placeholder||'')}" autocomplete="off" spellcheck="false">`}</label><button class="button" type="submit">認証へ送信</button></form>`;}
 function drawAuth(){
  const p=auth.pending,busy=['pending','cancelling'].includes(p?.status),provider=def(),event=p?.event;
  const authLink=`<div id="pi-auth-browser"></div>${event?.type==='device_code'?`<p>確認コード: <strong>${escape(event.userCode)}</strong></p>`:''}`;
  openSheet('アカウントで接続',`<section id="pi-auth-panel" class="connection-editor"><header class="connection-intro"><h3>使いたいサービスにログインします。</h3><p>サービスを選んで、案内に沿って進めてください。ログインしたあとに、使うモデルを選べます。</p></header>
  ${previewMode?'<p class="connection-preview-note">画面サンプルです。プレビューではログインや認証情報の入力はできません。</p>':''}
  ${!auth.supported&&!previewMode?`<p role="status" class="connection-preview-note">${escape(auth.note||'この環境ではアカウント接続を利用できません。')}</p>`:''}
  <label>サービス<select id="pi-auth-provider" ${busy?'disabled':''}>${options(providers.filter(item=>authKind!=='oauth'||item.oauth||item.id===providerId).map(item=>[item.id,item.name]),providerId)}</select></label>
  ${!busy?`<form id="pi-auth-start"><label>ログイン方法<select name="type">${options([...(provider.oauth?[['oauth',provider.oauth.name]]:[]),...(provider.apiKeyLogin?[['api_key','APIキーで認証する']]:[])],'oauth')}</select></label><p class="small-text">利用できる機能や上限、第三者アプリでの利用条件はサービスごとに異なります。</p><label class="toggle-row"><span>このサービスへの認証・利用条件を確認しました</span><input type="checkbox" name="consent" required ${previewMode?'disabled':''}></label><button class="button" type="submit" ${!previewMode&&auth.supported&&(provider.oauth||provider.apiKeyLogin)?'':'disabled'}>ログインへ進む</button></form>`:`<p role="status">${p.status==='cancelling'?'ログインの取り消しを待っています。':'サービス側でログインを完了してください。'}</p>${authLink}<p class="small-text">${escape(event?.instructions||event?.message||'')}</p>${promptHTML(p)}${btn('pi-auth-cancel','ログインを取り消す','','text-button')}`}
  ${p?.error?`<p role="status">${escape(p.error)}</p>`:''}
  <div class="provider-list">${auth.accounts.map(a=>`<article><div><strong>${escape(a.label)}</strong><small>${escape(a.provider)} · ${a.type==='oauth'?'OAuth':'APIキー'} · ${a.connected?'接続済み':'未接続'}</small></div><div>${a.connected?btn('pi-account-models','モデルを選ぶ','','button secondary',`data-account="${a.id}" data-provider="${escape(a.provider)}"`):''}${!busy?btn('pi-relogin','再接続','','text-button',`data-account="${a.id}" data-provider="${escape(a.provider)}" data-type="${a.type}"`):''}${a.connected?btn('pi-disconnect','ログアウト','','text-button',`data-account="${a.id}"`):''}</div></article>`).join('')||'<p class="small-text">まだ登録アカウントはありません。</p>'}</div>
  <details><summary>認証情報の保存と利用条件について</summary><p class="small-text">${escape(auth.note||'')} 認証情報はこのPCの専用ファイルへ保存し、チャットやエクスポートへは含めません。OSキーチェーン暗号化は未対応です。ログアウトはこのPCの資格情報を削除します（サービス側の許可取消とは別です）。サブスクリプションは提供元が認める範囲で利用してください。</p></details></section>`,'pi-auth');
  const back=$('.modal-header [data-action=pi-back]');if(back)back.disabled=busy;
  authSignature=JSON.stringify(auth);updateAuthBrowser();if(busy)schedulePoll();
 }
 function schedulePoll(){clearTimeout(poll);const g=generation;poll=setTimeout(async()=>{if(g!==generation||!$('#pi-auth-panel'))return;try{const next=await bridge.request('/api/pi/auth');if(g!==generation||!$('#pi-auth-panel'))return;
  if(JSON.stringify(next)!==authSignature){
   // Do not replace a live secret/code field while the user types. Update after prompt completion/cancellation.
   const unchangedPrompt=next.pending?.prompt?.id===auth.pending?.prompt?.id&&next.pending?.id===auth.pending?.id&&!!next.pending?.prompt;
   auth=next;if(!unchangedPrompt)drawAuth();else{authSignature=JSON.stringify(auth);updateAuthBrowser();schedulePoll();}
  }else if(['pending','cancelling'].includes(next.pending?.status))schedulePoll();
 }catch(e){fail(e);}},750);}
 async function authOpen(provider){clearTimeout(poll);const g=++generation;authBrowser.reset();await load();if(g!==generation)return;authKind=!provider&&providers.some(p=>p.oauth)?'oauth':'all';providerId=(['pending','cancelling'].includes(auth.pending?.status)?auth.pending.provider:null)||provider||providers.find(p=>p.id==='openai'&&p.oauth)?.id||providers.find(p=>p.id==='openai-codex'&&p.oauth)?.id||providers.find(p=>p.oauth)?.id||providers[0].id;drawAuth();}
 const actions={
  'pi-back':()=>{clearTimeout(poll);generation++;authBrowser.reset();onBack?.();},
  'pi-auth-browser':()=>authBrowser.open(),
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
  'pi-auth-cancel':async()=>{authBrowser.reset();const g=generation;try{const next=await bridge.request('/api/pi/auth/cancel','POST',{id:auth.pending?.id});if(g===generation&&$('#pi-auth-panel')){auth=next;drawAuth();}}finally{if(g===generation&&$('#pi-auth-panel'))updateAuthBrowser();}},
  'pi-disconnect':async e=>{auth=await bridge.request('/api/pi/auth/disconnect','POST',{accountId:e.dataset.account});drawAuth();},
  'pi-relogin':async e=>{providerId=e.dataset.provider;await startAuth({provider:providerId,type:e.dataset.type,accountId:e.dataset.account,consent:true});}
 };
 document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&actions[el.dataset.action])Promise.resolve().then(()=>actions[el.dataset.action](el)).catch(fail);});
 document.addEventListener('input',e=>{if(e.target.id==='pi-model-search'){const value=$('#pi-model').value;$('#pi-model').innerHTML=modelOptions(e.target.value,value);modelFields();const available=models.some(m=>m.id===$('#pi-model').value&&m.available);$('#pi-profile-form').querySelector('[type="submit"]').disabled=!available;const status=$('#pi-model-search-status');if(status)status.textContent=available?'':'一致するモデルがありません。別の名前で検索してください。';}});
 document.addEventListener('change',e=>{(async()=>{
  if(e.target.id==='pi-provider'){providerId=e.target.value;selected=null;await modelList();drawEditor();}
  if(e.target.id==='pi-model'){modelFields();$('#pi-profile-form').querySelector('[type="submit"]').disabled=!models.find(m=>m.id===e.target.value)?.available;}
  if(e.target.id==='pi-account'){const value=$('#pi-model').value;await modelList();$('#pi-model').innerHTML=modelOptions('',value);modelFields();$('#pi-model-refresh-consent').checked=false;$('[data-action="pi-model-refresh"]').disabled=!connectedAccount(e.target.value);$('#pi-profile-form').querySelector('[type="submit"]').disabled=!models.some(m=>m.available);}
  if(e.target.id==='pi-auth-provider'){providerId=e.target.value;drawAuth();}
 })().catch(fail);});
 document.addEventListener('submit',e=>{const form=e.target,formId=form.getAttribute('id');if(!['pi-profile-form','pi-auth-start','pi-auth-prompt'].includes(formId))return;e.preventDefault();if(!isTrustedForm(form))return;
  (async()=>{const d=Object.fromEntries(new FormData(form));
   if(formId==='pi-auth-start'){await startAuth({provider:providerId,type:d.type,consent:d.consent==='on'});return;}
   if(formId==='pi-auth-prompt'){if(previewMode)throw Error('プレビューでは認証情報を送信しません。');const value=d.value;form.elements.value.value='';auth=await bridge.request('/api/pi/auth/respond','POST',{id:form.dataset.attempt,promptId:Number(form.dataset.prompt),value});drawAuth();return;}
   const model=models.find(m=>m.id===d.model);if(!model?.available)throw Error('利用できるモデルを選んでください。');const account=auth.accounts.find(a=>a.id===d.accountId),old=current();
   const p={...editableProvider(old||{}),id:d.id,name:d.name,engine:'pi-ai',piProvider:providerId,model:model.id,protocol:model.protocol,baseUrl:d.baseUrl,domain:d.domain,
    authMode:account?(account.type==='oauth'?'pi-oauth':'pi-key'):'api-key',accountId:account?.id,apiKeyEnv:'',capabilities:{text:true,tools:null,vision:model.vision,structured:null},
    maxTokens:Number(d.maxTokens),contextTokens:model.contextTokens||null,maxParallel:Number(d.maxParallel),pinnedAddress:d.pinnedAddress,allowPlainHttp:!!d.allowPlainHttp,enabled:old?.enabled!==false};
   if(d.reasoningEffort)p.reasoningEffort=d.reasoningEffort;else delete p.reasoningEffort;
   config=await bridge.request('/api/providers','PUT',{expectedRevision:config.revision,config:{profiles:[...config.profiles.filter(x=>x.id!==selected).map(editableProvider),p],routes:config.profiles.length?config.routes:{main:{primary:p.id,fallbacks:[]}}}});
   const needsKey=!account&&p.domain==='cloud'&&(!old?.keyPresent||old.baseUrl!==p.baseUrl||old.protocol!==p.protocol||old.piProvider!==p.piProvider);
   await onSaved(config,{id:p.id,needsKey});notice(needsKey?'AIを登録しました。次にAPIキーを設定してください。':'AIを登録しました。接続テストで利用できるか確認できます。');
  })().catch(fail);
 });
 return {open,auth:authOpen};
}
