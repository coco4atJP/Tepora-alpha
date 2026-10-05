/** 蛍: work that has been handed over is shown as small lights around the character, and what waits
 * for the person as one amber light that stays near the antenna. A new job leaves the antenna and a
 * finished one flies back to it. The model is pure; createLights keeps one element per job so a light
 * never jumps when another one finishes.
 */
import {jobStatus,needsPerson} from './status.mjs';

/** Resting places around the character, in % of its box. */
export const LIGHT_SLOTS=Object.freeze([[-28,44],[126,60],[114,14],[-22,12],[104,92]]);
/** Where the amber light waits, near the antenna on the side the character looks toward. */
export const LIGHT_WAIT=Object.freeze([88,-4]);
// Per-slot drift: duration, delay, ripple delay and the reach of the wander. Fixed, so a light moves the same way every time.
const LIGHT_DRIFT=[[11,0,0,12,-14],[13,-4,-1.6,-13,11],[12,-7,-3.1,9,12],[14,-2,-2.2,-10,-9],[10,-5,-.8,11,8]];

/** Jobs shown as lights: queued or running work that does not need the person, oldest first. */
export function lightJobs(jobs=[]){
 return jobs.filter(j=>['queued','running'].includes(j.status)&&!needsPerson(j))
  .sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))||String(a.id).localeCompare(String(b.id)));
}
/** Keeps each job in the slot it already has; a new job takes the lowest free one. Jobs beyond the slots get none. */
export function assignLightSlots(previous,ids,count=LIGHT_SLOTS.length){
 const next=new Map(),used=new Set();
 for(const id of ids){const slot=previous.get(id);if(slot!==undefined&&slot<count&&!used.has(slot)){next.set(id,slot);used.add(slot);}}
 for(const id of ids){if(next.has(id))continue;let slot=0;while(used.has(slot)&&slot<count)slot++;if(slot<count){next.set(id,slot);used.add(slot);}}
 return next;
}

/** host is the layer over the character's box. Returns {set, gather, clear}. */
export function createLights(host){
 const nodes=new Map();let slots=new Map(),wait=LIGHT_WAIT;
 const place=(el,point)=>{if(point){el.style.setProperty('--lx',`${point[0]}%`);el.style.setProperty('--ly',`${point[1]}%`);}else{el.style.removeProperty('--lx');el.style.removeProperty('--ly');}};
 const drift=(el,slot)=>{const [dur,del,rd,ax,ay]=LIGHT_DRIFT[slot%LIGHT_DRIFT.length];for(const [k,v] of [['--dur',`${dur}s`],['--del',`${del}s`],['--rd',`${rd}s`],['--ax',`${ax}px`],['--ay',`${ay}px`]])el.style.setProperty(k,v);};
 const make=(key,amber)=>{
  const el=document.createElement('button');el.type='button';el.className=`ff${amber?' ff-wait':''}`;el.dataset.light=key;
  el.innerHTML=amber?'<b aria-hidden="true"></b><span class="ff-label">あなたの番<span class="ff-count"></span></span>':'<b aria-hidden="true"></b>';
  host.append(el);
  // Two frames: the element is first laid out at the antenna, then released toward its place.
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('on')));
  return el;
 };
 const retire=key=>{
  const el=nodes.get(key);if(!el)return;nodes.delete(key);
  place(el,null);el.classList.remove('on');el.disabled=true;el.removeAttribute('data-action');el.removeAttribute('data-id');
  setTimeout(()=>el.remove(),1900);
 };
 return {
  /** jobs: lightJobs(...); waiting: how many things wait for the person; shared: a presentation view with no titles. */
  set({jobs=[],waiting=0,shared=false}={}){
   const shown=jobs.slice(0,LIGHT_SLOTS.length);slots=assignLightSlots(slots,shown.map(j=>j.id));
   for(const j of shown){
    const slot=slots.get(j.id);if(slot===undefined)continue;
    let el=nodes.get(j.id);
    if(!el){el=make(j.id,false);nodes.set(j.id,el);drift(el,slot);}
    place(el,LIGHT_SLOTS[slot]);
    const label=shared?'仕事を進めています':`${j.title}（${jobStatus(j).label}）`;
    el.title=label;el.setAttribute('aria-label',shared?label:`${label}を開く`);
    if(shared){el.removeAttribute('data-action');el.removeAttribute('data-id');el.tabIndex=-1;}
    else{el.dataset.action='task';el.dataset.id=j.id;el.tabIndex=0;}
   }
   for(const key of [...nodes.keys()])if(key!=='__wait'&&!shown.some(j=>j.id===key))retire(key);
   if(waiting>0&&!shared){
    let el=nodes.get('__wait');
    if(!el){el=make('__wait',true);nodes.set('__wait',el);el.dataset.action='inbox';}
    place(el,wait);
    const count=el.querySelector('.ff-count');if(count&&count.textContent!==String(waiting))count.textContent=String(waiting);
    el.setAttribute('aria-label',`あなたの番 ${waiting}件を開く`);el.title=`あなたの番 ${waiting}件`;
   }else retire('__wait');
  },
  /** Where the amber light waits for this body (percent of its box); null for the default near the antenna. */
  setAnchor(point){wait=Array.isArray(point)&&point.length===2?point:LIGHT_WAIT;const el=nodes.get('__wait');if(el)place(el,wait);},
  /** The lights draw a little closer to the character, as they do when the person comes back. */
  gather(on){
   const w=host.clientWidth||200,h=host.clientHeight||224;
   for(const [key,el] of nodes){
    const point=key==='__wait'?wait:LIGHT_SLOTS[slots.get(key)];
    if(!on||!point){el.style.removeProperty('--gx');el.style.removeProperty('--gy');continue;}
    el.style.setProperty('--gx',`${((50-point[0])*.3*w/100).toFixed(1)}px`);
    el.style.setProperty('--gy',`${((56-point[1])*.3*h/100).toFixed(1)}px`);
   }
  },
  clear(){for(const key of [...nodes.keys()])retire(key);}
 };
}
