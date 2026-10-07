import {createCapabilityUI} from './capability-ui.mjs';
import {createProviderSettings} from './provider-settings.mjs';
import {createOnboarding} from './onboarding.mjs';
import {bridge,previewMode,previewAvatar} from './bridge.mjs';
import {escape,icon,btn,toolbtn,statuses,setArtifactFrame,field,toggle,modal,registerForms,isTrustedForm} from './ui.mjs';
import {DISPLAY_DEFAULT,WIDGETS,AMBIENT_DEFAULT,IDLE_CHOICES,WALLPAPERS} from './display-model.mjs';
import {VoiceDraft} from './draft.mjs';
import {companionArtifacts} from './companion-state.mjs';
import {DialogueDraftContext,characterName,characterVoice,currentReplyQuestion,latestCharacterReply,dialogueMessagePresentation,mergeDialogueMessages} from './dialogue-state.mjs';
import {VoiceCapture} from './voice.mjs';
import {RealtimeVoiceCapture} from './realtime-voice.mjs';
import {jobStatus,needsPerson} from './status.mjs';
import {describeApproval} from './approval-format.mjs';
import {renderMarkdown} from './markdown.mjs';
import {companionMood} from './avatar/pose.mjs';
import {AVATAR_BODIES,AVATAR_PALETTES} from './avatar/model.mjs';
import {createAvatar,avatarAssetUrl} from './avatar/stage.mjs';
import {avatarGeometry} from './avatar/geometry.mjs';
import {createAvatarStudio} from './avatar/settings.mjs';
import {VOICE_PROACTIVE,VOICE_SCENES,VOICE_TONES,voiceAddress,voiceLine,voiceSpeaks} from './voice-lines.mjs';
import {ambientCards,createDeck,createIdleWatcher,greeting,isNight,weatherLabel,weatherLine,deckWidgets,awayRecap,countWord} from './ambient.mjs';
import {inboxItems,inboxHTML,ago,approvalSlip} from './inbox.mjs';
import {createMusic} from './music.mjs';
import {seasonLine} from './seasons.mjs';
import {daylightState,daylightVars} from './daylight.mjs';
import {backdropFor,lampPalette,paintStars,wallpaperHTML,WALLPAPER_LABELS,WALLPAPER_NOTES} from './wallpaper.mjs';
import {createPhotoFrame,framePhotos,framePreview} from './frame.mjs';
import {createLights,lightJobs} from './lights.mjs';
import {sealHTML,stampHTML,sealDefs,bindSeals,SEAL_HOLD_MS} from './seal.mjs';
import {createFrameSettings} from './frame-settings.mjs';

const app=document.querySelector('#app'),overlay=document.querySelector('#overlay'),toastEl=document.querySelector('#toast');
const $=(selector,scope=document)=>scope.querySelector(selector);
let state,view='home',selectedArtifact=null,pinnedArtifact=null,followArtifact=true;
let workTab='tasks';
let sharedView=false,activeDialog=null,dialogReturnFocus=null,online=true,replyHidden=true;
let activePanel=null,panelReturnFocus=null,renderedView='',sheetBaseline='',settingsSection='';
const noticedRoutes=new Set();
let voice=null,voiceBusy=false,voiceAnchor=null,pendingSpeech='',displayHistory=[],refreshTimer,toastTimer;
let weatherData=null,newsData=null,lastVisibleKey='',pendingArtifactJobId=null;
let voiceEpoch=0,attachmentEpoch=0,submitEpoch=0,dialogueRenderKey='';
let voiceSendEnabled=false,voiceSendConsent=null,pendingVoiceConsent=null,pendingRelay=null,liveReply='';
// Home monitor and companion presentation. None of this changes permissions or work.
let ambientMode=false,ambientSince=0,idleWatcher=null,deck=null,stageCharacter=null,avatarCharacter=null,characterKey='',avatarAbort=null,avatarTheme='light';
let musicState=null,newsIndex=0,photoIndex=0,lastDeckCard='',celebrateUntil=0,talkUntil=0,lastSeenMessage='',presence='present',driftTimer=0,feedTimers=[],hiddenTimer=0;
// Idle screen as a screensaver: where to return to, what to say on return, the photo frame and the screen lock.
let lights=null,photoFrame=null,photoRunning=false,frameSession=false,enteredFullscreen=false,ambientReturn=null,recapUntil=0,recapText='',recapTimer=0,awaySince=0,wakeLock=null,daylightKey='',lightMinute=-1,backdropShown='',wallpaperDirty=true,moveFrom=null,frameUI=null;
// The conversation column is opened on demand; on the home stage the message box sits under the character.
let talkOpen=false;try{talkOpen=localStorage.getItem('tepora-talk-open')==='1';}catch{talkOpen=false;}
let reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
const wideScreen=globalThis.matchMedia?.('(min-width: 900px)');
const stageHost=document.createElement('div');stageHost.className='character-host';
const deckHost=document.createElement('div');deckHost.className='deck';
const glowHost=document.createElement('div');glowHost.className='stage-glow';
const lightsHost=document.createElement('div');lightsHost.className='stage-lights';
const draftContext=new DialogueDraftContext();
const draft=new VoiceDraft();
let capabilityUI=null;
function abilities(){return capabilityUI||=createCapabilityUI({bridge,openSheet,closeSheet,notice,previewMode,isPrivate:()=>!sharedView,isOpen:kind=>(activeDialog?.kind===kind||activePanel?.kind===kind)&&!sharedView,attached:()=>attachedFiles,latestReply:()=>latestCharacterReply(state.dialogue),onChanged:values=>{Object.assign(state,values);paintChrome();if(view==='home')paintHome();else if(view==='settings'&&!activeDialog)scheduleRender();}});}
let providerUI=null;
function providerSettings(){return providerUI||=createProviderSettings({bridge,openSheet,closeSheet,notice,previewMode,legacySettings:settings,onChanged:value=>{state={...state,...value};paintChrome();if(view==='settings'&&!activeDialog)scheduleRender();}});}
let setupUI=null,attachedFiles=[],pendingRequest=null,sending=false,lastRequestJobId=null,lastSubmitError='';
function onboarding(){
 setupUI ||= createOnboarding({bridge,openSheet,closeSheet,isOpen:()=>activeDialog?.kind==='setup'&&!sharedView,
  notice,onConnected:async value=>{const fresh=await bridge.request('/api/bootstrap');state.settings=fresh.settings;state.setup=value;},advanced:()=>providerSettings().open()});
 return setupUI;
}
let musicUI=null;
function musicPlayer(){return musicUI||=createMusic({onChange:value=>{musicState=value;if(view==='home')paintDeck();paintChrome();}});}

const widgetNames={clock:'時計',companion:'キャラクター',weather:'天気（日付の下に一行。雨などの日はカードも）',news:'ニュース',media:'音楽',work:'仕事のようす（キャラクターのまわりの灯り）',artifact:'つくった画像'};
const workJobs=()=>state.jobs.filter(j=>!(j.kind==='chat'&&j.characterSessionId));
const activeJobs=()=>workJobs().filter(j=>['queued','running','waiting_approval'].includes(j.status));
const settings=()=>state.settings;
const display=()=>{const d=state?.display||DISPLAY_DEFAULT;return {...DISPLAY_DEFAULT,...d,ambient:{...AMBIENT_DEFAULT,...(d.ambient||{})}};};
const inboxList=()=>state?inboxItems({approvals:state.approvals||[],jobs:state.jobs,dialogue:state.dialogue,routines:state.routines||[],plans:state.plans||[]}):[];
const narrow=()=>wideScreen?wideScreen.matches===false:false;
// The lamp (character, antenna, amber light) is on screen only on a home stage that shows the character.
const lampAvailable=()=>view==='home'&&!sharedView&&widgetsVisible().includes('companion')&&!(ambientMode&&backdropNow()==='photos');
const safe=fn=>async(...args)=>{try{return await fn(...args);}catch(e){if(e.name!=='AbortError')notice(e.message||String(e),'error');}};
// Composer errors already appear beside the message box; do not repeat them as a toast.
const quiet=fn=>async(...args)=>{try{return await fn(...args);}catch(e){if(e.name!=='AbortError'&&e.message!==lastSubmitError)notice(e.message||String(e),'error');}};
function notice(message,tone='info'){
 toastEl.textContent=sharedView?'Teporaからお知らせがあります。個人表示で確認できます。':message;
 toastEl.dataset.tone=tone;toastEl.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.classList.remove('show'),tone==='error'?9000:5000);
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

/* ---------- Shell ---------- */
function shell(){
 app.innerHTML=`${wallpaperHTML()}${sealDefs()}<div class="shell">
 <a class="skip-link" href="#composer-input">メッセージ入力へ移動</a>
 <header class="topbar">
  <button type="button" class="wordmark" data-action="view" data-view="home" aria-label="Teporaホーム">tepora<span class="wordmark-dot" aria-hidden="true"></span></button>
  <nav class="nav" aria-label="Tepora">
   <button type="button" data-action="view" data-view="home">${icon('home')}<span>ホーム</span></button>
   <button type="button" class="nav-talk" data-action="view" data-view="talk">${icon('chat')}<span>会話</span></button>
   <button type="button" data-action="view" data-view="workspace">${icon('work')}<span>仕事</span><span class="nav-count" id="work-count"></span></button>
   <button type="button" data-action="view" data-view="memory">${icon('memory')}<span>記憶</span></button>
   <button type="button" data-action="view" data-view="settings">${icon('settings')}<span>設定</span></button>
  </nav>
  <div class="topbar-tools">
   <button type="button" class="readiness" id="readiness" data-action="readiness" hidden></button>
   <button type="button" class="inbox-button" id="inbox-button" data-action="inbox" hidden><i class="lamp-dot" aria-hidden="true"></i><span class="inbox-label">あなたの番</span><span class="inbox-count" id="inbox-count"></span></button>
   <button type="button" class="stop-button" id="stop-all" data-action="stop" aria-label="すべて停止" hidden>${icon('stop','icon-fill')}<span>すべて停止</span></button>
   <button type="button" class="share-exit" id="share-exit" data-action="share" hidden>共有表示を終える</button>
   <div class="display-menu" id="display-menu">
    <button type="button" class="icon-button" id="display-menu-button" data-action="display-menu" aria-expanded="false" aria-controls="display-menu-list" aria-label="画面の表示" title="画面の表示">${icon('monitor')}</button>
    <div class="menu" id="display-menu-list" hidden>
     <button type="button" data-action="ambient-now" id="ambient-button">${icon('moon')}<span>待機画面にする</span></button>
     <button type="button" data-action="frame-now">${icon('image')}<span>写真立てにする</span></button>
     <button type="button" data-action="share" id="share-button" aria-pressed="false">${icon('eyeOff')}<span>共有表示（個人の内容を隠す）</span></button>
     <button type="button" data-action="fullscreen">${icon('expand')}<span>全画面</span></button>
    </div>
   </div>
  </div>
 </header>
 <div class="layout" id="layout">
  <section id="dialogue-panel" class="talk" aria-label="キャラクターとの会話">
   <header class="talk-head">
    <div class="talk-avatar" id="talk-avatar" aria-hidden="true"></div>
    <h1 id="character-name">Tepora</h1>
    ${toolbtn('talk-close','会話を閉じる','close','id="talk-close" data-narrow="hide"')}
   </header>
   <div id="dialogue-transcript" class="transcript" role="log" aria-label="会話履歴" tabindex="0"></div>
   <div id="dialogue-announcer" class="visually-hidden" aria-live="polite"></div>
   <section class="input-region" aria-label="メッセージを書く">
    <div id="reply" class="reply" hidden></div>
    <div id="voice-caption" class="voice-caption" aria-live="polite"></div>
    <div id="target-hint" class="target-hint" aria-live="polite"></div>
    <div id="request-status" class="request-status" role="status" aria-live="polite"></div>
    <div id="input-files" class="input-files"></div>
    <form id="composer-form" class="composer">
     <button type="button" data-action="attach" class="composer-tool" aria-label="ファイルを添える" title="ファイルを添える">${icon('plus')}</button>
     <textarea id="composer-input" rows="1" maxlength="32000" aria-label="Teporaへのメッセージ" aria-describedby="agent-selector" placeholder="Teporaに話しかける"></textarea>
     <button type="button" data-action="undo-draft" class="composer-tool" id="undo-draft" aria-label="入力を戻す" title="入力を戻す" hidden>${icon('undo')}</button>
     <button type="button" data-action="mic" class="composer-tool" id="mic-button" aria-label="音声入力を開始" title="音声入力">${icon('mic')}</button>
     <button type="submit" class="send-button" aria-label="送信" title="送信（Enter）">${icon('arrow')}</button>
    </form>
    <span id="agent-selector" class="visually-hidden">Teporaと会話中。Enterで送信、Shift+Enterで改行。</span>
   </section>
  </section>
  <main id="surface" class="surface" tabindex="-1"></main>
  <aside id="panel" class="panel" hidden aria-labelledby="panel-title"></aside>
 </div>
 <button type="button" class="talk-rail" id="talk-rail" data-action="talk-open" hidden>${icon('chat')}<span>会話</span></button>
 </div>`;
 registerForms(app);
 document.body.classList.toggle('preview',previewMode);
 const surface=$('#surface'),size=()=>{const w=surface.clientWidth,width=w<760?'narrow':w<1040?'medium':'wide';surface.dataset.width=width;document.body.dataset.surface=width;fitComposer();};
 if(globalThis.ResizeObserver)new ResizeObserver(size).observe(surface);size();
 abilities();mountCharacters();render();tick();
}
function applyTheme(){
 const prefs=display();
 document.body.dataset.theme=prefs.theme;applyAvatarTheme();
 document.body.classList.toggle('shared-view',sharedView);
 document.documentElement.style.fontSize=`${16*prefs.textScale}px`;
 const share=$('#share-button');if(share)share.setAttribute('aria-pressed',String(sharedView));
}
/** Shown only when something needs the person: no AI yet, a lost connection, or a restricted network. */
function readiness(){
 if(previewMode)return {tone:'idle',label:'プレビュー',title:'画面プレビューです。AIの推論・PC操作・外部への通信は行いません。'};
 const ready=!!(settings().model||state.providers?.profiles?.some(p=>p.enabled!==false&&p.model));
 if(!ready)return {tone:'attention',label:'AIを接続',title:'会話と仕事に使うAIを接続します'};
 if(!online)return {tone:'attention',label:'再接続中',title:'サービスとの接続を復旧しています'};
 const mode=state.network?.mode||'online';
 if(mode!=='online')return {tone:'idle',label:({offline:'完全オフライン','trusted-lan':'信頼LANだけ'})[mode]||mode,title:'通信の範囲（設定で変更できます）'};
 return null;
}
function paintChrome(){
 if(!state)return;
 const items=inboxList(),attention=items.length,active=activeJobs().length,body=document.body,wide=!narrow();
 const shown=sharedView&&view!=='home'?'home':view;
 body.dataset.view=shown;body.classList.toggle('is-ambient',ambientMode);
 body.classList.toggle('talk-open',wide&&talkOpen&&!sharedView&&!ambientMode);
 body.classList.toggle('talk-docked',shown==='home'&&!(wide&&talkOpen)&&!sharedView&&!ambientMode);
 document.querySelectorAll('.nav [data-action=view]').forEach(b=>{b.setAttribute('aria-current',b.dataset.view===(view==='talk'&&wide?'home':view)?'page':'false');});
 const count=$('#work-count');if(count){count.textContent=active?String(active):'';count.setAttribute('aria-label',active?`${active}件進行中`:'');}
 const r=readiness(),chip=$('#readiness');
 if(chip){chip.hidden=!r||sharedView;if(r){chip.className=`readiness tone-${r.tone}`;chip.innerHTML=`<i class="dot"></i><span>${escape(r.label)}</span>`;chip.title=r.title;}}
 const lamp=lampAvailable(),inbox=$('#inbox-button');if(inbox){inbox.hidden=sharedView||!attention||lamp;inbox.setAttribute('aria-label',`あなたの番 ${attention}件`);$('#inbox-count').textContent=attention?String(attention):'';}
 const running=active||sending||!!voice||(state.mediaJobs||[]).some(m=>['queued','submitting','running','downloading'].includes(m.status));
 const stop=$('#stop-all');if(stop)stop.hidden=!running||sharedView;
 const exit=$('#share-exit');if(exit)exit.hidden=!sharedView;
 const rail=$('#talk-rail');if(rail)rail.hidden=!(wide&&!talkOpen&&shown!=='home'&&!ambientMode&&!sharedView);
 body.dataset.lamp=attention&&!sharedView&&!lamp?'wait':'';
 paintBackdrop();paintLights();
}
function setTalkOpen(open){
 talkOpen=open;try{localStorage.setItem('tepora-talk-open',open?'1':'0');}catch{/* view preference only */}
 paintChrome();if(view==='home')paintSpeech();
 if(open)setTimeout(()=>$('#composer-input')?.focus(),0);else $('#surface')?.focus({preventScroll:true});
}
function closeDisplayMenu(returnFocus=false){
 const list=$('#display-menu-list');if(!list||list.hidden)return;
 list.hidden=true;$('#display-menu-button')?.setAttribute('aria-expanded','false');if(returnFocus)$('#display-menu-button')?.focus();
}

