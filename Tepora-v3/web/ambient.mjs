import {icon,escape} from './ui.mjs';
import {needsPerson} from './status.mjs';
import {voiceAddress,voiceLine} from './voice-lines.mjs';
import {SEASONS,seasonOf} from './seasons.mjs';
/** The home stage as a smart monitor: clock, a rotating deck of small modules (weather, news,
 * music, work, things you made) and an idle mode that dims, drifts and lets work continue.
 * Builders return HTML from already-loaded data; nothing here fetches or decides permissions.
 */

/** WMO weather interpretation codes used by Open-Meteo. */
export function weatherLabel(code){
 const c=Number(code);
 if(c===0)return {label:'晴れ',glyph:'sun'};if(c===1)return {label:'おおむね晴れ',glyph:'sun'};if(c===2)return {label:'晴れ時々くもり',glyph:'partly'};if(c===3)return {label:'くもり',glyph:'cloud'};
 if([45,48].includes(c))return {label:'霧',glyph:'fog'};if(c>=51&&c<=57)return {label:'霧雨',glyph:'rain'};if(c>=61&&c<=67)return {label:c>=65?'強い雨':'雨',glyph:'rain'};
 if(c>=71&&c<=77)return {label:'雪',glyph:'snow'};if(c>=80&&c<=82)return {label:'にわか雨',glyph:'rain'};if(c>=85&&c<=86)return {label:'にわか雪',glyph:'snow'};
 if(c>=95)return {label:'雷雨',glyph:'storm'};return {label:'—',glyph:'cloud'};
}
export function weatherGlyph(kind){
 const sun='<g class="wg-sun"><circle cx="24" cy="24" r="8"/><g class="wg-rays">'+[0,45,90,135,180,225,270,315].map(a=>`<line x1="24" y1="7" x2="24" y2="11" transform="rotate(${a} 24 24)"/>`).join('')+'</g></g>';
 const cloud='<path class="wg-cloud" d="M15 34h19a7 7 0 0 0 0-14 10 10 0 0 0-19-2 8 8 0 0 0 0 16z"/>';
 const drops='<g class="wg-drops"><line x1="18" y1="38" x2="16" y2="43"/><line x1="25" y1="38" x2="23" y2="43"/><line x1="32" y1="38" x2="30" y2="43"/></g>';
 const flakes='<g class="wg-flakes"><circle cx="18" cy="40" r="1.4"/><circle cx="25" cy="43" r="1.4"/><circle cx="32" cy="40" r="1.4"/></g>';
 const body={sun,partly:`<g transform="translate(-6 -6) scale(.8)">${sun}</g>${cloud}`,cloud,fog:`${cloud}<g class="wg-fog"><line x1="12" y1="39" x2="36" y2="39"/><line x1="16" y1="43" x2="32" y2="43"/></g>`,rain:cloud+drops,snow:cloud+flakes,storm:`${cloud}<path class="wg-bolt" d="M25 35l-4 6h4l-2 6 6-8h-4l2-4z"/>`}[kind]||cloud;
 return `<svg class="wg wg-${escape(kind)}" viewBox="0 0 48 48" aria-hidden="true">${body}</svg>`;
}

/** A short, human greeting tied to the hour and (if known) the real weather, in the persona's voice. */
export function greeting(now=new Date(),weather=null,name='Tepora',voice=undefined){
 const h=now.getHours(),w=weather?.current?weatherLabel(weather.current.weather_code):null,t=weather?.current?Math.round(weather.current.temperature_2m):null;
 const part=h<5?'night':h<10?'morning':h<17?'day':h<22?'evening':'night';
 const opening=voiceLine(voice,`opening.${part}`);
 let note='';
 if(w&&t!==null){
  if(w.glyph==='rain'||w.glyph==='storm')note=voiceLine(voice,'weather.rain',{label:w.label});
  else if(w.glyph==='snow')note=voiceLine(voice,'weather.snow');
  else if(t>=30)note=voiceLine(voice,'weather.hot',{t});
  else if(t<=5)note=voiceLine(voice,'weather.cold',{t});
 }
 note||=voiceLine(voice,`note.${part}`);
 const chat=voice?.proactive==='chatty'?voiceLine(voice,'season',{kou:seasonOf(now).kou}):'';
 return {part,text:`${voiceAddress(voice)}${opening}${note}${chat}`,name};
}
export const isNight=(now=new Date(),weather=null)=>{
 const sunset=weather?.daily?.sunset?.[0],sunrise=weather?.daily?.sunrise?.[0];
 if(sunset&&sunrise){const t=now.getTime(),set=Date.parse(sunset)+2*3600e3,rise=Date.parse(sunrise);if(!Number.isNaN(set)&&!Number.isNaN(rise))return t>=set||t<rise;}
 const h=now.getHours();return h>=22||h<6;
};

