/** The drawn bodies. One small controller gives every body the same quiet life: it blinks, glances now and then,
 * follows the pointer a little, does a small act now and then while idle, and takes its colours from the theme.
 * The body itself decides how a mood looks (see avatar.css); the controller only says which mood it is.
 */
import {avatarBody} from './model.mjs';
import {avatarCssVars,avatarUid} from './kit.mjs';
import {avatarGeometry} from './geometry.mjs';
import {AVATAR_BODY_SHIRO} from './body-shiro.mjs';
import {AVATAR_BODY_ANDON} from './body-andon.mjs';
import {AVATAR_BODY_ENSOU} from './body-ensou.mjs';
import {AVATAR_BODY_KOBAKO} from './body-kobako.mjs';
import {AVATAR_BODY_KITSUNE} from './body-kitsune.mjs';
import {AVATAR_BODY_HOTARU} from './body-hotaru.mjs';
import {AVATAR_BODY_KOKEDAMA} from './body-kokedama.mjs';
import {AVATAR_BODY_IMAGE} from './body-image.mjs';

const AVATAR_SVG_BODIES={shiro:AVATAR_BODY_SHIRO,andon:AVATAR_BODY_ANDON,ensou:AVATAR_BODY_ENSOU,kobako:AVATAR_BODY_KOBAKO,kitsune:AVATAR_BODY_KITSUNE,hotaru:AVATAR_BODY_HOTARU,kokedama:AVATAR_BODY_KOKEDAMA,image:AVATAR_BODY_IMAGE,imageset:AVATAR_BODY_IMAGE};
const AVATAR_ACTS=['tilt','stretch','hum'];
const avatarClamp=(x,a,b)=>Math.max(a,Math.min(b,x));

/** Put the colours and the theme on a drawing's root element. */
export function avatarApplyLook(svg,spec,theme){
 svg.dataset.avatarTheme=theme;
 for(const [name,value] of Object.entries(avatarCssVars(spec,theme)))svg.style.setProperty(name,value);
}

/** Draw a body from a spec into host. Returns a handle with setMood, setLook, setLevel, setTheme, setReduced, act and destroy. */
export function createSvgAvatar(host,spec,{mood='idle',follow=false,life=true,director=false,reduced=false,theme='light',label='',compact=false}={}){
 const body=AVATAR_SVG_BODIES[spec.body];
 if(!body)throw new Error(`この姿は描けません: ${spec.body}`);
 host.classList.add('cx-host');host.innerHTML=body.svg(spec,avatarUid());
 const svg=host.firstElementChild;svg.classList.add('cx',`cx-${body.id}`);
 if(label){svg.setAttribute('role','img');svg.setAttribute('aria-label',label);svg.removeAttribute('aria-hidden');}else svg.setAttribute('aria-hidden','true');
 if(spec.motion==='calm')svg.classList.add('m-calm');else if(spec.motion==='lively')svg.classList.add('m-lively');
 if(compact){const crop=avatarGeometry(spec).compact;if(crop)svg.setAttribute('viewBox',crop.join(' '));svg.classList.add('cx-compact');}
 avatarApplyLook(svg,spec,theme);svg.dataset.mood=mood;
 const h={kind:'svg',body:spec.body,svg,spec,recipe:spec,mood,dead:false,reduced,theme,timers:[],ext:null,isReduced:()=>h.reduced};
 svg.classList.toggle('cx-still',reduced);
 const later=(fn,ms)=>{const t=setTimeout(()=>{if(!h.dead)fn();},ms);h.timers.push(t);};
 const look=(x,y)=>{
  svg.style.setProperty('--look-x',`${(x*5).toFixed(2)}px`);svg.style.setProperty('--look-y',`${(y*3.5).toFixed(2)}px`);
  svg.style.setProperty('--lk-x',x.toFixed(3));svg.style.setProperty('--lk-y',y.toFixed(3));h.ext?.look?.(x,y);
 };
 let pointerHeld=false,pointerTimer=0,frame=0;
 if(life){
  const blink=()=>{
   if(h.mood!=='sleepy'&&h.mood!=='happy'&&!h.reduced){
    svg.classList.add('is-blinking');later(()=>svg.classList.remove('is-blinking'),130);
    if(Math.random()<.18)later(()=>{svg.classList.add('is-blinking');later(()=>svg.classList.remove('is-blinking'),120);},260);
   }
   later(blink,2200+Math.random()*4200);
  };
  later(blink,900+Math.random()*1200);
  const glance=()=>{if(h.mood==='idle'&&!pointerHeld&&!h.reduced)look((Math.random()*2-1)*.7,(Math.random()*2-1)*.4);later(glance,5000+Math.random()*7000);};
  later(glance,3000+Math.random()*3000);
 }
 h.act=(name,ms=2600)=>{if(h.reduced)return;svg.classList.add(`act-${name}`);later(()=>svg.classList.remove(`act-${name}`),ms);};
 if(director){
  const next=()=>{if(h.mood==='idle'&&!h.reduced)h.act(AVATAR_ACTS[Math.floor(Math.random()*AVATAR_ACTS.length)]);later(next,14000+Math.random()*18000);};
  later(next,9000+Math.random()*9000);
 }
 const onPointer=e=>{
  if(frame||h.reduced)return;
  frame=requestAnimationFrame(()=>{
   frame=0;const r=host.getBoundingClientRect();if(!r.width)return;
   const x=(e.clientX-(r.left+r.width/2))/Math.max(260,innerWidth/2),y=(e.clientY-(r.top+r.height*.45))/Math.max(220,innerHeight/2);
   pointerHeld=true;clearTimeout(pointerTimer);pointerTimer=setTimeout(()=>{pointerHeld=false;},4000);
   look(avatarClamp(x,-1,1),avatarClamp(y,-1,1));
  });
 };
 if(follow)window.addEventListener('pointermove',onPointer,{passive:true});
 h.setMood=m=>{h.mood=m;svg.dataset.mood=m;if(m==='sleepy')look(0,.6);else if(m!=='idle')look(0,0);h.ext?.setMood?.(m);};
 h.setLook=(x,y)=>look(avatarClamp(Number(x)||0,-1,1),avatarClamp(Number(y)||0,-1,1));
 h.setLevel=v=>{svg.style.setProperty('--mouth',String(.35+avatarClamp(Number(v)||0,0,1)*.75));h.ext?.setLevel?.(v);};
 h.setTheme=t=>{h.theme=t;avatarApplyLook(svg,spec,t);};
 h.setReduced=on=>{h.reduced=!!on;svg.classList.toggle('cx-still',h.reduced);h.ext?.setReduced?.(h.reduced);};
 h.destroy=()=>{
  h.dead=true;h.timers.forEach(clearTimeout);clearTimeout(pointerTimer);cancelAnimationFrame(frame);window.removeEventListener('pointermove',onPointer);
  h.ext?.destroy?.();host.classList.remove('cx-host');host.replaceChildren();
 };
 h.ext=body.init?.(svg,h)||null;
 h.setMood(mood);
 return h;
}
