import {createCapabilityUI} from './capability-ui.mjs';
import {createProviderSettings} from './provider-settings.mjs';
import {createOnboarding} from './onboarding.mjs';
import {bridge,previewMode} from './bridge.mjs';
import {escape,icon,btn,toolbtn,statuses,setArtifactFrame,field,toggle,modal} from './ui.mjs';
import {DISPLAY_DEFAULT,WIDGETS} from './display-model.mjs';
import {VoiceDraft} from './draft.mjs';
import {CompanionDraftContext,companionDestination,companionArtifacts,companionReply,companionSideJob,companionRole} from './companion-state.mjs';
import {VoiceCapture} from './voice.mjs';
import {RealtimeVoiceCapture} from './realtime-voice.mjs';

const app=document.querySelector('#app'),overlay=document.querySelector('#overlay'),toastEl=document.querySelector('#toast');
const $=(selector,scope=document)=>scope.querySelector(selector);
let state,view='home',selectedArtifact=null,pinnedArtifact=null,followArtifact=true;
let workTab='tasks',inputEngine='builtin';
let sharedView=false,activeDialog=null,dialogReturnFocus=null,online=true,replyHidden=true;
const noticedRoutes=new Set();
let voice=null,voiceBusy=false,voiceAnchor=null,pendingSpeech='',displayHistory=[],refreshTimer,toastTimer;
let weatherData=null,newsData=null,lastVisibleKey='',pendingArtifactJobId=null;
let composerIntent='new',naturalIntent=false,naturalConsent=null,naturalProposal=null,voiceEpoch=0,attachmentEpoch=0,submitEpoch=0;
let voiceSendEnabled=false,voiceSendConsent=null,pendingVoiceConsent=null;
const draftContext=new CompanionDraftContext();
const draft=new VoiceDraft();
let capabilityUI=null;
function abilities(){return capabilityUI||=createCapabilityUI({bridge,openSheet,closeSheet,notice,previewMode,isPrivate:()=>!sharedView,isOpen:kind=>activeDialog?.kind===kind&&!sharedView,attached:()=>attachedFiles,latestReply:()=>companionReply(state.jobs,state.messages,state.companion?.focusJobId),onChanged:values=>{Object.assign(state,values);paintCreative();if(view==='connections'&&!activeDialog)scheduleRender();}});}
function paintCreative(){const media=state.mediaJobs||[],active=media.filter(j=>['queued','submitting','running','downloading'].includes(j.status)).length,attention=media.filter(j=>['paused','unknown','awaiting-download'].includes(j.status)).length,el=document.querySelector('#creative-access');if(el){const ready=media.filter(j=>j.status==='ready').length;el.textContent=attention?`生成物 · ${attention}件の確認`:active?`生成物 · ${active}件進行中`:ready?`届いた生成物 · ${ready}件`:'つくったもの';el.hidden=sharedView;}}
let providerUI=null;
function providerSettings(){return providerUI||=createProviderSettings({bridge,openSheet,closeSheet,notice,previewMode,legacySettings:settings,onChanged:value=>{state={...state,...value};paintNetwork();if(view==='connections')scheduleRender();}});}
function paintNetwork(){const el=document.querySelector('#network-state');if(el)el.textContent=({online:'オンライン',offline:'完全オフライン','trusted-lan':'信頼LANだけ'})[state.network?.mode||'online'];}
let setupUI=null,attachedFiles=[],pendingRequest=null,sending=false,lastRequestJobId=null,lastSubmitError='';
function onboarding(){
 setupUI ||= createOnboarding({bridge,openSheet,closeSheet,isOpen:()=>activeDialog?.kind==='setup'&&!sharedView,
  notice,onConnected:async value=>{const fresh=await bridge.request('/api/bootstrap');state.settings=fresh.settings;state.setup=value;},advanced:()=>providerSettings().open()});
 return setupUI;
}

