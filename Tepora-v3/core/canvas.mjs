import {invariant} from './policy.mjs';
/** Conversational canvas: one visual artifact built by talking.
 * The model streams plain content (no provider tool-call buffering) and this module turns it back into
 * the canvas tool protocol: create_artifact(summary, html) and patch_artifact(summary, ops).
 * Ops are applied by the web client against its own version log; this service keeps no canvas state.
 */
export const CANVAS_LIMITS=Object.freeze({text:4000,html:200000,history:12,historyText:2000,versions:30,ops:400,output:16000});

const CANVAS_BASE=`You are the "second pair of hands" for a user who builds ONE visual artifact on a canvas by talking.
Choose the medium yourself from the request: an illustration, a circuit schematic, a UI/web page, a diagram or chart, or a mix. Ask ONE short question instead only if the request is truly ambiguous.
The artifact is one self-contained HTML fragment filling a sandboxed iframe. It changes only through two operations:
- create_artifact(summary, html): the first version, a totally new idea, or a rebuild in another medium; keep subject, colours and ids where they still fit.
- patch_artifact(summary, ops): every revision, as small diffs addressed by data-id. set {id, attrs?, style?, text?}, add {parent, html, before?}, remove {id}, replace {id, html}.
Rules:
- REPLY: exactly ONE short spoken-style sentence in the user's language (Japanese unless they write otherwise), e.g. 「炎を赤くしますね。」. No markdown, no ids. "summary" = caption <= 20 Japanese chars.
- Every element you may edit later has a unique, short, meaningful data-id ("nose", "R1", "chart-title"). Keep ids stable across versions.
- Build in a natural order (structure, then details, then decoration) so the canvas visibly grows; prefer many small ops over one huge replace.
- GROUPING: each logical object is a group (<g data-id="flame"> with its parts inside).
- SIZE/COLOUR WORDS: "大きく" = at least 1.4x, "小さく" <= 0.7x, "赤く" = clearly saturated red (#e02020-ish).
- Fragment only: no <html>/<head>/<body>, no scripts, no event-handler attributes, no external resources or network. Inline <style> is fine. url(#x)/href="#x" targets need a real id="x".
- Look good: thoughtful colours, spacing, typography. Text font: 'Hiragino Sans','Yu Gothic','Noto Sans JP',sans-serif.
- LAYOUT HYGIENE: text never overlaps text, shapes or wires; nothing outside the canvas/viewBox; no empty groups or leftovers.
MEDIA (use what fits; mix freely):
- PICTURE: <svg data-id="scene" viewBox="0 0 800 600" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">, first <rect data-id="bg" width="800" height="600">, then <g> groups in drawing order. A first "ロケットを描いて" is already a complete picture (8-20 elements).
- CIRCUIT: <div data-id="sheet"><svg data-id="schematic" viewBox=...> with standard symbols, parts as <g data-id="R1">, wires as orthogonal <polyline data-id="W1" class="wire" fill="none"> ending exactly on pins, labels like "R1 330Ω" beside the symbol.
- UI / DIAGRAM / CHART: <div data-id="app"> with semantic HTML and <style data-id="app-style">; nodes, cards and buttons get ids. Charts are inline SVG with axes, one <rect data-id="bar-1"> per bar, value labels and a title.`;

const CANVAS_CREATE_FORMAT=`OUTPUT FORMAT FOR THIS TURN (no tools are available; the canvas gets a brand-new artifact):
Write exactly this, nothing else:
<reply>ONE short spoken-style sentence in the user's language</reply>
<summary>caption (<= 20 Japanese chars)</summary>
then immediately the complete artifact HTML (what create_artifact's html would be), raw, no code fences, nothing after it.
If the request is too ambiguous to make anything sensible, write only one short clarifying question as plain text instead.`;

const CANVAS_PATCH_FORMAT=`OUTPUT FORMAT FOR THIS TURN (no tools are available; you EDIT the current artifact in place):
Write exactly this, nothing else:
<reply>ONE short spoken-style sentence in the user's language</reply>
<summary>caption (<= 20 Japanese chars)</summary>
then the patch_artifact ops, ONE compact JSON object per line (no array, no code fences, no comments), e.g.
{"op":"set","id":"bg","attrs":{"fill":"#0b1030"}}
{"op":"add","parent":"scene","html":"<g data-id=\\"rocket\\">...</g>"}
Ops: set (attrs/style/text of id), add (html into parent, optional before), replace (id with html that keeps the same data-id), remove.
Never replace the top container to restyle: change its parts. Put small in-place changes first and each big addition on its own line.`;

export function canvasSystemPrompt(mode){return `${CANVAS_BASE}\n\n${mode==='patch'?CANVAS_PATCH_FORMAT:CANVAS_CREATE_FORMAT}`;}

