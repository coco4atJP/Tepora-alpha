/** Pure parts of the home evaluation (scripts/eval-home.mjs): scenario validation, synthetic utterance audio,
 * simulated costs, the per-host summary and the Node/Rust comparison. No host, network or model here. */
import {createHash} from 'node:crypto';
import {invariant} from '../core/policy.mjs';

const COSTS=['wake','sttBase','sttPerSecond','llmFirstToken','llmPerChar','ttsFirstAudio'];
const text=(v,label)=>invariant(typeof v==='string'&&v.trim()&&v.length<=400,`${label} must be non-empty text`);
function turn(t,label,ids){
 invariant(t&&typeof t==='object'&&typeof t.id==='string'&&/^[\w-]{1,40}$/.test(t.id)&&!ids.has(t.id),`${label}: unique id required`);ids.add(t.id);
 text(t.say,`${t.id}.say`);text(t.reply,`${t.id}.reply`);
 invariant(Number.isFinite(t.seconds)&&t.seconds>=0.3&&t.seconds<=3,`${t.id}.seconds must be 0.3–3`);
 if(t.remember!==undefined)text(t.remember,`${t.id}.remember`);
 if(t.recall!==undefined){text(t.recall?.query,`${t.id}.recall.query`);text(t.recall?.expect,`${t.id}.recall.expect`);}
 invariant([t.remember,t.recall,t.interruptedBy].filter(x=>x!==undefined).length<=1,`${t.id}: one of remember, recall or interruptedBy`);
 if(t.interruptedBy!==undefined){invariant(!t.interruptedBy.interruptedBy&&!t.interruptedBy.remember&&!t.interruptedBy.recall,`${t.id}.interruptedBy is a plain turn`);turn(t.interruptedBy,`${t.id}.interruptedBy`,ids);}
}
export function validateScenario(s){
 invariant(s&&typeof s==='object'&&s.costs&&s.budget&&Array.isArray(s.days)&&s.days.length>=2,'A scenario needs costs, budget and at least two days');
 for(const k of COSTS)invariant(Number.isFinite(s.costs[k])&&s.costs[k]>=0,`costs.${k} must be a non-negative number`);
 invariant(Number.isFinite(s.budget.wakeToAudioMs)&&s.budget.wakeToAudioMs>0,'budget.wakeToAudioMs must be positive');
 const ids=new Set();s.days.forEach((d,i)=>{invariant(Array.isArray(d?.turns)&&d.turns.length>0,`day ${i+1} needs turns`);d.turns.forEach((t,j)=>turn(t,`day ${i+1} turn ${j+1}`,ids));});
 const all=s.days.flatMap(d=>d.turns);
 invariant(all.some(t=>t.remember)&&all.some(t=>t.recall)&&all.some(t=>t.interruptedBy),'A scenario must exercise remember, recall and barge-in');
 for(const r of all.filter(t=>t.recall)){const day=s.days.findIndex(d=>d.turns.includes(r));invariant(s.days.slice(0,day).some(d=>d.turns.some(t=>t.remember?.includes(r.recall.expect))),`${r.id} must recall a fact remembered on an earlier day`);}
 return s;
}

/** A short 8 kHz mono 16-bit WAV that is distinct per utterance id. It stands in for recorded speech: the fake
 * transcriber recognises it by its digest, so the host's real upload and STT routing are exercised. */
export function utteranceAudio(t){
 const rate=8000,n=Math.round(t.seconds*rate),seed=createHash('sha256').update(t.id).digest(),hz=180+seed.readUInt16BE(0)%320;
 const wav=Buffer.alloc(44+n*2);wav.write('RIFF',0);wav.writeUInt32LE(36+n*2,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(n*2,40);
 for(let i=0;i<n;i++){const env=Math.min(1,i/400,(n-i)/400);wav.writeInt16LE(Math.round(9000*env*Math.sin(2*Math.PI*hz*i/rate)*(0.6+0.4*Math.sin(2*Math.PI*3*i/rate))),44+i*2);}
 return wav;
}
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const sttCost=(costs,seconds)=>Math.round(costs.sttBase+costs.sttPerSecond*seconds);
export const llmCost=(costs,content)=>Math.round(costs.llmFirstToken+costs.llmPerChar*[...content].length);

/** Host-independent figures only: simulated latency, model rounds and outcomes. Wall time stays out of the diff. */
export function summarize(host,turns,{unsolicited,budget}){
 const timed=turns.filter(t=>Number.isFinite(t.wakeToAudioMs)).map(t=>t.wakeToAudioMs).sort((a,b)=>a-b);
 const of=kind=>{const list=turns.filter(t=>t.kind===kind);return {tried:list.length,ok:list.filter(t=>t.ok).length};};
 const metrics={turns:turns.length,ok:turns.filter(t=>t.ok).length,
  wakeToAudioMs:{p50:timed.length?timed[Math.floor((timed.length-1)/2)]:null,max:timed.length?timed.at(-1):null,budget,over:timed.filter(v=>v>budget).length},
  bargeIn:of('barge-in'),recall:of('recall'),proactive:{unsolicited,appropriateness:'not measured until T3'}};
 const passed=metrics.ok===metrics.turns&&metrics.wakeToAudioMs.over===0&&unsolicited===0;
 return {host,passed,metrics,turns};
}

/** Differences between two host summaries on the host-independent fields (the Node host is the oracle). */
export function compare(a,b){
 const strip=s=>({metrics:s.metrics,turns:s.turns.map(({wallMs,...t})=>t)}),x=strip(a),y=strip(b),out=[];
 (function walk(p,u,v){
  if(u&&v&&typeof u==='object'&&typeof v==='object'){for(const k of new Set([...Object.keys(u),...Object.keys(v)]))walk(p?`${p}.${k}`:k,u[k],v[k]);return;}
  if(JSON.stringify(u)!==JSON.stringify(v))out.push({path:p,[a.host]:u??null,[b.host]:v??null});
 })('',x,y);
 return out;
}