const widgetNames={clock:'時計',companion:'相棒',weather:'天気',news:'ニュース',media:'音楽',work:'進行中の仕事',artifact:'成果物'};
const activeJobs=()=>state.jobs.filter(j=>['queued','running','waiting_approval'].includes(j.status));
const settings=()=>state.settings;
const display=()=>state.display||DISPLAY_DEFAULT;
const safe=fn=>async(...args)=>{try{return await fn(...args);}catch(e){if(e.name!=='AbortError')notice(e.message||String(e));}};
function notice(message){
 toastEl.textContent=sharedView?'Teporaからお知らせがあります。個人表示で確認できます。':message;
 toastEl.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.classList.remove('show'),5500);
}
function saveFile(name,content,type='application/json'){
 const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');
 a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function chooseJSON(){
 return new Promise((resolve,reject)=>{
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
  input.onchange=async()=>{try{
   const f=input.files?.[0];if(!f)return resolve(null);
   if(f.size>12*1024*1024)throw new Error('12MB以下のJSONを選んでください。');
   resolve(JSON.parse(await f.text()));
  }catch(e){reject(e);}};input.addEventListener('cancel',()=>resolve(null),{once:true});input.click();
 });
}
function shell(){
 app.innerHTML=`<div class="calm-shell">
 <header class="calm-header"><button class="wordmark" data-action="view" data-view="home" aria-label="Teporaホーム">tepora<span class="presence-dot" aria-hidden="true"></span></button>
 <nav aria-label="Tepora"><button data-action="view" data-view="home">ホーム</button><button data-action="view" data-view="workspace">作業 <span id="work-count"></span></button><button data-action="view" data-view="memory">記憶</button><button data-action="view" data-view="connections">接続</button></nav>
 <div class="header-tools"><button class="network-state" id="network-state" data-action="providers-launch">オンライン</button>${toolbtn('share','共有表示に切り替える','shield','id="share-button"')}${toolbtn('display','表示をカスタマイズ','settings')}${toolbtn('fullscreen','全画面を切り替える','expand')}</div></header>
 ${previewMode?'<div class="preview-strip">操作プレビュー · AI推論・PC操作は行いません</div>':''}
 <main id="surface"></main><div class="creative-access"><button id="creative-access" data-action="creative-open">つくったもの</button></div>
 <section class="input-region" aria-label="Teporaに頼む"><div id="reply" class="reply" hidden></div>
 <div id="voice-caption" class="voice-caption" aria-live="polite"></div><div id="target-hint" aria-live="polite"></div>
 <div id="request-status" class="request-status" role="status" aria-live="polite"></div><div id="input-files" class="input-files"></div>
 <form id="composer-form" class="composer"><button type="button" data-action="attach" class="icon-button" aria-label="ファイルを添える">${icon('plus')}</button><textarea id="composer-input" rows="1" maxlength="32000" aria-label="Teporaへの依頼" placeholder="Teporaに話しかける"></textarea>
 <button type="button" data-action="mic" class="icon-button" id="mic-button" aria-label="音声入力を開始">${icon('mic')}</button><button type="submit" class="send-button" aria-label="送信">${icon('arrow')}</button></form>
 <div class="input-footer"><button data-action="agent-select" id="agent-selector">Tepora</button><button data-action="onboard" id="readiness">${previewMode?'プレビューの使い方':'接続と使い始め'}</button><button data-action="undo-draft">入力を戻す</button><button data-action="stop" class="stop-link">${icon('stop')}すべて停止</button></div></section></div>`;
 document.body.classList.toggle('preview',previewMode);
 abilities();render();tick();paintNetwork();paintCreative();
}
function applyTheme(){
 document.body.dataset.theme=display().theme;
 document.body.classList.toggle('shared-view',sharedView);
 document.documentElement.style.fontSize=`${16*display().textScale}px`;
 $('#share-button')?.setAttribute('aria-pressed',String(sharedView));
}
function home(){
 const prefs=display(),now=Date.now();
 const widgets=prefs.widgets.filter(w=>!prefs.hiddenUntil[w]||Date.parse(prefs.hiddenUntil[w])<=now);
 const surfaces=widgets.map(w=>{
  if(sharedView&&!['clock','companion','work'].includes(w))return '';
  if(w==='clock')return '<section class="clock-widget" aria-label="時計"><time id="clock-display"></time><div id="clock-date"></div></section>';
  if(w==='companion')return prefs.companion==='none'?'':`<div class="presence ${prefs.companion}" aria-label="Teporaの相棒"><i></i><i></i></div>`;
  if(w==='work')return `<section class="glance"><button data-action="view" data-view="workspace">${sharedView?'非公開の仕事': '進行中の仕事'} ${activeJobs().length}件 ${icon('arrow')}</button></section>`;
  if(w==='artifact')return `<section class="home-artifact">${artifactSurface()}</section>`;
  if(w==='weather')return `<section class="glance"><h2>天気</h2>${weatherData?`<strong>${Math.round(weatherData.current.temperature_2m)}°</strong><p>${escape(weatherData.city)}</p>`:'<p>場所と情報源を設定すると表示します。</p>'}${btn('weather','更新','refresh','text-button')}</section>`;
  if(w==='news')return `<section class="glance"><h2>ニュース</h2>${newsData?newsData.items.slice(0,3).map(n=>`<a href="${escape(n.url)}" target="_blank" rel="noreferrer">${escape(n.title)}</a>`).join(''):'<p>自分で選んだRSSだけを表示します。</p>'}${btn('news','更新','refresh','text-button')}</section>`;
  if(w==='media')return `<section class="glance media-glance">${icon('music')}<div><h2>好きな音を、この場所に。</h2>${btn('media','音楽・動画を開く','','text-button')}</div></section>`;
  return '';
 }).join('');
 const approvals=state.jobs.filter(j=>j.status==='waiting_approval').length;const blocked=state.jobs.filter(j=>['blocked','failed'].includes(j.status)).length;
 const proposals=(state.routines||[]).filter(r=>r.status==='proposed').length+(state.plans||[]).filter(p=>p.status==='proposed').length;
 return `<div class="quiet-home">${surfaces||'<button class="empty-home" data-action="display">この画面に表示するものを選ぶ</button>'}
 <div class="ambient-state">${proposals?`<button data-action="proposals">${proposals}件の提案を確認 ${icon('arrow')}</button>`:''}${activeJobs().length||blocked?`<button data-action="view" data-view="workspace">${blocked?`${blocked}件の仕事が待機・確認中です`:approvals?`${approvals}件の確認が必要です`:`${activeJobs().length}件の仕事を進めています`} ${icon('arrow')}</button>`:''}</div>
 ${sharedView?'<div class="shared-note">共有表示 · 個人情報を画面に出しません。仕事は継続します。</div>':''}</div>`;
}
function focusJob(){return state.jobs.find(j=>j.id===state.companion?.focusJobId);}
function focusedArtifacts(){return companionArtifacts(state.artifacts,state.companion?.focusJobId);}
function taskRows(){
 const row=j=>`<article class="task-row ${j.id===state.companion?.focusJobId?'focused':''}"><button type="button" class="task-focus" data-action="focus-task" data-id="${escape(j.id)}" aria-pressed="${j.id===state.companion?.focusJobId}"><strong>${escape(j.title)}</strong><small>${escape(j.note)}</small><span class="task-status">${escape(statuses[j.status]||j.status)}</span></button>${btn('task','詳細','','text-button',`data-id="${escape(j.id)}"`)}</article>`;
 const main=state.jobs.filter(j=>!companionSideJob(j)),side=state.jobs.filter(companionSideJob);
 return `${main.slice(0,60).map(row).join('')||'<p class="empty-copy">依頼した仕事がここに残ります。</p>'}${side.length?`<section class="side-lane" aria-label="並行して頼んだ用事"><h3>並行して頼んだ用事</h3><p>元の仕事へ戻れる、別の用事です。</p>${side.slice(0,20).map(row).join('')}</section>`:''}`;
}
function artifactSurface(){
 const artifacts=focusedArtifacts(),latest=artifacts.find(a=>a.id===selectedArtifact)||artifacts[0];
 if(!latest){selectedArtifact=null;pinnedArtifact=null;return `<div class="artifact-empty"><h2>${focusJob()?'この仕事の成果物が、ここに届きます。':'仕事を選ぶと、成果物がここに表示されます。'}</h2><p>別の用事の成果物がこの画面に割り込むことはありません。</p>${btn('demo','画面サンプルを試す','play','button')}<small>このサンプルはAIを呼びません。</small></div>`;}
 selectedArtifact=latest.id;
 if(!pinnedArtifact||pinnedArtifact.id!==latest.id)pinnedArtifact=structuredClone(latest);
 const hasNew=latest.version>pinnedArtifact.version;
 return `<div class="artifact-panel"><div class="artifact-toolbar"><div><strong>${escape(pinnedArtifact.title)}</strong><small>版 ${pinnedArtifact.version}${hasNew?' · 新しい版があります':''}</small></div><div>${toolbtn('artifact-follow',followArtifact?'更新を固定する':'最新の版を表示する','refresh')}${toolbtn('artifact-edit','成果物を直接編集','file')}${toolbtn('artifact-save','成果物を書き出す','download')}</div></div><div id="artifact-preview" class="artifact-frame"></div><div class="artifact-footer">${followArtifact?'途中経過に追従中 · 読むときは更新を固定できます':'この版を固定しています'}${btn('artifact-target','この仕事に追加指示','','text-button')}</div></div>`;
}
function workView(){
 if(workTab!=='tasks')return automationView();
 const artifacts=focusedArtifacts();
 return `<section class="page work-page"><div class="page-title"><h1>${escape(focusJob()?.title||'任せていること')}</h1>${btn('demo','画面サンプル','play','button secondary')}</div>${workTabs()}<div class="work-layout"><aside class="task-list">${taskRows()}</aside><section>${artifacts.length>1?`<div class="artifact-tabs">${artifacts.map(a=>`<button type="button" data-action="artifact-select" data-id="${escape(a.id)}" aria-pressed="${a.id===selectedArtifact}">${escape(a.title)}</button>`).join('')}</div>`:''}${artifactSurface()}</section></div></section>`;
}
function workTabs(){return `<div class="work-tabs" role="group" aria-label="仕事の種類">${[['tasks','仕事'],['plans','段階のあるプラン'],['routines','習慣・定期実行']].map(([key,label])=>`<button data-action="work-tab" data-tab="${key}" aria-pressed="${workTab===key}">${label}</button>`).join('')}</div>`;}
function verificationHTML(job){
 const checks=job.verification?.checks;
 return `<div id="verification">${checks?.results?.length?`<section class="check-report"><strong>${checks.passed?'指定した検査が通りました':'検査で確認が必要です'}</strong><ul>${checks.results.map(r=>`<li>${r.passed?'✓':'!'} ${escape(r.label)}${r.error?` — ${escape(r.error)}`:''}</li>`).join('')}</ul><small>指定した条件だけの検査です。依頼全体の品質保証ではありません。</small></section>`:''}${job.agentPlan?.length?`<ol>${job.agentPlan.map(s=>`<li>${escape(s.step)} <small>${escape(s.status)}</small></li>`).join('')}</ol>`:''}</div>`;
}
function automationView(){
 const plan=workTab==='plans',entries=plan?state.plans:state.routines;
 return `<section class="page"><div class="page-title"><h1>${plan?'順序と役割を、ひとつの仕事に。':'繰り返すことを、任せる。'}</h1>${btn(plan?'plan-add':'routine-add',plan?'プランを作る':'習慣を追加','plus','button')}</div>${workTabs()}
 <p class="automation-intro">${plan?'先に進められる段階は並行し、必要な成果が揃ってから次へ進みます。':'提案を有効にした後だけ実行します。Teporaのサービスが停止中やPCがスリープ中は実行できません。'}</p>
 <div class="automation-list">${entries.length?entries.map(item=>plan?planCard(item):routineCard(item)).join(''):`<div class="artifact-empty"><h2>${plan?'仕事の流れを組み立てる':'いつもの仕事を、忘れずに'}</h2><p>会話から提案してもらうか、ここで追加できます。</p>${btn(plan?'plan-add':'routine-add',plan?'プランを作る':'習慣を追加','plus','button secondary')}</div>`}</div></section>`;
}
function planCard(p){return `<article class="automation-card"><header><div><h2>${escape(p.title)}</h2><small>${escape({proposed:'まだ実行していません',running:'段階を進めています',paused:'一時停止',review:'結果の確認待ち','needs-consent':'接続の再確認が必要です'}[p.status]||p.status)}</small></div>${p.status==='running'?btn('plan-pause','一時停止','pause','button secondary',`data-id="${p.id}"`):['proposed','paused','needs-consent'].includes(p.status)?btn('plan-start',p.status==='proposed'?'このプランを開始':'未開始の段階を再開','play','button',`data-id="${p.id}"`):''}</header>
 <div class="stage-flow">${p.nodes.map(n=>{const j=state.jobs.find(j=>j.id===p.jobs[n.key]);return `<section class="stage"><small>${n.dependsOn.length?'前提: '+n.dependsOn.map(key=>escape(p.nodes.find(x=>x.key===key)?.title||key)).join('、'):'独立した段階'}</small><h3>${escape(n.title)}</h3><p>${escape(n.input)}</p><small>${escape({produced:'結果が用意できたら次へ',checked:'指定検査の合格後に次へ',accepted:'人の確認後に次へ'}[n.gate])}</small>${j?btn('task',statuses[j.status]||j.status,'arrow','text-button',`data-id="${j.id}"`):'<small>未開始</small>'}</section>`;}).join('')}</div>${p.note?`<p>${escape(p.note)}</p>`:''}</article>`;}
function routineCard(r){const label=r.schedule.type==='daily'?`${r.schedule.time} · ${r.schedule.timezone}`:r.schedule.type==='interval'?`${r.schedule.minutes}分ごと`:new Date(r.schedule.at).toLocaleString('ja-JP');
 return `<article class="automation-card"><header><div><h2>${escape(r.title)}</h2><small>${escape(label)} · ${r.enabled?'有効':'停止中'}</small></div>${btn('routine-toggle',r.enabled?'停止する':'内容を確認して有効にする',r.enabled?'pause':'play','button secondary',`data-id="${r.id}"`)}</header><p>${escape(r.input)}</p><div class="routine-meta">${r.nextAt?`次回: ${escape(new Date(r.nextAt).toLocaleString('ja-JP'))}`:'未開始'}${r.lastJobId?btn('task','前回の仕事','arrow','text-button',`data-id="${r.lastJobId}"`):''}</div>${r.note?`<p>${escape(r.note)}</p>`:''}<small>実行時は現在の接続先を固定します。接続先や権限を変えた場合は、再確認まで実行しません。</small></article>`;
}
function codexSheet(){const s=settings();openSheet('Codexをエージェントとして接続',`<p>インストール済みのCodex App Serverを使います。認証ファイルをTeporaへ取り込まず、Codexの認証とモデル設定を利用します。</p><form id="codex-form">
 ${toggle('Codexの起動と依頼の受け渡しを許可','codexEnabled',s.codexEnabled,'依頼内容はCodexで選択したプロバイダーへ送られます。TeporaのローカルLLM設定とは別です。')}
 ${field('Codex実行ファイル（空欄ならPATHのcodex）','codexBinary',s.codexBinary||'')}${field('モデル（空欄ならCodexの設定）','codexModel',s.codexModel||'')}
 ${toggle('Codex作業環境からのネットワーク利用','codexNetwork',s.codexNetwork,'作業フォルダー内の書き込みと制限付きの読み取りを指定します。権限拡大の要求は受け入れません。')}
 <button class="button" type="submit">この範囲で保存する</button>${btn('codex-check','起動・認証状態を確認','connect','button secondary')}<p id="codex-status" role="status"></p>
 </form><div class="sheet-actions">${btn('codex-managed-login','ChatGPTの契約でサインイン','','button secondary')}</div><p class="small-text">Windowsではネイティブの実行ファイルを指定してください。未対応のプロトコルや環境では停止し、強い権限へ勝手に切り替えません。</p>`,'codex');}
function routineSheet(){openSheet('繰り返す仕事を追加',`<form id="routine-form">${field('名前','title','','例: 朝の調べもの')}<label>任せること<textarea name="input" rows="3" maxlength="32000" required></textarea></label>
 <label>繰り返し<select name="scheduleType"><option value="daily">毎日、指定した時刻</option><option value="interval">一定の間隔</option><option value="once">一度だけ</option></select></label>
 <div class="form-grid"><label>毎日の時刻<input type="time" name="time" value="09:00"></label>${field('タイムゾーン','timezone',Intl.DateTimeFormat().resolvedOptions().timeZone||'Asia/Tokyo')}
 <label>間隔（分）<input type="number" name="minutes" min="5" max="525600" value="60"></label><label>一度だけの日時（この端末の時刻）<input type="datetime-local" name="onceAt"></label></div>
 <label>休止中に時刻を過ぎた場合<select name="catchUp"><option value="latest">直近の1回だけ（猶予時間内）</option><option value="skip">過ぎた分は実行しない</option></select></label>
 <p class="small-text">まず提案として保存します。有効にするまで実行しません。前回の仕事が停止・中断中なら新しい仕事を重ねません。</p><button class="button" type="submit">提案を保存する</button></form>`,'routine');}
function planSheet(){openSheet('並行する2段階と、仕上げを作る',`<form id="plan-form">${field('全体の名前','title','','例: 二つの案を比較してまとめる')}
 ${[1,2,3].map(n=>`<fieldset><legend>${n===3?'前の2段階を受け取って仕上げる':`${n}つ目の独立した仕事`}</legend>${field('段階の名前','title'+n,'')}<label>依頼<textarea name="input${n}" rows="2" required maxlength="8000"></textarea></label></fieldset>`).join('')}
 <p class="small-text">提案として保存します。前提と内容を見てから開始できます。より複雑な依存関係・受け入れ条件は会話またはAPIで指定できます。</p><button class="button" type="submit">プランを保存する</button></form>`,'plan');}
function memoryView(){
 return `<section class="page"><div class="page-title"><div><h1>覚えていること</h1><p>記憶は編集・削除できます。提案された記憶は確認後に使います。</p></div><div>${btn('semantic-open','意味で探す','memory','button secondary')}${btn('memory-add','記憶を追加','plus','button')}</div></div><div class="memory-list">${state.memories.map(m=>`<article><div><small>${m.confirmed?(m.scope==='shared'?'共有を許可':'このPCだけ'):'確認前'}</small><h2>${escape(m.title||'記憶')}</h2><p>${escape(m.content)}</p></div><div>${!m.confirmed?btn('memory-confirm','使う','check','text-button',`data-id="${escape(m.id)}"`):''}${toolbtn('memory-edit','記憶を編集','file',`data-id="${escape(m.id)}"`)}${toolbtn('memory-delete','この記憶を削除','trash',`data-id="${escape(m.id)}"`)}</div></article>`).join('')||'<p class="empty-copy">まだ記憶はありません。大量のプロフィール入力は不要です。</p>'}</div><div class="page-actions">${btn('context-export','専用データを書き出す','download','button secondary')}${btn('context-import','専用データを読み込む','upload','button secondary')}</div></section>`;
}
function connectionView(){
 return `<section class="page"><div class="page-title"><h1>つながりと道具</h1>${btn('onboard','使い始めを確認','','button')}</div><div class="connection-list">
 <article><div><h2>聴く、思い出す、つくる</h2><p>読み上げ・意味検索・画像・動画・軽い判断の接続先を、それぞれ選べます。</p></div>${btn('abilities-open','能力をつなぐ','','button')}${btn('creative-new','つくってみる','','text-button')}</article>
 <article><div><h2>プロバイダーと通信</h2><p>クラウドの主モデル、ローカルの継続先、画像担当を分けて選べます。LANは特定の推論機だけを信頼します。</p></div>${btn('providers-launch','使い分ける','','button')}${btn('catalog-open','モデルを探す','','text-button')}</article>
 <article><div><h2>コンピューター操作</h2><p>専用ブラウザとWindows UIA。Layaの候補選択と、必要時だけVLMの画像観測を使います。</p></div>${btn('computer-launch','接続する','','button secondary')}</article>
 <article><div><h2>会話と仕事</h2><p>${escape(settings().model||'モデルを接続すると実際の依頼ができます。')}</p></div>${btn('runtime-settings','接続する','','button secondary')}</article>
 <article><div><h2>ローカル音声・軽量判断</h2><p>Laya多言語版を独立した判断役に。音声と判断の無断クラウド切替えはありません。</p></div>${btn('voice-settings','設定','','button secondary')}</article>
 <article><div><h2>Codex</h2><p>モデルAPIではなく、エージェントごと接続します。途中指示・停止・承認をこの画面で扱います。</p></div>${btn('codex-settings','接続する','','button secondary')}</article>
 <article><div><h2>共有スキル</h2><p>~/.agents/skills を読み取り専用で探します。発見しただけでは実行・有効化しません。</p></div>${btn('shared-scan','共有スキルを探す','','button secondary')}</article>
 ${state.skills.map(s=>`<article><div><h2>${escape(s.name||s.id)}</h2><p>${escape(s.description||'')}${s.source==='shared'?' · 共通資産（読み取り専用）':''}</p></div>${btn('skill-details','内容を見る','','text-button',`data-id="${escape(s.id)}"`)}${btn('skill-toggle',s.enabled===false?'有効にする':'無効にする','','text-button',`data-id="${escape(s.id)}"`)}</article>`).join('')}
 <article><div><h2>MCP</h2><p>必要な道具だけ接続します。コマンドは接続を保存しただけでは起動しません。</p></div>${btn('tools-import','まとめて追加','','button secondary')}${btn('mcp-add','1件追加','','text-button')}${btn('tools-connect','まとめて接続','','text-button')}${btn('tools-search','道具を探す','','text-button')}</article>
 ${state.mcp.map(m=>`<article><div><h2>${escape(m.name)}</h2><p>${escape(m.transport)}</p></div>${m.enabled?btn('tools-discover','道具を調べる','','text-button',`data-id="${m.id}"`):''}${btn('mcp-toggle',m.enabled?'無効にする':'有効にする','','text-button',`data-id="${escape(m.id)}"`)}</article>`).join('')}
 </div></section>`;
}
function render(){
 if(!state)return;
 applyTheme();
 const oldFrame=$('#artifact-preview iframe');
 $('#surface').innerHTML=sharedView&&view!=='home'?home():view==='home'?home():view==='workspace'?workView():view==='memory'?memoryView():connectionView();
 document.querySelectorAll('[data-action=view]').forEach(b=>b.setAttribute('aria-current',b.dataset.view===view?'page':'false'));
 $('#work-count').textContent=activeJobs().length||'';
 showRequestStatus();showInputFiles();
 const target=$('#artifact-preview');
 if(target&&pinnedArtifact){
  const key=`${pinnedArtifact.id}:${pinnedArtifact.version}`;
  if(oldFrame?.dataset.key===key)target.append(oldFrame);else setArtifactFrame(target,pinnedArtifact);
 }
 tick();showReply();showTarget();paintCreative();
}
function syncLiveSurface(){render();}
function scheduleRender(){clearTimeout(refreshTimer);refreshTimer=setTimeout(syncLiveSurface,80);}
function tick(){
 const now=new Date();
 if($('#clock-display'))$('#clock-display').textContent=now.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
 if($('#clock-date'))$('#clock-date').textContent=now.toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'long'});
 // Expiry affects presentation only, never the permanent layout or task execution.
 const key=JSON.stringify(Object.entries(display().hiddenUntil).filter(([,t])=>Date.parse(t)>Date.now()).map(([w])=>w));
 if(lastVisibleKey&&lastVisibleKey!==key&&view==='home')scheduleRender();
 lastVisibleKey=key;
}
function invalidatePendingSubmit(){submitEpoch++;if(pendingRequest&&!pendingRequest.dispatched&&!pendingRequest.uncertain)pendingRequest=null;}
function composerLocked(){return sending||Boolean(pendingRequest?.uncertain);}
function requireComposerUnlocked(){if(composerLocked())throw new Error('前の送信結果を確認してから変更してください。同じ送信を確認しても依頼は重複しません。');}
function pinDraft(){return draftContext.pin(state.companion,state.jobs,composerIntent,inputEngine);}
function clearDraftDestination(){draftContext.clear();naturalProposal=null;}
function showTarget(){
 const host=$('#target-hint');if(!host)return;if(sharedView){host.innerHTML='';return;}
 const focus=focusJob(),destination=draftContext.destination,target=state.jobs.find(j=>j.id===destination?.targetJobId),locked=composerLocked();
 const changed=destination&&(destination.companionRevision!==state.companion.revision||destination.intent==='continue'&&destination.jobRevision!==target?.revision);
 host.innerHTML=`<div class="companion-focus"><span>${focus?`開いている仕事: <strong>${escape(focus.title)}</strong>`:'新しい会話を始められます'}</span>${state.companion.returnStack?.length?btn('return-focus','前の仕事へ戻る','','text-button',locked?'disabled':''):''}<small>切り替え・戻る操作だけでは仕事を実行しません</small></div>
 <div class="composer-intents" role="group" aria-label="依頼の送り先">${[['continue','この仕事の続き'],['new','新しい用事'],['side','並行して頼む']].map(([intent,label])=>btn('composer-intent',label,'','text-button',`data-intent="${intent}" aria-pressed="${composerIntent===intent}" ${(locked||(!focus&&intent!=='new'))?'disabled':''}`)).join('')}${btn('natural-intent',naturalIntent?'意図の判断: オン':'意図の判断: オフ','','text-button',locked&&!naturalIntent?'disabled':'')}${btn('voice-autosend',voiceSendEnabled?'話し終えたら送信: オン':'話し終えたら送信: オフ','','text-button',locked&&!voiceSendEnabled?'disabled':'')}</div>
 ${destination?`<div class="draft-destination">下書きの送り先: ${escape(destination.intent==='new'?'新しい用事':destination.intent==='side'?`${target?.title||destination.targetJobId||'元の仕事'}から別の用事へ。元の仕事へ戻れます`:target?.title||destination.targetJobId||'新しい用事')}${changed?`<span> · 状態が変わりました。送り先を確認してください</span>${btn('rebind-draft','この下書きの送り先を確認','','text-button',locked?'disabled':'')}`:''}</div>`:''}
 ${naturalProposal?`<div class="intent-proposal"><strong>${escape(naturalProposal.action==='clarify'?'送り先を確認したいこと':naturalProposal.summary||'依頼の送り先')}</strong><p>${escape(naturalProposal.question||'')}</p><small>上の「続き・新しい用事・並行」で送り先を指定できます。</small></div>`:''}`;
}
function showReply(){
 const el=$('#reply');if(!el)return;
 const content=companionReply(state.jobs,state.messages,state.companion?.focusJobId);
 if(sharedView||replyHidden||!content){el.hidden=true;el.replaceChildren();return;}
 el.hidden=false;el.innerHTML=`<div>${escape(content)}</div><div class="reply-controls">${toolbtn('reply-speak','返事を聴く','volume')}${toolbtn('hide-reply','返答を閉じる','close')}</div>`;
}
function acceptCompanion(value){
 if(!value)return;const prior=state.companion||{revision:-1,focusJobId:null};
 if(value.revision<prior.revision)return;
 state.companion=value;
 if(prior.focusJobId!==value.focusJobId){invalidatePendingSubmit();voiceSendEnabled=false;voiceSendConsent=null;cancelVoice();capabilityUI?.stopPlayback();selectedArtifact=null;pinnedArtifact=null;pendingArtifactJobId=null;followArtifact=true;replyHidden=false;
  if(!draftContext.destination)composerIntent=value.focusJobId?'continue':'new';
 }
 showTarget();scheduleRender();
}
async function navigateFocus(jobId,{returning=false}={}){
 requireComposerUnlocked();cancelVoice();
 if(!returning&&jobId===state.companion.focusJobId){closeSheet();view='workspace';workTab='tasks';render();return;}
 const value=await bridge.request(returning?'/api/companion/return':'/api/companion/focus','POST',returning?{expectedRevision:state.companion.revision}:{jobId,expectedRevision:state.companion.revision,pushReturn:true});
 acceptCompanion(value);closeSheet();view='workspace';workTab='tasks';render();
}
async function chooseComposerIntent(intent){
 requireComposerUnlocked();cancelVoice();voiceSendEnabled=false;voiceSendConsent=null;composerIntent=intent;naturalProposal=null;naturalIntent=false;
 if(draft.content||attachedFiles.length)draftContext.replace(state.companion,state.jobs,intent,inputEngine);else clearDraftDestination();
 showTarget();$('#composer-input').focus();
}
async function rebindDraft(){
 requireComposerUnlocked();const destination=draftContext.destination;
 if(destination?.targetJobId&&destination.targetJobId!==state.companion.focusJobId)await navigateFocus(destination.targetJobId);
 await chooseComposerIntent(destination?.intent||composerIntent);
}
async function configureNaturalIntent(){
 if(naturalIntent){invalidatePendingSubmit();naturalIntent=false;naturalConsent=null;naturalProposal=null;showTarget();return;}
 requireComposerUnlocked();
 if(!focusJob())throw new Error('この機能は仕事を開いているときに使えます。');
 const focusRevision=state.companion.revision,focusJobId=state.companion.focusJobId;
 const context=await bridge.request('/api/companion/context');requireComposerUnlocked();
 if(focusRevision!==state.companion.revision)throw new Error('対象が変わりました。送り先を確認してください。');
 naturalConsent={...context,focusJobId};
 openSheet('送り先の判断をAIに任せますか？',`<p>続き・新しい用事・並行のどれかを、送信時に判断します。はっきりした場合はそのまま依頼を始め、あいまいな場合は確認します。</p><p>判断する対象: ${escape(focusJob()?.title||'選択中の仕事')}</p><p>判断の接続先: ${escape(context.label)}</p><p>${escape(context.note)}</p><p>現在の仕事の目的・指示・直近のユーザー発言と、入力した文章を送ります。判断のために追加のモデル呼び出しが1回発生し、接続先の料金がかかる場合があります。</p><p>いつでも上のボタンで送り先を指定できます。</p>${btn('enable-natural-intent','この接続先で判断を有効にする','','button')}`,'natural-consent');
}
async function configureVoiceSend(){
 if(voiceSendEnabled){voiceSendEnabled=false;voiceSendConsent=null;invalidatePendingSubmit();cancelVoice();showTarget();return;}
 requireComposerUnlocked();
 if(previewMode)throw new Error('プレビューでは音声を認識・送信しません。');
 if(settings().dictationEditing)throw new Error('言い直しの編集を使うときは、音声を下書きで確認してから送信してください。');
 const destination=companionDestination(state.companion,state.jobs,composerIntent,inputEngine);
 if(draft.content||attachedFiles.length)throw new Error('この機能は、空の下書きからの音声入力で使えます。今の下書きは送信または消去してから設定してください。');
 const context=await bridge.request(`/api/requests/context?engine=${encodeURIComponent(destination.engine)}&role=${companionRole(destination,state.jobs,0)}${destination.intent==='continue'?`&targetJobId=${encodeURIComponent(destination.targetJobId)}`:''}`);
 requireComposerUnlocked();if(JSON.stringify(destination)!==JSON.stringify(companionDestination(state.companion,state.jobs,composerIntent,inputEngine)))throw new Error('対象が変わりました。送り先を確認してください。');
 pendingVoiceConsent={destination,context};
 openSheet('話し終えた内容を、そのまま送信しますか？',`<p>自分でマイクを押して録音し、止めると、確定した認識文を通常の送信と同じ経路で依頼します。途中の認識文では実行しません。時間上限による録音終了時も、確定した文が対象です。</p><p>送り先: ${escape(destination.intent==='continue'?focusJob()?.title||destination.targetJobId:destination.intent==='side'?'別の用事。元の仕事へ戻れます':'新しい用事')}</p><p>実行する接続先: ${escape(context.label)}</p><p>音声は設定済みのローカル認識経路で処理します。確定した文は上記の接続先へ送られ、推論・仕事の利用料金がかかる場合があります。${naturalIntent?'意図の判断を有効にしているため、追加の対象判断も行います。':''}</p><p>空の下書きから始め、録音中に入力・添付・送り先が変わらない場合だけ送信します。編集提案は下書きのままです。いつでもオフにできます。</p>${btn('enable-voice-send','この条件で話し終えたら送信する','','button')}`,'voice-send-consent');
}
function openSheet(title,body,kind='generic',id=null){capabilityUI?.onClose();
 clearTimeout(toastTimer);toastEl.classList.remove('show');
 dialogReturnFocus=document.activeElement;activeDialog={kind,id};
 overlay.innerHTML=modal(escape(title),body,kind==='artifact-edit');
 document.body.classList.add('dialog-open');
 setTimeout(()=>$('input,textarea,select,button',overlay)?.focus(),0);
}
function closeSheet(){capabilityUI?.onClose();
 overlay.replaceChildren();document.body.classList.remove('dialog-open');activeDialog=null;
 if(dialogReturnFocus?.isConnected)dialogReturnFocus.focus();
}
function displaySheet(){
 const d=display(),order=[...d.widgets,...WIDGETS.filter(w=>!d.widgets.includes(w))];
 openSheet('この画面を、あなたに合わせる',`<form id="display-form">
 <div class="form-grid"><label>テーマ<select name="theme">${['system','light','dark'].map(v=>`<option value="${v}" ${d.theme===v?'selected':''}>${{system:'端末に合わせる',light:'明るい',dark:'暗い'}[v]}</option>`).join('')}</select></label>
 <label>文字の大きさ<input name="textScale" type="number" min=".8" max="1.8" step=".05" value="${d.textScale}"></label>
 <label>相棒<select name="companion">${['orb','brass','none'].map(v=>`<option value="${v}" ${d.companion===v?'selected':''}>${{orb:'静かな相棒',brass:'あたたかな相棒',none:'表示しない'}[v]}</option>`).join('')}</select></label></div>
 <h3>表示するもの・順序</h3><div id="widget-order">${order.map(w=>`<div class="widget-option" data-widget="${w}"><label><input type="checkbox" name="widget" value="${w}" ${d.widgets.includes(w)?'checked':''}>${widgetNames[w]}</label><div><button type="button" data-action="widget-up" aria-label="${widgetNames[w]}を上へ">↑</button><button type="button" data-action="widget-down" aria-label="${widgetNames[w]}を下へ">↓</button></div></div>`).join('')}</div>
 <div class="sheet-actions"><button class="button" type="submit">表示に反映する</button>${btn('display-undo','前の表示に戻す','','button secondary')}${btn('display-reset','既定に戻す','','text-button')}</div></form>
 <div class="page-actions">${btn('display-export','表示を保存','download','text-button')}${btn('display-import','表示を読み込む','upload','text-button')}${btn('hide-news-today','ニュースを今日だけ隠す','','text-button')}</div><p class="small-text">表示の変更でモデル・権限・仕事は変わりません。</p>`,'display');
}
function runtimeSheet(){
 if(state.providers?.profiles?.length){providerSettings().open();return;}
 const s=settings();openSheet('会話と仕事をつなぐ',`<p>起動済みの接続先を指定できます。使い始めの画面では、稼働中のOllama経由でモデルを取得できます。OSへの実行基盤の自動インストールは行いません。</p>
 ${btn('discover','このPCの接続先を探す','refresh','button secondary')}<div id="discovery"></div>
 <form id="runtime-form"><details open><summary>接続設定</summary>
 <label>実行基盤<select name="provider">${['llama.cpp','vllm','ollama','lmstudio','compatible'].map(x=>`<option ${s.provider===x?'selected':''}>${x}</option>`).join('')}</select></label>
 ${field('接続先','baseUrl',s.baseUrl)}${field('モデル','model',s.model)}${field('APIキー（起動中のみ保持）','sessionKey','','','password')}
 ${toggle('外部モデルへの接続を許可','allowCloud',s.allowCloud,'ローカル音声・Layaには適用しません。')}
 ${toggle('共有指定した記憶だけ外部モデルに渡す','shareMemory',s.shareMemory)}
 <label>1回の実行予算（ステップ）<input type="number" name="maxSteps" min="1" max="512" value="${s.maxSteps}"></label>
 <label>並行する仕事<input type="number" name="concurrency" min="1" max="32" value="${s.concurrency}"></label></details>
 <button class="button" type="submit">保存して接続を確認</button>${btn('model-probe','ツールの実往復を試験','check','button secondary')}<div id="connection-result" role="status"></div></form>`,'runtime');
}
function voiceSheet(){
 const s=settings();openSheet('ローカル音声と軽量判断',`<form id="voice-form">
 ${field('リアルタイム音声ワーカーのURL','asrStreamUrl',s.asrStreamUrl||'','http://127.0.0.1:8768')}
 ${field('LayaのSystem One URL','decisionUrl',s.decisionUrl,'http://127.0.0.1:8767/v1/systemone')}
 ${field('判断モデル','decisionModel',s.decisionModel||'multilingual')}
 <p class="small-text">Layaは multilingual を使用します。ワーカーとモデルの導入・実機性能確認は別途必要です。未接続でも文字での依頼はできます。</p>
 <details><summary>録音後に認識する互換経路</summary>${field('音声認識URL','asrUrl',s.asrUrl||'')}${field('音声モデル','asrModel',s.asrModel||'')}</details>
 ${toggle('ローカルモデルで言い直しを整理する','dictationEditing',s.dictationEditing,'途中の音声を実行命令にせず、版付きの下書き編集だけを行います。ローカルの会話モデルが必要です。')}
 ${toggle('音声入力を使用する','voiceEnabled',s.voiceEnabled,'マイクはボタンを押すまで起動しません。')}
 <button class="button" type="submit">保存する</button></form>`,'voice');
}
function approvalBox(j){
 if(!j.approval)return '';
 const detail=j.approval.name==='computer_open'&&j.approval.args.htmlArtifactId?'この仕事が作成したHTMLだけを専用のオフラインブラウザで開きます。外部通信やホストAPIは使わず、この文書内の操作を設定した回数上限まで任せます。いつでも全停止できます。':'この操作はPCまたは接続した道具に影響します。権限は今回の操作だけに適用します。CLIはホスト上で動き、OSサンドボックスではありません。';
 return `<section class="approval-box"><h3>実行前の確認</h3><p>${detail}</p><pre>${escape(j.approval.name)}\n${escape(JSON.stringify(j.approval.args,null,2))}</pre><div class="sheet-actions">${btn('approve','この操作を許可','check','button',`data-id="${escape(j.approval.id)}"`)}${btn('deny','実行しない','','button secondary',`data-id="${escape(j.approval.id)}"`)}</div></section>`;
}
function taskSheet(id){
 const j=state.jobs.find(x=>x.id===id);if(!j)return;
 openSheet(j.title,`<p><span class="task-status" id="task-status">${escape(statuses[j.status]||j.status)}</span></p><p id="task-note">${escape(j.note)}</p>
 ${verificationHTML(j)}<p id="task-route" class="small-text">${j.executionRoute?escape(`実行先: ${j.executionRoute.profileId} · ${j.executionRoute.model} (${j.executionRoute.domain})`):''}</p><div id="task-approval">${approvalBox(j)}</div><pre id="task-output">${escape(j.output||'')}</pre>
 <div class="task-meta-actions">${btn('raise-priority','優先して進める','arrow','text-button',`data-id="${j.id}"`)}${btn('recheck','成果物を再検査','check','text-button',`data-id="${j.id}"`)}</div><div class="sheet-actions" id="task-actions">${['paused','interrupted','failed','blocked'].includes(j.status)?btn('resume','続きを再開','play','button',`data-id="${j.id}"`):''}${['running','queued','waiting_approval'].includes(j.status)?btn('pause','一時停止','pause','button secondary',`data-id="${j.id}"`):''}${j.status==='review'?btn('accept','結果を確認した','check','button',`data-id="${j.id}"`):''}${btn('target-task','追加の指示を送る','','button secondary',`data-id="${j.id}"`)}${btn('cancel','この仕事を停止','stop','text-button',`data-id="${j.id}"`)}</div>
 <details open><summary>作成したファイル</summary><div id="task-files"></div></details><details><summary>実行の記録・結果不明の操作</summary><div id="effects">記録を読み込んでいます。</div></details>`,'task',id);
 if(!previewMode)bridge.request(`/api/jobs/${id}/files`).then(r=>{if(activeDialog?.id!==id)return;$('#task-files').innerHTML=r.files.map(f=>`<a class="workspace-download" href="/api/jobs/${encodeURIComponent(id)}/download?path=${encodeURIComponent(f.path)}" download>${escape(f.path)} <small>${f.bytes.toLocaleString()} bytes</small></a>`).join('')||'<p class="small-text">まだ作成されたファイルはありません。</p>';}).catch(()=>{});
 if(!previewMode)bridge.request(`/api/jobs/${id}/effects`).then(effects=>{
  if(activeDialog?.id!==id)return;
  $('#effects').innerHTML=effects.map(e=>`<article><strong>${escape(e.name)} · ${escape(e.status)}</strong><pre>${escape(JSON.stringify({arguments:e.args,result:e.result},null,2))}</pre>${['unknown','running'].includes(e.status)?`<p>外部の実状態を確認してください。再実行は自動で行いません。</p>${btn('reconcile-done','実行済みと確認','','button secondary',`data-id="${escape(e.id)}"`)}${btn('reconcile-none','未実行と確認','','button secondary',`data-id="${escape(e.id)}"`)}`:''}</article>`).join('')||'<p>操作の記録はありません。モデルの返答だけで完了とは判断しません。</p>';
 }).catch(e=>{if($('#effects'))$('#effects').textContent=e.message;});
 else $('#effects').textContent='AIを使わない画面サンプルです。';
}
function refreshTask(){
 if(activeDialog?.kind!=='task')return;
 const j=state.jobs.find(x=>x.id===activeDialog.id);if(!j)return;
 const prior=$('#task-status').dataset.status;
 if($('#task-route')&&j.executionRoute)$('#task-route').textContent=`実行先: ${j.executionRoute.profileId} · ${j.executionRoute.model} (${j.executionRoute.domain})`;
 $('#task-note').textContent=j.note;$('#task-status').textContent=statuses[j.status]||j.status;$('#task-status').dataset.status=j.status;$('#task-output').textContent=j.output||'';if($('#verification'))$('#verification').outerHTML=verificationHTML(j);
 if(prior!==j.status&&$('#task-actions')){
  $('#task-actions').innerHTML=(['paused','interrupted','failed','blocked'].includes(j.status)?btn('resume','続きを再開','play','button',`data-id="${j.id}"`):'')+
   (['running','queued','waiting_approval'].includes(j.status)?btn('pause','一時停止','pause','button secondary',`data-id="${j.id}"`):'')+
   (j.status==='review'?btn('accept','結果を確認した','check','button',`data-id="${j.id}"`):'')+
   btn('target-task','追加の指示を送る','','button secondary',`data-id="${j.id}"`)+btn('cancel','この仕事を停止','stop','text-button',`data-id="${j.id}"`);
 }
 const box=$('#task-approval'),id=j.approval?.id||'';
 if(box.dataset.approval!==id){box.dataset.approval=id;box.innerHTML=approvalBox(j);}
}
function memorySheet(id){
 const m=state.memories.find(x=>x.id===id);
 openSheet(m?'記憶を編集する':'覚えておいてほしいこと',`<form id="memory-form" data-id="${id||''}">${field('見出し','title',m?.title||'')}<label>内容<textarea name="content" rows="6" maxlength="32000" required>${escape(m?.content||'')}</textarea></label>${toggle('この記憶を外部モデルにも共有できるようにする','shared',m?.scope==='shared','外部モデル利用と記憶共有の両方を許可した場合だけです。')}<button type="submit" class="button">保存する</button></form>`,'memory');
}
function mcpSheet(){
 openSheet('MCPの道具を追加',`<form id="mcp-form">${field('接続名','name')}<label>接続方法<select name="transport"><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>${field('コマンド（stdio）','command')}${field('引数のJSON配列（stdio）','args','[]')}${field('URL（HTTP）','url')}<p class="small-text">無効状態で登録します。実際の接続・呼び出し時に確認します。</p><button class="button" type="submit">登録する</button></form>`,'mcp');
}
function mediaSheet(){
 openSheet('音楽と動画',`<form id="media-form"><label>YouTube / YouTube MusicのURL<input type="url" name="url" required></label><div class="sheet-actions"><button class="button" type="submit">画面で再生</button>${btn('media-external','Braveで開く','','button secondary')}</div></form><div id="media-player"></div><p class="small-text">アプリ内で広告除去は行いません。埋め込み非対応の動画は外部再生を使用します。</p>`,'media');
}
function youtubeId(value){
 const u=new URL(value);
 if(!['youtube.com','www.youtube.com','music.youtube.com','youtu.be'].includes(u.hostname)||u.protocol!=='https:')throw new Error('YouTubeのHTTPS URLを指定してください。');
 const id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v');
 if(!/^[\w-]{11}$/.test(id||''))throw new Error('動画のURLを指定してください。');
 return id;
}
function cancelVoice(){
 const capture=voice;voice=null;voiceBusy=false;voiceAnchor=null;voiceEpoch++;pendingSpeech='';
 if($('#voice-caption'))$('#voice-caption').textContent='';paintMicrophone(false);
 capture?.cancel().catch(()=>{});
}
async function recordToggle(){capabilityUI?.stopPlayback();
 requireComposerUnlocked();
 if(previewMode)throw new Error('プレビューではマイクを使用しません。');
 if(!settings().voiceEnabled)throw new Error('音声入力が無効です。文字での依頼は使えます。');
 if(voiceBusy)return;
 if(voice){const capture=voice,anchor=voiceAnchor,epoch=voiceEpoch;voiceBusy=true;try{
  if(capture instanceof RealtimeVoiceCapture)await capture.stop();
  else{const wav=await capture.stop();if(epoch!==voiceEpoch)return;const r=await bridge.request('/api/voice/transcribe','POST',wav);await finishSpeech(r.text,anchor,epoch);}
 }catch(e){if(epoch===voiceEpoch&&e.name!=='AbortError')throw e;}
 finally{if(epoch===voiceEpoch){voice=null;voiceBusy=false;paintMicrophone(false);}}return;}
 if(!settings().asrStreamUrl&&!settings().asrUrl){voiceSheet();return;}
 pinDraft();const epoch=++voiceEpoch;
 const anchor=draftContext.anchor(draft,{start:$('#composer-input').selectionStart,end:$('#composer-input').selectionEnd,id:crypto.randomUUID(),attachmentEpoch,companionRevision:state.companion.revision});voiceAnchor=anchor;
 voiceBusy=true;
 const capture=settings().asrStreamUrl?new RealtimeVoiceCapture(bridge):new VoiceCapture();voice=capture;
 try{
  if(capture instanceof RealtimeVoiceCapture){
   await capture.start({onPartial:text=>{if(voice===capture&&epoch===voiceEpoch)$('#voice-caption').textContent=text;},onFinal:text=>{if(epoch===voiceEpoch){safe(finishSpeech)(text,anchor,epoch);voice=null;paintMicrophone(false);}},
    onError:e=>{if(epoch===voiceEpoch){if(e.name!=='AbortError')notice(e.message);voice=null;paintMicrophone(false);}}});
  }else{await capture.start(()=>{if(voice===capture&&epoch===voiceEpoch)safe(recordToggle)();});if(epoch===voiceEpoch)$('#voice-caption').textContent='録音中 · 停止後に認識する互換経路です';}
  if(epoch===voiceEpoch&&voice===capture)paintMicrophone(true);
 }catch(e){await capture.cancel();if(epoch===voiceEpoch){voice=null;if(e.name!=='AbortError')throw e;}}
 finally{if(epoch===voiceEpoch)voiceBusy=false;}
 showTarget();
}
function paintMicrophone(on){
 const button=$('#mic-button');if(!button)return;button.classList.toggle('is-recording',on);button.setAttribute('aria-label',on?'音声入力を終了':'音声入力を開始');
 if(!on&&!pendingSpeech&&/^録音中/.test($('#voice-caption').textContent))$('#voice-caption').textContent='';
}
async function finishSpeech(text,anchor,epoch){
 if(!text||!anchor||epoch!==voiceEpoch||anchor.destination!==draftContext.destination)return;
 try{
  let patch={baseRevision:anchor.revision,utteranceId:anchor.id,edits:[{start:anchor.start,end:anchor.end,text}]};
  if(settings().dictationEditing){
   $('#voice-caption').textContent='言い直しを整理しています。元の下書きは保持しています。';
   patch=await bridge.request('/api/voice/edit','POST',{draft:anchor.content,spoken:text,baseRevision:anchor.revision,utteranceId:anchor.id,selection:{start:anchor.start,end:anchor.end}});
  }
  if(epoch!==voiceEpoch||anchor.destination!==draftContext.destination)return;
  if(!draftContext.accepts(anchor,draft))throw new Error('入力が変わったため、自動では反映しませんでした。');
  const autoSubmit=voiceSendEnabled&&voiceSendConsent&&!settings().dictationEditing&&anchor.content===''&&!attachedFiles.length&&anchor.attachmentEpoch===attachmentEpoch&&anchor.companionRevision===state.companion.revision&&!composerLocked();
  draft.apply(patch);$('#composer-input').value=draft.content;showTarget();
  $('#voice-caption').textContent=(patch.summary||'下書きに反映しました。')+' まだ送信していません。';
  if(autoSubmit)await safe(submitIntent)(false,false,{contextId:voiceSendConsent.context.id,destination:anchor.destination,revision:draft.revision,attachmentEpoch,epoch});
 }catch(e){
  if(epoch!==voiceEpoch||anchor.destination!==draftContext.destination)return;
  pendingSpeech={text,anchor,epoch};$('#voice-caption').innerHTML=`下書きを保持しました。${escape(e.message)} ${btn('append-speech','認識結果を末尾に追加','','text-button')}`;
 }
}