/* ---------- Room light, wallpaper and lights ---------- */
const frameStored=()=>previewMode?framePreview:state?.frame?.photos||[];
function framePhotoList(){return framePhotos({photos:frameStored(),created:sharedView?[]:imageAssets(),includeCreated:display().ambient.frameCreated});}
function backdropNow(){return backdropFor({ambient:ambientMode,wallpaper:display().ambient.wallpaper,photoCount:framePhotoList().length,shared:sharedView,frameNow:frameSession});}
/** Window light and lamp light, from the clock (and the weather when it is known). Once a minute is enough. */
function paintDaylight(now=new Date()){
 const vars=daylightVars(daylightState({now,weather:weatherData})),key=JSON.stringify(vars);
 if(key===daylightKey)return;daylightKey=key;
 for(const [name,value] of Object.entries(vars))document.body.style.setProperty(name,value);
}
/** What is behind the screen: room light, plain paper, drifting colour, a night sky or the photo frame. */
function paintBackdrop(){
 if(!state)return;
 const ambient=display().ambient,body=document.body,shown=backdropNow();
 const night=ambientMode&&ambient.nightDim&&isNight(new Date(),weatherData);
 body.dataset.backdrop=shown;body.dataset.frameClock=ambient.frameClock;body.dataset.frameFit=ambient.frameFit;
 body.classList.toggle('is-lamp',lampPalette({ambient:ambientMode,backdrop:shown,night,nightDim:ambient.nightDim}));
 applyAvatarTheme();
 if(wallpaperDirty||shown!==backdropShown){backdropShown=shown;wallpaperDirty=false;syncWallpaper(shown);}
}
function syncWallpaper(shown){
 if(shown==='stars')paintStars($('#wp-stars'));
 if(shown==='photos'&&ambientMode){
  photoFrame||=createPhotoFrame($('#wp-photos'),{reducedMotion});
  photoFrame.start(framePhotoList(),display().ambient);photoRunning=true;
 }else if(photoFrame&&photoRunning){photoFrame.stop();photoRunning=false;}
}
/** Running work as lights around the character; what waits for the person as one amber light. */
function paintLights(){
 if(!lights)return;
 const showWork=widgetsVisible().includes('companion')&&widgetsVisible().includes('work'),showLamp=widgetsVisible().includes('companion');
 lights.set({jobs:showWork?lightJobs(workJobs()):[],waiting:showLamp&&!sharedView?inboxList().length:0,shared:sharedView});
}
/** The idle screen keeps the display on when asked (and for the photo frame). Not every environment allows it. */
async function holdScreen(on){
 try{
  if(on&&!wakeLock&&navigator.wakeLock&&!document.hidden){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null;});}
  else if(!on&&wakeLock){const lock=wakeLock;wakeLock=null;await lock.release();}
 }catch{wakeLock=null;}
}
/** On return the character says what happened while the person was away, if anything did. */
function startRecap(){
 const text=awayRecap({jobs:state.jobs,waiting:inboxList().length,since:awaySince||ambientSince,voice:characterVoice(state.dialogue)});
 awaySince=0;clearTimeout(recapTimer);recapUntil=0;
 if(!text)return;
 recapText=text;recapUntil=Date.now()+9000;
 lights?.gather(true);
 recapTimer=setTimeout(()=>{recapUntil=0;lights?.gather(false);if(view==='home')paintSpeech();},9100);
}

/* ---------- Home: the companion stage and monitor modules ---------- */
function widgetsVisible(){const prefs=display(),now=Date.now();return prefs.widgets.filter(w=>!prefs.hiddenUntil[w]||Date.parse(prefs.hiddenUntil[w])<=now);}
function homeHTML(){
 return `<section class="stage" id="stage" aria-label="ホーム">
  <div class="stage-figure" id="stage-figure"><div class="stage-character" id="stage-character-slot"></div><div class="speech" id="speech" hidden></div></div>
  <div class="stage-side">
   <div class="clock" id="clock"><time id="clock-display"></time><p class="clock-line"><span id="clock-date"></span><span id="clock-season"></span></p><p class="clock-weather" id="clock-sub"></p></div>
   <div id="deck-slot" class="deck-slot"></div>
   <button type="button" class="link-button deck-setup" data-action="display">ホームのカードを設定</button>
  </div>
  <div class="stage-notes" id="stage-notes"></div>
 </section>`;
}
function attachStage(){
 const slot=$('#stage-character-slot');if(slot)slot.append(glowHost,stageHost,lightsHost);
 lights||=createLights(lightsHost);if(state?.avatar)lights.setAnchor(avatarGeometry(state.avatar).amber);
 const deckSlot=$('#deck-slot');if(deckSlot)deckSlot.append(deckHost);
 deck||=createDeck(deckHost,{interval:display().ambient.rotateSeconds*1000,reducedMotion,onChange:id=>{
  // A card shows its next headline/picture the next time it comes to the front.
  if(lastDeckCard&&lastDeckCard!==id){if(lastDeckCard==='news')newsIndex++;if(lastDeckCard==='photos')photoIndex++;if(['news','photos'].includes(lastDeckCard))setTimeout(paintDeck,0);}
  lastDeckCard=id;}});
}
function imageAssets(){return (state.mediaJobs||[]).filter(j=>j.asset?.mime?.startsWith('image/')&&j.status==='ready').slice(0,24).map(j=>({src:`/api/media/assets/${encodeURIComponent(j.asset.id)}`,title:j.title||'つくった画像'}));}
function paintHome(){
 if(!$('#stage'))return;
 const visible=widgetsVisible(),prefs=display();
 $('#clock').hidden=!visible.includes('clock');
 $('#stage-figure').classList.toggle('is-empty',!visible.includes('companion'));
 paintSpeech();paintStageNotes();paintDeck();paintLights();tick();
}
function paintSpeech(){
 const el=$('#speech');if(!el)return;
 if(sharedView||!widgetsVisible().includes('companion')||(talkOpen&&!narrow())||(ambientMode&&backdropNow()==='photos')){el.hidden=true;return;}
 const all=state.dialogue?.messages||[],messages=all.filter(m=>m.role==='assistant'&&!['worker-report','worker-question'].includes(m.kind));
 const last=messages.at(-1),fresh=last&&Date.now()-Date.parse(last.at||0)<(ambientMode?20*60e3:6*3600e3),waiting=inboxList().length;
 // On return the caption says what happened; otherwise a fresh reply, then a word about what waits, then the greeting.
 const voice=characterVoice(state.dialogue),recapping=recapUntil>Date.now();
 if(!recapping&&!fresh&&!waiting&&!voiceSpeaks(voice,'greeting')){el.hidden=true;return;}
 const text=recapping?recapText:fresh?String(last.content||''):waiting?`${voiceAddress(voice)}${voiceLine(voice,'waiting',{n:countWord(waiting)})}`:greeting(new Date(),weatherData,characterName(state.dialogue),voice).text;
 el.hidden=false;el.classList.toggle('is-greeting',!fresh);
 el.innerHTML=`<div class="speech-text md">${renderMarkdown(text.length>900?text.slice(0,898)+'…':text,{headings:'text'})}</div>${all.length&&!ambientMode?`<button type="button" class="speech-more" data-action="${narrow()?'view':'talk-open'}" data-view="talk">会話の履歴</button>`:''}`;
 const body=el.querySelector('.speech-text');el.classList.toggle('is-clipped',!!body&&body.scrollHeight>body.clientHeight+2);
}
/** Below the stage: only what the topbar cannot show (it is hidden on the idle screen). */
function paintStageNotes(){
 const host=$('#stage-notes');if(!host)return;
 const items=inboxList().length;
 host.innerHTML=sharedView?'<p class="shared-note">共有表示中 · 個人の内容は表示していません</p>':
  ambientMode&&items&&!lampAvailable()?`<button type="button" class="pill tone-attention" data-action="inbox"><i class="lamp-dot" aria-hidden="true"></i><span>あなたの番 ${items}件</span></button>`:'';
}
function paintDeck(){
 if(!deck)return;
 const visible=deckWidgets(widgetsVisible().filter(w=>!['clock','companion'].includes(w)),{weather:weatherData});
 const sample={weather:!!weatherData?.sample,news:!!newsData?.sample};
 deck.set(ambientCards({widgets:visible,weather:weatherData,news:newsData,music:musicState,jobs:workJobs(),images:sharedView?[]:imageAssets(),shared:sharedView,newsIndex,photoIndex,sample}));
 const slot=$('#deck-slot');if(slot)slot.classList.toggle('is-empty',!deckHost.querySelector('.deck-card'));
}
async function loadFeeds(force=false){
 if(!state)return;const s=settings(),visible=widgetsVisible();
 try{
  if(previewMode){weatherData||=sampleWeather();newsData||=sampleNews();}
  else{
   if(visible.includes('weather')&&s.allowNetwork&&s.weatherCity&&(force||!weatherData||Date.now()-Date.parse(weatherData.fetchedAt||0)>25*60e3))weatherData=await bridge.request('/api/connector/weather','POST',{});
   if(visible.includes('news')&&s.allowNetwork&&s.newsUrl&&(force||!newsData||Date.now()-Date.parse(newsData.fetchedAt||0)>12*60e3))newsData=await bridge.request('/api/connector/news','POST',{});
  }
 }catch(e){if(force)notice(e.message,'error');}
 paintDaylight();
 if(view==='home')paintHome();
}
function sampleWeather(){const now=new Date(),hours=Array.from({length:12},(_,i)=>{const d=new Date(now);d.setMinutes(0,0,0);d.setHours(d.getHours()+i);return d.toISOString();});
 return {sample:true,city:'東京（サンプル）',current:{temperature_2m:19,weather_code:2},hourly:{time:hours,temperature_2m:hours.map((_,i)=>19+Math.round(Math.sin(i/3)*3)),precipitation_probability:hours.map((_,i)=>i>6?30:10)},daily:{temperature_2m_max:[23],temperature_2m_min:[15],sunrise:[new Date(now.setHours(5,42,0,0)).toISOString()],sunset:[new Date(new Date().setHours(17,21,0,0)).toISOString()]},fetchedAt:new Date().toISOString()};}
function sampleNews(){return {sample:true,title:'ニュース（サンプル表示）',items:['自分で選んだRSSの見出しが、ここに順番に流れます','読みたい見出しを押すと、ブラウザで開きます','通信を許可したときだけ取得します'].map((title,i)=>({title,url:'https://example.com/'+i})),fetchedAt:new Date().toISOString()};}

/* Idle screen: dims, drifts slightly against burn-in, and tells the service the person is away. */
/** The idle screen works like a screensaver: it starts by itself, covers the screen, drifts against
 * burn-in and, on any deliberate input, gives the person back what they were doing. */
function setAmbient(on,{restore=false}={}){
 if(ambientMode===on)return;ambientMode=on;ambientSince=Date.now();
 if(on){
  awaySince=ambientSince;ambientReturn={view,scroll:$('#surface')?.scrollTop||0};
  closePanel();if(view!=='home'){view='home';render();}
  const surface=$('#surface');if(surface)surface.scrollTop=0;   // a body that fills the stage makes home taller than the screen: start from the top, not where settings was scrolled to
  clearInterval(driftTimer);if(!reducedMotion)driftTimer=setInterval(drift,90000);
  holdScreen(display().ambient.keepAwake||frameSession);
 }else{
  clearInterval(driftTimer);$('#stage')?.style.removeProperty('--drift-x');$('#stage')?.style.removeProperty('--drift-y');
  holdScreen(false);if(enteredFullscreen){enteredFullscreen=false;document.exitFullscreen?.().catch(()=>{});}
  startRecap();frameSession=false;wallpaperDirty=true;
  const back=ambientReturn;ambientReturn=null;
  if(restore&&back&&back.view!=='home'&&!sharedView){view=back.view;render();const surface=$('#surface');if(surface)surface.scrollTop=back.scroll;}
 }
 setPresence(on||document.hidden?'away':'present');paintChrome();paintHome();paintMood();
}
function drift(){const stage=$('#stage');if(!stage)return;stage.style.setProperty('--drift-x',`${Math.round(Math.random()*16-8)}px`);stage.style.setProperty('--drift-y',`${Math.round(Math.random()*12-6)}px`);}
function canIdle(){return !activeDialog&&!activePanel&&!draft.content&&!voice&&!attachedFiles.length&&document.activeElement?.id!=='composer-input'&&!(view==='workspace'&&$('#artifact-preview iframe'));}
function setPresence(next){if(next===presence)return;presence=next;if(!previewMode)bridge.request('/api/presence','POST',{state:next}).catch(()=>{});}

/* ---------- Characters ---------- */
/** The avatar on the stage, and its small icon in the conversation column. What it looks like is the avatar spec;
 * what it says is the persona. The two are saved and changed separately. */
const avatarAssetList=()=>state.avatarAssets?.assets||[];
function avatarContext(){
 return previewMode?{assets:avatarAssetList(),assetUrl:(id,path)=>previewAvatar.url(id,path),readJSON:(id,path)=>previewAvatar.readJSON(id,path),previewMode:true}
  :{assets:avatarAssetList(),assetUrl:avatarAssetUrl,previewMode:false};
}
function avatarThemeNow(){
 if(document.body.classList.contains('is-lamp'))return 'lamp';
 const theme=display().theme;
 return theme==='dark'||(theme==='system'&&globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches===true)?'dark':'light';
}
function applyAvatarTheme(){
 const theme=avatarThemeNow();if(theme===avatarTheme)return;avatarTheme=theme;
 stageCharacter?.setTheme?.(theme);avatarCharacter?.setTheme?.(theme);
}
globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change',()=>applyAvatarTheme());
globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.addEventListener?.('change',e=>{reducedMotion=e.matches;for(const c of [stageCharacter,avatarCharacter])c?.setReduced?.(e.matches);});
/** Where the lamp and the amber light sit around this body, and how large it is on the stage. */
function applyAvatarGeometry(spec){
 const g=avatarGeometry(spec);
 for(const host of [glowHost,lightsHost]){host.style.setProperty('--ant-x',`${g.lamp[0]}%`);host.style.setProperty('--ant-y',`${g.lamp[1]}%`);}
 document.body.toggleAttribute('data-avatar-fill',g.fill);document.body.style.setProperty('--avatar-scale',String((spec.size||1)*(g.scale||1)));
 lights?.setAnchor(g.amber);
}
async function mountCharacters(){
 if(!state?.avatar)return;
 const spec=state.avatar,name=characterName(state.dialogue),shown=widgetsVisible().includes('companion');
 const key=JSON.stringify([spec,avatarAssetList().map(a=>a.id),name,shown]);
 if(key===characterKey)return;characterKey=key;
 avatarAbort?.abort();avatarAbort=new AbortController();const signal=avatarAbort.signal;
 stageCharacter?.destroy();stageCharacter=null;avatarCharacter?.destroy();avatarCharacter=null;stageHost.replaceChildren();
 applyAvatarGeometry(spec);
 const context={...avatarContext(),theme:avatarTheme,reduced:reducedMotion,signal,onProblem:message=>notice(message,'error')};
 const small=$('#talk-avatar');
 if(small){
  small.replaceChildren();
  const icon=shown?await createAvatar(small,spec,{...context,compact:true,onProblem:()=>{}}):null;
  if(signal.aborted){icon?.destroy();return;}
  if(icon)avatarCharacter=icon;else small.innerHTML=`<span class="initial">${escape(name.slice(0,1))}</span>`;
 }
 if(shown){
  const created=await createAvatar(stageHost,spec,{...context,follow:true,director:true,label:name});
  if(signal.aborted){created?.destroy();return;}
  stageCharacter=created;
 }
 paintMood();
}
function paintMood(){
 if(!state)return;
 const now=Date.now(),chatBusy=state.dialogue?.status==='running';
 const failures=workJobs().some(j=>j.status==='failed'&&now-Date.parse(j.endedAt||j.createdAt||0)<30*60e3);
 const playing=[...document.querySelectorAll('#ability-now-playing audio')].some(a=>!a.paused);
 const mood=companionMood({recording:!!voice,typing:document.activeElement?.id==='composer-input'&&!!draft.content,sending,awaitingReply:chatBusy,talking:playing||now<talkUntil,celebrate:now<celebrateUntil,attention:inboxList().length,failures,sleepy:ambientMode&&display().ambient.nightDim&&isNight(new Date(),weatherData)});
 for(const c of [stageCharacter,avatarCharacter])c?.setMood(mood);
 document.body.dataset.mood=mood;
}

