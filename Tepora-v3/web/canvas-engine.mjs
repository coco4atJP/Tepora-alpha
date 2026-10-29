/** Canvas engine: pure functions for the conversational canvas (ported from live-canvas's patch/version engine).
 * DOM work uses an inert DOMParser document, so model markup never runs in the app page.
 * Every top-level name starts with `canvas` because the web bundle shares one scope.
 */
const CANVAS_OP_ALIASES={set:'set',update:'set',modify:'set',setattrs:'set',setattributes:'set',setstyle:'set',settext:'set',style:'set',attr:'set',attrs:'set',text:'set',add:'add',insert:'add',append:'add',create:'add',remove:'remove',delete:'remove',replace:'replace',swap:'replace'};

/** Normalise loosely-shaped ops coming from a model. Returns null when unusable. */
export function canvasNormalizeOp(raw){
 if(!raw||typeof raw!=='object')return null;
 const kind=CANVAS_OP_ALIASES[String(raw.op??raw.type??raw.action??'').toLowerCase().replace(/[_\s-]/g,'')];
 const id=raw.id??raw.target??raw.dataId??raw['data-id'];
 if(kind==='set')return id?{op:'set',id:String(id),attrs:raw.attrs,style:raw.style,text:typeof raw.text==='string'?raw.text:undefined}:null;
 if(kind==='add')return typeof raw.html==='string'?{op:'add',parent:raw.parent??raw.parentId??null,before:raw.before??null,html:raw.html}:null;
 if(kind==='remove')return id?{op:'remove',id:String(id)}:null;
 if(kind==='replace')return id&&typeof raw.html==='string'?{op:'replace',id:String(id),html:raw.html}:null;
 return null;
}

const canvasSel=id=>`[data-id="${String(id).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"]`;
const canvasAsMap=v=>{if(v==null)return undefined;if(typeof v==='string'){try{const p=JSON.parse(v);return p&&typeof p==='object'?p:undefined;}catch{return undefined;}}return typeof v==='object'?v:undefined;};
const canvasKebab=k=>k.startsWith('--')?k:k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());

export function canvasParseStyle(s){const m=new Map();for(const part of (s||'').split(';')){const i=part.indexOf(':');if(i>0)m.set(part.slice(0,i).trim(),part.slice(i+1).trim());}return m;}
function canvasMergeStyle(el,style){
 const m=canvasParseStyle(el.getAttribute('style'));
 for(const [k,v] of Object.entries(style)){if(v==null||v==='')m.delete(canvasKebab(k));else m.set(canvasKebab(k),String(v));}
 const out=[...m].map(([k,v])=>`${k}: ${v}`).join('; ');if(out)el.setAttribute('style',out);else el.removeAttribute('style');
}
function canvasSetText(el,text){
 if(!el.children.length){el.textContent=text;return;}
 const t=[...el.childNodes].find(n=>n.nodeType===3&&n.nodeValue.trim());
 if(t)t.nodeValue=text;else el.insertBefore(el.ownerDocument.createTextNode(text),el.firstChild);
}
/** Tolerant lookup for a slightly misremembered id; resolves only when exactly one id matches. */
export function canvasFuzzyFind(root,id){
 if(!id)return null;const low=String(id).toLowerCase(),all=[...root.querySelectorAll('[id],[data-id]')];
 const key=el=>(el.getAttribute('data-id')||el.id||'').toLowerCase();
 const pick=pred=>{const hits=all.filter(el=>{const k=key(el);return !!k&&pred(k);});return hits.length===1?hits[0]:null;};
 return pick(k=>k===low)??pick(k=>low.endsWith('-'+k)||low.endsWith('_'+k))??pick(k=>k.endsWith('-'+low)||k.endsWith('_'+low));
}
const canvasIdsIn=html=>[...String(html).matchAll(/data-id\s*=\s*["']([^"']+)["']/g)].map(m=>m[1]);

