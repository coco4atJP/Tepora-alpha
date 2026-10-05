/** 押印: saying yes is pressing a seal. Operations that act on this PC or can cost money are held
 * for a moment while the ring fills; the rest take one tap. Nothing here decides what is allowed.
 * It changes only how the person says yes, and the service still replays exactly the request shown.
 * Without a pointer (keyboard, screen reader) a held seal asks for two deliberate activations.
 */
import {escape} from './ui.mjs';
export const SEAL_HOLD_MS=700;
export const SEAL_STAMP_MS=380;
export const SEAL_ARM_MS=4000;
export const SEAL_MIN_GAP_MS=350;

/** The seal button. `hold` makes it a held seal; the ring and the stamp are drawn by CSS. */
export function sealHTML({action,id='',ids='',hold=false,label='許可する',hint=''}={}){
 const attrs=`data-seal="${escape(action)}"${id?` data-id="${escape(id)}"`:''}${ids?` data-ids="${escape(ids)}"`:''} data-hold="${hold?1:0}"`;
 return `<span class="seal-wrap"><button type="button" class="seal${hold?'':' is-tap'}" ${attrs} aria-label="${escape(label)}${hold?'（長押し）':''}"><svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><circle class="seal-track" cx="24" cy="24" r="21.5"/>${hold?'<circle class="seal-ring" cx="24" cy="24" r="21.5" transform="rotate(-90 24 24)"/>':''}<text x="24" y="31.5" text-anchor="middle">可</text></svg></button><span class="seal-hint">${escape(hint||(hold?'長押しで許可':'タップで許可'))}</span></span>`;
}
/** The mark left on the slip. Place it inside an element that carries data-sealable. */
export function stampHTML(){
 return '<svg class="stamp" viewBox="0 0 80 80" aria-hidden="true" focusable="false"><g class="stamp-ring" filter="url(#tp-rough)"><circle cx="40" cy="40" r="35"/><circle class="stamp-inner" cx="40" cy="40" r="30.5"/></g><text x="40" y="54" text-anchor="middle" filter="url(#tp-rough)">可</text></svg>';
}
/** The rough edge of a pressed seal. Include once per page. */
export function sealDefs(){
 return '<svg class="seal-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs><filter id="tp-rough" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>';
}

/** Two deliberate activations of the same seal, a moment apart, stand in for a hold. */
export function createArmGate({ms=SEAL_ARM_MS,gap=SEAL_MIN_GAP_MS,now=()=>Date.now()}={}){
 let key='',at=0;
 return {
  /** 'armed' on the first activation (and for one that comes too soon), 'commit' on the second. */
  activate(next){
   const t=now();
   if(key===next&&t-at<=ms){if(t-at<gap)return 'armed';key='';return 'commit';}
   key=next;at=t;return 'armed';
  },
  reset(){key='';at=0;}
 };
}

/** Wires every .seal[data-seal] under root. onCommit(el) runs once the stamp has landed. */
export function bindSeals({root=document,onCommit,onArm=()=>{}}={}){
 const gate=createArmGate();let held=null,pointerAt=0;
 const sealOf=target=>target?.closest?.('.seal[data-seal]');
 const keyOf=el=>`${el.dataset.seal}:${el.dataset.id||el.dataset.ids||''}`;
 const finish=el=>{
  if(held?.el===el){clearTimeout(held.timer);held=null;}
  const host=el.closest('[data-sealable]')||el.parentElement;
  if(!host||host.classList.contains('is-sealed'))return;
  el.classList.remove('is-holding','is-armed');host.classList.add('is-sealed');gate.reset();
  setTimeout(()=>onCommit(el),SEAL_STAMP_MS);
 };
 const begin=el=>{
  if(held||el.closest('.is-sealed'))return;
  el.classList.add('is-holding');
  held={el,timer:setTimeout(()=>finish(el),SEAL_HOLD_MS)};
 };
 const cancel=()=>{if(!held)return;clearTimeout(held.timer);held.el.classList.remove('is-holding');held=null;};
 root.addEventListener('pointerdown',e=>{
  const el=sealOf(e.target);if(!el||e.button>0)return;
  pointerAt=Date.now();
  if(el.dataset.hold!=='1')return;
  e.preventDefault();begin(el);
 });
 window.addEventListener('pointerup',cancel);
 window.addEventListener('pointercancel',cancel);
 // Sliding off the seal cancels the hold, so a press that drifts away never commits.
 window.addEventListener('pointermove',e=>{if(held&&!held.el.contains(document.elementFromPoint(e.clientX,e.clientY)))cancel();});
 // Holding a key must not repeat the activation.
 root.addEventListener('keydown',e=>{if(e.repeat&&sealOf(e.target)&&(e.key==='Enter'||e.key===' '))e.preventDefault();});
 root.addEventListener('click',e=>{
  const el=sealOf(e.target);if(!el)return;
  e.preventDefault();
  if(el.closest('.is-sealed'))return;
  if(el.dataset.hold!=='1'){finish(el);return;}
  // A mouse or touch hold decides by itself; the click that follows it carries no new intent.
  if(e.detail>0&&Date.now()-pointerAt<1500)return;
  if(gate.activate(keyOf(el))==='commit'){finish(el);return;}
  el.classList.add('is-armed');setTimeout(()=>el.classList.remove('is-armed'),SEAL_ARM_MS);onArm(el);
 });
 return {cancel};
}