/* ---------- Work ---------- */
function focusJob(){return state.jobs.find(j=>j.id===state.companion?.focusJobId);}
function focusedArtifacts(){return companionArtifacts(state.artifacts,state.companion?.focusJobId);}
function taskRows(){
 const jobs=workJobs().slice(0,120),focusId=state.companion?.focusJobId;
 const row=j=>{const s=jobStatus(j);return `<button type="button" class="job-row${j.id===focusId?' is-focused':''}" data-action="focus-task" data-id="${escape(j.id)}" aria-pressed="${j.id===focusId}"><span class="job-title">${escape(j.title)}</span><span class="job-state tone-${s.tone}">${escape(s.note||s.label)}</span></button>`;};
 const groups=[['あなたの番',jobs.filter(j=>needsPerson(j))],['進行中',jobs.filter(j=>!needsPerson(j)&&['queued','running'].includes(j.status))],['そのほか',jobs.filter(j=>!needsPerson(j)&&!['queued','running'].includes(j.status))]];
 return groups.filter(([,list])=>list.length).map(([label,list])=>`<section class="job-group"><h2>${label}</h2>${list.map(row).join('')}</section>`).join('')||'<p class="empty-copy">頼んだ仕事が、ここに並びます。</p>';
}
/** Resolves which artifact and version the bench shows; null when the job has none. */
function currentArtifact(){
 const artifacts=focusedArtifacts(),latest=artifacts.find(a=>a.id===selectedArtifact)||artifacts[0];
 if(!latest){selectedArtifact=null;pinnedArtifact=null;return null;}
 selectedArtifact=latest.id;
 if(!pinnedArtifact||pinnedArtifact.id!==latest.id)pinnedArtifact=structuredClone(latest);
 return latest;
}
function artifactToolbar(latest){
 const hasNew=latest.version>pinnedArtifact.version;
 return `<button type="button" class="version-button" data-action="artifact-versions" data-id="${escape(latest.id)}" title="版の一覧">${icon('history')}<span>版 ${pinnedArtifact.version}${hasNew?' · 新しい版あり':followArtifact?'':' · 固定中'}</span></button>
  <div class="artifact-tools">${toolbtn('artifact-follow',followArtifact?'この版で固定する':'最新の版に追従する','pin',`aria-pressed="${!followArtifact}"`)}${toolbtn('artifact-edit','直接編集','pencil')}${toolbtn('artifact-save','書き出す','download')}${toolbtn('artifact-expand',document.body.classList.contains('artifact-focus')?'元の大きさに戻す':'大きく表示','expand')}</div>`;
}
function artifactSurface(){
 const latest=currentArtifact();if(!latest)return '';
 return `<div class="artifact-panel"><div class="artifact-toolbar" id="artifact-toolbar">${artifactToolbar(latest)}</div><div id="artifact-preview" class="artifact-frame"></div></div>`;
}
function approvalsFor(job){return (state.approvals||[]).filter(a=>a.jobId===job.id&&a.status==='pending');}
function approvalCards(job){
 return approvalsFor(job).map(a=>approvalSlip(a,{job,tag:'section',kind:'approval-card inbox-item',showJob:false})).join('');
}
// A job's note is shown only when it explains a stop; otherwise the status says enough.
const jobReason=j=>['failed','blocked','interrupted'].includes(j.status)?[j.note,j.retryAt&&`${new Date(j.retryAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}に再試行`].filter(Boolean).join(' · '):'';
function workbenchParts(job,artifacts){
 const s=jobStatus(job);
 const report=job.output?`<article class="report-doc md">${renderMarkdown(job.output)}</article>`:'';
 return {report,
  top:`<header class="bench-head"><div class="bench-title"><h2>${escape(job.title)}</h2><p class="bench-state tone-${s.tone}">${escape([s.note||s.label,jobReason(job)].filter(Boolean).join(' · '))}</p></div>
  <div class="bench-actions">${jobActions(job,{compact:true})}${toolbtn('task','詳細','list',`data-id="${escape(job.id)}"`)}</div></header>
  ${approvalCards(job)}
  ${artifacts.length>1?`<div class="artifact-tabs" role="group" aria-label="成果物">${artifacts.map(a=>`<button type="button" data-action="artifact-select" data-id="${escape(a.id)}" aria-pressed="${a.id===selectedArtifact}">${escape(a.title)}</button>`).join('')}</div>`:''}`,
  bottom:artifacts.length&&report?`<details class="report-more"><summary>作業担当の報告</summary>${report}</details>`:''};
}
function workbench(job,artifacts){
 const parts=workbenchParts(job,artifacts);
 const main=artifacts.length?artifactSurface():parts.report||`<p class="bench-empty">${['queued','running'].includes(job.status)?'成果物ができると、ここに表示されます。':'表示できる成果物はありません。'}</p>`;
 return `<div id="bench-top" class="bench-part">${parts.top}</div><div class="bench-part">${main}</div><div id="bench-bottom" class="bench-part">${parts.bottom}</div>`;
}
/** Updates the work page around a live artifact frame. An iframe reloads whenever it is detached,
 * so a pin, a status change or a new note must not replace it. False when a full render is needed. */
function patchWork(frame){
 const surface=$('#surface'),bench=$('.workbench',surface),job=focusJob();
 if(workTab!=='tasks'||!frame||!job||bench?.dataset.job!==job.id||!$('#bench-top',surface))return false;
 const latest=currentArtifact();
 if(!latest||frame.dataset.key!==`${pinnedArtifact.id}:${pinnedArtifact.version}`)return false;
 const parts=workbenchParts(job,focusedArtifacts());
 $('.job-list',surface).innerHTML=taskRows();$('#bench-top',surface).innerHTML=parts.top;$('#bench-bottom',surface).innerHTML=parts.bottom;$('#artifact-toolbar',surface).innerHTML=artifactToolbar(latest);
 registerForms(surface);return true;
}
function workHead(){return `<header class="page-head"><h1 class="visually-hidden">仕事</h1>${workTabs()}</header>`;}
function workView(){
 if(workTab!=='tasks')return madeView();
 const focus=focusJob(),artifacts=focusedArtifacts(),jobs=workJobs();
 return `<section class="page work-page">${workHead()}
 <div class="work-grid"><aside class="job-list" aria-label="仕事の一覧">${taskRows()}</aside>
 <section class="workbench" aria-label="選んだ仕事" data-job="${escape(focus?.id||'')}">${focus?workbench(focus,artifacts):`<div class="bench-empty is-large">${jobs.length?'<p>仕事を選ぶと、ここに成果物が出ます。</p>':`<h2>まだ仕事はありません</h2><p>会話で頼むと、ここに届きます。</p>${previewMode?btn('demo','画面サンプルを試す','play','button secondary'):''}`}</div>`}</section></div></section>`;
}
function workTabs(){return `<div class="tabs" role="group" aria-label="仕事の種類">${[['tasks','仕事'],['made','つくったもの']].map(([key,label])=>`<button type="button" data-action="work-tab" data-tab="${key}" aria-pressed="${workTab===key}">${label}</button>`).join('')}</div>`;}
function todoHTML(job){
 const items=job.todo||[];if(!items.length)return '';
 const mark={done:'✓',in_progress:'▸',blocked:'!',pending:'·'};
 return `<section class="panel-section" id="task-todo"><h3>やること</h3><ul class="todo-list">${items.map(t=>`<li class="todo-${escape(t.status)}"><span aria-hidden="true">${mark[t.status]||'·'}</span>${escape(t.text)}</li>`).join('')}</ul></section>`;
}
function routeLine(j){
 const r=j.route,st=j.stats||{},where=r?`${r.profileId} · ${r.model}（${({device:'このPC',lan:'LAN',cloud:'クラウド'})[r.domain]||r.domain}）`:'';
 const cache=st.input?Math.round(100*(st.cacheRead||0)/st.input):0;
 return escape([where,st.steps?`${st.steps}ステップ`:'',st.input?`入力 ${st.input.toLocaleString()}・出力 ${(st.output||0).toLocaleString()}トークン${cache?`（キャッシュ ${cache}%）`:''}`:'',st.cost?`費用 $${st.cost<0.01?st.cost.toFixed(4):st.cost.toFixed(2)}`:'',st.clears||st.compactions?`文脈の整理 ${st.clears||0}回・要約 ${st.compactions||0}回`:''].filter(Boolean).join(' · '));
}
function madeView(){
 const media=state.mediaJobs||[];
 return `<section class="page">${workHead()}
 <div class="page-tools">${btn('creative-new','画像・動画をつくる','plus','button secondary')}${media.length?btn('creative-open','一覧','list','text-button'):''}</div>
 ${media.length?`<div class="made-grid">${media.slice(0,60).map(j=>`<article class="made-card">${j.asset?.mime?.startsWith('image/')?`<img src="/api/media/assets/${escape(j.asset.id)}" alt="${escape(j.title)}" loading="lazy">`:`<div class="made-icon">${icon(j.kind==='tts'?'volume':j.kind==='video'?'play':'image')}</div>`}<p>${escape(j.title)}</p>${j.status==='ready'?'':`<small>${escape(({failed:'失敗',cancelled:'停止'})[j.status]||'処理中')}</small>`}</article>`).join('')}</div>`:'<div class="bench-empty is-large"><p>つくった画像や音声が、ここに並びます。</p></div>'}</section>`;
}

/* ---------- Memory ---------- */
function memoryView(){
 const list=state.memories.map(m=>`<article class="memory-card${m.confirmed?'':' is-pending'}"><h2>${escape(m.title||'記憶')}</h2><p>${escape(m.content)}</p>
  <footer>${m.confirmed?(m.scope==='shared'?'<span class="memory-scope">外部モデルにも共有</span>':''):'<span class="memory-scope is-pending">未確認</span>'}<span class="memory-tools">${!m.confirmed?btn('memory-confirm','使う','check','text-button',`data-id="${escape(m.id)}"`):''}${toolbtn('memory-edit','記憶を編集','pencil',`data-id="${escape(m.id)}"`)}${toolbtn('memory-delete','この記憶を削除','trash',`data-id="${escape(m.id)}"`)}</span></footer></article>`).join('');
 return `<section class="page memory-page"><header class="page-head"><h1>記憶</h1><div class="page-tools">${btn('semantic-open','意味で探す','','text-button')}${btn('memory-add','記憶を追加','plus','button')}</div></header>
 ${list?`<div class="memory-grid">${list}</div>`:'<div class="bench-empty is-large"><p>覚えてほしいことは、会話でそう伝えるか、ここに追加してください。</p></div>'}</section>`;
}

