import {icon,escape} from './ui.mjs';
import {needsPerson} from './status.mjs';
import {voiceAddress,voiceLine} from './voice-lines.mjs';
import {seasonOf} from './seasons.mjs';
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
 * the date, so the weather card comes back only when it changes what you would do. */
export function deckWidgets(widgets,{weather=null,now=Date.now()}={}){
 return widgets.filter(w=>w==='work'?false:w==='weather'?weatherNotable(weather,now):true);
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
 return {id:'photos',title:'つくったもの',html:`<figure class="photo-frame"><img src="${escape(img.src)}" alt="${escape(img.title)}" loading="lazy"><figcaption>${escape(img.title)}</figcaption></figure>`};
}
/** Ordered cards for the deck, following the display widget order. Shared view drops private ones. */
export function ambientCards({widgets=[],weather,news,music,jobs=[],images=[],shared=false,newsIndex=0,photoIndex=0,sample={}}){
 const cards=[];
 for(const w of widgets){
  if(w==='weather')cards.push(ambientWeatherCard(weather,{sample:sample.weather}));
  if(w==='news')cards.push(ambientNewsCard(news,newsIndex));
  if(w==='media')cards.push(ambientMusicCard(music));
  if(w==='work')cards.push(ambientWorkCard(jobs,{shared}));
  if(w==='artifact'&&!shared)cards.push(ambientPhotoCard(images,photoIndex));
 }
 return cards.filter(Boolean);
}

/** One card at a time; the next one rises into place. Hover or focus holds the current card. */
export function createDeck(host,{interval=12000,reducedMotion=false,onChange=()=>{}}={}){
 let cards=[],index=0,timer=0,paused=false,stopped=false;
 const paint=(animate=false)=>{
  if(!cards.length){host.innerHTML='';onChange(null);return;}
  index=((index%cards.length)+cards.length)%cards.length;const c=cards[index];
  host.innerHTML=`<article class="deck-card${animate&&!reducedMotion?' is-arriving':''}" data-card="${escape(c.id)}"><header class="deck-title">${escape(c.title)}</header><div class="deck-body">${c.html}</div></article>
   ${cards.length>1?`<div class="deck-pager" role="group" aria-label="表示するカード">${cards.map((x,n)=>`<button type="button" data-deck="${n}" aria-label="${escape(x.title)}" aria-pressed="${n===index}"></button>`).join('')}</div>`:''}`;
  onChange(c.id);
 };
 const schedule=()=>{clearTimeout(timer);if(stopped||paused||reducedMotion||cards.length<2)return;timer=setTimeout(()=>{index++;paint(true);schedule();},interval);};
 host.addEventListener('click',e=>{const b=e.target.closest('[data-deck]');if(!b)return;index=Number(b.dataset.deck);paint(true);schedule();});
 host.addEventListener('pointerenter',()=>{paused=true;clearTimeout(timer);});host.addEventListener('pointerleave',()=>{paused=false;schedule();});
 host.addEventListener('focusin',()=>{paused=true;clearTimeout(timer);});host.addEventListener('focusout',()=>{paused=false;schedule();});
 return {
  set(next,{keep=true}={}){const current=cards[index]?.id;cards=next;if(keep&&current){const at=cards.findIndex(c=>c.id===current);if(at>=0)index=at;}paint();schedule();},
  next(){index++;paint(true);schedule();},
  current(){return cards[index]?.id||null;},
  stop(){stopped=true;clearTimeout(timer);}
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