/** The first hour in the next six with a real chance of rain: {time, rain} or null. */
function rainSoon(weather,now=Date.now()){
 const times=weather?.hourly?.time||[],rain=weather?.hourly?.precipitation_probability||[];
 const start=times.findIndex(t=>Date.parse(t)>=now-3600e3);if(start<0)return null;
 for(let i=start;i<Math.min(times.length,start+7);i++)if((rain[i]??0)>=40)return {time:new Date(times[i]).getHours(),rain:rain[i]};
 return null;
}
/** One quiet line under the date: {temp, label, hint}. Null without weather. */
export function weatherLine(weather,now=Date.now()){
 if(!weather?.current)return null;
 const sky=weatherLabel(weather.current.weather_code),soon=rainSoon(weather,now);
 return {temp:Math.round(weather.current.temperature_2m),label:sky.label,hint:soon?`${soon.time}時ごろ 雨 ${soon.rain}%`:''};
}
/** The weather changes what you would do: rain or snow now or soon, or a hot or cold day. */
export function weatherNotable(weather,now=Date.now()){
 if(!weather?.current)return false;
 const code=Number(weather.current.weather_code),temp=weather.current.temperature_2m;
 return code>=51||temp>=30||temp<=5||Boolean(rainSoon(weather,now));
}
/** Cards for the deck. Work is shown as lights around the character and weather as one line under
 * the date by default; weatherMode='always', workCard=true, and pinned=[] customize what stays in the deck. */
export function deckWidgets(widgets,{weather=null,now=Date.now(),weatherMode='notable',workCard=false,pinned=[]}={}){
 const pinnedSet=new Set(Array.isArray(pinned)?pinned:[]);
 return widgets.filter(w=>{
  if(pinnedSet.has(w))return false;
  if(w==='work')return Boolean(workCard);
  if(w==='weather')return weatherMode==='always'?true:weatherNotable(weather,now);
  return true;
 });
}
export const countWord=n=>['','ひとつ','ふたつ','みっつ'][n]||`${n}件`;
/** What to say when the person comes back, in the persona's voice. Empty unless something happened or they were away a while. */
export function awayRecap({jobs=[],waiting=0,since=0,now=Date.now(),voice=undefined}={}){
 const work=jobs.filter(j=>!(j.kind==='chat'&&j.characterSessionId)&&j.kind!=='demo');
 const finished=work.filter(j=>['review','completed'].includes(j.status)&&Date.parse(j.endedAt||0)>=since).length;
 const running=work.filter(j=>['queued','running'].includes(j.status)&&!needsPerson(j)).length;
 const parts=[],address=voiceAddress(voice);
 if(finished)parts.push(voiceLine(voice,'back.finished',{n:countWord(finished)}));
 if(waiting)parts.push(voiceLine(voice,'back.waiting',{n:countWord(waiting)}));
 else if(running)parts.push(voiceLine(voice,'back.running',{n:countWord(running)}));
 if(!parts.length)return since>0&&now-since>=30*60e3&&voice?.proactive!=='quiet'?`${address}${voiceLine(voice,'back.quiet')}`:'';
 return `${address}${voiceLine(voice,'back.hello')}${parts.join('')}`;
}

