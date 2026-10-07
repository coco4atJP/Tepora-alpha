import {nativeCompute} from '../native-state.mjs';
/** Rust token estimation; calibration persistence and per-instance caching stay
 * in this thin service facade until the complete runtime moves to Rust. */
export const rawTokens=text=>nativeCompute('tokens.raw',{text:String(text??'')});
export const messageTokens=message=>nativeCompute('tokens.message',{message});
export const messagesTokens=messages=>nativeCompute('tokens.messages',{messages});
export const toolsTokens=tools=>nativeCompute('tokens.tools',{tools});

/** Per-model multiplicative correction, learnt from the prompt sizes providers report. */
export class TokenCalibration{
 constructor(store){this.store=store;this.cache=new Map();}
 key(identity){return 'token-ratio:'+identity;}
 ratio(identity){
  if(!identity)return 1;if(this.cache.has(identity))return this.cache.get(identity);
  const saved=this.store?.value(this.key(identity))?.ratio;const r=Number.isFinite(saved)?saved:1;this.cache.set(identity,r);return r;
 }
 estimate(identity,raw){return nativeCompute('tokens.estimate',{raw,ratio:this.ratio(identity)});}
 /** `estimated` is the raw estimate of what was sent, `actual` the provider's input token count. */
 observe(identity,estimated,actual){
  if(!identity||!(estimated>200)||!(actual>0))return this.ratio(identity);
  const next=nativeCompute('tokens.observe',{identity,estimated,actual,ratio:this.ratio(identity)});
  this.cache.set(identity,next);this.store?.value(this.key(identity),{ratio:next,at:new Date().toISOString()});return next;
 }
}