const actions={
 'task-rebind':async el=>{const p=await bridge.request(`/api/jobs/${el.dataset.id}/route`);openSheet('この仕事の接続先を切り替える',`<p>${escape(p.note)}</p><p>${p.recipients.map(r=>escape(`${r.name}: ${r.model} (${r.domain})`)).join('<br>')}</p><p>接続設定で選んだ現在の経路へ変更します。操作のやり直しや結果不明の操作の自動再実行はしません。</p><button class="button" data-action="task-rebind-confirm" data-id="${escape(p.jobId)}" data-revision="${p.expectedRevision}" data-route="${escape(p.routeId)}">この経路へ引き継ぐ</button>`,'rebind');},
 'task-rebind-confirm':async el=>{await bridge.request(`/api/jobs/${el.dataset.id}/route`,'POST',{consent:true,expectedRevision:Number(el.dataset.revision),routeId:el.dataset.route});closeSheet();taskSheet(el.dataset.id);},
 'providers-launch':()=>providerSettings().open(),'computer-launch':()=>providerSettings().computer(),
 attach:attachFiles,'detach-file':detachFile,'send-files-confirm':el=>submitIntent(el.dataset.request),
 'show-request':async()=>{const j=state.jobs.find(x=>x.id===lastRequestJobId);if(j){await navigateFocus(j.id);taskSheet(j.id);}},
 'retry-request':()=>submitIntent(false,true),
 'focus-task':el=>navigateFocus(el.dataset.id),'return-focus':()=>navigateFocus(null,{returning:true}),
 'voice-autosend':configureVoiceSend,'enable-voice-send':()=>{requireComposerUnlocked();if(!pendingVoiceConsent)return;if(draft.content||attachedFiles.length||JSON.stringify(pendingVoiceConsent.destination)!==JSON.stringify(companionDestination(state.companion,state.jobs,composerIntent,inputEngine)))throw new Error('下書きか送り先が変わりました。条件を確認し直してください。');voiceSendConsent=pendingVoiceConsent;pendingVoiceConsent=null;voiceSendEnabled=true;closeSheet();showTarget();},
 'composer-intent':el=>chooseComposerIntent(el.dataset.intent),'rebind-draft':rebindDraft,'natural-intent':configureNaturalIntent,
 'enable-natural-intent':()=>{requireComposerUnlocked();if(!naturalConsent)return;if(naturalConsent.focusJobId!==state.companion.focusJobId)throw new Error('対象が変わりました。意図の判断を設定し直してください。');cancelVoice();composerIntent='continue';draftContext.replace(state.companion,state.jobs,composerIntent,inputEngine);naturalIntent=true;closeSheet();showTarget();},
 'confirm-intent-destination':el=>{if(!pendingRequest||pendingRequest.body.requestId!==el.dataset.request)return;pendingRequest.executionConsent=true;closeSheet();return submitIntent();},
 'work-tab':el=>{workTab=el.dataset.tab;render();},
 proposals:()=>{view='workspace';workTab=(state.plans||[]).some(p=>p.status==='proposed')?'plans':'routines';render();},
 'agent-select':()=>openSheet('仕事の実行先',`<p>普段の会話はTepora。専門的な仕事はCodexへ直接任せられます。</p><div class="onboard-actions">${btn('use-builtin','Tepora · 会話と委任','','button')}${btn('use-codex','Codex · 仕事を直接任せる','','button secondary')}</div><p class="small-text">Codexは既存の認証・設定を利用します。利用料金と処理場所はその構成に従います。</p>`),
 'use-builtin':async()=>{requireComposerUnlocked();inputEngine='builtin';$('#agent-selector').textContent='Tepora';closeSheet();await chooseComposerIntent(composerIntent);},
 'use-codex':async()=>{requireComposerUnlocked();if(!settings().codexEnabled){codexSheet();return;}inputEngine='codex';$('#agent-selector').textContent='Codex';closeSheet();await chooseComposerIntent(composerIntent);},
 'codex-settings':codexSheet,
 'codex-check':async()=>{const r=await bridge.request('/api/codex/check','POST',{});$('#codex-status').textContent=r.authenticated?'接続と認証状態を確認しました。実際の仕事はまだ実行していません。':'起動しました。Codex側でログイン・モデル設定を確認してください。';},
 'model-probe':async()=>{const out=$('#connection-result');out.textContent='安全なツール呼び出しを2往復検査しています。';const r=await bridge.request('/api/runtime/probe','POST',{});out.textContent=`ツールの呼び出し・結果の利用を確認しました（${r.latencyMs} ms）。すべての仕事の品質保証とは別です。`;},
 'routine-add':routineSheet,
 'routine-toggle':async el=>{const r=state.routines.find(x=>x.id===el.dataset.id);await bridge.request(`/api/routines/${r.id}/enable`,'POST',{enabled:!r.enabled,expectedRevision:r.revision});},
 'plan-add':planSheet,
 'plan-start':async el=>{const p=state.plans.find(x=>x.id===el.dataset.id);await bridge.request(`/api/plans/${p.id}/activate`,'POST',{expectedRevision:p.revision});},
 'plan-pause':el=>bridge.request(`/api/plans/${el.dataset.id}/pause`,'POST',{}),
 'raise-priority':async el=>{await bridge.request(`/api/jobs/${el.dataset.id}/priority`,'POST',{priority:5});notice('待機中の仕事より先に進めます。実行中の操作は勝手に中断しません。');},
 recheck:async el=>{await bridge.request(`/api/jobs/${el.dataset.id}/verify`,'POST',{});taskSheet(el.dataset.id);},
 'skill-details':el=>{const skill=state.skills.find(s=>s.id===el.dataset.id);openSheet(skill.name,`<p>${escape(skill.source==='learned-proposal'?'仕事から提案された手順です。確認して有効化するまで使用しません。':skill.description)}</p><pre>${escape(skill.content||'共有スキルです。実行時に出所とハッシュを照合して読み込みます。')}</pre><p class="small-text">${escape(skill.sourceJobId?'元の仕事: '+skill.sourceJobId:'')}</p>`);},
 view:el=>{if(sharedView&&el.dataset.view!=='home'){notice('個人表示に戻してから開いてください。');return;}view=el.dataset.view;render();},
 display:displaySheet,'runtime-settings':runtimeSheet,'voice-settings':voiceSheet,close:closeSheet,
 share:async()=>{capabilityUI?.stop();sharedView=!sharedView;if(sharedView){invalidatePendingSubmit();view='home';closeSheet();render();cancelVoice();}render();},
 fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();},
 onboard:()=>state.providers?.profiles?.length?providerSettings().open():onboarding().open(),
 demo:async()=>{requireComposerUnlocked();closeSheet();const job=await bridge.request('/api/jobs','POST',{input:'画面と途中更新を体験する',kind:'demo'});await navigateFocus(job.id);pendingArtifactJobId=job.id;view='workspace';followArtifact=true;pinnedArtifact=null;selectedArtifact=state.artifacts.find(a=>a.jobId===job.id)?.id||null;render();},
 discover:async()=>{const result=await bridge.request('/api/runtime/discover','POST',{});$('#discovery').innerHTML=result.filter(p=>p.available).map(p=>p.models.map(m=>`<button class="connection-option" data-action="choose-runtime" data-provider="${p.id||p.provider||p.name}" data-url="${escape(p.url)}" data-model="${escape(m)}">${escape(p.name)} · ${escape(m)}</button>`).join('')).join('')||'<p>起動済みの接続先が見つかりませんでした。ソース付属の導入手順を確認してください。</p>';},
 'choose-runtime':el=>{const f=$('#runtime-form');$('[name=baseUrl]',f).value=el.dataset.url;$('[name=model]',f).value=el.dataset.model;if([...$('[name=provider]',f).options].some(o=>o.value===el.dataset.provider))$('[name=provider]',f).value=el.dataset.provider;},
 'display-undo':async()=>{await bridge.request('/api/display/undo','POST',{expectedRevision:display().revision});closeSheet();},
 'display-reset':async()=>{await bridge.request('/api/display/reset','POST',{expectedRevision:display().revision});closeSheet();},
 'display-export':async()=>saveFile('tepora-display.json',JSON.stringify(await bridge.request('/api/display/export'),null,2)),
 'display-import':async()=>{const preset=await chooseJSON();if(!preset)return;await bridge.request('/api/display/import','POST',{preset,expectedRevision:display().revision});closeSheet();},
 'hide-news-today':async()=>{const until=new Date();until.setHours(24,0,0,0);await bridge.request('/api/display','PATCH',{patch:{hiddenUntil:{...display().hiddenUntil,news:until.toISOString()}},expectedRevision:display().revision});closeSheet();},
 'widget-up':el=>{const row=el.closest('[data-widget]');if(row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling);},
 'widget-down':el=>{const row=el.closest('[data-widget]');if(row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row);},
 task:el=>taskSheet(el.dataset.id),
 pause:async el=>{await bridge.request(`/api/jobs/${el.dataset.id}/pause`,'POST',{});closeSheet();},
 resume:async el=>{await bridge.request(`/api/jobs/${el.dataset.id}/resume`,'POST',{});closeSheet();},
 cancel:async el=>{await bridge.request(`/api/jobs/${el.dataset.id}/cancel`,'POST',{});closeSheet();},
 accept:async el=>{const j=state.jobs.find(x=>x.id===el.dataset.id);await bridge.request(`/api/jobs/${j.id}/accept`,'POST',{expectedRevision:j.revision});closeSheet();},
 'target-task':async el=>{await navigateFocus(el.dataset.id);await chooseComposerIntent('continue');},
 'clear-target':()=>chooseComposerIntent('new'),
 approve:async el=>bridge.request(`/api/approvals/${el.dataset.id}`,'POST',{allow:true}),
 deny:async el=>bridge.request(`/api/approvals/${el.dataset.id}`,'POST',{allow:false}),
 'reconcile-done':async el=>{await bridge.request(`/api/effects/${encodeURIComponent(el.dataset.id)}/reconcile`,'POST',{disposition:'confirmed_done'});taskSheet(activeDialog.id);},
 'reconcile-none':async el=>{await bridge.request(`/api/effects/${encodeURIComponent(el.dataset.id)}/reconcile`,'POST',{disposition:'not_executed'});taskSheet(activeDialog.id);},
 'artifact-select':el=>{if(!focusedArtifacts().some(a=>a.id===el.dataset.id))return;selectedArtifact=el.dataset.id;pinnedArtifact=null;followArtifact=false;render();},
 'artifact-follow':()=>{followArtifact=!followArtifact;if(followArtifact)pinnedArtifact=structuredClone(focusedArtifacts().find(a=>a.id===selectedArtifact));syncLiveSurface();
 const panel=$('.artifact-panel');if(panel){const b=$('[data-action=artifact-follow]',panel);b.setAttribute('aria-label',followArtifact?'更新を固定する':'最新の版を表示する');b.title=b.getAttribute('aria-label');$('.artifact-footer',panel).innerHTML=(followArtifact?'途中経過に追従中 · 読むときは更新を固定できます':'この版を固定しています')+btn('artifact-target','この仕事に追加指示','','text-button');}}, 
 'artifact-target':()=>chooseComposerIntent('continue'),
 'artifact-save':()=>{if(!pinnedArtifact)return;const a=pinnedArtifact;saveFile(`${a.title.replace(/[\\/:*?"<>|]/g,'_')}.${a.kind==='html'?'html':a.kind==='markdown'?'md':'txt'}`,a.content,'text/plain;charset=utf-8');},
 'artifact-edit':()=>{if(!pinnedArtifact)return;const a=pinnedArtifact;followArtifact=false;openSheet('成果物を編集',`<form id="artifact-form" data-id="${escape(a.id)}" data-version="${a.version}"><label>内容<textarea name="content" rows="15" maxlength="200000" required>${escape(a.content)}</textarea></label><p>表示中の版を基準に保存します。他の変更が先に入った場合は上書きしません。</p><button class="button" type="submit">新しい版として保存</button></form>`,'artifact-edit',a.id);},
 'memory-add':()=>memorySheet(), 'memory-edit':el=>memorySheet(el.dataset.id),
 'memory-confirm':el=>bridge.request(`/api/memories/${el.dataset.id}`,'PATCH',{confirmed:true}),
 'memory-delete':el=>openSheet('この記憶を削除しますか？',`<p>記憶とその記憶イベントを削除します。別の会話に自分で書いた文章や、既に書き出したバックアップは消しません。</p>${btn('memory-delete-confirm','削除する','trash','button',`data-id="${escape(el.dataset.id)}"`)}`),
 'memory-delete-confirm':async el=>{await bridge.request(`/api/memories/${el.dataset.id}`,'DELETE');closeSheet();},
 'context-export':async()=>saveFile('tepora-context.json',JSON.stringify(await bridge.request('/api/context/export'),null,2)),
 'context-import':async()=>{const data=await chooseJSON();if(data){const result=await bridge.request('/api/context/import','POST',data);notice(result.note||'読み込みました。');}},
 'shared-scan':async()=>{const r=await bridge.request('/api/shared/scan','POST',{consent:true});state.skills=r.skills;render();notice(`${r.skills.filter(s=>s.source==='shared').length}件を発見しました。有効化は別に選びます。`);},
 'skill-toggle':async el=>{const s=state.skills.find(x=>x.id===el.dataset.id);await bridge.request(`/api/skills/${s.id}`,'PATCH',{enabled:s.enabled===false});},
 'mcp-add':mcpSheet,'mcp-toggle':el=>{const m=state.mcp.find(x=>x.id===el.dataset.id);return bridge.request(`/api/mcp/${m.id}`,'PATCH',{enabled:!m.enabled});},
 weather:async()=>{if(!settings().weatherCity||!settings().allowNetwork){connectionDataSheet();return;}weatherData=await bridge.request('/api/connector/weather','POST',{});render();},
 news:async()=>{if(!settings().newsUrl||!settings().allowNetwork){connectionDataSheet();return;}newsData=await bridge.request('/api/connector/news','POST',{});render();},
 media:mediaSheet,'media-external':async()=>bridge.request('/api/media/open','POST',{url:$('[name=url]',overlay).value}),
 mic:recordToggle,'append-speech':()=>{requireComposerUnlocked();if(!pendingSpeech||pendingSpeech.epoch!==voiceEpoch||pendingSpeech.anchor.destination!==draftContext.destination)return;draft.manual(draft.content+pendingSpeech.text);$('#composer-input').value=draft.content;pendingSpeech='';$('#voice-caption').textContent='下書きに追加しました。まだ送信していません。';},
 'undo-draft':()=>{requireComposerUnlocked();cancelVoice();pinDraft();draft.undo();$('#composer-input').value=draft.content;showTarget();},
 'hide-reply':()=>{replyHidden=true;showReply();},
 stop:async()=>{invalidatePendingSubmit();capabilityUI?.stop();cancelVoice();await bridge.request('/api/stop','POST',{});notice('実行中の仕事を停止しました。成果物は残しています。');}
};
function connectionDataSheet(){
 openSheet('暮らしの情報源',`<form id="data-form">${field('天気の場所','weatherCity',settings().weatherCity)}${field('ニュースのRSS URL','newsUrl',settings().newsUrl)}${toggle('選んだ情報源への通信を許可','allowNetwork',settings().allowNetwork)}<button class="button" type="submit">保存する</button></form>`,'data');
}
document.addEventListener('click',e=>{
 const el=e.target.closest('[data-action]');if(!el)return;
 if(el.dataset.action==='backdrop'){if(e.target===el)closeSheet();return;}
 if(actions[el.dataset.action])safe(actions[el.dataset.action])(el);
});
document.addEventListener('input',e=>{if(e.target.id==='composer-input'){if(e.target.value)pinDraft();draft.manual(e.target.value);naturalProposal=null;if(!e.target.value&&!attachedFiles.length&&!pendingRequest&&!voice)clearDraftDestination();showTarget();}});
document.addEventListener('submit',e=>{
 e.preventDefault();safe(async()=>{
  const form=e.target,fd=new FormData(form),data=Object.fromEntries(fd.entries());
  if(form.id==='composer-form'){
   await submitIntent();
  }else if(form.id==='codex-form'){
   await bridge.request('/api/settings','PATCH',{codexEnabled:fd.has('codexEnabled'),codexNetwork:fd.has('codexNetwork'),codexBinary:data.codexBinary,codexModel:data.codexModel});
   $('#codex-status').textContent='保存しました。接続確認はまだ行っていません。';
  }else if(form.id==='routine-form'){
   const schedule=data.scheduleType==='daily'?{type:'daily',time:data.time,timezone:data.timezone}:data.scheduleType==='interval'?{type:'interval',minutes:Number(data.minutes)}:{type:'once',at:new Date(data.onceAt).toISOString()};
   await bridge.request('/api/routines','POST',{title:data.title,input:data.input,schedule,catchUp:data.catchUp});
   closeSheet();workTab='routines';view='workspace';render();notice('提案を保存しました。内容と時刻を確認して有効にしてください。');
  }else if(form.id==='plan-form'){
   const nodes=[{key:'first',title:data.title1,input:data.input1,gate:'produced'},{key:'second',title:data.title2,input:data.input2,gate:'produced'},
    {key:'combine',title:data.title3,input:data.input3,dependsOn:['first','second'],gate:'produced'}];
   await bridge.request('/api/plans','POST',{title:data.title,nodes});closeSheet();workTab='plans';view='workspace';render();
  }else if(form.id==='display-form'){
   await bridge.request('/api/display','PATCH',{expectedRevision:display().revision,patch:{
    theme:data.theme,textScale:Number(data.textScale),companion:data.companion,
    widgets:[...form.querySelectorAll('[name=widget]:checked')].map(x=>x.value)
   }});closeSheet();
  }else if(['runtime-form','voice-form','data-form'].includes(form.id)){
   for(const el of form.querySelectorAll('input[type=checkbox]'))data[el.name]=el.checked;
   for(const el of form.querySelectorAll('input[type=number]'))data[el.name]=Number(el.value);
   if(data.sessionKey==='')delete data.sessionKey;
   await bridge.request('/api/settings','PATCH',data);
   if(form.id==='runtime-form'){
    if($('[name=sessionKey]',form))$('[name=sessionKey]',form).value='';
    const r=await bridge.request('/api/runtime/check','POST',{});
    $('#connection-result').textContent=`モデル一覧を確認しました: ${r.models.join(', ')}。実際の仕事の品質確認とは別です。`;
   }else closeSheet();
  }else if(form.id==='memory-form'){
   const value={content:data.content,title:data.title||'',scope:fd.has('shared')?'shared':'private'};
   await bridge.request(form.dataset.id?`/api/memories/${form.dataset.id}`:'/api/memories',form.dataset.id?'PATCH':'POST',value);closeSheet();
  }else if(form.id==='mcp-form'){
   await bridge.request('/api/mcp','POST',{name:data.name,transport:data.transport,enabled:false,
    ...(data.transport==='stdio'?{command:data.command,args:JSON.parse(data.args)}:{url:data.url})});closeSheet();
  }else if(form.id==='artifact-form'){
   if(previewMode)throw new Error('この編集は実サービスで利用できます。');
   const value=await bridge.request(`/api/artifacts/${form.dataset.id}`,'PATCH',{content:data.content,expectedVersion:Number(form.dataset.version)});
   pinnedArtifact=value;closeSheet();render();
  }else if(form.id==='media-form'){
   const r=await bridge.request('/api/media/embed','POST',{id:youtubeId(data.url)});
   const frame=document.createElement('iframe');frame.src=r.path;frame.title='YouTube';frame.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';frame.referrerPolicy='no-referrer';$('#media-player').replaceChildren(frame);
  }
 })();
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){closeSheet();return;}
 if(e.target.id==='composer-input'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#composer-form').requestSubmit();}
 if(e.key==='Tab'&&activeDialog){
  const nodes=[...overlay.querySelectorAll('button,input,textarea,select,a[href]')].filter(n=>!n.disabled&&n.getClientRects().length);
  const first=nodes[0],last=nodes.at(-1);
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
 }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){invalidatePendingSubmit();cancelVoice();}});