/* ---------- Settings: one place, each row says what is connected ---------- */
function settingRow(title,status,tone,body,actions){return `<div class="setting-row"><div class="setting-text"><h3>${title}</h3>${status?`<p class="setting-status">${tone?`<i class="dot dot-${tone}"></i>`:''}${status}</p>`:''}${body?`<p class="setting-note">${body}</p>`:''}</div><div class="setting-actions">${actions}</div></div>`;}
function wallpaperPicker(current){
 return `<div class="wp-tiles" role="group" aria-label="待機画面の壁紙">${WALLPAPERS.map(w=>`<button type="button" class="wp-tile" data-action="wallpaper-set" data-value="${w}" aria-pressed="${w===current}"><i class="wp-thumb wp-thumb-${w}" aria-hidden="true"></i><span>${WALLPAPER_LABELS[w]}</span></button>`).join('')}</div>`;
}
function frameSummary(){
 const stored=frameStored().length,made=display().ambient.frameCreated?imageAssets().length:0;
 return stored||made?[stored&&`写真 ${stored}枚`,made&&`つくった画像 ${made}枚`].filter(Boolean).join(' · '):'写真はまだありません';
}
function segmented(action,options,current,label){return `<div class="segmented" role="group" aria-label="${label}">${options.map(([value,text])=>`<button type="button" data-action="${action}" data-value="${escape(value)}" aria-pressed="${String(value)===String(current)}">${text}</button>`).join('')}</div>`;}
function avatarSummary(){
 const spec=state.avatar,def=AVATAR_BODIES.find(b=>b.id===spec.body)||AVATAR_BODIES[0],asset=spec.asset?avatarAssetList().find(a=>a.id===spec.asset):null;
 return asset?`${def.name} · ${asset.name}`:`${def.name} · ${spec.palette==='custom'?'好きな色':AVATAR_PALETTES[spec.palette]?.name||''}`;
}
let avatarStudioUI=null;
function avatarStudio(){return avatarStudioUI||=createAvatarStudio({bridge,openSheet,notice,previewMode,previewAvatar,saveFile,chooseJSON,themeNow:avatarThemeNow,state:()=>state,isOpen:()=>activeDialog?.kind==='avatar'&&!sharedView});}
const agentSettings=()=>({sandbox:{mode:'off'},webSearch:{provider:'auto'},heartbeat:{enabled:false,minutes:30},budget:{sessionUsd:0,dailyUsd:0},verifyCompletion:'auto',cacheRetention:{main:'long',worker:'short'},...state.agent?.settings});
const money=n=>`$${(n||0)<0.01&&n>0?(n||0).toFixed(4):(n||0).toFixed(2)}`;
function usageSummary(){const u=state.agent?.usage?.today,b=agentSettings().budget;return [u?.calls?`今日 ${money(u.cost)}・${(u.input||0).toLocaleString()}トークン`:'今日はまだ使っていません',b.dailyUsd?`上限 1日${money(b.dailyUsd)}`:'',b.sessionUsd?`1仕事${money(b.sessionUsd)}`:''].filter(Boolean).join(' · ');}
function budgetSheet(){
 const a=agentSettings(),b=a.budget;
 openSheet('費用と仕上げ',`<form id="budget-form"><p class="small-text">${escape(usageSummary())}。費用はmodels.devの公開価格から見積もります（このPCとLANのモデルは0）。</p>
 <label class="field"><span>1日の上限（ドル、0は上限なし）</span><input type="number" name="dailyUsd" min="0" max="100000" step="0.01" value="${b.dailyUsd||0}"></label>
 <label class="field"><span>1つの仕事の上限（ドル、0は上限なし）</span><input type="number" name="sessionUsd" min="0" max="100000" step="0.01" value="${b.sessionUsd||0}"></label>
 <label class="field"><span>仕上げの確認</span><select name="verifyCompletion">${[['auto','自動（判断モデルか、作業担当の見直し）'],['off','しない']].map(([v,l])=>`<option value="${v}" ${a.verifyCompletion===v?'selected':''}>${l}</option>`).join('')}</select></label>
 <label class="field"><span>キャラクターの文脈キャッシュ</span><select name="mainCache">${[['long','長く保つ（1時間・24時間。対応APIのみ）'],['short','標準（数分）']].map(([v,l])=>`<option value="${v}" ${a.cacheRetention.main===v?'selected':''}>${l}</option>`).join('')}</select></label>
 <div class="sheet-actions"><button class="button" type="submit">保存する</button></div></form>`,'budget');
}
function searchSheet(){
 const w=agentSettings().webSearch;
 openSheet('Web検索',`<form id="search-form"><label class="field"><span>検索の提供元</span><select name="provider">${[['auto','自動（キーがあればBrave、URLがあればSearXNG、なければDuckDuckGo）'],['duckduckgo','DuckDuckGo（キー不要）'],['brave','Brave Search API'],['searxng','SearXNG（自分のサーバー）']].map(([v,t])=>`<option value="${v}" ${w.provider===v?'selected':''}>${escape(t)}</option>`).join('')}</select></label>
 ${field('SearXNGのURL','searxngUrl',w.searxngUrl||'','http://127.0.0.1:8888')}${field('Brave SearchのAPIキー（保存すると上書き）','braveKey','','','password')}
 <p class="small-text">検索語は選んだ提供元へ送られます。キーはこのPCのデータベースに保存します。</p><div class="sheet-actions"><button class="button" type="submit">保存する</button></div></form>`,'search');
}
function heartbeatSheet(){
 const h=agentSettings().heartbeat;
 openSheet('常駐と見回り',`<form id="heartbeat-form">${toggle('決まった間隔で見回る','enabled',h.enabled,'キャラクターが仕事の様子を確かめ、伝えることがあるときだけ話しかけます。モデルを呼ぶので費用や計算資源を使います。')}
 <label class="field"><span>間隔（分）</span><input type="number" name="minutes" min="5" max="1440" value="${h.minutes||30}"></label>
 <label class="field"><span>見回りで確かめること（任意）</span><textarea name="text" rows="3" maxlength="2000">${escape(h.text||'')}</textarea></label><div class="sheet-actions"><button class="button" type="submit">保存する</button></div></form>`,'heartbeat');
}
function computerSummary(){const c=state.computer;if(!c?.config?.enabled)return '無効';return [c.browser?.executable?`ブラウザ${c.config.headless?'（見えない）':''}`:'ブラウザなし',c.desktop?.supported&&c.config.desktop?'Macのアプリ':'',({both:'判断モデル優先・直接も可',decision:'判断モデルのみ',direct:'直接操作のみ'})[c.config.control]].filter(Boolean).join(' · ');}
function settingsView(){
 const s=settings(),prefs=display(),caps=state.capabilities||{profiles:[],routes:{}},providers=state.providers?.profiles||[],net=state.network||{mode:'online'};
 const ready=!!(s.model||providers.some(p=>p.enabled!==false&&p.model)),roleNames={tts:'読み上げ',embedding:'意味検索',image:'画像',image_edit:'画像の編集',video:'動画',decision:'判断'};
 const connected=Object.entries(roleNames).filter(([role])=>caps.routes?.[role]).map(([,n])=>n);
 const order=[...prefs.widgets,...WIDGETS.filter(w=>!prefs.widgets.includes(w))];
 const sections=[
  ['ai','AIとの接続',`${settingRow('会話と仕事のAI',ready?escape(s.model||providers.find(p=>p.enabled!==false)?.model||'接続済み'):'未接続',ready?'ok':'attention','',ready?`${btn('providers-launch','接続先と役割','','button secondary')}${btn('catalog-open','モデルを探す','','text-button')}`:`${btn('onboard','AIを接続する','','button')}${btn('providers-launch','接続先と役割','','text-button')}${btn('catalog-open','モデルを探す','','text-button')}`)}
   ${settingRow('通信','',null,'Teporaの通信だけを制限します。OS全体のファイアウォールではありません。',segmented('net-mode',[['online','オンライン'],['trusted-lan','信頼LANだけ'],['offline','完全オフライン']],net.mode,'通信モード'))}
   ${settingRow('インターネットを使う道具','',null,'天気・ニュース・Web取得・専用ブラウザ',`<label class="switch-label"><input class="switch" type="checkbox" role="switch" data-action="allow-network" ${s.allowNetwork?'checked':''} aria-label="インターネットを使う道具を許可"></label>`)}`],
  ['character','キャラクター',`${settingRow('姿',escape(avatarSummary()),null,'体・色・灯り・顔・小物・動きを選べます。今までのキャラクター（3Dモデル・画像・メッシュアバター）も持ち込めます。',btn('avatar-open','姿を作る','pencil','button'))}
   ${settingRow('人格と口調',escape(characterName(state.dialogue)),null,'名前・振る舞い・口調・呼び名・話しかけ方。姿とは別に設定します。',btn('personas','編集','pencil','button secondary','aria-label="人格と口調を編集"'))}`],
  ['home','ホームと待機画面',`${settingRow('テーマ','',null,'',segmented('theme-set',[['system','端末に合わせる'],['light','明るい'],['dark','暗い']],prefs.theme,'テーマ'))}
   ${settingRow('文字の大きさ','',null,'',segmented('scale-set',[['0.9','小さめ'],['1','標準'],['1.15','大きめ'],['1.3','特大'],['1.6','最大']],[0.9,1,1.15,1.3,1.6].reduce((a,b)=>Math.abs(b-prefs.textScale)<Math.abs(a-prefs.textScale)?b:a),'文字の大きさ'))}
   ${settingRow('待機画面','',null,'操作がないと、画面いっぱいの待機画面になります。スクリーンセーバーのように、触れる・キーを押す・マウスを大きく動かすと、元の画面に戻ります。',`<label class="select-label"><span class="visually-hidden">待機画面に切り替えるまで</span><select data-action="idle-set">${IDLE_CHOICES.map(m=>`<option value="${m}" ${prefs.ambient.idleMinutes===m?'selected':''}>${m?`${m}分後`:'切り替えない'}</option>`).join('')}</select></label><label class="switch-label"><span>夜は暗く</span><input class="switch" type="checkbox" role="switch" data-action="night-set" ${prefs.ambient.nightDim?'checked':''}></label>${btn('ambient-try','いま試す','moon','text-button')}`)}
   ${settingRow('壁紙','',null,escape(WALLPAPER_NOTES[prefs.ambient.wallpaper]||''),wallpaperPicker(prefs.ambient.wallpaper))}
   ${settingRow('写真立て',frameSummary(),frameStored().length?'ok':null,'選んだ写真を、待機画面でゆっくり切り替えます。写真はこのPCに保存し、外へは送りません。',`${btn('frame-open','写真を管理','image','button secondary')}${btn('frame-now','写真立てを始める','','text-button')}`)}
   ${settingRow('画面をつけたままにする','',null,'待機画面のあいだ、画面が消えないようにします（対応している環境のみ）。',`<label class="switch-label"><input class="switch" type="checkbox" role="switch" data-action="awake-set" aria-label="待機画面のあいだ画面をつけたままにする" ${prefs.ambient.keepAwake?'checked':''}></label>`)}
   ${settingRow('ホームのカード','',null,'ニュース・音楽・つくった画像は、この順番でカードをめくります。仕事は灯り、天気は日付の下の一行で表します。',`<label class="select-label"><span class="visually-hidden">めくる間隔</span><select data-action="rotate-set">${[8,12,20,30,60].map(n=>`<option value="${n}" ${prefs.ambient.rotateSeconds===n?'selected':''}>${n}秒ごと</option>`).join('')}</select></label>`)}
   <ol class="widget-order">${order.map((w,i)=>`<li><label><input type="checkbox" data-action="widget-toggle" value="${w}" ${prefs.widgets.includes(w)?'checked':''}><span>${widgetNames[w]}</span></label><span class="widget-move">${toolbtn('widget-up',`${widgetNames[w]}を上へ`,'arrow',`data-widget="${w}" data-dir="up" ${i===0?'disabled':''}`)}${toolbtn('widget-down',`${widgetNames[w]}を下へ`,'arrow',`data-widget="${w}" data-dir="down" ${i===order.length-1?'disabled':''}`)}</span></li>`).join('')}</ol>
   ${settingRow('天気とニュース',[s.weatherCity&&`天気: ${escape(s.weatherCity)}`,s.newsUrl&&'ニュース: 設定済み'].filter(Boolean).join(' · '),s.weatherCity||s.newsUrl?'ok':null,'',btn('feeds-setup',s.weatherCity||s.newsUrl?'変更':'場所とRSSを設定','','button secondary'))}
   ${settingRow('音楽',musicState?.track?escape(`${musicState.count}曲を選択中`):'',musicState?.track?'ok':null,'このPCの音楽ファイルをホームで流します。送信はしません。',`${btn('music-choose','曲を選ぶ','music','button secondary')}${btn('media','YouTube','','text-button','aria-label="YouTubeを流す"')}`)}
   <div class="setting-foot">${btn('display-undo','前の表示に戻す','undo','text-button')}${btn('display-reset','既定に戻す','','text-button')}</div>`],
  ['abilities','声・画像・意味検索',`${settingRow('能力の接続',connected.length?connected.join('・'):'',connected.length?'ok':null,connected.length?'':'読み上げ・画像・意味検索などを、役割ごとに接続できます。',`${btn('abilities-open','管理','','button secondary','aria-label="能力の接続を管理"')}${btn('creative-new','つくってみる','','text-button')}`)}
   ${settingRow('音声入力',s.asrStreamUrl||s.asrUrl?'設定済み':'',s.asrStreamUrl||s.asrUrl?'ok':null,'マイクはボタンを押したときだけ使います。',btn('voice-settings','設定','','button secondary','aria-label="音声入力の設定"'))}`],
  ['work','仕事の実行',`${settingRow('サンドボックス',({off:'オフ（このPCで直接実行）',workspace:'作業フォルダだけ書き込める',readonly:'読み取りだけ',container:'コンテナ'})[agentSettings().sandbox.mode],agentSettings().sandbox.mode==='off'?null:'ok','保護は既定でオフです。必要なときだけ、作業エージェントのコマンドとファイル書き込みを閉じ込めます。',segmented('sandbox-set',[['off','オフ'],['workspace','作業フォルダ'],['readonly','読み取り'],['container','コンテナ']],agentSettings().sandbox.mode,'サンドボックス'))}
   ${settingRow('Web検索',({auto:'自動',brave:'Brave Search',searxng:'SearXNG',duckduckgo:'DuckDuckGo'})[agentSettings().webSearch.provider]||'自動',null,'調べものに使う検索。キーなしで使えるDuckDuckGoが既定です。',btn('search-setup','設定','','button secondary','aria-label="Web検索の設定"'))}
   ${settingRow('常駐と見回り',agentSettings().heartbeat.enabled?`${agentSettings().heartbeat.minutes}分ごと`:'オフ',agentSettings().heartbeat.enabled?'ok':null,'決まった間隔でキャラクターが仕事の様子を見回り、伝えることがあれば話しかけます。',btn('heartbeat-setup','設定','','button secondary','aria-label="見回りの設定"'))}
   ${settingRow('判断モデル',state.capabilities?.routes?.decision?(state.capabilities.profiles.find(p=>p.id===state.capabilities.routes.decision)?.name||'接続済み'):'未接続',state.capabilities?.routes?.decision?'ok':null,'選ぶ・判定するだけの速いモデルです。画面操作、ページの要点抜き出し、仕上げの確認、見回りの判定に使います。Liquid d1（クラウド）か Laya（このPC）を接続します。',btn('abilities-open','接続','','button secondary','aria-label="判断モデルを接続"'))}
   ${settingRow('コンピューター操作',computerSummary(),state.computer?.config?.enabled?'ok':null,'作業担当がブラウザ（見えないまま動かせます）とMacのアプリを操作します。判断モデルが画面上の操作を選び、作業担当が直接操作もできます。',btn('computer-launch','設定','','button secondary','aria-label="コンピューター操作の設定"'))}
   ${settingRow('費用と仕上げ',usageSummary(),null,'費用の上限（既定はなし）と、仕事を終える前の確認です。',btn('budget-setup','設定','','button secondary','aria-label="費用と仕上げの設定"'))}
   ${settingRow('道具（MCP）',state.mcp.length?`${state.mcp.length}件 · ${state.mcp.filter(m=>m.enabled).length}件有効`:'',state.mcp.some(m=>m.enabled)?'ok':null,'作業エージェントは必要なときに道具を探して使います。',`${btn('mcp-add','追加','plus','button secondary','aria-label="道具を1件追加"')}${btn('tools-import','まとめて追加','','text-button')}${btn('tools-connect','まとめて接続','','text-button')}${btn('tools-search','探す','','text-button','aria-label="道具を探す"')}`)}
   ${state.mcp.length?`<ul class="plain-list">${state.mcp.map(m=>`<li><span>${escape(m.name)}<small>${escape(m.transport)}</small></span><span>${m.enabled?btn('tools-discover','道具を調べる','','text-button',`data-id="${escape(m.id)}"`):''}${btn('mcp-toggle',m.enabled?'無効にする':'有効にする','','text-button',`data-id="${escape(m.id)}"`)}</span></li>`).join('')}</ul>`:''}
   ${settingRow('プラグイン','',null,`データフォルダの plugins/ に置いた .mjs のツールを読み込みます。`,btn('plugins-reload','読み込み直す','refresh','button secondary'))}
   ${settingRow('共有スキル',state.skills.length?`${state.skills.length}件`:'',state.skills.length?'ok':null,'~/.agents/skills を読み取り専用で探します。',btn('shared-scan','探す','','button secondary','aria-label="共有スキルを探す"'))}
   ${state.skills.length?`<ul class="plain-list">${state.skills.map(k=>`<li><span>${escape(k.name||k.id)}<small>${escape(k.description||'')}${k.source==='shared'?' · 共通資産（読み取り専用）':''}</small></span><span>${btn('skill-details','内容','','text-button',`data-id="${escape(k.id)}"`)}${btn('skill-toggle',k.enabled===false?'有効にする':'無効にする','','text-button',`data-id="${escape(k.id)}"`)}</span></li>`).join('')}</ul>`:''}`],
  ['data','データ',`${settingRow('記憶・成果物・スキル','',null,'メディアファイルと認証情報は含みません。以前の版の記憶は、新しい会話と仕事に自動では渡しません。',`${btn('context-export','書き出す','download','button secondary','aria-label="記憶・成果物・スキルを書き出す"')}${btn('context-import','読み込む','upload','text-button','aria-label="記憶・成果物・スキルを読み込む"')}`)}
   ${settingRow('表示の設定','',null,'',`${btn('display-export','書き出す','download','button secondary','aria-label="表示の設定を書き出す"')}${btn('display-import','読み込む','upload','text-button','aria-label="表示の設定を読み込む"')}`)}`]
 ];
 return `<section class="page settings-page"><header class="page-head"><h1>設定</h1></header>
 <div class="settings-grid"><nav class="settings-nav" aria-label="設定の項目">${sections.map(([id,title])=>`<a href="#settings-${id}" data-action="settings-jump" data-id="${id}">${title}</a>`).join('')}</nav>
 <div class="settings-sections">${sections.map(([id,title,body])=>`<section class="settings-section" id="settings-${id}" aria-labelledby="settings-${id}-title"><h2 id="settings-${id}-title">${title}</h2>${body}</section>`).join('')}</div></div></section>`;
}