// Cards appear only when they have something to show; setup lives in 設定, not on the monitor.
function ambientWeatherCard(weather,{sample=false}={}){
 if(!weather?.current)return null;
 const now=weatherLabel(weather.current.weather_code),hours=[];
 const times=weather.hourly?.time||[],temps=weather.hourly?.temperature_2m||[],rain=weather.hourly?.precipitation_probability||[];
 const start=times.findIndex(t=>Date.parse(t)>=Date.now()-3600e3);
 for(let i=Math.max(0,start);i<times.length&&hours.length<5;i+=2)hours.push({time:new Date(times[i]).getHours(),temp:Math.round(temps[i]),rain:rain[i]??null});
 const hi=weather.daily?.temperature_2m_max?.[0],lo=weather.daily?.temperature_2m_min?.[0],wet=hours.find(h=>h.rain>=40);
 return {id:'weather',title:weather.city?`天気 · ${weather.city}`:'天気',html:`<div class="weather">
  <div class="weather-now">${weatherGlyph(now.glyph)}<strong class="weather-temp">${Math.round(weather.current.temperature_2m)}<span>°</span></strong><div><p class="weather-label">${escape(now.label)}</p>${hi!=null?`<p class="weather-range">${Math.round(hi)}° / ${Math.round(lo)}°</p>`:''}</div></div>
  ${hours.length?`<ol class="weather-hours">${hours.map(h=>`<li><span>${h.time}時</span><b>${h.temp}°</b></li>`).join('')}</ol>`:''}
  <p class="card-source">${wet?`${wet.time}時ごろ 雨 ${wet.rain}% · `:''}${sample?'表示サンプル':'Open-Meteo'}</p></div>`};
}
function ambientNewsCard(news,index=0){
 if(!news?.items?.length)return null;
 const items=news.items.slice(0,12),i=((index%items.length)+items.length)%items.length,item=items[i];
 return {id:'news',title:news.title||'ニュース',html:`<div class="news">
  <a class="news-headline" href="${escape(item.url)}" target="_blank" rel="noreferrer noopener">${escape(item.title)}</a>
  <p class="card-source">${i+1} / ${items.length}</p></div>`};
}
function ambientMusicCard(music){
 if(!music?.track)return null;
 return {id:'media',title:'音楽',html:`<div class="music${music.playing?' is-playing':''}">
  <div class="music-disc" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
  <p class="music-title">${escape(music.track.title)}</p>
  <div class="music-progress" aria-hidden="true"><span style="--p:${Math.round((music.progress||0)*100)}%"></span></div>
  <div class="card-actions"><button type="button" class="round-button" data-action="music-prev" aria-label="前の曲">${icon('prev')}</button><button type="button" class="round-button is-primary" data-action="music-toggle" aria-label="${music.playing?'一時停止':'再生'}">${icon(music.playing?'pause':'play')}</button><button type="button" class="round-button" data-action="music-next" aria-label="次の曲">${icon('next')}</button><span class="card-source">${music.index+1} / ${music.count}</span></div></div>`};
}
function ambientWorkCard(jobs,{shared=false}={}){
 const active=jobs.filter(j=>['queued','running','waiting_approval'].includes(j.status));
 if(!active.length)return null;
 return {id:'work',title:'進めている仕事',html:shared?`<p class="work-shared">${active.length}件の仕事を進めています</p>`:
  `<ul class="work-glance">${active.slice(0,4).map(j=>`<li><button type="button" data-action="task" data-id="${escape(j.id)}"><i class="dot dot-${j.status==='waiting_approval'||j.pendingApprovals>0?'attention':'active'}"></i><span>${escape(j.title)}</span></button></li>`).join('')}</ul>${active.length>4?`<p class="card-source">ほか${active.length-4}件</p>`:''}`};
}
function ambientPhotoCard(images,index=0){
 if(!images.length)return null;const img=images[((index%images.length)+images.length)%images.length];
 return {id:'photos',widget:'artifact',title:'つくったもの',html:`<figure class="photo-frame"><img src="${escape(img.src)}" alt="${escape(img.title)}" loading="lazy"><figcaption>${escape(img.title)}</figcaption></figure>`};
}
function ambientFocusCard(focus){
 if(!focus)return null;
 const total=Math.max(60,(Number(focus.minutes)||25)*60),rem=Math.max(0,Number.isFinite(focus.remainingSeconds)?focus.remainingSeconds:total);
 const m=String(Math.floor(rem/60)).padStart(2,'0'),s=String(Math.floor(rem%60)).padStart(2,'0');
 const pct=Math.min(100,Math.max(0,Math.round(((total-rem)/total)*100)));
 const mins=Number(focus.minutes)||25;
 return {id:'focus',title:'集中タイマー',focus:{time:`${m}:${s}`,meta:`${focus.running?'集中中':'待機中'}${focus.completed?` · 今日 ${focus.completed}回`:''}`,progress:pct,minutes:mins,running:!!focus.running},html:`<div class="focus-widget${focus.running?' is-running':''}">
  <div class="focus-readout"><strong class="focus-time">${m}:${s}</strong><span class="focus-meta">${focus.running?'集中中':'待機中'}${focus.completed?` · 今日 ${focus.completed}回`:''}</span></div>
  <div class="music-progress focus-progress" aria-hidden="true"><span style="--p:${pct}%"></span></div>
  <div class="focus-controls">
   <button type="button" class="secondary-button is-compact" data-action="focus-toggle">${focus.running?'一時停止':'開始'}</button>
   <button type="button" class="ghost-button is-compact" data-action="focus-reset">リセット</button>
   <div class="focus-presets" role="group" aria-label="時間プリセット">${[15,25,45].map(n=>`<button type="button" class="chip-btn${mins===n?' is-on':''}" data-action="focus-preset" data-minutes="${n}">${n}分</button>`).join('')}</div>
  </div></div>`};
}
function ambientScheduleCard(schedule,{shared=false}={}){
 if(!schedule)return null;
 const saved=(Array.isArray(schedule.items)?schedule.items:[]).filter(d=>d&&typeof d.text==='string'&&Number.isFinite(Date.parse(d.at))).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 if(shared)return {id:'schedule',title:'予定・定期タスク',html:`<p class="work-shared">${saved.length?`${saved.length}件の予定があります`:'予定はありません'}</p>`};
 const items=saved.slice(0,4).map(d=>({kind:d.every?'定期':d.mode==='task'?'仕事':'通知',title:d.text,sub:d.lastError?'再試行待ち':`${new Date(d.at).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}${d.every?` · ${d.every}分ごと`:''}`}));
 if(!items.length)return {id:'schedule',title:'予定・定期タスク',html:'<div class="schedule-widget is-empty"><p class="muted">予定されているタスクやリマインダーはありません。</p><p class="small-text">予定の追加や確認は、会話で頼めます。</p></div>'};
 return {id:'schedule',title:'予定・定期タスク',html:`<ul class="schedule-list">${items.map(it=>`<li><span class="schedule-badge">${escape(it.kind)}</span><span class="schedule-title">${escape(it.title)}</span><small class="schedule-sub">${escape(it.sub)}</small></li>`).join('')}</ul>`};
}
/** Apply a committed read-only schedule delta; source fire receipts are not state. */
export function applyScheduleView(items,change){
 const current=Array.isArray(items)?items:[],id=change?.id,item=change?.item;
 if(typeof id!=='string'||!id)return current;
 if(item===null)return current.filter(d=>d.id!==id);
 if(!item||typeof item!=='object'||Array.isArray(item)||item.id!==id)return current;
 const next=[...current],index=next.findIndex(d=>d.id===id);
 if(index<0)next.unshift(item);else next[index]=item;
 return next;
}
function ambientMemoCard(memo,{shared=false}={}){
 if(!memo||shared)return null;
 const note=(memo.note||'').trim(),mem=memo.memory;
 const body=note||(mem?.content||mem?.summary||mem?.text||'').trim();
 return {id:'memo',title:note?'ピン留めメモ':'最近の記憶・メモ',html:`<div class="memo-widget">
  <p class="memo-body">${body?escape(body):'<span class="muted">ステージに置いておきたい一言メモを書き留められます。</span>'}</p>
  <div class="memo-footer"><span class="card-source">${note?'固定メモ':mem?'記憶より':'未入力'}</span><button type="button" class="ghost-button is-compact" data-action="memo-edit">編集</button></div></div>`};
}
function ambientSystemCard(system){
 if(!system)return null;
 const safetyLabel=system.safety==='host'?'ホスト許可':'保護モード';
 return {id:'system',title:'システム・AI状態',html:`<div class="system-widget">
  <div class="system-grid">
   <div class="system-cell"><span class="system-k">AIモデル</span><strong class="system-v"><i class="dot dot-${system.ready?'active':'idle'}"></i>${escape(system.model||(system.ready?'接続済み':'未設定'))}</strong></div>
   <div class="system-cell"><span class="system-k">実行保護</span><strong class="system-v">${escape(safetyLabel)}</strong></div>
   <div class="system-cell"><span class="system-k">本日の応答</span><strong class="system-v">${Number(system.todayRequests)||0}回</strong></div>
   <div class="system-cell"><span class="system-k">記憶・稼働</span><strong class="system-v">${Number(system.memoryCount)||0}件 · ${Number(system.activeJobs)||0}稼働</strong></div>
  </div></div>`};
}
function ambientAlmanacCard(almanac){
 if(!almanac)return null;
 const now=almanac.now instanceof Date?almanac.now:new Date(almanac.now||Date.now());
 const s=seasonOf(now),next=SEASONS[(s.index+1)%SEASONS.length];
 const fmt=h=>{if(!Number.isFinite(h))return null;const hr=Math.floor(h),mn=Math.round((h%1)*60);return `${String(hr).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;};
 const rise=almanac.sunrise||fmt(almanac.sun?.rise),set=almanac.sunset||fmt(almanac.sun?.set);
 return {id:'almanac',title:`二十四節気 · ${s.sekki}`,html:`<div class="almanac-widget">
  <p class="almanac-kou"><span class="almanac-sekki">${escape(s.sekki)}</span><strong>${escape(s.kou)}</strong></p>
  ${next?`<p class="almanac-meaning">次の候（${next.month}月${next.day}日ごろ）: ${escape(next.sekki)} ・ ${escape(next.kou)}</p>`:''}
  ${rise&&set?`<p class="card-source">日の出 ${escape(rise)} · 日の入り ${escape(set)}</p>`:`<p class="card-source">${now.getMonth()+1}月${now.getDate()}日の暦</p>`}</div>`};
}
/** Ordered cards for the deck or pinned slots, following the display widget order. Shared view drops private ones. */
export function ambientCards({widgets=[],weather,news,music,jobs=[],images=[],focus=null,schedule=null,memo=null,system=null,almanac=null,shared=false,newsIndex=0,photoIndex=0,sample={}}){
 const cards=[];
 for(const w of widgets){
  if(w==='weather')cards.push(ambientWeatherCard(weather,{sample:sample.weather}));
  if(w==='news')cards.push(ambientNewsCard(news,newsIndex));
  if(w==='media')cards.push(ambientMusicCard(music));
  if(w==='work')cards.push(ambientWorkCard(jobs,{shared}));
  if(w==='artifact'&&!shared)cards.push(ambientPhotoCard(images,photoIndex));
  if(w==='focus')cards.push(ambientFocusCard(focus));
  if(w==='schedule')cards.push(ambientScheduleCard(schedule,{shared}));
  if(w==='memo'&&!shared)cards.push(ambientMemoCard(memo,{shared}));
  if(w==='system')cards.push(ambientSystemCard(system));
  if(w==='almanac')cards.push(ambientAlmanacCard(almanac));
 }
 return cards.filter(Boolean);
}

/** Multi-slot pinned board renderer for the smart monitor stage. */
export function renderPinnedCards(cards=[]){
 return cards.filter(Boolean).map(c=>`<article class="deck-card pinned-card" data-card="${escape(c.id)}"><header class="deck-title"><span>${escape(c.title)}</span><button type="button" class="card-pin-btn" data-action="toggle-pin-widget" data-widget="${escape(c.widget||c.id)}" aria-label="固定を解除" title="固定を解除">固定中</button></header><div class="deck-body">${c.html}</div></article>`).join('');
}

// A running clock must not replace controls (or the keyboard focus inside them).
function paintFocusCard(article,card){
 const value=card.focus;if(!value||!article?.querySelector('.focus-widget'))return false;
 const text=(selector,value)=>{const el=article.querySelector(selector);if(el.textContent!==value)el.textContent=value;};
 text('.focus-time',value.time);text('.focus-meta',value.meta);
 text('[data-action="focus-toggle"]',value.running?'一時停止':'開始');
 article.querySelector('.focus-widget').classList.toggle('is-running',value.running);
 article.querySelector('.focus-progress span').style.setProperty('--p',`${value.progress}%`);
 article.querySelectorAll('[data-action="focus-preset"]').forEach(el=>el.classList.toggle('is-on',Number(el.dataset.minutes)===value.minutes));
 return true;
}
/** Keyed pinned cards: update only the changed widget, keeping other cards and their focus. */
export function createPinnedBoard(host){
 const records=new Map();
 const update=card=>{
  const record=records.get(card.id);if(!record)return;
  if(record.card.html===card.html&&record.card.title===card.title)return;
  if(!paintFocusCard(record.el,card)){
   record.el.querySelector('.deck-title span').textContent=card.title;
   record.el.querySelector('.deck-body').innerHTML=card.html;
  }
  record.card=card;
 };
 return {
  set(cards){
   const ids=new Set(cards.map(c=>c.id));
   for(const [id,record] of records)if(!ids.has(id)){record.el.remove();records.delete(id);}
   cards.forEach((card,index)=>{
    if(!records.has(card.id)){
     const box=host.ownerDocument.createElement('div');box.innerHTML=renderPinnedCards([card]);
     records.set(card.id,{el:box.firstElementChild,card});
    }else update(card);
    const el=records.get(card.id).el;if(host.children[index]!==el)host.insertBefore(el,host.children[index]||null);
   });
   host.classList.toggle('is-empty',!cards.length);
  },
  update
 };
}

/** One card at a time; data refreshes do not postpone rotation. Hover or focus holds the card. */
export function createDeck(host,{interval=12000,reducedMotion=false,onChange=()=>{}}={}){
 let cards=[],index=0,timer=0,hovered=false,focused=false,stopped=false,lastSig='',lastCard='',lastPager='';
 const paint=(animate=false)=>{
  if(!cards.length){if(lastSig!==''){host.innerHTML='';lastSig='';lastCard='';}onChange(null);return;}
  index=((index%cards.length)+cards.length)%cards.length;const c=cards[index];
  // Only the displayed content and pager labels can affect the displayed DOM.
  const pager=JSON.stringify(cards.map(x=>[x.id,x.title])),sig=JSON.stringify([index,c.id,c.title,c.html,pager]);
  if(!animate&&sig===lastSig){onChange(c.id);return;}
  const live=!animate&&lastCard===c.id&&lastPager===pager&&paintFocusCard(host.querySelector?.('.deck-card'),c);
  lastSig=sig;lastCard=c.id;lastPager=pager;
  if(!live)host.innerHTML=`<article class="deck-card${animate&&!reducedMotion?' is-arriving':''}" data-card="${escape(c.id)}"><header class="deck-title">${escape(c.title)}</header><div class="deck-body">${c.html}</div></article>
   ${cards.length>1?`<div class="deck-pager" role="group" aria-label="表示するカード">${cards.map((x,n)=>`<button type="button" data-deck="${n}" aria-label="${escape(x.title)}" aria-pressed="${n===index}"></button>`).join('')}</div>`:''}`;
  onChange(c.id);
 };
 const clear=()=>{clearTimeout(timer);timer=0;};
 const schedule=(restart=false)=>{
  if(stopped||hovered||focused||reducedMotion||cards.length<2){clear();return;}
  if(timer&&!restart)return;
  clear();timer=setTimeout(()=>{timer=0;index++;paint(true);schedule();},interval);
 };
 host.addEventListener('click',e=>{const b=e.target.closest('[data-deck]');if(!b)return;index=Number(b.dataset.deck);paint(true);schedule(true);});
 host.addEventListener('pointerenter',()=>{hovered=true;clear();});host.addEventListener('pointerleave',()=>{hovered=false;schedule();});
 host.addEventListener('focusin',()=>{focused=true;clear();});host.addEventListener('focusout',e=>{if(e.relatedTarget&&host.contains?.(e.relatedTarget))return;focused=false;schedule();});
 return {
  set(next,{keep=true}={}){const current=cards[index]?.id;cards=next;if(keep&&current){const at=cards.findIndex(c=>c.id===current);if(at>=0)index=at;}paint();schedule();},
  update(card){const at=cards.findIndex(c=>c.id===card.id);if(at>=0){cards[at]=card;paint();}},
  next(){index++;paint(true);schedule(true);},
  current(){return cards[index]?.id||null;},
  stop(){stopped=true;clear();}
 };
}

/** Calls onIdle after ms without input; onWake on the next input. ms<=0 disables. */
export function createIdleWatcher({ms=0,onIdle=()=>{},onWake=()=>{},target=window}={}){
 let timer=0,idle=false,limit=ms;
 const arm=()=>{clearTimeout(timer);if(limit>0)timer=setTimeout(()=>{idle=true;onIdle();},limit);};
 const activity=()=>{if(idle){idle=false;onWake();}arm();};
 for(const type of ['pointerdown','pointermove','keydown','wheel','touchstart'])target.addEventListener(type,activity,{passive:true});
 arm();
 return {set(ms){limit=ms;arm();},idle:()=>idle,wake(){if(idle){idle=false;onWake();}arm();},sleep(){clearTimeout(timer);if(!idle){idle=true;onIdle();}}};
}
