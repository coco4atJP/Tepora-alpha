// TEST-ONLY historical differential oracle; never import from production.
// Source: 44a5ec0bd0bb6973da275d2956540bd3a91ecadf:Tepora-v3/core/agent/tokens.mjs
// Only relative imports have been adjusted to test fixtures or unchanged helpers.
import {imageTokens} from './images.mjs';
/** Token estimates. Characters are counted by script and corrected per model from real `usage`.
 * Over-estimating is safer than under-estimating: a budget that is too small costs a compaction,
 * one that is too large costs an overflow and a retry.
 */
const WIDE=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

export function rawTokens(text){
 const s=String(text??'');if(!s)return 0;
 let wide=0;for(const ch of s)if(WIDE.test(ch))wide++;
 // Japanese/Chinese characters are close to one token each in current BPE vocabularies;
 // other text averages a little over three characters per token (code and JSON are denser).
 return Math.ceil(wide+(s.length-wide)/3.2);
}
const partTokens=p=>p?.type==='text'?rawTokens(p.text):p?.type==='image_url'?imageTokens(p.image_url?.url):0;
export function messageTokens(m){
 let n=4+(typeof m.content==='string'?rawTokens(m.content):Array.isArray(m.content)?m.content.reduce((a,p)=>a+partTokens(p),0):0);
 for(const c of m.tool_calls||[])n+=8+rawTokens(c.function?.name)+rawTokens(c.function?.arguments);
 return n;
}
export const messagesTokens=messages=>messages.reduce((n,m)=>n+messageTokens(m),0);
export const toolsTokens=tools=>tools?.length?rawTokens(JSON.stringify(tools))+tools.length*6:0;

/** Per-model multiplicative correction, learnt from the prompt sizes providers report. */
export class TokenCalibration{
 constructor(store){this.store=store;this.cache=new Map();}
 key(identity){return 'token-ratio:'+identity;}
 ratio(identity){
  if(!identity)return 1;if(this.cache.has(identity))return this.cache.get(identity);
  const saved=this.store?.value(this.key(identity))?.ratio;const r=Number.isFinite(saved)?saved:1;this.cache.set(identity,r);return r;
 }
 estimate(identity,raw){return Math.ceil(raw*this.ratio(identity));}
 /** `estimated` is the raw estimate of what was sent, `actual` the provider's input token count. */
 observe(identity,estimated,actual){
  if(!identity||!(estimated>200)||!(actual>0))return this.ratio(identity);
  const sample=Math.min(2.5,Math.max(0.35,actual/estimated)),old=this.ratio(identity),next=old+(sample-old)*0.3;
  this.cache.set(identity,next);this.store?.value(this.key(identity),{ratio:next,at:new Date().toISOString()});return next;
 }
}