/* ---------- Render ---------- */
function captureFocus(scope){const el=document.activeElement;if(!el||!scope.contains(el)||el===scope)return null;return {action:el.dataset?.action,id:el.dataset?.id,view:el.dataset?.view,value:el.dataset?.value,tab:el.dataset?.tab,elementId:el.id};}
function restoreFocus(scope,key){
 if(!key)return;let el=key.elementId?scope.querySelector(`#${CSS.escape(key.elementId)}`):null;
 if(!el&&key.action){const sel=[`[data-action="${CSS.escape(key.action)}"]`,key.id&&`[data-id="${CSS.escape(key.id)}"]`,key.value&&`[data-value="${CSS.escape(key.value)}"]`,key.tab&&`[data-tab="${CSS.escape(key.tab)}"]`].filter(Boolean).join('');el=scope.querySelector(sel);}
 (el||scope).focus({preventScroll:true});
}
function captureScroll(scope){return {surface:scope.scrollTop,list:$('.job-list',scope)?.scrollTop||0,bench:$('.workbench',scope)?.scrollTop||0};}
function restoreScroll(scope,s){scope.scrollTop=s.surface;const list=$('.job-list',scope);if(list)list.scrollTop=s.list;const bench=$('.workbench',scope);if(bench)bench.scrollTop=s.bench;}
function render(){
 if(!state)return;
 if(view==='talk'&&!narrow())view='home';
 applyTheme();paintChrome();
 const surface=$('#surface'),target=sharedView&&view!=='home'?'home':view;
 if(target==='home'){
  if(renderedView!=='home'||!$('#stage',surface)){surface.innerHTML=homeHTML();attachStage();}
  paintHome();
 }else if(target==='talk'){surface.replaceChildren();}
 else{
  const focus=captureFocus(surface),scroll=renderedView===target?captureScroll(surface):{surface:0,list:0,bench:0},oldFrame=$('#artifact-preview iframe');
  if(!(target==='workspace'&&renderedView==='workspace'&&patchWork(oldFrame))){
   surface.innerHTML=target==='workspace'?workView():target==='memory'?memoryView():settingsView();
   registerForms(surface);
   const preview=$('#artifact-preview');
   if(preview&&pinnedArtifact)setArtifactFrame(preview,pinnedArtifact);
  }
  restoreScroll(surface,scroll);restoreFocus(surface,focus);
 }
 renderedView=target;
 tick();showDialogue();showReply();showTarget();showRequestStatus();showInputFiles();paintMood();
 if(activePanel?.kind==='inbox')paintInbox();
}
function syncLiveSurface(){render();}
function scheduleRender(){clearTimeout(refreshTimer);refreshTimer=setTimeout(syncLiveSurface,80);}
function tick(){
 const now=new Date();
 if($('#clock-display'))$('#clock-display').textContent=now.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
 if($('#clock-date'))$('#clock-date').textContent=`${now.getMonth()+1}月${now.getDate()}日（${now.toLocaleDateString('ja-JP',{weekday:'short'})}）`;
 const season=$('#clock-season');if(season)season.textContent=seasonLine(now);
 const sub=$('#clock-sub');
 if(sub){
  const line=widgetsVisible().includes('weather')?weatherLine(weatherData):null,key=line?`${line.temp}|${line.label}|${line.hint}`:'';
  if(sub.dataset.key!==key){sub.dataset.key=key;sub.innerHTML=line?`<span class="wt">${line.temp}°</span><span>${escape(line.label)}</span>${line.hint?`<span class="wh">${escape(line.hint)}</span>`:''}`:'';}
 }
 document.body.classList.toggle('is-night',ambientMode&&display().ambient.nightDim&&isNight(now,weatherData));
 if(now.getMinutes()!==lightMinute){lightMinute=now.getMinutes();paintDaylight(now);}
 paintBackdrop();
 // Expiry affects presentation only, never the permanent layout or task execution.
 const key=JSON.stringify(Object.entries(display().hiddenUntil).filter(([,t])=>Date.parse(t)>Date.now()).map(([w])=>w));
 if(lastVisibleKey&&lastVisibleKey!==key&&view==='home')scheduleRender();
 lastVisibleKey=key;
}
function invalidatePendingSubmit(){submitEpoch++;if(pendingRequest&&!pendingRequest.dispatched&&!pendingRequest.uncertain)pendingRequest=null;}
function composerLocked(){return sending||Boolean(pendingRequest?.uncertain);}
function requireComposerUnlocked(){if(composerLocked())throw new Error('前の送信結果を確認してから変更してください。同じ送信を確認しても依頼は重複しません。');}
function pinDraft(){return draftContext.pin(state.dialogue.session);}
function clearDraftDestination(){draftContext.clear();}
function showTarget(){
 const host=$('#target-hint');if(!host)return;if(sharedView){host.innerHTML='';return;}
 const voiceReady=settings().voiceEnabled&&(settings().asrStreamUrl||settings().asrUrl);
 host.innerHTML=voiceReady?`<div class="voice-send">${btn('voice-autosend',voiceSendEnabled?'話し終えたら送信: オン':'話し終えたら送信: オフ','',`chip-button${voiceSendEnabled?' is-on':''}`,`aria-pressed="${voiceSendEnabled}" ${composerLocked()&&!voiceSendEnabled?'disabled':''}`)}</div>`:'';
 const input=$('#composer-input'),name=characterName(state.dialogue);
 if(input){input.placeholder=`${name}に話しかける`;input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,200)}px`;}
 const undo=$('#undo-draft');if(undo)undo.hidden=!draft.history.length||composerLocked();
}
/** The message box grows with its text. Measured again after the window changes width, because a width measured mid-resize can be nearly zero. */
function fitComposer(){const input=$('#composer-input');if(!input)return;input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,200)}px`;}
function showDialogue(){
 const host=$('#dialogue-transcript');if(!host)return;
 const name=characterName(state.dialogue);$('#character-name').textContent=sharedView?'会話は非公開':name;$('#agent-selector').textContent=sharedView?'個人表示で会話できます':`${name}と会話中。Enterで送信、Shift+Enterで改行。`;
 $('#composer-input').placeholder=`${name}に話しかける`;$('#composer-input').setAttribute('aria-label',`${name}へのメッセージ`);
 const key=JSON.stringify([sharedView,state.dialogue,state.jobs.map(j=>[j.id,j.title,j.status,j.revision,j.pendingQuestionId])]);
 if(key===dialogueRenderKey)return;dialogueRenderKey=key;
 const follow=host.scrollHeight-host.scrollTop-host.clientHeight<80,active=document.activeElement,keep=active&&host.contains?.(active)?{action:active.dataset?.action,id:active.dataset?.id}:null;
 if(sharedView){host.innerHTML='<p class="empty-copy">共有表示では会話・仕事の内容を表示しません。</p>';return;}
 const messages=state.dialogue?.messages||[];
 // A later message about the same job supersedes its quiet start/progress line.
 const latestForJob=new Map();for(const m of messages)if(m.jobId&&['worker-report','worker-question'].includes(m.kind))latestForJob.set(m.jobId,m.id);
 const lastReplyId=[...messages].reverse().find(m=>m.role==='assistant'&&!['worker-report','worker-question'].includes(m.kind))?.id;
 let day='',lastAt=0;
 host.innerHTML=messages.map(m=>{
  const p=dialogueMessagePresentation(m,state.dialogue,state.jobs);
  // Progress and waiting notices give way to the next message about the same job; results stay.
  if(m.kind==='worker-report'&&!['review','completed','failed','blocked','cancelled'].includes(m.status)&&latestForJob.get(m.jobId)!==m.id)return '';
  const at=new Date(m.at||Date.now()),valid=!Number.isNaN(at.getTime()),stamp=valid?at.toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'}):'',label=valid?at.toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'short'}):'';
  // A date or a time appears only where the conversation paused; otherwise it is on hover.
  const t=valid?at.getTime():lastAt,paused=lastAt&&t-lastAt>=30*60e3;
  const divider=label!==day?`<p class="day-divider"><span>${escape(label)} ${escape(stamp)}</span></p>`:paused?`<p class="time-divider">${escape(stamp)}</p>`:'';day=label;lastAt=t;
  if(p.compact)return `${divider}<p class="msg-activity" data-message-id="${escape(m.id)}" title="${escape(stamp)}"><i class="dot dot-active"></i><span>${escape(p.source.replace(/^(.*)からの報告 · /,'$1が「'))}」を${m.status==='queued'?'引き受けました':'進めています'}</span></p>`;
  if(m.role==='user')return `${divider}<article class="msg msg-user" data-message-id="${escape(m.id)}" title="${escape(stamp)}"><span class="visually-hidden">あなた: </span><div class="msg-bubble md">${renderMarkdown(p.content,{headings:'text'})}</div></article>`;
  if(!p.source)return `${divider}<article class="msg msg-character" data-message-id="${escape(m.id)}" title="${escape(stamp)}"><span class="visually-hidden">${escape(p.speaker)}: </span><div class="msg-bubble md">${renderMarkdown(p.content,{headings:'text'})}</div>${m.id===lastReplyId&&state.capabilities?.routes?.tts?`<div class="msg-actions">${btn('reply-speak','読み上げる','volume','text-button')}</div>`:''}</article>`;
  const job=state.jobs.find(j=>j.id===m.jobId);
  const action=p.canReply?btn('reply-worker-question','回答する','','button small',`data-id="${escape(m.id)}"`):
   p.parked||m.status==='waiting_approval'?btn('inbox','あなたの番を見る','','text-button',''):m.jobId?btn('task','開く','','text-button',`data-id="${escape(m.jobId)}" aria-label="${escape(job?.title||'仕事')}を開く"`):'';
  return `${divider}<article class="msg msg-worker tone-${escape(p.tone)}${m.kind==='worker-question'?' is-question':''}" data-message-id="${escape(m.id)}" title="${escape(stamp)}"><header><span class="visually-hidden">${escape(p.speaker)} · ${escape(p.source)}: </span><span class="msg-job">${escape(job?.title||p.source)}</span>${p.status?`<span class="msg-state">${escape(p.status)}</span>`:''}</header>
   <div class="msg-quote worker-quotation md" aria-label="作業担当からの引用">${renderMarkdown(p.content,{headings:'text'})}</div>${p.questionState&&!p.canReply?`<p class="msg-note">${escape(p.questionState)}</p>`:''}${action?`<div class="msg-actions">${action}</div>`:''}</article>`;
 }).join('')+`<article class="msg msg-character is-live" id="dialogue-live" aria-hidden="true" ${liveReply?'':'hidden'}><div class="msg-bubble md"></div></article>`||`<p class="dialogue-welcome">${escape(name)}に、なんでも話しかけてください。</p>`;
 paintLive();
 const last=messages.at(-1);
 if(last&&last.id!==lastSeenMessage){
  if(lastSeenMessage&&last.role!=='user'){const announcer=$('#dialogue-announcer');if(announcer)announcer.textContent=`${last.role==='assistant'?name:'作業担当'}: ${String(last.content||'').slice(0,240)}`;if(last.role==='assistant'&&!last.kind?.startsWith('worker'))talkUntil=Date.now()+Math.min(5200,Math.max(1400,String(last.content||'').length*55));}
  lastSeenMessage=last.id;
 }
 if(keep?.action){const again=host.querySelector?.(`[data-action="${keep.action}"]${keep.id?`[data-id="${keep.id}"]`:''}`);again?.focus?.({preventScroll:true});}
 if(follow)host.scrollTop=host.scrollHeight;
 paintMood();
}
/** The reply as it streams in: in the conversation column and, on the home stage, as the caption. */
function paintLive(){
 const el=$('#dialogue-live');
 if(el){el.hidden=!liveReply||sharedView;if(liveReply)el.querySelector('.msg-bubble').innerHTML=renderMarkdown(liveReply.length>4000?liveReply.slice(-4000):liveReply,{headings:'text'});
  const host=$('#dialogue-transcript');if(host&&liveReply&&host.scrollHeight-host.scrollTop-host.clientHeight<160)host.scrollTop=host.scrollHeight;}
 if(view==='home'&&liveReply&&!sharedView){const speech=$('#speech');if(speech&&!speech.hidden){const body=speech.querySelector('.speech-text');if(body)body.innerHTML=renderMarkdown(liveReply.length>900?'…'+liveReply.slice(-898):liveReply,{headings:'text'});}}
}
function showReply(){const el=$('#reply');if(el){el.hidden=true;el.replaceChildren();}}
function acceptDialogue(value){
 if(!value)return;
 const old=state.dialogue;
 if(value.session&&old?.session?.id===value.session.id&&value.session.revision<old.session.revision)return;
 state.dialogue=value.session?{...old,...value,messages:value.messages?(old?.session?.id===value.session.id?mergeDialogueMessages(old.messages,value.messages):value.messages):old?.messages||[]}:old;
 if(old?.session?.id&&(old.session.id!==state.dialogue.session.id||old.session.revision!==state.dialogue.session.revision)){invalidatePendingSubmit();voiceSendEnabled=false;voiceSendConsent=null;cancelVoice();}
 showDialogue();showTarget();
}
function acceptCompanion(value){
 if(!value)return;const prior=state.companion||{revision:-1,focusJobId:null};if(value.revision<prior.revision)return;
 state.companion=value;
 if(prior.focusJobId!==value.focusJobId){selectedArtifact=null;pinnedArtifact=null;pendingArtifactJobId=null;followArtifact=true;}
 scheduleRender();
}
/** Which job the work page shows. Presentation only: it never changes where messages go. */
async function navigateFocus(jobId,{returning=false}={}){
 const c=state.companion;let next;
 if(returning){const stack=[...c.returnStack];next={revision:c.revision+1,focusJobId:stack.pop()||null,returnStack:stack};}
 else next=jobId===c.focusJobId?c:{revision:c.revision+1,focusJobId:jobId,returnStack:[...c.returnStack.filter(x=>x!==jobId),...(c.focusJobId?[c.focusJobId]:[])].slice(-20)};
 acceptCompanion(next);closeSheet();view='workspace';workTab='tasks';render();
}
async function personaSheet(){
 const p=await bridge.request('/api/dialogue/personas'),voice=p.character.voice||{tone:'polite',callName:'',proactive:'normal',lines:{}},pack=VOICE_TONES[voice.tone]||VOICE_TONES.polite;
 const groups=[...new Set(VOICE_SCENES.map(x=>x.group))],lineRows=group=>VOICE_SCENES.filter(x=>x.group===group).map(x=>`<label class="field line-field"><span>${escape(x.label)}${x.vars?.length?` <small>（${x.vars.map(v=>`{${v}}`).join(' ')}を使えます）</small>`:''}</span><input name="line:${x.key}" type="text" maxlength="100" value="${escape(Object.hasOwn(voice.lines||{},x.key)?voice.lines[x.key]:'')}" placeholder="${escape(pack.lines[x.key]||'（何も言わない）')}" autocomplete="off"></label>`).join('');
 openSheet('人格と口調、作業担当',`<p>会話相手はひとつの継続した会話を持ちます。人格と口調は、姿（見た目）とは別に設定します。変更はこれから始める処理に使い、進行中の仕事の指示は変えません。</p><form id="personas-form" data-revision="${p.revision}"><fieldset><legend>会話のキャラクター</legend>${field('名前','characterName',p.character.name)}<label>会話での振る舞い<textarea name="characterInstructions" rows="4" maxlength="8000">${escape(p.character.instructions)}</textarea></label>
 <label class="field"><span>口調</span><select name="voiceTone" data-action="voice-tone">${Object.entries(VOICE_TONES).map(([id,t])=>`<option value="${id}" ${voice.tone===id?'selected':''}>${escape(t.name)} — ${escape(t.note)}</option>`).join('')}</select></label>
 ${field('呼び名（あなたをどう呼ぶか）','voiceCallName',voice.callName||'','例：ミカ')}
 <label class="field"><span>話しかけ方</span><select name="voiceProactive">${Object.entries(VOICE_PROACTIVE).map(([id,t])=>`<option value="${id}" ${voice.proactive===id?'selected':''}>${escape(t.name)} — ${escape(t.text)}</option>`).join('')}</select></label>
 <details class="voice-lines"><summary>画面の一言を、自分の言葉に書き換える</summary><p class="small-text">空のままなら、選んだ口調の文面を使います。ここに書いた言葉は画面にだけ出て、AIには送りません。</p>${groups.map(g=>`<h3 class="voice-group">${escape(g)}</h3>${lineRows(g)}`).join('')}</details></fieldset>
 <fieldset><legend>作業担当</legend>${field('名前','workerName',p.worker.name)}<label>作業時の指示<textarea name="workerInstructions" rows="5" maxlength="8000">${escape(p.worker.instructions)}</textarea></label></fieldset><p class="small-text">以前の記憶は保持されていますが、会話・作業のどちらにも自動では渡しません。どちらの人格設定も、接続先・ファイル・ツール操作の許可を広げるものではありません。口調はAIには「話し方の指示」としてだけ渡します。</p><button type="submit" class="button">人格を保存する</button></form>`,'personas');
}
/** Hands-free sending of a finished utterance. Talk mode (always listening) is in the voice settings. */
async function configureVoiceSend(){
 if(voiceSendEnabled){voiceSendEnabled=false;invalidatePendingSubmit();cancelVoice();showTarget();return;}
 requireComposerUnlocked();if(previewMode)throw new Error('プレビューでは音声を認識・送信しません。');
 if(settings().dictationEditing)throw new Error('言い直しの編集を使うときは、音声を下書きで確認してから送信してください。');
 voiceSendEnabled=true;showTarget();
}
/* Sheets are modal dialogs for focused edits and confirmations. Details that should sit beside
 * the conversation (a task, the stack of things waiting for you, generated media) open as a
 * non-modal panel instead, so talking never has to stop. */