/** Applies one normalised op to a live root element (mutates). */
export function canvasApplyOp(root,op){
 const find=id=>root.querySelector(canvasSel(id))??canvasFuzzyFind(root,id);
 try{
  if(op.op==='set'){
   const el=find(op.id);if(!el)return {ok:false,error:`set: id "${op.id}" not found`};
   const attrs=canvasAsMap(op.attrs);
   if(attrs)for(const [k,v] of Object.entries(attrs)){if(k==='data-id'||/^on/i.test(k))continue;if(v==null)el.removeAttribute(k);else el.setAttribute(k,String(v));}
   const style=canvasAsMap(op.style);if(style)canvasMergeStyle(el,style);
   if(typeof op.text==='string')canvasSetText(el,op.text);
   return {ok:true};
  }
  if(op.op==='add'){
   const parent=op.parent?find(op.parent):root;if(!parent)return {ok:false,error:`add: parent "${op.parent}" not found`};
   const before=op.before?find(op.before):null;
   if(before&&before.parentElement===parent)before.insertAdjacentHTML('beforebegin',op.html);else parent.insertAdjacentHTML('beforeend',op.html);
   return {ok:true};
  }
  if(op.op==='remove'){find(op.id)?.remove();return {ok:true};} // idempotent: models remove ids they only guessed
  if(op.op==='replace'){
   const el=find(op.id);
   if(!el){
    // A guessed id: add the content to the top container, unless any of its ids already exists.
    const ids=canvasIdsIn(op.html),top=root.children.length===1?root.firstElementChild:root;
    if(!ids.length||ids.some(i=>root.querySelector(canvasSel(i))))return {ok:false,error:`replace: id "${op.id}" not found`};
    top.insertAdjacentHTML('beforeend',op.html);return {ok:true};
   }
   // Replacing the whole top container must not wipe drawn parts the new markup forgot.
   const fresh=new Set(canvasIdsIn(op.html)),keep=el.parentElement===root?[...el.children].filter(c=>{const cid=c.getAttribute('data-id');return cid&&!fresh.has(cid);}):[];
   el.insertAdjacentHTML('afterend',op.html);el.remove();
   if(keep.length){const ne=find(op.id);if(ne)for(const c of keep)ne.appendChild(c);}
   return {ok:true};
  }
 }catch(error){return {ok:false,error:String(error?.message||error)};}
 return {ok:false,error:'unknown op'};
}