const REBUILD=/(スライド|プレゼン|回路|図|イラスト|絵|画面|ページ|UI|グラフ|チャート)[^。]{0,12}(にして|に変えて|に変換|で作り直|化して|にしたい)|作り直して|最初から/i;
/** A new artifact streams as raw markup; an edit streams as one op per line. */
export function canvasMode(input){return !input.artifact||REBUILD.test(input.text)?'create':'patch';}

export function validateCanvasTurn(b){
 invariant(b&&typeof b==='object'&&!Array.isArray(b),'Invalid canvas request');
 invariant(typeof b.text==='string'&&b.text.trim()&&b.text.length<=CANVAS_LIMITS.text,'依頼の文章を入力してください。');
 let artifact=null;
 if(b.artifact!=null){
  invariant(typeof b.artifact.html==='string'&&b.artifact.html.length<=CANVAS_LIMITS.html,'Canvas artifact is too large',413);
  invariant(Number.isSafeInteger(b.artifact.version)&&b.artifact.version>0,'Invalid canvas version');
  artifact={html:b.artifact.html,version:b.artifact.version};
 }
 const history=Array.isArray(b.history)?b.history.slice(-CANVAS_LIMITS.history).filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.text==='string').map(m=>({role:m.role,text:m.text.slice(0,CANVAS_LIMITS.historyText)})):[];
 const versions=Array.isArray(b.versions)?b.versions.slice(-CANVAS_LIMITS.versions).filter(v=>v&&Number.isSafeInteger(v.n)&&typeof v.caption==='string').map(v=>({n:v.n,caption:v.caption.slice(0,80)})):[];
 return {text:b.text.trim(),artifact,history,versions};
}

export function canvasMessages(input,mode=canvasMode(input)){
 const lines=['','---','[Canvas context]'];
 if(input.artifact){
  if(mode==='create')lines.push('The user wants the canvas rebuilt: answer in the OUTPUT FORMAT above with the COMPLETE new artifact. Reuse subject, palette and ids where they fit.');
  lines.push(`Current artifact = version ${input.artifact.version}:`,'```html',input.artifact.html,'```');
 }else lines.push('The canvas is empty: answer in the OUTPUT FORMAT above.');
 if(input.versions.length)lines.push('Versions: '+input.versions.map(v=>`v${v.n} ${v.caption}`).join(' | '));
 return [{role:'system',content:canvasSystemPrompt(mode)},...input.history.map(m=>({role:m.role,content:m.text})),{role:'user',content:input.text+lines.join('\n')}];
}

const firstSentence=s=>s.trim().replace(/[。.!！]$/,'').slice(0,24);

/** Streamed create: <reply>…</reply><summary>…</summary> then raw markup until the end (or a closing fence). */
export function canvasCreateParser(){
 let buf='',phase='head',html='',started=false;const head={reply:'',summary:''},out=[];
 const reply=t=>{if(t){head.reply+=t;out.push({type:'reply',delta:t});}};
 const start=()=>{phase='html';started=true;out.push({type:'tool.start',name:'create_artifact',summary:head.summary.trim()||firstSentence(head.reply)});};
 const pushHtml=s=>{
  if(!s)return;
  invariant(html.length+s.length<=CANVAS_LIMITS.html,'Canvas artifact exceeded its size limit',502);
  html+=s;out.push({type:'tool.html',delta:s});
 };
 const step=final=>{
  if(phase==='html'){
   const f=buf.indexOf('```');
   if(f>=0){pushHtml(buf.slice(0,f).replace(/\s+$/,''));buf=buf.slice(f+3).replace(/^[a-z]*\n?/i,'');phase='tail';return true;}
   // Hold back trailing whitespace and a possible half-written closing fence.
   const cut=final?buf.length:/\s*`{0,2}$/.exec(buf).index;
   pushHtml(final?buf.replace(/\s+$/,''):buf.slice(0,cut));buf=final?'':buf.slice(cut);return false;
  }
  if(phase==='tail'){if(!head.tail)buf=buf.replace(/^\s+/,'');if(buf){head.tail=true;reply(buf);}buf='';return false;}
  if(phase!=='head'){
   const close=`</${phase}>`,e=buf.indexOf(close),take=e>=0?buf.slice(0,e):final?buf:buf.slice(0,Math.max(0,buf.length-close.length));
   if(phase==='reply')reply(take);else head[phase]+=take;
   buf=buf.slice(take.length);if(e<0)return false;buf=buf.slice(close.length);phase='head';return true;
  }
  buf=buf.replace(/^\s+/,'');if(!buf)return false;
  if(!final&&/^`{1,2}$/.test(buf))return false;
  if(buf.startsWith('```')){const nl=buf.indexOf('\n');if(nl<0&&!final)return false;buf=nl<0?'':buf.slice(nl+1);return true;}
  if(buf[0]==='<'){
   for(const tag of ['reply','summary']){const open=`<${tag}>`;if(buf.startsWith(open)){buf=buf.slice(open.length);phase=tag;return true;}if(!final&&open.startsWith(buf))return false;}
   if(buf.length<2&&!final)return false;
   start();return true;
  }
  const nx=buf.search(/<|```/),t=nx>=0?buf.slice(0,nx):final?buf:buf.replace(/`{1,2}$/,'');reply(t);buf=buf.slice(t.length);return nx>=0;
 };
 return {
  push(delta){buf+=delta;while(step(false));return out.splice(0);},
  end(){while(step(true));if(started)out.push({type:'tool.end',name:'create_artifact',args:{summary:head.summary.trim()||firstSentence(head.reply),html}});return out.splice(0);}
 };
}