const PANEL_KINDS=new Set(['task','inbox','creative']);
function formSnapshot(scope){return JSON.stringify([...scope.querySelectorAll('input,textarea,select')].filter(el=>el.name&&el.type!=='password').map(el=>[el.name,el.type==='checkbox'?el.checked:el.value]));}
function openSheet(title,body,kind='generic',id=null){
 if(PANEL_KINDS.has(kind))return openPanel(title,body,kind,id);
 capabilityUI?.onClose();
 clearTimeout(toastTimer);toastEl.classList.remove('show');
 if(!activeDialog)dialogReturnFocus=document.activeElement;activeDialog={kind,id};
 overlay.innerHTML=modal(escape(title),body,['artifact-edit','approve-all','avatar'].includes(kind));
 registerForms(overlay);sheetBaseline=formSnapshot(overlay);
 document.body.classList.add('dialog-open');
 setTimeout(()=>{const first=kind==='avatar'?null:$('.modal-body input:not([type=hidden]):not([readonly]):not([type=checkbox]),.modal-body textarea,.modal-body select',overlay);(first||$('#modal-title',overlay))?.focus();},0);
}
function closeSheet(){capabilityUI?.onClose();avatarStudioUI?.close();pendingRelay=null;
 const wasAvatar=activeDialog?.kind==='avatar';
 overlay.replaceChildren();document.body.classList.remove('dialog-open');activeDialog=null;sheetBaseline='';
 if(wasAvatar&&view==='settings')scheduleRender();   // the summary line under 姿 changed while the studio was open
 if(dialogReturnFocus?.isConnected)dialogReturnFocus.focus();
}
/** Escape, the backdrop and the close button ask before discarding typed changes. */
function requestCloseSheet(){
 if(activeDialog&&sheetBaseline&&formSnapshot(overlay)!==sheetBaseline&&!$('.discard-bar',overlay)){
  $('.modal-body',overlay)?.insertAdjacentHTML('afterbegin',`<div class="discard-bar" role="alert"><span>変更がまだ保存されていません。</span>${btn('discard-close','破棄して閉じる','','text-button danger')}${btn('discard-cancel','編集に戻る','','text-button')}</div>`);
  $('.discard-bar button:last-child',overlay)?.focus();return;
 }
 closeSheet();
}
function openPanel(title,body,kind,id){
 const panel=$('#panel');if(!panel)return;
 if(!activePanel)panelReturnFocus=document.activeElement;
 activePanel={kind,id};
 panel.innerHTML=`<header class="panel-head"><h2 id="panel-title" tabindex="-1">${escape(title)}</h2>${toolbtn('close-panel','閉じる','close')}</header><div class="panel-body">${body}</div>`;
 panel.hidden=false;registerForms(panel);document.body.classList.add('panel-open');
 setTimeout(()=>$('#panel-title')?.focus(),0);
}
function closePanel(){
 if(!activePanel)return;if(activePanel.kind==='creative')capabilityUI?.onClose();
 const panel=$('#panel');panel.hidden=true;panel.replaceChildren();activePanel=null;document.body.classList.remove('panel-open');
 if(panelReturnFocus?.isConnected)panelReturnFocus.focus();
}
function openInbox(){openPanel('あなたの番',inboxHTML(inboxList(),{presence}),'inbox');}
function paintInbox(){const body=$('#panel .panel-body');if(!body||activePanel?.kind!=='inbox')return;const top=body.scrollTop;body.innerHTML=inboxHTML(inboxList(),{presence});body.scrollTop=top;}
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
function approvalBox(j){return approvalCards(j);}
function taskSheet(id){
 const j=state.jobs.find(x=>x.id===id);if(!j)return;const s=jobStatus(j);
 openSheet(j.title,`<p class="panel-status tone-${s.tone}" id="task-state"><span id="task-status">${escape(s.note||s.label)}</span><span id="task-note">${escape(jobReason(j))}</span></p>
 <div id="task-approval">${approvalBox(j)}</div>
 <div class="panel-actions" id="task-actions">${jobActions(j)}</div>
 <form id="steer-form" class="steer-form" data-id="${escape(j.id)}"><label class="visually-hidden" for="steer-input">この仕事への追加の指示</label><input id="steer-input" name="text" maxlength="32000" autocomplete="off" placeholder="この仕事に直接伝える"><button class="button small secondary" type="submit">伝える</button></form>
 <div id="task-todo-slot">${todoHTML(j)}</div>
 <section class="panel-section"><h3>報告</h3><div id="task-output" class="md">${j.output?renderMarkdown(j.output):'<p class="small-text">まだ報告はありません。</p>'}</div></section>
 <p id="task-route" class="small-text">${routeLine(j)}</p>
 <details class="panel-section" open><summary>作業の経過</summary><div id="task-timeline" class="timeline">${previewMode?'<p class="small-text">画面サンプルには経過がありません。</p>':'<p class="small-text">読み込んでいます…</p>'}</div></details>
 <details class="panel-section"><summary>作業フォルダ</summary><div id="task-files">${previewMode?'<p class="small-text">画面サンプルにはファイルがありません。</p>':'<p class="small-text">読み込んでいます…</p>'}</div></details>
 <div class="panel-more">${btn('open-work','仕事の画面で開く','arrow','text-button',`data-id="${escape(j.id)}"`)}${['review','completed','paused'].includes(j.status)?btn('task-delete','一覧から消す','trash','text-button danger',`data-id="${escape(j.id)}"`):''}</div>`,'task',id);
 if(!previewMode){loadTimeline(id);bridge.request(`/api/agent/sessions/${id}/files`).then(r=>{if(activePanel?.id!==id)return;$('#task-files').innerHTML=`<p class="small-text">${escape(r.root)}</p>`+(r.files.map(f=>`<a class="file-link" href="/api/agent/sessions/${encodeURIComponent(id)}/download?path=${encodeURIComponent(f.path)}" download>${escape(f.path)} <small>${f.bytes.toLocaleString()} bytes</small></a>`).join('')||'<p class="small-text">まだファイルはありません。</p>');}).catch(()=>{});}
}
const TOOL_WORDS={exec:'コマンド',process:'プロセス',read:'読む',write:'書く',edit:'編集',find:'探す',grep:'検索',web_search:'Web検索',web_fetch:'Webを読む',computer:'画面操作',todo:'やること',artifact:'成果物',recall:'思い出す',history_search:'経過を探す',memory_search:'記憶を探す',memory_write:'記憶する',sessions_spawn:'作業を頼む',sessions_send:'伝える',sessions_list:'一覧',sessions_history:'様子を見る',tools_search:'道具を探す',tools_call:'道具を使う'};
/** The work so far, newest at the bottom: what the agent said, which tools it used and what came back. */
function timelineHTML(entries){
 const rows=[];
 for(const e of entries){
  if(e.type==='input')rows.push(`<div class="tl tl-input"><small>${escape(e.kind==='task'?'依頼':e.kind==='report'?'報告を受け取りました':'指示')}</small><div class="md">${renderMarkdown(String(e.text||'').slice(0,4000),{headings:'text'})}</div></div>`);
  else if(e.type==='assistant'){
   if(String(e.content||'').trim())rows.push(`<div class="tl tl-say md">${renderMarkdown(String(e.content).slice(0,6000),{headings:'text'})}</div>`);
   for(const c of e.toolCalls||[])rows.push(`<div class="tl tl-call"><span class="tl-tool">${escape(TOOL_WORDS[c.name]||c.name)}</span><code>${escape(String(c.arguments||'').slice(0,240))}</code></div>`);
  }
  else if(e.type==='tool')rows.push(`<details class="tl tl-result${e.error?' is-error':''}"><summary>${escape(e.stub||e.name)}</summary><pre>${escape(String(e.content||'').slice(0,4000))}</pre></details>`);
  else if(e.type==='checkpoint')rows.push(`<details class="tl tl-checkpoint"><summary>文脈を整理しました（#${e.upTo}まで・${escape(e.method||'')}）</summary><div class="md">${renderMarkdown(String(e.summary||'').slice(0,8000))}</div></details>`);
  else if(e.type==='notice')rows.push(`<p class="tl tl-notice">${escape(String(e.text||'').replace(/^\[harness\]\s*/,'').slice(0,300))}</p>`);
  else if(e.type==='event'&&['waiting','escalated','overflow','crash','lean-tools'].includes(e.event))rows.push(`<p class="tl tl-event">${escape(e.note||e.message||e.reason||e.event)}</p>`);
 }
 return rows.join('')||'<p class="small-text">まだ経過はありません。</p>';
}
let timelineTimer=0;
async function loadTimeline(id){
 try{const r=await bridge.request(`/api/agent/sessions/${id}?limit=150`);if(activePanel?.id!==id)return;const host=$('#task-timeline');if(!host)return;
  const follow=host.scrollHeight-host.scrollTop-host.clientHeight<60;host.innerHTML=timelineHTML(r.entries);if(follow)host.scrollTop=host.scrollHeight;}
 catch(e){const host=$('#task-timeline');if(host)host.textContent=e.message;}
}
function jobActions(j,{compact=false}={}){
 const id=escape(j.id),out=[];
 if(j.status==='review')out.push(btn('accept','確認した','check','button',`data-id="${id}"`),btn('revise','直してほしいことを伝える','pencil','button secondary',`data-id="${id}"`));
 if(['paused','blocked'].includes(j.status))out.push(btn('resume',j.status==='blocked'?'いま再試行':'続きを再開','play','button',`data-id="${id}"`));
 if(['running','queued','waiting_approval','blocked'].includes(j.status))out.push(btn('pause','止める','pause','button secondary',`data-id="${id}"`));
 return out.join('');
}
function refreshTask(){
 if(activePanel?.kind!=='task')return;
 const j=state.jobs.find(x=>x.id===activePanel.id);if(!j)return;const s=jobStatus(j);
 const status=$('#task-status');if(!status)return;
 status.textContent=s.note||s.label;$('#task-state').className=`panel-status tone-${s.tone}`;$('#task-note').textContent=jobReason(j);
 $('#task-route').textContent=routeLine(j).replace(/&amp;/g,'&');
 $('#task-output').innerHTML=j.output?renderMarkdown(j.output):'<p class="small-text">まだ報告はありません。</p>';
 $('#task-todo-slot').innerHTML=todoHTML(j);$('#task-actions').innerHTML=jobActions(j);
 const box=$('#task-approval'),key=approvalsFor(j).map(a=>a.id).join(',');
 if(box.dataset.approval!==key){box.dataset.approval=key;box.innerHTML=approvalBox(j);}
 if(!previewMode){clearTimeout(timelineTimer);timelineTimer=setTimeout(()=>loadTimeline(j.id),700);}
}
function memorySheet(id){
 const m=state.memories.find(x=>x.id===id);
 openSheet(m?'記憶を編集':'覚えておいてほしいこと',`<form id="memory-form" data-id="${id||''}">${field('見出し','title',m?.title||'')}<label class="field"><span>内容</span><textarea name="content" rows="6" maxlength="32000" required>${escape(m?.content||'')}</textarea></label>${toggle('外部モデルにも共有できるようにする','shared',m?.scope==='shared','外部モデルの利用と記憶の共有を、どちらも許可したときだけ使われます。')}<div class="sheet-actions"><button type="submit" class="button">保存する</button></div></form>`,'memory');
}
function mcpSheet(){
 openSheet('MCPの道具を追加',`<form id="mcp-form">${field('接続名','name')}<label class="field"><span>接続方法</span><select name="transport"><option value="stdio">stdio</option><option value="http">HTTP</option></select></label>${field('コマンド（stdio）','command')}${field('引数のJSON配列（stdio）','args','[]')}${field('URL（HTTP）','url')}<p class="small-text">無効の状態で登録します。実際の接続と呼び出しは、そのときに確認します。</p><div class="sheet-actions"><button class="button" type="submit">登録する</button></div></form>`,'mcp');
}
function mediaSheet(){
 openSheet('YouTubeを流す',`<form id="media-form"><label class="field"><span>YouTube / YouTube MusicのURL</span><input type="url" name="url" required></label><div class="sheet-actions"><button class="button" type="submit">この画面で再生</button>${btn('media-external','Braveで開く','','button secondary')}</div></form><div id="media-player"></div><p class="small-text">アプリ内で広告の除去は行いません。埋め込めない動画は外部のブラウザで再生してください。</p>`,'media');
}
function youtubeId(value){
 const u=new URL(value);
 if(!['youtube.com','www.youtube.com','music.youtube.com','youtu.be'].includes(u.hostname)||u.protocol!=='https:')throw new Error('YouTubeのHTTPS URLを指定してください。');
 const id=u.hostname==='youtu.be'?u.pathname.slice(1):u.searchParams.get('v');
 if(!/^[\w-]{11}$/.test(id||''))throw new Error('動画のURLを指定してください。');
 return id;
}
function connectionDataSheet(){
 openSheet('天気とニュース',`<form id="data-form">${field('天気を見る場所（市区町村名）','weatherCity',settings().weatherCity,'例: 渋谷、Sapporo')}${field('ニュースのRSS URL','newsUrl',settings().newsUrl,'https://')}${toggle('ここで選んだ情報源への通信を許可','allowNetwork',settings().allowNetwork,'天気はOpen-Meteoから取得します。ニュースは指定したRSSだけを読みます。')}<div class="sheet-actions"><button class="button" type="submit">保存する</button></div></form>`,'data');
}
function approveAllSheet(){
 const list=(state.approvals||[]).filter(a=>a.status==='pending');if(!list.length)return;
 openSheet(`${list.length}件の操作をまとめて許可しますか？`,`<p>次の操作を、表示どおりの内容で許可します。内容を変えたものは許可されません。</p><ol class="approve-list">${list.map(a=>{const d=describeApproval(a);return `<li><strong>${escape(d.title)}</strong><small>${escape(a.jobTitle||'')}</small>${d.detail?`<code>${escape(d.detail)}</code>`:''}</li>`;}).join('')}</ol><div class="seal-box" data-sealable><div class="seal-actions">${sealHTML({action:'approve-all-confirm',ids:list.map(a=>a.id).join(','),hold:true,label:'これらをすべて許可する',hint:'長押しでまとめて許可'})}${btn('close','やめる','','button secondary')}</div><p class="seal-done">許可しました。許可した内容だけを、そのまま実行します。</p>${stampHTML()}</div>`,'approve-all');
}
function revealComposer(){
 if(narrow()){if(!['home','talk'].includes(view)){view='talk';render();}}
 else if(view!=='home'&&!talkOpen)setTalkOpen(true);
 setTimeout(()=>$('#composer-input')?.focus(),0);
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
 const anchor=draftContext.anchor(draft,{start:$('#composer-input').selectionStart,end:$('#composer-input').selectionEnd,id:crypto.randomUUID(),attachmentEpoch,sessionId:state.dialogue.session.id});voiceAnchor=anchor;
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
 const button=$('#mic-button');if(!button)return;button.classList.toggle('is-recording',on);button.setAttribute('aria-label',on?'音声入力を終了':'音声入力を開始');button.setAttribute('aria-pressed',String(on));
 if(on)musicUI?.pause();
 if(!on&&!pendingSpeech&&/^録音中/.test($('#voice-caption').textContent))$('#voice-caption').textContent='';
 paintChrome();paintMood();
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
  const autoSubmit=voiceSendEnabled&&!settings().dictationEditing&&anchor.content===''&&!attachedFiles.length&&anchor.attachmentEpoch===attachmentEpoch&&!composerLocked();
  draft.apply(patch);$('#composer-input').value=draft.content;showTarget();
  $('#voice-caption').textContent=(patch.summary||'下書きに反映しました。')+' まだ送信していません。';
  if(autoSubmit)await safe(submitDialogue)(false,false,{revision:draft.revision,epoch});
 }catch(e){
  if(epoch!==voiceEpoch||anchor.destination!==draftContext.destination)return;
  pendingSpeech={text,anchor,epoch};$('#voice-caption').innerHTML=`下書きを保持しました。${escape(e.message)} ${btn('append-speech','認識結果を末尾に追加','','text-button')}`;
 }
}
const actions={
 'providers-launch':()=>providerSettings().open(),'computer-launch':()=>providerSettings().computer(),
 attach:attachFiles,'detach-file':detachFile,
 'retry-request':()=>submitDialogue(false,true),
 'focus-task':el=>navigateFocus(el.dataset.id),'return-focus':()=>navigateFocus(null,{returning:true}),
 'open-work':async el=>{closePanel();await navigateFocus(el.dataset.id);},
 'voice-autosend':configureVoiceSend,'enable-voice-send-legacy':()=>{requireComposerUnlocked();if(!pendingVoiceConsent)return;if(draft.content||attachedFiles.length||draftContext.destination?.reply||pendingVoiceConsent.sessionId!==state.dialogue.session.id)throw new Error('下書きか会話が変わりました。条件を確認し直してください。');voiceSendConsent=pendingVoiceConsent;pendingVoiceConsent=null;voiceSendEnabled=true;closeSheet();showTarget();},
 personas:personaSheet,
 'work-tab':el=>{workTab=el.dataset.tab;render();},
 proposals:()=>{closePanel();view='workspace';workTab='tasks';render();},
 'skill-details':el=>{const skill=state.skills.find(s=>s.id===el.dataset.id);openSheet(skill.name,`<p>${escape(skill.source==='learned-proposal'?'仕事から提案された手順です。確認して有効化するまで使用しません。':skill.description)}</p><pre>${escape(skill.content||'共有スキルです。実行時に出所とハッシュを照合して読み込みます。')}</pre><p class="small-text">${escape(skill.sourceJobId?'元の仕事: '+skill.sourceJobId:'')}</p>`);},
 view:el=>{if(sharedView&&el.dataset.view!=='home'){notice('個人表示に戻してから開いてください。');return;}if(ambientMode)setAmbient(false);document.body.classList.remove('artifact-focus');view=el.dataset.view;closePanel();render();if(view==='talk')setTimeout(()=>$('#composer-input')?.focus(),0);else $('#surface')?.focus({preventScroll:true});},
 display:()=>{view='settings';render();setTimeout(()=>$('#settings-home')?.scrollIntoView({block:'start'}),0);},'runtime-settings':()=>providerSettings().open(),'voice-settings':voiceSheet,close:requestCloseSheet,'close-panel':closePanel,
 'discard-close':closeSheet,'discard-cancel':()=>{$('.discard-bar',overlay)?.remove();$('.modal-body input,.modal-body textarea',overlay)?.focus();},
 share:async()=>{capabilityUI?.stop();sharedView=!sharedView;if(sharedView){invalidatePendingSubmit();view='home';closeSheet();closePanel();cancelVoice();}dialogueRenderKey='';render();paintHome();},
 fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();},
 onboard:()=>state.providers?.profiles?.length?providerSettings().open():onboarding().open(),
 readiness:()=>{if(previewMode)return onboarding().open();const ready=!!(settings().model||state.providers?.profiles?.some(p=>p.enabled!==false&&p.model));ready?providerSettings().open():onboarding().open();},
 inbox:()=>{if(sharedView)return;activePanel?.kind==='inbox'?closePanel():openInbox();},
 'ambient-now':()=>setAmbient(true),'ambient-try':()=>setAmbient(true),wake:()=>{setAmbient(false);revealComposer();},
 'wallpaper-set':el=>patchDisplay({ambient:{...display().ambient,wallpaper:el.dataset.value}}),
 'frame-open':()=>frameSettings().open(),
 'frame-now':async()=>{
  if(!framePhotoList().length){if(activeDialog?.kind!=='frame')frameSettings().open();notice('写真を追加すると、写真立てを始められます。');return;}
  if(activeDialog)closeSheet();
  frameSession=true;wallpaperDirty=true;setAmbient(true);holdScreen(true);
  try{if(!document.fullscreenElement){await document.documentElement.requestFullscreen();enteredFullscreen=true;}}catch{/* the window stays as it is */}
 },
 'talk-open':()=>{if(narrow()){view='talk';render();setTimeout(()=>$('#composer-input')?.focus(),0);return;}setTalkOpen(true);},
 'talk-close':()=>setTalkOpen(false),
 'display-menu':el=>{const list=$('#display-menu-list');if(!list)return;if(!list.hidden){closeDisplayMenu();return;}list.hidden=false;el.setAttribute('aria-expanded','true');setTimeout(()=>list.querySelector('button')?.focus(),0);},
 'settings-jump':el=>{$(`#settings-${el.dataset.id}`)?.scrollIntoView({block:'start',behavior:reducedMotion?'auto':'smooth'});},
 demo:async()=>{requireComposerUnlocked();closeSheet();const job=await bridge.request('/api/jobs','POST',{input:'画面と途中更新を体験する',kind:'demo'});await navigateFocus(job.id);pendingArtifactJobId=job.id;view='workspace';followArtifact=true;pinnedArtifact=null;selectedArtifact=state.artifacts.find(a=>a.jobId===job.id)?.id||null;render();},
 'display-undo':async()=>{await bridge.request('/api/display/undo','POST',{expectedRevision:display().revision});},
 'display-reset':async()=>{await bridge.request('/api/display/reset','POST',{expectedRevision:display().revision});},
 'display-export':async()=>saveFile('tepora-display.json',JSON.stringify(await bridge.request('/api/display/export'),null,2)),
 'display-import':async()=>{const preset=await chooseJSON();if(!preset)return;await bridge.request('/api/display/import','POST',{preset,expectedRevision:display().revision});},
 'hide-news-today':async()=>{const until=new Date();until.setHours(24,0,0,0);await patchDisplay({hiddenUntil:{...display().hiddenUntil,news:until.toISOString()}});},
 'theme-set':el=>patchDisplay({theme:el.dataset.value}),'scale-set':el=>patchDisplay({textScale:Number(el.dataset.value)}),
 'avatar-open':()=>avatarStudio().open(),
 'widget-up':el=>moveWidget(el.dataset.widget,-1),'widget-down':el=>moveWidget(el.dataset.widget,1),
 'feeds-setup':connectionDataSheet,'weather-setup':connectionDataSheet,'news-setup':connectionDataSheet,
 'net-mode':async el=>{const value=await bridge.request('/api/network','PATCH',{expectedRevision:state.network.revision,patch:{mode:el.dataset.value}});state.network=value;render();},
 'music-choose':async()=>{await musicPlayer().choose();},'music-toggle':()=>musicPlayer().toggle(),'music-next':()=>musicPlayer().next(),'music-prev':()=>musicPlayer().prev(),
 'approve-all':approveAllSheet,
 'approve-all-confirm':async el=>{const ids=el.dataset.ids.split(',').filter(Boolean),r=await bridge.request('/api/agent/approvals','POST',{ids,allow:true});closeSheet();const failed=r.results.filter(x=>!x.ok).length;notice(failed?`${ids.length-failed}件を許可しました。${failed}件は内容が変わったため許可していません。`:`${ids.length}件を許可しました。続きを進めます。`);},
 'deny-all':async()=>{const ids=(state.approvals||[]).filter(a=>a.status==='pending').map(a=>a.id);if(!ids.length)return;await bridge.request('/api/agent/approvals','POST',{ids,allow:false});notice(`${ids.length}件を許可しませんでした。作業担当に伝えます。`);},
 revise:el=>{taskSheet(el.dataset.id);setTimeout(()=>$('#steer-input')?.focus(),0);},
 'task-delete':el=>openSheet('この仕事を一覧から消しますか？',`<p>経過の記録を消します。作業フォルダのファイルと成果物は残ります。</p><div class="sheet-actions">${btn('task-delete-confirm','消す','trash','button danger',`data-id="${escape(el.dataset.id)}"`)}${btn('close','やめる','','button secondary')}</div>`,'task-delete'),
 'task-delete-confirm':async el=>{await bridge.request(`/api/agent/sessions/${el.dataset.id}`,'DELETE');state.jobs=state.jobs.filter(j=>j.id!==el.dataset.id);closeSheet();closePanel();if(state.companion.focusJobId===el.dataset.id)acceptCompanion({...state.companion,revision:state.companion.revision+1,focusJobId:null});scheduleRender();},
 task:el=>taskSheet(el.dataset.id),
 pause:async el=>{await bridge.request(`/api/agent/sessions/${el.dataset.id}/stop`,'POST',{});notice('止めました。経過と成果物は残しています。');},
 resume:async el=>{await bridge.request(`/api/agent/sessions/${el.dataset.id}/resume`,'POST',{});notice('続きから再開します。');},
 cancel:async el=>{await bridge.request(`/api/agent/sessions/${el.dataset.id}/stop`,'POST',{});notice('止めました。できていた成果物は残しています。');},
 accept:async el=>{await bridge.request(`/api/agent/sessions/${el.dataset.id}/accept`,'POST',{});notice('確認済みにしました。');},
 approve:async el=>{await bridge.request(`/api/agent/approvals/${el.dataset.id}`,'POST',{allow:true});notice('許可しました。続きを進めます。');},
 deny:async el=>{await bridge.request(`/api/agent/approvals/${el.dataset.id}`,'POST',{allow:false});notice('許可しませんでした。作業担当に伝えます。');},
 'artifact-select':el=>{if(!focusedArtifacts().some(a=>a.id===el.dataset.id))return;selectedArtifact=el.dataset.id;pinnedArtifact=null;followArtifact=false;render();},
 'artifact-follow':()=>{followArtifact=!followArtifact;if(followArtifact)pinnedArtifact=structuredClone(focusedArtifacts().find(a=>a.id===selectedArtifact));render();},
 'artifact-expand':()=>{document.body.classList.toggle('artifact-focus');const on=document.body.classList.contains('artifact-focus'),b=$('[data-action=artifact-expand]');if(b){b.setAttribute('aria-label',on?'元の大きさに戻す':'大きく表示');b.title=b.getAttribute('aria-label');}},
 'artifact-versions':async el=>{const a=focusedArtifacts().find(x=>x.id===el.dataset.id);if(!a)return;let versions=[{version:a.version,updatedAt:a.updatedAt}];if(!previewMode){try{versions=(await bridge.request(`/api/artifacts/${encodeURIComponent(a.id)}/revisions`)).versions;}catch{/* current version only */}}
  openSheet('成果物の版',`<p>${escape(a.title)}</p><ol class="version-list">${versions.map(v=>`<li><span>版 ${v.version}${v.version===a.version?'（最新）':''}<small>${escape(v.updatedAt?ago(v.updatedAt):'')}</small></span>${btn('artifact-version-open',v.version===pinnedArtifact?.version?'表示中':'この版を見る','','text-button',`data-id="${escape(a.id)}" data-version="${v.version}" ${v.version===pinnedArtifact?.version?'disabled':''}`)}</li>`).join('')}</ol>`,'versions');},
 'artifact-version-open':async el=>{const latest=focusedArtifacts().find(x=>x.id===el.dataset.id),version=Number(el.dataset.version);if(!latest)return;
  const doc=version===latest.version?latest:await bridge.request(`/api/artifacts/${encodeURIComponent(latest.id)}/revisions/${version}`);
  pinnedArtifact={...latest,...doc,id:latest.id,jobId:latest.jobId};followArtifact=version===latest.version;closeSheet();render();},
 'artifact-save':()=>{if(!pinnedArtifact)return;const a=pinnedArtifact;saveFile(`${a.title.replace(/[\\/:*?"<>|]/g,'_')}.${a.kind==='html'?'html':a.kind==='markdown'?'md':'txt'}`,a.content,'text/plain;charset=utf-8');},
 'artifact-edit':()=>{if(!pinnedArtifact)return;const a=pinnedArtifact;followArtifact=false;openSheet('成果物を直接編集',`<form id="artifact-form" data-id="${escape(a.id)}" data-version="${a.version}"><label class="field"><span>内容（版 ${a.version} をもとに保存します）</span><textarea name="content" rows="18" maxlength="200000" required>${escape(a.content)}</textarea></label><p class="small-text">保存すると新しい版になります。ほかの変更が先に入っていた場合は上書きしません。</p><div class="sheet-actions"><button class="button" type="submit">新しい版として保存</button></div></form>`,'artifact-edit',a.id);},
 'memory-add':()=>memorySheet(), 'memory-edit':el=>memorySheet(el.dataset.id),
 'memory-confirm':el=>bridge.request(`/api/memories/${el.dataset.id}`,'PATCH',{confirmed:true}),
 'memory-delete':el=>openSheet('この記憶を削除しますか？',`<p>記憶と、その記憶の履歴を削除します。ほかの会話に自分で書いた文章や、書き出したバックアップは消えません。</p><div class="sheet-actions">${btn('memory-delete-confirm','削除する','trash','button danger',`data-id="${escape(el.dataset.id)}"`)}${btn('close','やめる','','button secondary')}</div>`,'memory-delete'),
 'memory-delete-confirm':async el=>{await bridge.request(`/api/memories/${el.dataset.id}`,'DELETE');closeSheet();},
 'context-export':async()=>saveFile('tepora-context.json',JSON.stringify(await bridge.request('/api/context/export'),null,2)),
 'context-import':async()=>{const data=await chooseJSON();if(data){const result=await bridge.request('/api/context/import','POST',data);notice(result.note||'読み込みました。');}},
 'shared-scan':async()=>{const r=await bridge.request('/api/shared/scan','POST',{consent:true});state.skills=r.skills;render();notice(`${r.skills.filter(s=>s.source==='shared').length}件を見つけました。使うかどうかは別に選べます。`);},
 'skill-toggle':async el=>{const s=state.skills.find(x=>x.id===el.dataset.id);await bridge.request(`/api/skills/${s.id}`,'PATCH',{enabled:s.enabled===false});},
 'mcp-add':mcpSheet,'mcp-toggle':el=>{const m=state.mcp.find(x=>x.id===el.dataset.id);return bridge.request(`/api/mcp/${m.id}`,'PATCH',{enabled:!m.enabled});},
 weather:async()=>{if(!settings().weatherCity||!settings().allowNetwork){connectionDataSheet();return;}await loadFeeds(true);},
 news:async()=>{if(!settings().newsUrl||!settings().allowNetwork){connectionDataSheet();return;}await loadFeeds(true);},
 media:mediaSheet,'media-external':async()=>bridge.request('/api/media/open','POST',{url:$('[name=url]',overlay).value}),
 mic:recordToggle,'append-speech':()=>{requireComposerUnlocked();if(!pendingSpeech||pendingSpeech.epoch!==voiceEpoch||pendingSpeech.anchor.destination!==draftContext.destination)return;draft.manual(draft.content+pendingSpeech.text);$('#composer-input').value=draft.content;pendingSpeech='';$('#voice-caption').textContent='下書きに追加しました。まだ送信していません。';},
 'undo-draft':()=>{requireComposerUnlocked();cancelVoice();pinDraft();draft.undo();$('#composer-input').value=draft.content;showTarget();},
 'hide-reply':()=>{replyHidden=true;showReply();},
 stop:async()=>{invalidatePendingSubmit();capabilityUI?.stop();cancelVoice();musicUI?.pause();await bridge.request('/api/stop','POST',{});notice('動いていた仕事をすべて止めました。成果物は残しています。');},
 'sandbox-set':async el=>{const value=await bridge.request('/api/agent/settings','PATCH',{sandbox:{...state.agent.settings.sandbox,mode:el.dataset.value}});state.agent={...state.agent,settings:value};render();notice(el.dataset.value==='off'?'サンドボックスをオフにしました。コマンドはこのPCで直接動きます。':'次のコマンドからサンドボックスで実行します。');},
 'search-setup':searchSheet,'heartbeat-setup':heartbeatSheet,'budget-setup':budgetSheet,
 'plugins-reload':async()=>{const r=await bridge.request('/api/agent/plugins/reload','POST',{});notice(`プラグインを${r.loaded}件読み込みました。${r.errors?.length?r.errors.length+'件は読み込めませんでした。':''}`);},
};
function frameSettings(){
 return frameUI||=createFrameSettings({bridge,openSheet,notice,previewMode,isOpen:()=>activeDialog?.kind==='frame'&&!sharedView,
  stored:frameStored,created:()=>imageAssets(),ambient:()=>display().ambient,
  setAmbient:patch=>patchDisplay({ambient:{...display().ambient,...patch}}),
  onPhotos:value=>{if(value)state.frame=value;wallpaperDirty=true;paintBackdrop();if(view==='settings'&&!activeDialog)scheduleRender();}});
}
/** Display preferences save immediately; the service keeps history for undo. */
async function patchDisplay(patch){const value=await bridge.request('/api/display','PATCH',{expectedRevision:display().revision,patch});state.display=value;applyAvatarTheme();await mountCharacters();render();return value;}
function moveWidget(widget,step){const prefs=display(),order=[...prefs.widgets,...WIDGETS.filter(w=>!prefs.widgets.includes(w))],i=order.indexOf(widget),j=i+step;if(i<0||j<0||j>=order.length)return;[order[i],order[j]]=[order[j],order[i]];return patchDisplay({widgets:order.filter(w=>prefs.widgets.includes(w))});}
document.addEventListener('click',e=>{
 if(!e.target.closest?.('#display-menu'))closeDisplayMenu();
 const el=e.target.closest('[data-action]');if(!el)return;
 if(el.closest('#display-menu-list'))closeDisplayMenu();
 if(el.dataset.action==='backdrop'){if(e.target===el)requestCloseSheet();return;}
 if(['allow-network','night-set','widget-toggle'].includes(el.dataset.action))return;
 const action=actions[el.dataset.action];if(!action)return;
 if(el.tagName==='A')e.preventDefault();
 (el.dataset.action==='retry-request'?quiet:safe)(action)(el);
});
document.addEventListener('change',e=>{
 const el=e.target,action=el.dataset?.action;if(!action||!state)return;
 const run=fn=>safe(fn)();
 if(action==='allow-network')run(async()=>{await bridge.request('/api/settings','PATCH',{allowNetwork:el.checked});if(el.checked)loadFeeds(true);});
 if(action==='night-set')run(()=>patchDisplay({ambient:{...display().ambient,nightDim:el.checked}}));
 if(action==='idle-set')run(()=>patchDisplay({ambient:{...display().ambient,idleMinutes:Number(el.value)}}));
 if(action==='awake-set')run(()=>patchDisplay({ambient:{...display().ambient,keepAwake:el.checked}}));
 if(action==='rotate-set')run(()=>patchDisplay({ambient:{...display().ambient,rotateSeconds:Number(el.value)}}));
 if(action==='voice-tone'){const pack=VOICE_TONES[el.value];if(pack)for(const input of el.form?.querySelectorAll('input[name^="line:"]')||[])input.placeholder=pack.lines[input.name.slice(5)]||'（何も言わない）';}
 if(action==='widget-toggle'){const prefs=display(),order=[...prefs.widgets,...WIDGETS.filter(w=>!prefs.widgets.includes(w))];run(()=>patchDisplay({widgets:order.filter(w=>w===el.value?el.checked:prefs.widgets.includes(w))}));}
});
document.addEventListener('input',e=>{if(e.target.id==='composer-input'){if(e.target.value)pinDraft();draft.manual(e.target.value);if(!e.target.value&&!attachedFiles.length&&!pendingRequest&&!voice)clearDraftDestination();showTarget();paintMood();}});
document.addEventListener('submit',e=>{
 e.preventDefault();if(!isTrustedForm(e.target))return;safe(async()=>{
  const form=e.target,fd=new FormData(form),data=Object.fromEntries(fd.entries());
  if(form.id==='composer-form'){
   await quiet(submitDialogue)();
  }else if(form.id==='steer-form'){
   const id=form.dataset.id,j=state.jobs.find(x=>x.id===id),input=$('#steer-input',form);if(!input.value.trim())return;
   await bridge.request(`/api/agent/sessions/${id}/message`,'POST',{text:input.value.trim(),mode:j&&['running','queued'].includes(j.status)?'steer':'followup'});input.value='';notice('この仕事に伝えました。');
  }else if(form.id==='search-form'){
   const value=await bridge.request('/api/agent/settings','PATCH',{webSearch:{...agentSettings().webSearch,provider:data.provider,searxngUrl:data.searxngUrl.trim()}});
   if(data.braveKey)await bridge.request('/api/agent/search-key','PUT',{provider:'brave',key:data.braveKey});
   state.agent={...state.agent,settings:value};closeSheet();render();
  }else if(form.id==='budget-form'){
   const value=await bridge.request('/api/agent/settings','PATCH',{budget:{dailyUsd:Math.max(0,Number(data.dailyUsd)||0),sessionUsd:Math.max(0,Number(data.sessionUsd)||0)},verifyCompletion:data.verifyCompletion,cacheRetention:{...agentSettings().cacheRetention,main:data.mainCache}});
   state.agent={...state.agent,settings:value};closeSheet();render();notice('費用と仕上げの設定を保存しました。');
  }else if(form.id==='heartbeat-form'){
   const value=await bridge.request('/api/agent/settings','PATCH',{heartbeat:{enabled:fd.has('enabled'),minutes:Math.max(5,Number(data.minutes)||30),text:data.text||''}});
   state.agent={...state.agent,settings:value};closeSheet();render();
  }else if(form.id==='personas-form'){
   const lines={};for(const scene of VOICE_SCENES){const value=String(data[`line:${scene.key}`]||'').trim();if(value)lines[scene.key]=value;}
   const personas=await bridge.request('/api/dialogue/personas','PUT',{expectedRevision:Number(form.dataset.revision),character:{name:data.characterName,instructions:data.characterInstructions,voice:{tone:data.voiceTone,callName:data.voiceCallName||'',proactive:data.voiceProactive,lines}},worker:{name:data.workerName,instructions:data.workerInstructions}});
   state.dialogue={...state.dialogue,personas,session:{...state.dialogue.session,revision:personas.revision,character:personas.character}};acceptDialogue(await bridge.request('/api/agent/dialogue'));closeSheet();characterKey='';mountCharacters();paintHome();notice('人格と口調、作業担当を、それぞれ保存しました。');
  }else if(['voice-form','data-form'].includes(form.id)){
   for(const el of form.querySelectorAll('input[type=checkbox]'))data[el.name]=el.checked;
   for(const el of form.querySelectorAll('input[type=number]'))data[el.name]=Number(el.value);
   await bridge.request('/api/settings','PATCH',data);
   closeSheet();if(form.id==='data-form')loadFeeds(true);
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
// Composition input: Safari/WebKit delivers the committing Enter or Escape after compositionend
// with keyCode 229, so isComposing alone is not enough on the macOS app.
const composing=e=>e.isComposing||e.keyCode===229;
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'&&!composing(e)){
  if($('#display-menu-list')&&!$('#display-menu-list').hidden){closeDisplayMenu(true);return;}
  if(activeDialog){requestCloseSheet();return;}
  if(activePanel){closePanel();return;}
  if(document.body.classList.contains('artifact-focus')){actions['artifact-expand']();return;}
  return;
 }
 if(e.target.id==='composer-input'&&e.key==='Enter'&&!e.shiftKey&&!composing(e)){e.preventDefault();$('#composer-form').requestSubmit();}
 if(e.key==='Tab'&&activeDialog){
  const nodes=[...overlay.querySelectorAll('button,input,textarea,select,a[href],summary,[tabindex]:not([tabindex="-1"])')].filter(n=>!n.disabled&&n.getClientRects().length);
  const first=nodes[0],last=nodes.at(-1);
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
 }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){invalidatePendingSubmit();cancelVoice();}});
document.addEventListener('visibilitychange',()=>{
 clearTimeout(hiddenTimer);
 if(document.hidden)hiddenTimer=setTimeout(()=>{awaySince=Date.now()-60000;setPresence('away');},60000);
 else if(!ambientMode){if(presence==='away'){startRecap();if(view==='home')paintSpeech();}setPresence('present');}
 else if(display().ambient.keepAwake||frameSession)holdScreen(true);
});
document.addEventListener('focusin',e=>{if(e.target.id==='composer-input')paintMood();});document.addEventListener('focusout',e=>{if(e.target.id==='composer-input')paintMood();});
wideScreen?.addEventListener?.('change',()=>{if(state)render();});
window.addEventListener('tepora-stop',()=>safe(actions.stop)());
window.addEventListener('tepora-hide',()=>{invalidatePendingSubmit();capabilityUI?.stop();cancelVoice();});
window.addEventListener('pagehide',()=>{invalidatePendingSubmit();cancelVoice();bridge.close();});
function upsert(list,data){const i=state[list].findIndex(x=>x.id===data.id);if(i<0)state[list].unshift(data);else state[list][i]=data;}
bridge.on(e=>{
 if(!state)return;
 if(e.type==='route.selected'&&e.data.reason!=='selected'){const key=e.data.jobId+':'+e.data.profileId;if(!noticedRoutes.has(key)){noticedRoutes.add(key);if(noticedRoutes.size>100)noticedRoutes.delete(noticedRoutes.values().next().value);notice(`実行先: ${e.data.profileId} (${e.data.domain}) の経路で処理を続けます。`);}return;}
 if(e.type==='providers.updated'){state.providers=e.data;paintChrome();return;}
 if(e.type==='computer.updated'){state.computer=e.data;return;}
 if(e.type==='network.updated'){state.network=e.data;paintChrome();if(e.data.mode!=='online'||!e.data.internetTools){if(activeDialog?.kind==='media')closeSheet();document.querySelectorAll('#media-player iframe').forEach(x=>x.remove());}if(view==='settings')scheduleRender();return;}
 if(e.type==='dialogue.updated'){acceptDialogue(e.data);paintChrome();if(view==='home')paintSpeech();if(activePanel?.kind==='inbox')paintInbox();return;}
 if(e.type==='dialogue.message'){state.dialogue.messages=mergeDialogueMessages(state.dialogue.messages,[e.data]);if(e.data.role==='assistant')liveReply='';showDialogue();showTarget();showRequestStatus();if(view==='home')paintSpeech();return;}
 if(e.type==='dialogue.delta'){liveReply=e.data.done?'':e.data.text||'';paintLive();showRequestStatus();return;}
 if(e.type==='session.updated'&&e.data.kind==='main'){state.dialogue={...state.dialogue,status:e.data.status,note:e.data.note||''};if(e.data.status!=='running')liveReply='';paintLive();showRequestStatus();paintMood();return;}
 if(e.type==='session.removed'){state.jobs=state.jobs.filter(j=>j.id!==e.data.id);scheduleRender();return;}
 if(e.type==='personas.updated'){state.dialogue={...state.dialogue,personas:e.data,session:{...state.dialogue.session,revision:e.data.revision,character:e.data.character}};characterKey='';mountCharacters();showDialogue();return;}
 if(e.type==='agent.settings'){state.agent={...state.agent,settings:e.data};if(view==='settings'&&!activeDialog)scheduleRender();return;}
 if(e.type==='approval.updated'&&!previewMode)return;
 if(e.type==='companion.updated'){acceptCompanion(e.data);return;}
 if(e.type==='snapshot'){const prior=state.companion,dialogue=state.dialogue;state={...state,...e.data,companion:prior,dialogue};liveReply='';if(e.data.dialogue)acceptDialogue(e.data.dialogue);acceptCompanion(e.data.companion||prior);const latest=focusedArtifacts().find(a=>a.id===selectedArtifact);if(!latest){pinnedArtifact=null;selectedArtifact=null;}else if(followArtifact)pinnedArtifact=structuredClone(latest);scheduleRender();return;}
 if(e.type==='transport.status'){online=e.data.online;showRequestStatus();paintChrome();if(!online)notice('接続を復旧しています。仕事の状態はサービスに保存されています。');return;}
 if(e.type==='setup.updated'){state.setup=e.data;paintChrome();return;}
 if(e.type==='routine.updated'){upsert('routines',e.data);scheduleRender();return;}
 if(e.type==='plan.updated'){upsert('plans',e.data);scheduleRender();return;}
 if(e.type==='display.updated'){const interval=display().ambient.rotateSeconds;state.display=e.data;wallpaperDirty=true;if(deck&&display().ambient.rotateSeconds!==interval){deck.stop();deck=null;deckHost.replaceChildren();renderedView='';}idleWatcher?.set(display().ambient.idleMinutes*60000);mountCharacters();scheduleRender();return;}
 if(e.type==='frame.updated'){state.frame=e.data;wallpaperDirty=true;paintBackdrop();frameUI?.refresh();if(view==='settings'&&!activeDialog)scheduleRender();return;}
 if(e.type==='avatar.updated'){state.avatar=e.data;mountCharacters();avatarStudioUI?.refresh();if(view==='settings'&&!activeDialog)scheduleRender();return;}
 if(e.type==='avatar.assets'){state.avatarAssets=e.data;mountCharacters();avatarStudioUI?.refresh();if(view==='settings'&&!activeDialog)scheduleRender();return;}
 if(e.type==='approval.updated'||e.type==='approval.view'){state.approvals||=[];const i=state.approvals.findIndex(a=>a.id===e.data.id);if(i<0)state.approvals.unshift(e.data);else state.approvals[i]=e.data;paintChrome();refreshTask();if(activePanel?.kind==='inbox')paintInbox();if(view==='home')paintStageNotes();else if(view==='workspace')scheduleRender();paintMood();return;}
 if(e.type==='settings.updated'){if(!e.data.voiceEnabled||e.data.dictationEditing||e.data.asrUrl!==state.settings.asrUrl||e.data.asrStreamUrl!==state.settings.asrStreamUrl){voiceSendEnabled=false;voiceSendConsent=null;cancelVoice();}state.settings=e.data;state.setup={...state.setup,verified:false};scheduleRender();return;}
 if(e.type==='job.updated'){const before=state.jobs.find(j=>j.id===e.data.id)?.status;upsert('jobs',e.data);if(before&&before!==e.data.status&&['review','completed'].includes(e.data.status)&&e.data.kind!=='chat')celebrateUntil=Date.now()+2600;paintLights();showDialogue();showTarget();showRequestStatus();refreshTask();if(activePanel?.kind==='inbox')paintInbox();scheduleRender();return;}
 if(e.type==='job.output'){const j=state.jobs.find(x=>x.id===e.data.id);if(j&&previewMode)j.output=e.data.output;return;}
 if(e.type==='artifact.updated'){
  upsert('artifacts',e.data);
  if(e.data.jobId!==state.companion.focusJobId){scheduleRender();return;}
  if(e.data.jobId===pendingArtifactJobId){selectedArtifact=e.data.id;pinnedArtifact=null;pendingArtifactJobId=null;}
  if(!selectedArtifact)selectedArtifact=e.data.id;
  if(e.data.id===selectedArtifact&&followArtifact)pinnedArtifact=structuredClone(e.data);
  scheduleRender();return;
 }
 if(e.type==='message.created'){state.messages.push(e.data);return;}
 for(const [prefix,list] of [['memory','memories'],['skill','skills'],['mcp','mcp']]){
  if(e.type===`${prefix}.updated`){upsert(list,e.data);scheduleRender();}
  if(e.type===`${prefix}.deleted`){state[list]=state[list].filter(x=>x.id!==e.data.id);scheduleRender();}
 }
});
try{
 state=await bridge.init();state.companion={revision:0,focusJobId:null,returnStack:[]};state.dialogue||=await bridge.request('/api/agent/dialogue');
 state.display||=structuredClone(DISPLAY_DEFAULT);state.jobs||=[];state.artifacts||=[];state.routines=[];state.plans=[];state.approvals||=[];state.mediaJobs||=[];state.frame||={photos:[],limits:{}};
 globalThis.__TEPORA_LIVE__=!previewMode;lastSeenMessage=state.dialogue?.messages?.at(-1)?.id||'';
 shell();setInterval(()=>{tick();paintMood();},1000);
 document.documentElement.style.setProperty('--seal-hold',`${SEAL_HOLD_MS}ms`);
 bindSeals({onCommit:el=>safe(actions[el.dataset.seal])(el),onArm:()=>notice('もう一度押すと許可します（4秒以内）。')});
 idleWatcher=createIdleWatcher({ms:display().ambient.idleMinutes*60000,onIdle:()=>{if(canIdle())setAmbient(true);else idleWatcher.wake();}});
 for(const type of ['pointerdown','keydown','wheel','touchstart'])window.addEventListener(type,e=>{if(ambientMode&&Date.now()-ambientSince>1200&&!e.target.closest?.('.deck,[data-action=ambient-now]'))setAmbient(false,{restore:true});},{capture:true,passive:true});
 // Like a screensaver, a deliberate sweep of the pointer also ends it; a nudge or a vibrating desk does not.
 window.addEventListener('pointermove',e=>{
  if(!ambientMode||Date.now()-ambientSince<1200)return;
  const t=performance.now();
  if(!moveFrom||t-moveFrom.t>800)moveFrom={x:e.clientX,y:e.clientY,t};
  else if(Math.hypot(e.clientX-moveFrom.x,e.clientY-moveFrom.y)>=96){moveFrom=null;setAmbient(false,{restore:true});}
 },{passive:true});
 loadFeeds();feedTimers=[setInterval(()=>loadFeeds(),5*60e3)];
 if(!previewMode)bridge.request('/api/presence','POST',{state:document.hidden?'away':'present'}).catch(()=>{});
 if(!previewMode&&!state.setup?.dismissed&&!state.providers?.profiles?.length)setTimeout(()=>onboarding().open(),100);
}
catch(e){app.innerHTML=`<div class="fatal"><h1>Tepora</h1><p>${escape(e.message)}</p><p>起動したときのURLから開き直してください。未接続のまま成功とは表示しません。</p></div>`;}

function showInputFiles(){
 const el=$('#input-files');if(!el)return;
 el.innerHTML=attachedFiles.map(f=>`<span><span>${escape(f.name)}</span><button type="button" data-action="detach-file" data-id="${escape(f.id)}" ${composerLocked()?'disabled':''} aria-label="${escape(f.name)}を下書きから外す">${icon('close')}</button></span>`).join('');
}
async function attachFiles(){
 if(sharedView)throw new Error('個人表示に戻してからファイルを選んでください。');
 requireComposerUnlocked();if(draftContext.destination?.reply)throw new Error('作業担当の質問への回答に新しい添付は送れません。会話に添えて送信してください。');const epoch=++attachmentEpoch,scope=draftContext.epoch;
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
 if(sharedView){el.hidden=true;return;}el.hidden=false;el.className='request-status';
 if(sending){el.textContent='メッセージを受け付けています…';return;}
 if(pendingRequest?.uncertain){el.classList.add('is-error');el.innerHTML=`<span>応答を確認できませんでした。送った内容と添付はそのまま残しています。</span>${btn('retry-request','同じ内容で確認する','','text-button')}`;return;}
 if(lastSubmitError){el.classList.add('is-error');el.textContent=lastSubmitError;return;}
 const d=state.dialogue||{};
 if(d.status==='running'){el.textContent=liveReply?'':'考えています…';return;}
 if(d.status==='waiting'&&d.note){el.classList.add('is-error');el.textContent=d.note;return;}
 el.textContent='';
}
function requestId(){return globalThis.crypto?.randomUUID?.()||`request-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
/** One entry point to the resident character. Retrying an uncertain send reuses its request id, so it is never doubled. */
async function submitDialogue(consent=false,retry=false,automatic=null){
 if(sending)return;
 if(automatic&&(!voiceSendEnabled||automatic.epoch!==voiceEpoch||automatic.revision!==draft.revision||attachedFiles.length||settings().dictationEditing))return;
 cancelVoice();
 if(sharedView)throw new Error('個人表示に戻してから送信してください。');
 sending=true;lastSubmitError='';showRequestStatus();showTarget();showInputFiles();
 let request=pendingRequest?.uncertain?pendingRequest:null,dispatching=false;
 try{
  if(!request){
   const input=$('#composer-input').value.trim();if(!input)return;
   if(previewMode)throw new Error('これは画面プレビューです。AIとの会話と仕事には実サービスを使ってください。');
   if(!state.providers?.profiles?.some(p=>p.enabled!==false&&p.model)){await onboarding().open();return;}
   request={draftRevision:draft.revision,body:{requestId:requestId(),text:input,source:automatic?'voice':'text',attachmentIds:attachedFiles.map(f=>f.id)}};
   pendingRequest=request;
  }
  dispatching=true;request.dispatched=true;
  await bridge.request('/api/agent/input','POST',request.body);
  if(draft.revision===request.draftRevision){draft.manual('');$('#composer-input').value='';clearDraftDestination();}
  attachedFiles=attachedFiles.filter(f=>!request.body.attachmentIds.includes(f.id));pendingRequest=null;
  state.dialogue={...state.dialogue,status:'running'};scheduleRender();
 }catch(e){lastSubmitError=e.message;if(request){request.uncertain=dispatching&&(!e.status||e.status>=500);if(!request.uncertain&&pendingRequest===request)pendingRequest=null;}throw e;}
 finally{sending=false;showRequestStatus();showInputFiles();showTarget();}
}
