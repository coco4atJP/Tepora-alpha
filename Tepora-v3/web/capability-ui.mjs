import {escape,icon,btn,field,toggle,isTrustedForm} from './ui.mjs';

/** Optional abilities stay off the home dashboard. User content never enters remote players. */
export function createCapabilityUI({bridge,openSheet,closeSheet,notice,previewMode,isPrivate,isOpen,attached=()=>[],latestReply=()=>'',onChanged=()=>{}}){
 const $=(s)=>document.querySelector(s),names={decision:'判断',embedding:'意味検索',tts:'読み上げ',image:'画像をつくる',image_edit:'画像を直す',video:'動画をつくる'};
 const protocols={'system-one':['decision','System One · Liquid d1 / Laya'],'openai-embeddings':['embedding','OpenAI互換 Embeddings'],'ollama-embed':['embedding','Ollama Embed'],'openai-speech':['tts','OpenAI互換 Speech'],'openai-images':['image','OpenAI互換 画像生成'],'openai-image-edit':['image_edit','OpenAI互換 画像編集'],'xai-video':['video','xAI 動画生成']};
 const presets={laya:{name:'Laya 多言語版',protocol:'system-one',baseUrl:'http://127.0.0.1:8767/v1',model:'multilingual',domain:'device'},liquid:{name:'Liquid d1',protocol:'system-one',baseUrl:'https://api.liquid.ai/decisions/v1',model:'d1:free',domain:'cloud',apiKeyEnv:'LIQUID_API_KEY'},embedding:{name:'このPCの意味検索',protocol:'ollama-embed',baseUrl:'http://127.0.0.1:11434/api',model:'',domain:'device'},tts:{name:'ローカル音声',protocol:'openai-speech',baseUrl:'http://127.0.0.1:8880/v1',model:'',domain:'device'},image:{name:'画像生成 API',protocol:'openai-images',baseUrl:'https://api.openai.com/v1',model:'',domain:'cloud'},edit:{name:'画像編集 API',protocol:'openai-image-edit',baseUrl:'https://api.openai.com/v1',model:'',domain:'cloud'},video:{name:'xAI Video',protocol:'xai-video',baseUrl:'https://api.x.ai/v1',model:'grok-imagine-video-1.5',domain:'cloud',assetOrigins:['https://vidgen.x.ai']}};
 const opts=(entries,selected)=>entries.map(([v,l])=>`<option value="${escape(v)}" ${v===selected?'selected':''}>${escape(l)}</option>`).join('');
 const editable=p=>Object.fromEntries(['id','name','protocol','baseUrl','model','domain','pinnedAddress','allowPlainHttp','enabled','apiKeyEnv','timeoutMs','maxParallel','resource','voice','dimensions','assetOrigins'].filter(k=>p[k]!==undefined&&p[k]!==null).map(k=>[k,p[k]]));
 let config={revision:0,profiles:[],routes:{}},selected=null,jobs=[],pending=null,loginTimer=null,querySerial=0,playing=null,pendingPlaybackId=null,speechEpoch=0,readoutRequest=null,readoutStarting=false;
 const guard=()=>{if(!isPrivate())throw Error('個人表示に戻してから開いてください。');};
 async function refresh(){config=await bridge.request('/api/capabilities');onChanged({capabilities:config});}
 function reportError(e){if(isPrivate())notice(e.message||String(e));}
 async function open(){guard();await refresh();draw();}
 function draw(){guard();openSheet('見る、聴く、つくるための接続',`<p>いつもの会話から使う能力です。主モデルとは独立して、このPC・LAN・クラウドを選べます。追加しただけではモデルを呼びません。</p>
 <div class="ability-list">${Object.entries(names).map(([role,label])=>{const p=config.profiles.find(x=>x.id===config.routes[role]);return `<article><div><strong>${label}</strong><small>${p?escape(p.name)+' · '+escape(p.model):'まだ接続していません'}</small></div>${btn('ability-new','追加','','button secondary',`data-role="${role}"`)}</article>`;}).join('')}</div>
 ${config.profiles.length?`<form id="ability-routes"><h3>使う接続先</h3><div class="form-grid">${Object.entries(names).map(([role,label])=>`<label>${label}<select name="${role}"><option value="">使わない</option>${opts(config.profiles.filter(p=>p.role===role&&p.enabled).map(p=>[p.id,p.name]),config.routes[role])}</select></label>`).join('')}</div><button class="button" type="submit">この組み合わせを使う</button></form>`:''}
 <div class="provider-list">${config.profiles.map(p=>`<article><div><strong>${escape(p.name)}</strong><small>${names[p.role]} · ${escape(p.domain)} · ${p.keyPresent?'認証あり':'キー未設定／不要'}</small></div><div>${btn('ability-edit','編集','','text-button',`data-id="${p.id}"`)}${btn('ability-key','認証','','text-button',`data-id="${p.id}"`)}</div></article>`).join('')}</div>
 <p class="small-text">確率や類似度は、事実・権限・仕事の完成を保証しません。生成・読み上げは明示的に頼んだときだけ。外部画像生成・動画生成は費用が発生する場合があります。</p>`,'abilities');}
 function editor(role='decision',id=null){selected=id;const current=config.profiles.find(p=>p.id===id),preset=Object.values(presets).find(p=>protocols[p.protocol][0]===role)||presets.laya;
  const p=current||{...preset,id:'',voice:'alloy',enabled:true,maxParallel:1,timeoutMs:120000};
  openSheet('能力の接続先',`<form id="ability-form"><label>ひな形<select id="ability-preset"><option value="">カスタム設定</option>${opts(Object.entries(presets).map(([k,p])=>[k,p.name]),'')}</select></label>
  <div class="form-grid">${field('接続ID','id',p.id)}${field('名前','name',p.name)}<label>API形式<select name="protocol">${opts(Object.entries(protocols).map(([v,a])=>[v,a[1]]),p.protocol)}</select></label><label>信頼範囲<select name="domain">${opts([['device','このPC'],['lan','指定LAN機'],['cloud','クラウド']],p.domain)}</select></label></div>
  ${field('APIベースURL','baseUrl',p.baseUrl)}${field('モデルID','model',p.model)}<div class="form-grid">${field('声（Speech用）','voice',p.voice||'alloy')}${field('埋め込み次元数（任意）','dimensions',p.dimensions||'','','number')}</div>
  <details><summary>認証・LAN・生成物の配信元</summary>${field('APIキーの環境変数名（任意）','apiKeyEnv',p.apiKeyEnv||'')}${field('LANの固定IP','pinnedAddress',p.pinnedAddress||'')}${toggle('LANの平文HTTPを許可','allowPlainHttp',p.allowPlainHttp)}<label>画像・動画の配信元（正確なHTTPSオリジンを1行1件）<textarea name="assetOrigins" rows="2" placeholder="https://vidgen.x.ai">${escape((p.assetOrigins||[]).join('\n'))}</textarea></label><p class="small-text">ダウンロード先にAPIキーを転送しません。無関係な配信元は拒否します。</p></details>
  <div class="form-grid">${field('応答待ち上限（ms）','timeoutMs',p.timeoutMs||120000,'','number')}${field('最大並行数','maxParallel',p.maxParallel||1,'','number')}</div>${toggle('有効にする','enabled',p.enabled)}<button class="button" type="submit">保存する</button>${id?btn('ability-delete','接続を削除','','text-button',`data-id="${id}"`):''}</form>`,'ability-edit');if(id)$('[name=id]').readOnly=true;
 }
 async function gallery(){guard();jobs=(await bridge.request('/api/media/jobs')).jobs;openSheet('つくったもの、届いたもの',`<div class="creative-heading"><p>生成中も、Teporaとの会話は続けられます。</p>${btn('creative-new','画像・動画をつくる','plus','button')}</div><div id="creative-feed"></div>`,'creative');paintJobs();}
 function paintJobs(){const feed=$('#creative-feed');if(!feed||!isPrivate())return;
  const present=new Set(jobs.map(j=>j.id));
  for(const el of feed.querySelectorAll('[data-creative-id]'))if(!present.has(el.dataset.creativeId)){el.querySelector('video')?.pause();el.remove();}
  if(!jobs.length){feed.innerHTML='<div class="artifact-empty"><h2>思いついたことを、かたちに。</h2><p>画像、動画、音声はここに届きます。表示中の文書は勝手に切り替えません。</p></div>';return;}
  feed.querySelector('.artifact-empty')?.remove();
  for(const j of jobs){
   let card=feed.querySelector(`[data-creative-id="${j.id}"]`);
   if(!card){card=document.createElement('article');card.className='creative-card';card.dataset.creativeId=j.id;
    card.innerHTML='<header><div><strong></strong><small></small></div></header><p class="creative-note"></p><div class="generated-surface"></div><div class="sheet-actions"></div>';
    const next=jobs.slice(jobs.indexOf(j)+1).map(x=>feed.querySelector(`[data-creative-id="${x.id}"]`)).find(Boolean);feed.insertBefore(card,next||null);
   }
   card.querySelector('strong').textContent=j.title;card.querySelector('small').textContent=`${names[j.kind]} · ${j.provider||''} · ${j.status}`;
   card.querySelector('.creative-note').textContent=j.note||'';
   card.querySelector('.sheet-actions').innerHTML=(j.asset?`<a class="text-button" href="/api/media/assets/${j.asset.id}?download=1">ファイルを保存</a>`:'')+
    (j.canResume?btn('creative-resume','同じ受付を確認','','button secondary',`data-id="${j.id}"`):'')+
    (['queued','submitting','running','downloading'].includes(j.status)?btn('creative-cancel','処理を停止','stop','text-button',`data-id="${j.id}"`):btn('creative-delete','履歴と生成物を削除','trash','text-button',`data-id="${j.id}"`));
   const slot=card.querySelector('.generated-surface'),a=j.asset;
   // Do not detach an existing media element when a different job updates.
   if(!a){if(slot.dataset.assetId){slot.querySelector('video')?.pause();slot.replaceChildren();delete slot.dataset.assetId;}continue;}
   if(slot.dataset.assetId===a.id)continue;slot.querySelector('video')?.pause();slot.replaceChildren();slot.dataset.assetId=a.id;
   if(a.mime.startsWith('audio/')){slot.innerHTML=btn('creative-listen','聴く','volume','button secondary',`data-asset="${a.id}" data-title="${escape(j.title)}"`);continue;}
   const el=document.createElement(a.mime.startsWith('image/')?'img':'video');el.dataset.mediaId=a.id;el.src=`/api/media/assets/${a.id}`;
   if(el.tagName==='IMG'){el.alt=j.title;el.loading='lazy';}else{el.controls=true;el.preload='metadata';el.playsInline=true;el.addEventListener('play',()=>{if(playing!==el)playing?.pause();playing=el;});}
   slot.append(el);
  }
 }
 async function generate(kind='image',prompt=''){guard();await refresh();const p=config.profiles.find(x=>x.id===config.routes[kind]);
  if(!p){draw();notice(`${names[kind]}の接続先を追加し、役割に選んでください。`);return;}
  pending={id:globalThis.crypto?.randomUUID?.()||Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),identity:p.identity,kind};
  const images=attached().filter(f=>f.kind==='image');jobs=(await bridge.request('/api/media/jobs')).jobs;
  openSheet(kind==='tts'?'返事を聴く':names[kind],`<form id="creative-form"><label>何をつくりますか<select name="kind" id="creative-kind">${opts(Object.entries(names).filter(([k])=>['image','image_edit','video','tts'].includes(k)).map(([k,l])=>[k,l]),kind)}</select></label>
  <label>${kind==='tts'?'読み上げる文章':'依頼'}<textarea name="prompt" rows="5" maxlength="${kind==='tts'?4096:12000}" required>${escape(prompt)}</textarea></label>
  ${['image_edit','video'].includes(kind)?`<label>使う画像<select name="source"><option value="">${kind==='video'?'画像なし（文章から）':'画像を選ぶ'}</option>${opts(images.map(f=>['input:'+f.id,f.name]),'')}${opts(jobs.filter(j=>j.asset?.mime.startsWith('image/')).map(j=>['asset:'+j.asset.id,j.title]),'')}</select></label><p class="small-text">新しい画像は、入力欄の＋で添えてから選べます。</p>`:''}
  ${kind==='video'?'<label>秒数<input type="number" name="duration" min="1" max="15" value="5"></label>':''}
  <div class="recipient-note"><strong>${escape(p.name)}</strong><span>${escape(p.model)} · ${escape(p.domain)}</span><small>${escape(new URL(p.baseUrl).origin)}</small><p>${p.domain==='device'?'このPCの接続先に文章・選択画像を渡します。推論サーバー自身の外部転送は別設定です。':'文章・選択画像はこの接続先へ送られます。契約に応じた費用がかかる場合があります。'}</p></div>
  <button class="button" type="submit">${kind==='tts'?'この文章を音声にする':'この内容で生成する'}</button><p class="small-text">送信後、先方の生成・課金は停止できない場合があります。通信が切れても無条件に再生成しません。</p></form>`,'creative-compose');
 }
 async function semantic(){guard();await refresh();const p=config.profiles.find(x=>x.id===config.routes.embedding);
  openSheet('前の話を、意味で探す',`<p>言い回しが違っても見つけやすく。原文・確認状態・共有範囲はそのまま守ります。</p><form id="semantic-form"><label>覚えていることを探す<input name="query" placeholder="例：落ち着いて作業できる場所" maxlength="4000" required></label>${p?.domain!=='device'&&p?toggle('この検索文を埋め込み先へ送信する','consent',false,`${p.name} · ${new URL(p.baseUrl).origin}`):''}<button class="button" type="submit">探す</button></form><div id="semantic-results" aria-live="polite"></div><details><summary>意味検索の準備と共有範囲</summary><p>${p?escape(p.name)+' · '+escape(p.domain):'未接続ではキーワード検索を使います。'}。索引には確認済みの記憶を使います。LAN・クラウドには共有指定の記憶だけを、許可後に送ります。</p>${p?btn('semantic-index','24件ずつ索引を更新','','button secondary'):btn('abilities-open','埋め込みを接続する','','button secondary')}<div id="semantic-index-note" role="status"></div></details>`,'semantic');
 }
 async function toolImport(){guard();openSheet('道具をまとめてつなぐ',`<p>他のクライアントの <code>mcpServers</code> 設定を貼り付けます。内容を確認した後も無効で登録し、使う接続だけ有効にします。</p><form id="tools-import-form"><label>接続設定<textarea name="json" rows="9" required placeholder='{"mcpServers":{"my-tool":{"url":"https://example.com/mcp"}}}'></textarea></label><button class="button" type="submit">取り込む内容を確認</button></form><p class="small-text">環境変数の値は起動中だけ保持します。引数に秘密を書かないでください。OAuth・SSE専用接続・任意ヘッダーの取込はまだ対応していません。</p>`,'tools-import');}
 async function toolConnect(){guard();const fresh=await bridge.request('/api/bootstrap');openSheet('使う道具をまとめて選ぶ',`<p>接続先の内容を次の画面で確認します。一度に12接続まで、実際の起動は3接続ずつ行います。</p><form id="tools-connect-form">${fresh.mcp.map(c=>`<label class="widget-option"><span><input type="checkbox" name="server" value="${c.id}"> ${escape(c.name)}</span><small>${escape(c.transport)}</small></label>`).join('')||'<p>先に接続設定を追加してください。</p>'}<button class="button" type="submit">接続内容を確認</button></form>`,'tools-connect');}
 async function toolSearch(){guard();openSheet('使える道具を探す',`<form id="tool-search-form"><label>やりたいこと<input name="query" required placeholder="例：ファイルを検索"></label><button class="button" type="submit">探す</button></form><div id="tool-search-results"></div>`,'tool-search');}
 async function catalogue(){guard();const result=await bridge.request('/api/model-catalog');openSheet('モデルを探す',`<p>models.devの公開メタデータです。対応能力は実接続の検証とは別です。ネットワークなしでも、保存済みデータを検索できます。</p><div class="sheet-actions">${btn('catalog-refresh','一覧を取得・更新','','button secondary')}${btn('catalog-import','JSONを読み込む','','text-button')}</div><form id="catalog-form"><label>モデル名・会社・入出力<input name="query" placeholder="image, local, モデル名など"></label><button type="submit" class="button">検索</button></form><div id="catalog-results"></div>`,'catalog');paintCatalog(result);}
 function paintCatalog(result){if(!isOpen('catalog'))return;$('#catalog-results').innerHTML=`<p class="small-text">${result.count}モデルのメタデータ · ${result.at?escape(result.at):'一覧を読み込んでいません'}</p>`+result.models.map(m=>`<article class="catalog-row"><strong>${escape(m.name)}</strong><small>${escape(m.provider)} · ${escape(m.input.join(', '))} → ${escape(m.output.join(', '))}</small><code>${escape(m.modelId)}</code>${btn('catalog-copy','モデルIDをコピー','','text-button',`data-value="${escape(m.modelId)}"`)}</article>`).join('');}
 function loginView(status){if(!isOpen('codex-login'))return;
  if(status.phase==='existing-api-key'){$('#managed-login').innerHTML=`<p>現在のCodexはAPIキー等で認証されています。これはChatGPTのサブスク接続とは別です。</p><p>変更するとCodex CLIと共有する認証が変わる場合があります。Teporaは既存のキーを取得・転記しません。</p>${btn('codex-login-switch','Codexの認証をChatGPTに切り替える','','button secondary')}`;return;}
  $('#managed-login').innerHTML=status.phase==='waiting'?`<p>Codexが発行した認証先で手続きを進めてください。</p>${status.userCode?`<strong class="device-code">${escape(status.userCode)}</strong>`:''}${btn('codex-login-open','OpenAIで認証する','','button secondary',`data-id="${escape(status.loginId)}"`)}<p>認証情報はCodexが保存します。Teporaはトークンを取り出しません。</p>`:`<p>${escape({idle:'まだ開始していません',starting:'Codexに接続しています',complete:'Codexの認証を確認しました',failed:'認証できませんでした。Codexの導入と対応版を確認してください。',cancelled:'手続きを取り消しました'}[status.phase]||status.phase)}</p>`;
 }
 async function login(){guard();openSheet('ChatGPTの契約でCodexを使う',`<p>インストール済みのCodex App Serverがサインインを担当します。利用枠・費用・使用できるモデルは契約に従います。まずCodex連携を有効にしてください。</p><div class="sheet-actions">${btn('codex-login-device','デバイスコードで接続','','button')}${btn('codex-login-browser','ブラウザで接続','','button secondary')}${btn('codex-login-cancel','手続きを取り消す','','text-button')}</div><div id="managed-login" role="status"></div>`,'codex-login');loginView(await bridge.request('/api/codex/login'));}
 function listenAsset(id,title){
  guard();playing?.pause();let dock=$('#ability-now-playing');if(!dock){dock=document.createElement('div');dock.id='ability-now-playing';dock.className='ability-now-playing';$('.input-region').prepend(dock);}
  dock.innerHTML=`<div><small>読み上げ · ${escape(title.slice(0,55))}</small><audio controls data-media-id="${id}" src="/api/media/assets/${id}"></audio></div>${btn('creative-audio-stop','停止','stop','text-button')}`;playing=dock.querySelector('audio');playing.play().catch(()=>notice('音声の準備ができました。再生ボタンを押してください。'));
 }
 function stopPlayback(){speechEpoch++;pendingPlaybackId=null;playing?.pause();for(const el of document.querySelectorAll('audio[data-media-id],video[data-media-id]'))el.pause();$('#ability-now-playing')?.remove();playing=null;}
 async function readReply(){
  guard();if(readoutStarting)return;const full=latestReply();if(!full.trim())throw Error('返答が届いてから読み上げできます。');
  if(full.length>4096)return generate('tts',full.slice(0,4096)).then(()=>notice('長い返答の先頭4096文字です。読み上げる範囲を確認してください。'));
  stopPlayback();const epoch=speechEpoch;readoutStarting=true;
  try{
   await refresh();if(epoch!==speechEpoch||!isPrivate())return;
   const p=config.profiles.find(x=>x.id===config.routes.tts);
   if(!p){draw();notice('読み上げの接続先を選んでください。');return;}
   // One explicit speaker click is consent for this exact reply to the configured local voice.
   // A non-device recipient still gets the full prompt/recipient confirmation sheet.
   if(p.domain!=='device')return generate('tts',full);
   if(previewMode)throw Error('プレビューでは音声を生成しません。実サービスでローカル音声に接続してください。');
   const identity=p.identity+'\n'+full;
   if(readoutRequest?.identity!==identity)readoutRequest={identity,id:globalThis.crypto?.randomUUID?.()||Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('')};
   const created=await bridge.request('/api/media/jobs','POST',{kind:'tts',prompt:full,requestId:readoutRequest.id,profileIdentity:p.identity,consent:true});
   if(epoch!==speechEpoch||!isPrivate())return;pendingPlaybackId=created.id;
   jobs=(await bridge.request('/api/media/jobs')).jobs;if(epoch!==speechEpoch||!isPrivate())return;
   const ready=jobs.find(j=>j.id===created.id&&j.asset);if(ready){pendingPlaybackId=null;listenAsset(ready.asset.id,ready.title);}else notice('このPCで音声を準備しています。別の画面を見ながら聴けます。');
  }finally{readoutStarting=false;}
 }
 const actions={
  'abilities-open':open,'ability-new':el=>editor(el.dataset.role),'ability-edit':el=>editor(null,el.dataset.id),
  'ability-key':el=>{selected=el.dataset.id;const p=config.profiles.find(p=>p.id===selected);openSheet('この能力の認証',`<p>${escape(p.name)} · ${escape(new URL(p.baseUrl).origin)}</p><form id="ability-key-form" data-identity="${p.identity}">${field('APIキー（起動中のみ）','key','','','password')}<button class="button" type="submit">この接続先だけに設定</button></form>`,'ability-key');},
  'ability-delete':async el=>{if(Object.values(config.routes).includes(el.dataset.id))throw Error('先に役割を「使わない」へ変更してください。');config=await bridge.request('/api/capabilities','PUT',{expectedRevision:config.revision,config:{profiles:config.profiles.filter(p=>p.id!==el.dataset.id).map(editable),routes:config.routes}});draw();},
  'creative-listen':el=>listenAsset(el.dataset.asset,el.dataset.title),'creative-audio-stop':stopPlayback,
  'creative-open':gallery,'creative-new':()=>generate(),'reply-speak':readReply,
  'creative-cancel':async el=>{await bridge.request(`/api/media/jobs/${el.dataset.id}/cancel`,'POST',{});await gallery();},
  'creative-resume':async el=>{await bridge.request(`/api/media/jobs/${el.dataset.id}/resume`,'POST',{});await gallery();},
  'creative-delete':el=>{openSheet('この生成物を削除しますか？',`<p>このPCに保存したファイルと生成履歴を削除します。書き出したコピーやプロバイダー側の保存は別です。</p>${btn('creative-delete-confirm','削除する','trash','button',`data-id="${el.dataset.id}"`)}`,'creative-delete');},
  'creative-delete-confirm':async el=>{const victim=jobs.find(j=>j.id===el.dataset.id);if(victim?.asset?.id===playing?.dataset.mediaId)stopPlayback();await bridge.request(`/api/media/jobs/${el.dataset.id}`,'DELETE');await gallery();},
  'semantic-open':semantic,'semantic-index':async()=>{const p=config.profiles.find(p=>p.id===config.routes.embedding);if(p?.domain!=='device'&&!$('#semantic-form [name=consent]')?.checked)throw Error('埋め込み先への送信を確認してください。');const result=await bridge.request('/api/semantic/index','POST',{consent:p?.domain!=='device',profileIdentity:p?.identity});if($('#semantic-index-note'))$('#semantic-index-note').textContent=`索引 ${result.indexed}件 / 残り ${result.remaining}件。${result.truncatedDocuments?'長い記憶は先頭区間を索引にしました。':''}`;},
  'tools-import':toolImport,'tools-import-apply':async el=>{const result=await bridge.request('/api/tools/import/apply','POST',{id:el.dataset.id,consent:true});const fresh=await bridge.request('/api/bootstrap');onChanged({mcp:fresh.mcp});closeSheet();notice(`${result.created}件を無効で追加しました。使う接続を有効にして「道具を調べる」を押してください。`);},
  'tools-discover':async el=>{guard();openSheet('この道具に接続しますか？',`<p>有効にした接続のコマンドを起動、またはHTTPサービスへ接続し、提供する道具の一覧を取得します。安全性の認証ではありません。</p>${btn('tools-discover-confirm','接続して一覧を調べる','','button',`data-id="${el.dataset.id}"`)}<div id="tool-discovery-note" role="status"></div>`,'tools-discover');},
  'tools-discover-confirm':async el=>{el.disabled=true;try{const r=await bridge.request(`/api/tools/${el.dataset.id}/discover`,'POST',{consent:true});if($('#tool-discovery-note'))$('#tool-discovery-note').textContent=`${r.count}個の道具を記録しました。検索したときに必要なものだけモデルへ渡します。`;}finally{el.disabled=false;}},
  'tools-connect':toolConnect,'tools-connect-apply':async el=>{el.disabled=true;try{const r=await bridge.request('/api/tools/connect/apply','POST',{id:el.dataset.id,consent:true});onChanged({mcp:r.servers});openSheet('接続の結果',r.results.map(x=>`<article class="catalog-row"><strong>${escape(x.name)}</strong><p>${x.ok?`${x.count}個の道具を確認`:escape(x.error)}</p></article>`).join('')+btn('tools-search','道具を検索する','','button'),'tools-connected');}finally{el.disabled=false;}},
  'tools-search':toolSearch,'catalog-open':catalogue,'catalog-refresh':async()=>{await bridge.request('/api/model-catalog/refresh','POST',{});paintCatalog(await bridge.request('/api/model-catalog'));},
  'catalog-import':()=>new Promise((resolve,reject)=>{const input=document.createElement('input');input.type='file';input.accept='.json';input.onchange=async()=>{try{const file=input.files?.[0];if(file){if(file.size>12*1024*1024)throw Error('12MB以下のJSONを選んでください。');await bridge.request('/api/model-catalog/import','POST',JSON.parse(await file.text()));paintCatalog(await bridge.request('/api/model-catalog'));}resolve();}catch(e){reject(e);}};input.oncancel=resolve;input.click();}),
  'catalog-copy':async el=>{await navigator.clipboard.writeText(el.dataset.value);notice('モデルIDをコピーしました。接続先や権限は変更していません。');},
  'codex-managed-login':login,'codex-login-device':()=>startLogin('device'),'codex-login-browser':()=>startLogin('browser'),
  'codex-login-switch':()=>startLogin('device',true),
  'codex-login-open':el=>bridge.request('/api/codex/login/open','POST',{loginId:el.dataset.id}),
  'codex-login-cancel':async()=>{clearInterval(loginTimer);loginView(await bridge.request('/api/codex/login/cancel','POST',{}));}
 };
 async function startLogin(type,switchAccount=false){if(previewMode)throw Error('プレビューではアカウントに接続しません。');const value=await bridge.request('/api/codex/login','POST',{type,switchAccount});loginView(value);clearInterval(loginTimer);loginTimer=setInterval(async()=>{if(!isOpen('codex-login')){clearInterval(loginTimer);return;}try{const value=await bridge.request('/api/codex/login');loginView(value);if(value.phase!=='waiting')clearInterval(loginTimer);}catch(e){clearInterval(loginTimer);reportError(e);}},1500);}
 document.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el&&actions[el.dataset.action])Promise.resolve().then(()=>{guard();return actions[el.dataset.action](el);}).catch(reportError);});
 document.addEventListener('change',e=>{if(e.target.id==='ability-preset'&&presets[e.target.value]){const p=presets[e.target.value],form=$('#ability-form');for(const [key,value]of Object.entries(p)){if(form.elements[key])form.elements[key].value=Array.isArray(value)?value.join('\n'):value;}if(!selected)form.elements.id.value=e.target.value+'-'+(config.profiles.length+1);}
  if(e.target.id==='creative-kind'){const prompt=$('#creative-form [name=prompt]').value;generate(e.target.value,prompt).catch(reportError);}});
 document.addEventListener('submit',e=>{const form=e.target,id=form.getAttribute('id');if(!['ability-form','ability-key-form','ability-routes','creative-form','semantic-form','tools-import-form','tool-search-form','tools-connect-form','catalog-form'].includes(id))return;e.preventDefault();
  if(!isTrustedForm(form))return;
  (async()=>{guard();const d=Object.fromEntries(new FormData(form));
   if(id==='ability-form'){
    const raw={id:d.id,name:d.name,protocol:d.protocol,baseUrl:d.baseUrl,model:d.model,domain:d.domain,pinnedAddress:d.pinnedAddress,allowPlainHttp:!!d.allowPlainHttp,enabled:!!d.enabled,apiKeyEnv:d.apiKeyEnv,voice:d.voice,timeoutMs:Number(d.timeoutMs),maxParallel:Number(d.maxParallel),assetOrigins:d.assetOrigins.split('\n').map(x=>x.trim()).filter(Boolean)};if(d.dimensions)raw.dimensions=Number(d.dimensions);
    const role=protocols[raw.protocol][0],routes={...config.routes};if(!routes[role]&&raw.enabled)routes[role]=raw.id;
    config=await bridge.request('/api/capabilities','PUT',{expectedRevision:config.revision,config:{profiles:[...config.profiles.filter(p=>p.id!==selected).map(editable),raw],routes}});onChanged({capabilities:config});draw();
   }else if(id==='ability-key-form'){await bridge.request(`/api/capabilities/${selected}/key`,'POST',{key:d.key,identity:form.dataset.identity});form.elements.key.value='';await open();}
   else if(id==='ability-routes'){config=await bridge.request('/api/capabilities','PUT',{expectedRevision:config.revision,config:{profiles:config.profiles.map(editable),routes:Object.fromEntries(Object.entries(d).filter(([,v])=>v))}});onChanged({capabilities:config});draw();}
   else if(id==='creative-form'){
    const source=d.source?.split(':');const button=form.querySelector('[type=submit]');button.disabled=true;
    try{const created=await bridge.request('/api/media/jobs','POST',{kind:d.kind,prompt:d.prompt,requestId:pending.id,profileIdentity:pending.identity,consent:true,options:d.kind==='video'?{duration:Number(d.duration)}:{},...(source?.[0]==='input'?{inputId:source[1]}:source?.[0]==='asset'?{sourceAssetId:source[1]}:{})});if(d.kind==='tts')pendingPlaybackId=created.id;await gallery();const ready=jobs.find(j=>j.id===pendingPlaybackId&&j.asset);if(ready){pendingPlaybackId=null;listenAsset(ready.asset.id,ready.title);}}finally{button.disabled=false;}
   }else if(id==='semantic-form'){const serial=++querySerial,result=await bridge.request('/api/semantic/search','POST',{query:d.query,consent:!!d.consent,profileIdentity:config.profiles.find(x=>x.id===config.routes.embedding)?.identity});if(serial!==querySerial||!isOpen('semantic'))return;$('#semantic-results').innerHTML=`<p class="small-text">${escape(result.note)} · 意味索引 ${result.indexed} / ${result.total}</p>`+result.hits.map(m=>`<article class="semantic-hit"><strong>${escape(m.title||'記憶')}</strong><p>${escape(m.content)}</p></article>`).join('')+(result.hits.length?'':'<p>該当する確認済みの記憶が見つかりませんでした。</p>');}
   else if(id==='tools-import-form'){const raw=JSON.parse(d.json);form.elements.json.value='';const result=await bridge.request('/api/tools/import/preview','POST',raw);openSheet('登録する接続を確認',`<p>${escape(result.note)}</p>${result.items.map(c=>`<article class="catalog-row"><strong>${escape(c.name)}</strong><code>${escape(c.command||c.url)}</code><small>${escape(c.transport)} · 無効で登録 · 秘密: ${escape((c.secretNames||[]).join(', ')||'なし')}</small></article>`).join('')}${btn('tools-import-apply','この内容で登録','','button',`data-id="${result.id}"`)}`,'tools-preview');}
   else if(id==='tools-connect-form'){const r=await bridge.request('/api/tools/connect/preview','POST',{ids:new FormData(form).getAll('server')});openSheet('この接続を起動しますか？',`<p>${escape(r.note)}</p>${r.connections.map(c=>`<article class="catalog-row"><strong>${escape(c.name)}</strong><pre>${escape(c.url||[c.command,...(c.args||[])].join(' '))}</pre><small>秘密情報の名前: ${escape(c.secretNames.join(', ')||'なし')}</small></article>`).join('')}${btn('tools-connect-apply','選んだ接続を起動して確認','','button',`data-id="${r.id}"`)}`,'tools-confirm');}
   else if(id==='tool-search-form'){const r=await bridge.request('/api/tools/search','POST',{query:d.query});if(!isOpen('tool-search'))return;$('#tool-search-results').innerHTML=`<p class="small-text">${escape(r.note)}</p>`+r.tools.map(t=>`<article class="catalog-row"><strong>${escape(t.name)}</strong><small>${escape(t.serverName)}</small><p>${escape(t.description)}</p></article>`).join('')+(r.tools.length?'':'<p>接続を有効にし、一覧を取得すると検索できます。</p>');}
   else if(id==='catalog-form')paintCatalog(await bridge.request('/api/model-catalog?q='+encodeURIComponent(d.query)));
  })().catch(reportError);
 });
 bridge.on(e=>{if(e.type==='media.updated'){const i=jobs.findIndex(j=>j.id===e.data.id);if(i>=0)jobs[i]=e.data;else jobs.unshift(e.data);onChanged({mediaJobs:jobs});if(isOpen('creative'))paintJobs();if(e.data.id===pendingPlaybackId&&e.data.status==='ready'&&isPrivate()){pendingPlaybackId=null;listenAsset(e.data.asset.id,e.data.title);}}
  if(e.type==='media.deleted'){const victim=jobs.find(j=>j.id===e.data.id);if(victim?.asset?.id===playing?.dataset.mediaId)stopPlayback();jobs=jobs.filter(j=>j.id!==e.data.id);onChanged({mediaJobs:jobs});if(isOpen('creative'))paintJobs();}
  if(e.type==='capabilities.updated'){config=e.data;onChanged({capabilities:config});}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPlayback();});
 return {open,gallery,semantic,stopPlayback,stop:()=>{stopPlayback();clearInterval(loginTimer);querySerial++;},onClose:()=>{for(const el of document.querySelectorAll('#creative-feed video'))el.pause();clearInterval(loginTimer);querySerial++;}};
}