window.addEventListener('tepora-stop',()=>safe(actions.stop)());
window.addEventListener('tepora-hide',()=>{invalidatePendingSubmit();capabilityUI?.stop();cancelVoice();});
window.addEventListener('pagehide',()=>{invalidatePendingSubmit();cancelVoice();bridge.close();});
function upsert(list,data){const i=state[list].findIndex(x=>x.id===data.id);if(i<0)state[list].unshift(data);else state[list][i]=data;}
bridge.on(e=>{
 if(!state)return;
 if(e.type==='route.selected'&&e.data.reason!=='selected'){const key=e.data.jobId+':'+e.data.profileId;if(!noticedRoutes.has(key)){noticedRoutes.add(key);if(noticedRoutes.size>100)noticedRoutes.delete(noticedRoutes.values().next().value);notice(`実行先: ${e.data.profileId} (${e.data.domain}) の経路で処理を続けます。`);}return;}
 if(e.type==='providers.updated'){state.providers=e.data;return;}
 if(e.type==='computer.updated'){state.computer=e.data;return;}
 if(e.type==='network.updated'){state.network=e.data;paintNetwork();if(e.data.mode!=='online'||!e.data.internetTools){if(activeDialog?.kind==='media')closeSheet();document.querySelectorAll('#media-player iframe').forEach(x=>x.remove());}return;}
 if(e.type==='companion.updated'){acceptCompanion(e.data);return;}
 if(e.type==='snapshot'){const prior=state.companion;state={...state,...e.data,companion:prior};acceptCompanion(e.data.companion||prior);const latest=focusedArtifacts().find(a=>a.id===selectedArtifact);if(!latest){pinnedArtifact=null;selectedArtifact=null;}else if(followArtifact)pinnedArtifact=structuredClone(latest);scheduleRender();return;}
 if(e.type==='transport.status'){online=e.data.online;showRequestStatus();if(!online)notice('接続を復旧しています。仕事の状態はサービスに保存されています。');return;}
 if(e.type==='setup.updated'){state.setup=e.data;return;}
 if(e.type==='routine.updated'){upsert('routines',e.data);scheduleRender();return;}
 if(e.type==='plan.updated'){upsert('plans',e.data);scheduleRender();return;}
 if(e.type==='display.updated'){state.display=e.data;scheduleRender();return;}
 if(e.type==='settings.updated'){if(!e.data.voiceEnabled||e.data.dictationEditing||e.data.asrUrl!==state.settings.asrUrl||e.data.asrStreamUrl!==state.settings.asrStreamUrl){voiceSendEnabled=false;voiceSendConsent=null;cancelVoice();}state.settings=e.data;state.setup={...state.setup,verified:false};scheduleRender();return;}
 if(e.type==='job.updated'){upsert('jobs',e.data);showRequestStatus();refreshTask();scheduleRender();return;}
 if(e.type==='job.output'){const j=state.jobs.find(x=>x.id===e.data.id);if(j)j.output=e.data.output;refreshTask();showReply();return;}
 if(e.type==='artifact.updated'){
  upsert('artifacts',e.data);
  if(e.data.jobId!==state.companion.focusJobId){scheduleRender();return;}
  if(e.data.jobId===pendingArtifactJobId){selectedArtifact=e.data.id;pinnedArtifact=null;pendingArtifactJobId=null;}
  if(!selectedArtifact)selectedArtifact=e.data.id;
  if(e.data.id===selectedArtifact&&followArtifact)pinnedArtifact=structuredClone(e.data);
  scheduleRender();return;
 }
 if(e.type==='message.created'){state.messages.push(e.data);if(e.data.role==='assistant'&&e.data.jobId===state.companion.focusJobId)replyHidden=false;showReply();return;}
 for(const [prefix,list] of [['memory','memories'],['skill','skills'],['mcp','mcp']]){
  if(e.type===`${prefix}.updated`){upsert(list,e.data);scheduleRender();}
  if(e.type===`${prefix}.deleted`){state[list]=state[list].filter(x=>x.id!==e.data.id);scheduleRender();}
 }
});
try{state=await bridge.init();state.companion||=await bridge.request('/api/companion');composerIntent=state.companion.focusJobId?'continue':'new';state.display||=structuredClone(DISPLAY_DEFAULT);state.routines||=[];state.plans||=[];globalThis.__TEPORA_LIVE__=!previewMode;shell();setInterval(tick,1000);if(!previewMode&&!state.setup?.dismissed&&!state.settings.model&&!state.providers?.profiles?.length)setTimeout(()=>onboarding().open(),100);}
catch(e){app.innerHTML=`<div class="fatal"><h1>Tepora</h1><p>${escape(e.message)}</p><p>起動時のURLから開き直してください。未接続のまま成功とは表示しません。</p></div>`;}