/** Streamed patch: <reply>/<summary> then one JSON op per line; each op is released when its line completes. */
export function canvasPatchParser(){
 let buf='',phase='head',pending='',summary='',replyText='',started=false;const ops=[],out=[];
 const caption=()=>summary.trim()||firstSentence(replyText);
 const emitOp=value=>{
  const list=Array.isArray(value)?value:Array.isArray(value?.ops)?value.ops:[value];
  for(const op of list){
   if(!op||typeof op!=='object'||!op.op||ops.length>=CANVAS_LIMITS.ops)continue;
   if(!started){started=true;out.push({type:'tool.start',name:'patch_artifact',summary:caption()});}
   ops.push(op);out.push({type:'tool.op',op});
  }
 };
 const line=l=>{
  const s=l.trim();
  if(!pending&&(!s||s.startsWith('```')||/^[[\]],?$/.test(s)))return;
  if(!pending&&/^(<|[|｜])/.test(s))return; // leaked tool-call markup
  if(!pending&&!/^[{[]/.test(s)){replyText+=s;out.push({type:'reply',delta:(replyText.length>s.length?' ':'')+s});return;}
  pending+=(pending?'\n':'')+s;
  const p=pending.replace(/,$/,''),q=p.slice(0,p.lastIndexOf('}')+1).replace(/^\[\s*/,'');
  for(const c of [p,p.replace(/^\[\s*/,''),p.replace(/\s*\]$/,''),p.replace(/^\[\s*/,'').replace(/\s*\]$/,''),q]){try{emitOp(JSON.parse(c));pending='';return;}catch{/* not complete yet */}}
  if(pending.length>60000)pending='';
 };
 const step=final=>{
  if(phase==='ops'){const nl=buf.indexOf('\n');if(nl<0){if(final&&buf){line(buf);buf='';}return false;}line(buf.slice(0,nl));buf=buf.slice(nl+1);return true;}
  if(phase==='reply'||phase==='summary'){
   const close=`</${phase}>`,e=buf.indexOf(close),take=e>=0?buf.slice(0,e):final?buf:buf.slice(0,Math.max(0,buf.length-close.length));
   if(phase==='reply'){replyText+=take;if(take)out.push({type:'reply',delta:take});}else summary+=take;
   buf=buf.slice(take.length);if(e<0)return false;buf=buf.slice(close.length);phase='head';return true;
  }
  buf=buf.replace(/^\s+/,'');if(!buf)return false;
  for(const tag of ['reply','summary']){const open=`<${tag}>`;if(buf.startsWith(open)){buf=buf.slice(open.length);phase=tag;return true;}if(!final&&open.startsWith(buf))return false;}
  phase='ops';return true;
 };
 return {
  push(delta){buf+=delta;while(step(false));return out.splice(0);},
  end(){while(step(true));if(pending)line('');if(started)out.push({type:'tool.end',name:'patch_artifact',args:{summary:caption(),ops}});return out.splice(0);}
 };
}

/** One canvas turn through Tepora's provider layer. `invoke` is ProviderRegistry.invoke (or a test double). */
export async function runCanvasTurn(invoke,input,{signal,emit}){
 const mode=canvasMode(input),fresh=()=>mode==='create'?canvasCreateParser():canvasPatchParser();let parser=fresh();
 emit({type:'turn',mode});
 let streamed=false;
 const answer=await invoke('work',canvasMessages(input,mode),{tools:[],signal,maxTokens:CANVAS_LIMITS.output,
  onDelta:delta=>{if(!delta)return;streamed=true;for(const e of parser.push(String(delta)))emit(e);},
  onRoute:route=>{
   // The registry may retry or fall back after a partial stream; the client drops that partial turn.
   if(streamed){parser=fresh();streamed=false;emit({type:'reset'});}
   emit({type:'route',model:route.model,domain:route.domain});
  }});
 // A provider that does not stream still returns the whole answer.
 if(!streamed&&typeof answer?.content==='string')for(const e of parser.push(answer.content))emit(e);
 for(const e of parser.end())emit(e);
 emit({type:'done',mode});
}
