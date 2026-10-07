/** Digital photo frame. The idle screen can show the person's own photos (and, if they like, the
 * pictures Tepora made) full screen with a slow crossfade, like a smart display. Photos come from the
 * service's data directory or, in the offline preview, from this window only. Nothing is uploaded.
 */
import {escape} from './ui.mjs';
export const FRAME_MAX_EDGE=3200;
/** Photos chosen in the offline preview. They live in this window only; the real service stores its own. */
export const framePreview=[];
const frameRandom=seed=>()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};

/** Order in which photos are shown: as added, or a fixed shuffle for the seed. */
export function shuffledOrder(count,{shuffle=true,seed=1}={}){
 const order=Array.from({length:count},(_,i)=>i);
 if(!shuffle)return order;
 const random=frameRandom(seed);
 for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
 return order;
}
/** One list for the frame: stored photos, then Tepora's own images when asked. {id, url, name} each. */
export function framePhotos({photos=[],created=[],includeCreated=true}={}){
 const own=photos.map(p=>({id:p.id,url:p.url||`/api/frame/photos/${encodeURIComponent(p.id)}`,name:p.name||''}));
 return includeCreated?[...own,...created.map(c=>({id:`made:${c.src}`,url:c.src,name:c.title||''}))]:own;
}
/** Long edge and size to fit inside `edge` without enlarging. */
export function fitWithin(width,height,edge=FRAME_MAX_EDGE){
 const scale=Math.min(1,edge/Math.max(width,height,1));
 return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale)),scaled:scale<1};
}
function frameSlideHTML(photo,fit,variant){
 const url=escape(photo.url),alt=escape(photo.name||'');
 if(fit==='contain')return `<div class="fs fs-contain"><img class="fs-back" src="${url}" alt="" decoding="async"><img class="fs-fore" src="${url}" alt="${alt}" decoding="async"></div>`;
 if(fit==='mat')return `<div class="fs fs-mat"><div class="fs-matte"><img src="${url}" alt="${alt}" decoding="async"></div></div>`;
 return `<div class="fs fs-cover"><img class="${variant===null?'':`kb kb-${variant}`}" src="${url}" alt="${alt}" decoding="async"></div>`;
}

/** host receives the slides. controller: {start(photos, options), stop()}; options as in AMBIENT_DEFAULT. */
export function createPhotoFrame(host,{reducedMotion=false}={}){
 const layers=[document.createElement('div'),document.createElement('div')];
 for(const layer of layers){layer.className='fl';host.append(layer);}
 let photos=[],options=null,order=[],pos=-1,timer=0,running=false,front=0,epoch=0,signature='',looks='',fails=0;
 const settle=layer=>{
  const img=layer.querySelector('.fs-fore,.fs-matte img,.fs-cover img');
  if(!img)return Promise.resolve(false);
  return Promise.race([img.decode().then(()=>img.naturalWidth>0,()=>false),new Promise(r=>setTimeout(()=>r(false),6000))]);
 };
 async function show(){
  if(!running||!photos.length)return;
  const mine=++epoch,photo=photos[order[pos]],next=layers[front^1];
  next.innerHTML=frameSlideHTML(photo,options.frameFit,options.frameMotion&&!reducedMotion&&options.frameFit==='cover'?pos%4:null);
  next.style.setProperty('--frame-s',`${options.frameSeconds+4}s`);
  const ok=await settle(next);
  if(mine!==epoch||!running)return;
  // A picture that cannot be read is skipped; if none can, the frame waits for the next interval.
  if(!ok){if(++fails<photos.length)advance();return;}
  fails=0;next.classList.add('is-in');layers[front].classList.remove('is-in');front^=1;
 }
 function advance(){if(!photos.length)return;pos=(pos+1)%order.length;show();}
 function schedule(){clearTimeout(timer);timer=setTimeout(()=>{if(!running)return;fails=0;advance();schedule();},options.frameSeconds*1000);}
 return {
  /** Starts or updates. The order restarts only when the photos or the shuffle change; a slide is
   * redrawn only when how it looks (fit, motion) changes. Each new run begins at a different photo. */
  start(list,next){
   const sig=JSON.stringify([list.map(p=>p.id),next.frameShuffle]),look=JSON.stringify([next.frameFit,next.frameMotion]);
   const wasRunning=running;options={...next};photos=list;running=photos.length>0;
   if(!running){this.stop();return;}
   if(sig!==signature||!wasRunning){signature=sig;looks=look;order=shuffledOrder(photos.length,{shuffle:next.frameShuffle,seed:next.seed??Math.floor(Math.random()*2147483647)});pos=-1;fails=0;advance();}
   else if(look!==looks){looks=look;show();}
   schedule();
  },
  stop(){running=false;epoch++;clearTimeout(timer);signature='';looks='';for(const layer of layers){layer.classList.remove('is-in');layer.replaceChildren();}}
 };
}