export function canvasParseFragment(html,Parser=globalThis.DOMParser){
 if(!Parser)throw new Error('DOMParser is unavailable');
 const doc=new Parser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`,'text/html');return doc.body;
}
const canvasListIds=root=>[...root.querySelectorAll('[data-id]')].map(e=>e.getAttribute('data-id'));

/** Applies ops to an HTML string; failed ops are skipped and reported. */
export function canvasApplyOps(html,ops,Parser){
 const root=canvasParseFragment(html,Parser),before=new Set(canvasListIds(root)),results=[],changed=new Set();
 for(const raw of ops){
  const op=canvasNormalizeOp(raw);
  if(!op){results.push({ok:false,error:`invalid op: ${JSON.stringify(raw).slice(0,120)}`});continue;}
  const r=canvasApplyOp(root,op);results.push(r);if(r.ok&&(op.op==='set'||op.op==='replace'))changed.add(op.id);
 }
 const after=canvasListIds(root),afterSet=new Set(after);
 return {html:root.innerHTML,ok:results.every(r=>r.ok),results,added:after.filter(id=>!before.has(id)),changed:[...changed].filter(id=>afterSet.has(id)&&before.has(id)),removed:[...before].filter(id=>!afterSet.has(id))};
}

/** Fallback caption when the model gave no summary. */
export function canvasDescribeOps(ops){
 const c={set:0,add:0,remove:0,replace:0};for(const o of ops){const n=canvasNormalizeOp(o);if(n)c[n.op]++;}
 return [c.add&&`${c.add}件追加`,c.set&&`${c.set}件変更`,c.replace&&`${c.replace}件置換`,c.remove&&`${c.remove}件削除`].filter(Boolean).join(' / ')||'変更なし';
}

/* Append-only version log: numbered from 1, never mutated or removed. */
export function canvasAppendVersion(log,v,now=Date.now()){return [...log,{html:v.html,caption:v.caption,source:v.source,...(v.from?{from:v.from}:{}),n:log.length+1,createdAt:now}];}
export function canvasRestoreVersion(log,n,caption,source='restore'){const v=log[n-1];if(!v)throw new Error(`version ${n} not found`);return canvasAppendVersion(log,{html:v.html,caption:caption??`v${n} を復元`,source,from:n});}
export const canvasLatest=log=>log[log.length-1];

/** Canvas state: the version log, the shown html, and the turn in flight. Streamed server events fold into it. */
export function canvasInitialState(){return {versions:[],shown:'',messages:[],turn:null,error:''};}
export function canvasStartTurn(state,text){return {...state,error:'',messages:[...state.messages,{role:'user',text}],turn:{mode:null,reply:'',tool:null,summary:'',html:'',ops:[],base:canvasLatest(state.versions)?.html??''}};}

/** Folds one server event into the state. `apply(html, ops)` runs the patch engine (injected for tests). */
export function canvasReduce(state,event,apply=canvasApplyOps){
 const turn=state.turn;if(!turn)return state;
 switch(event.type){
  case 'turn':return {...state,turn:{...turn,mode:event.mode}};
  case 'reset':return {...state,shown:turn.base,turn:{...turn,reply:'',tool:null,summary:'',html:'',ops:[]}};
  case 'reply':return {...state,turn:{...turn,reply:turn.reply+event.delta}};
  case 'tool.start':return {...state,turn:{...turn,tool:event.name,summary:event.summary||''}};
  case 'tool.html':{const html=turn.html+event.delta;return {...state,shown:html,turn:{...turn,html}};}
  case 'tool.op':{const ops=[...turn.ops,event.op];return {...state,shown:apply(turn.base,ops).html,turn:{...turn,ops}};}
  case 'tool.end':{
   const create=event.name==='create_artifact',html=create?event.args.html:apply(turn.base,event.args.ops).html;
   const caption=(event.args.summary||'').trim()||(create?'新しい作品':canvasDescribeOps(event.args.ops));
   if(!create&&html===turn.base)return {...state,shown:html,turn:{...turn,tool:null}};
   return {...state,shown:html,versions:canvasAppendVersion(state.versions,{html,caption,source:create?'create':'patch'}),turn:{...turn,tool:null}};
  }
  case 'error':return {...state,error:event.error||'キャンバスの更新に失敗しました。'};
  case 'done':return canvasFinishTurn(state);
  default:return state;
 }
}
/** Ends the turn: keeps the spoken reply, and shows the latest saved version (dropping any unfinished draft). */
export function canvasFinishTurn(state,error=''){
 const turn=state.turn;if(!turn)return state;
 const reply=turn.reply.trim(),messages=reply?[...state.messages,{role:'assistant',text:reply}]:state.messages;
 return {...state,messages,turn:null,shown:canvasLatest(state.versions)?.html??'',error:error||state.error};
}
/** Undo appends a copy of the previous version; restore appends a copy of any earlier one. Nothing is erased. */
export function canvasRevert(state,n=state.versions.length-1){
 if(state.turn||!Number.isSafeInteger(n)||n<1||n>=state.versions.length)return state;
 const versions=canvasRestoreVersion(state.versions,n,`v${n} に戻す`,'revert');
 return {...state,versions,shown:canvasLatest(versions).html};
}
/** What the server needs for the next turn. */
export function canvasTurnBody(state,text){
 const v=canvasLatest(state.versions);
 return {text,artifact:v?{html:v.html,version:v.n}:null,history:state.messages.slice(-12),versions:state.versions.slice(-30).map(x=>({n:x.n,caption:x.caption}))};
}