function showInputFiles(){
 const el=$('#input-files');if(!el)return;
 el.innerHTML=attachedFiles.map(f=>`<span><span>${escape(f.name)}</span><button type="button" data-action="detach-file" data-id="${escape(f.id)}" ${composerLocked()?'disabled':''} aria-label="${escape(f.name)}を下書きから外す">${icon('close')}</button></span>`).join('');
}
async function attachFiles(){
 if(sharedView)throw new Error('個人表示に戻してからファイルを選んでください。');
 requireComposerUnlocked();const epoch=++attachmentEpoch,scope=draftContext.epoch;
 const current=()=>{requireComposerUnlocked();if(sharedView||epoch!==attachmentEpoch||scope!==draftContext.epoch)throw new Error('下書きの送り先が変わりました。ファイルを選び直してください。');};
 const files=await new Promise(resolve=>{
  const picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.accept='.txt,.md,.csv,.tsv,.json,.yaml,.yml,.png,.jpg,.jpeg';
  picker.onchange=()=>resolve([...picker.files]);picker.addEventListener('cancel',()=>resolve([]),{once:true});picker.click();
 });
 current();if(!files.length)return;
 if(attachedFiles.length+files.length>6)throw new Error('一度に添えられるファイルは6件までです。');
 const payload=[];for(const file of files){
  if(!file.size||file.size>(/\.(png|jpe?g)$/i.test(file.name)?4*1024*1024:256*1024))throw new Error('テキストは256KB以下、PNG/JPEG画像は4MB以下を選んでください。');
  const buffer=await file.arrayBuffer();current();
  if(/\.(png|jpe?g)$/i.test(file.name)){
   const bytes=new Uint8Array(buffer);let binary='';
   for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
   payload.push({name:file.name,base64:btoa(binary)});continue;
  }
  let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw new Error('UTF-8のテキストを選んでください。PDF・Office文書の解析はまだ対応していません。');}
  payload.push({name:file.name,content});
 }
 const total=attachedFiles.reduce((n,f)=>n+f.bytes,0)+files.reduce((n,f)=>n+f.size,0);
 if(total>8*1024*1024)throw new Error('添付は合計8MBまでです。テキストは合計1MBまでです。');
 current();const r=await bridge.request('/api/inputs','POST',{files:payload});current();
 pinDraft();attachedFiles.push(...r.files);pendingRequest=null;showInputFiles();showTarget();
 notice('選んだファイルだけを下書きに添えました。まだAIへ送信していません。');
}
async function detachFile(el){
 requireComposerUnlocked();attachmentEpoch++;const id=el.dataset.id;
 attachedFiles=attachedFiles.filter(f=>f.id!==id);pendingRequest=null;
 if(!draft.content&&!attachedFiles.length)clearDraftDestination();showInputFiles();showTarget();
 try{await bridge.request(`/api/inputs/${id}`,'DELETE');}catch{}
}
function showRequestStatus(){
 const el=$('#request-status');if(!el)return;
 if(sharedView){el.hidden=true;return;}el.hidden=false;
 if(sending){el.textContent=naturalIntent?'送り先と依頼を確認しています。':'依頼を受け付けています。';return;}
 if(pendingRequest?.uncertain){el.innerHTML=`応答を確認できませんでした。前の送信と添付を保持しています。${btn('retry-request','同じ送信を確認する','','text-button')}`;return;}
 if(lastSubmitError){el.textContent=lastSubmitError;return;}
 const j=state.jobs.find(x=>x.id===lastRequestJobId);
 if(!j){el.textContent='';return;}
 const text=j.status==='failed'?'仕事が止まりました。依頼と途中の成果は残っています。':j.status==='review'?'結果が届きました。内容を確認できます。':j.status==='completed'?'返答しました。':j.note;
 el.innerHTML=`<span>${escape(text)}</span>${btn('show-request',j.status==='failed'?'状態を確認':'仕事を見る','','text-button')}`;
}
function requestId(){return globalThis.crypto?.randomUUID?.()||`request-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
async function submitIntent(consent=false,retry=false,automatic=null){
 if(sending)return;
 if(automatic&&(!voiceSendEnabled||automatic.epoch!==voiceEpoch||automatic.destination!==draftContext.destination||automatic.revision!==draft.revision||automatic.attachmentEpoch!==attachmentEpoch||attachedFiles.length||settings().dictationEditing))return;
 cancelVoice();
 if(sharedView)throw new Error('個人表示に戻してから依頼してください。');
 // Lock before the first await. An uncertain receipt always retains its original bytes and ID.
 sending=true;lastSubmitError='';showRequestStatus();showTarget();showInputFiles();
 const generation=++submitEpoch,captureEpoch=voiceEpoch,current=()=>{if(generation!==submitEpoch||sharedView||automatic&&(captureEpoch!==voiceEpoch||!voiceSendEnabled||automatic.destination!==draftContext.destination||automatic.revision!==draft.revision||automatic.attachmentEpoch!==attachmentEpoch||attachedFiles.length||settings().dictationEditing))throw Object.assign(new Error('送信を中止しました。下書きは残しています。'),{name:'AbortError'});};
 let request=pendingRequest?.uncertain?pendingRequest:null,dispatching=false;
 try{
  if(!request){
   const input=$('#composer-input').value.trim();if(!input)return;
   if(previewMode&&!attachedFiles.length&&!settings().model)throw new Error('これは画面プレビューです。AIとの仕事には実サービスを使ってください。');
   const destination=pinDraft(),engine=destination.engine,registryReady=state.providers?.profiles?.some(p=>p.enabled!==false&&p.model);
   if(!previewMode&&engine==='builtin'&&!settings().model&&!registryReady){await onboarding().open();return;}
   if(destination.companionRevision!==state.companion.revision)throw new Error('仕事の表示が変わりました。「この下書きの送り先を確認」で対象を確認してください。');
   if(destination.intent==='continue'){
    const target=state.jobs.find(j=>j.id===destination.targetJobId);
    if(!target||destination.jobRevision!==target.revision)throw new Error('仕事の状態が変わりました。「この下書きの送り先を確認」で続ける対象を確認してください。');
    if(attachedFiles.length&&!naturalIntent)throw new Error('既存の仕事への追加添付は未対応です。「新しい用事」または「並行して頼む」を選んでください。');
   }
   const shape=JSON.stringify({input,destination,attachmentIds:attachedFiles.map(f=>f.id),naturalIntent});
   if(pendingRequest?.shape===shape)request=pendingRequest;
   else{
    request={shape,draftRevision:draft.revision,destination,attachmentNames:attachedFiles.map(f=>f.name),endpoint:'/api/requests',body:{requestId:requestId(),input,engine,attachmentIds:attachedFiles.map(f=>f.id),attachmentConsent:null,intent:destination.intent,targetJobId:destination.targetJobId,expectedRevision:destination.jobRevision,companionRevision:destination.companionRevision}};
    pendingRequest=request;
    if(naturalIntent&&destination.targetJobId){
     const context=await bridge.request('/api/companion/context');current();
     const focusedExecution=await bridge.request(`/api/requests/context?engine=${encodeURIComponent(engine)}&role=${companionRole({...destination,intent:'continue'},state.jobs,0)}&targetJobId=${encodeURIComponent(destination.targetJobId)}`);current();
     if(!naturalConsent||naturalConsent.id!==context.id){pendingRequest=null;naturalIntent=false;naturalConsent=null;throw new Error('判断の接続先が変わりました。「意図の判断」をもう一度有効にして接続先を確認してください。');}
     const proposal=await bridge.request('/api/companion/propose','POST',{input,focusRevision:destination.companionRevision,requestId:request.body.requestId,attachmentIds:request.body.attachmentIds,consent:context.id});current();
     naturalProposal=proposal;
     if(proposal.action==='clarify'){pendingRequest=null;showTarget();return;}
     if(!['continue','new','side'].includes(proposal.action)||proposal.input!==input||proposal.focusRevision!==destination.companionRevision)throw new Error('送り先の判断を確認できませんでした。上のボタンで送り先を指定してください。');
     request.endpoint='/api/companion/submit';
     const executionRole=proposal.action==='continue'?companionRole({...destination,intent:'continue'},state.jobs,0):(request.body.attachmentIds.length||engine==='codex'?'work':'chat');
     request.context=await bridge.request(`/api/requests/context?engine=${encodeURIComponent(engine)}&role=${executionRole}${proposal.action==='continue'?`&targetJobId=${encodeURIComponent(proposal.targetJobId)}`:''}`);
     current();
     if(proposal.action!=='continue'&&request.context.id!==proposal.executionDestination)throw new Error('実行の接続先が変わりました。送り先を選び直してください。');
     request.requiresExecutionConsent=proposal.action!=='continue'&&request.context.id!==focusedExecution.id;request.proposal=proposal;
     request.body={proposalId:proposal.id,requestId:request.body.requestId,attachmentIds:request.body.attachmentIds,attachmentConsent:null};
     request.input=input;
     notice(`送り先: ${proposal.action==='continue'?'この仕事の続き':proposal.action==='side'?'並行する用事':'新しい用事'} · ${proposal.summary||''}`);
    }else{
     const role=companionRole(destination,state.jobs,request.body.attachmentIds.length);
     request.context=await bridge.request(`/api/requests/context?engine=${encodeURIComponent(engine)}&role=${role}${destination.intent==='continue'?`&targetJobId=${encodeURIComponent(destination.targetJobId)}`:''}`);
    }
   }
   current();const context=request.context;
   if(automatic&&context.id!==automatic.contextId)throw new Error('音声の送信先が変わりました。認識文は下書きに残しています。送り先を確認して送信してください。');
   if(request.requiresExecutionConsent&&!request.executionConsent){openSheet('この接続先で、新しい用事を始めますか？',`<p>${escape(request.proposal.summary||'別の用事として依頼します。')}</p><p>実行する接続先: ${escape(context.label)}</p><p>${escape(context.note)}</p><p>開いている仕事とは接続先が異なります。新しい依頼と選んだ添付だけを渡し、この接続先の利用料金がかかる場合があります。</p>${btn('confirm-intent-destination','この接続先で依頼する','','button',`data-request="${escape(request.body.requestId)}"`)}${btn('close','下書きのままにする','','button secondary')}`,'intent-destination');return;}
   if(request.body.attachmentIds.length&&context?.remote&&!request.body.attachmentConsent){
    if(consent!==request.body.requestId){openSheet('選んだファイルを、この接続先へ送りますか？',`<p>${escape(context.label)}</p><p>${escape(context.note)}</p><p>対象: ${request.attachmentNames.map(escape).join('、')}</p><div class="sheet-actions">${btn('send-files-confirm','この接続先へ送信する','','button',`data-request="${escape(request.body.requestId)}"`)}${btn('close','送信しない','','button secondary')}</div>`,'file-consent');return;}
    request.body.attachmentConsent=context.id;closeSheet();
   }
  }
  current();dispatching=true;request.dispatched=true;
  const receipt=await bridge.request(request.endpoint,'POST',request.body);
  if(!receipt?.job?.id)throw new Error('送信結果を確認できませんでした。');
  upsert('jobs',receipt.job);lastRequestJobId=receipt.job.id;
  // A slow receipt must not erase edits made after the send began.
  if(draft.revision===request.draftRevision){draft.manual('');$('#composer-input').value='';clearDraftDestination();}
  attachedFiles=attachedFiles.filter(f=>!request.body.attachmentIds.includes(f.id));pendingRequest=null;naturalProposal=null;replyHidden=false;
  if(receipt.companion)acceptCompanion(receipt.companion);
  else try{acceptCompanion(await bridge.request('/api/companion'));}catch{notice('依頼を受け付けました。画面の状態は再接続時に更新します。');}
  if(!draftContext.destination)composerIntent=state.companion.focusJobId?'continue':'new';
  if(receipt.job.kind==='work'&&receipt.job.id===state.companion.focusJobId)pendingArtifactJobId=receipt.job.id;
  showReply();scheduleRender();
 }catch(e){lastSubmitError=e.message;if(request){request.uncertain=dispatching&&(!e.status||e.status>=500);if(!request.uncertain&&pendingRequest===request)pendingRequest=null;}throw e;}
 finally{sending=false;showRequestStatus();showInputFiles();showTarget();}
}
