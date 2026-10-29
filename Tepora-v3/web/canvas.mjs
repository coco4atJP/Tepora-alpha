import {canvasApplyOps} from './canvas-engine.mjs';
/** The canvas view: a live window onto the shared canvas board.
 * Agents (the conversation and work agents) draw through their `canvas` tool; this view follows their progress
 * from `canvas.stream` / `canvas.updated` events. The user's own hands (select, remove, undo) go to /api/canvas/*,
 * and the composer talks to the conversation, so there is one canvas and one way to ask for things.
 */
export function createCanvasView({request,say,escape,icon,preview=false,onError=()=>{},onStop=()=>{},lastReply=()=>''}){
 let board={version:0,caption:'',html:'',versions:[],selection:null,live:null},live=null,root=null,frame=null,ready=false,queued=0,lastShown=null,loading=null,sending=false,error='';
 const q=s=>root?.querySelector(s);
 const shown=()=>live?live.html:board.html;
 const post=()=>{
  queued=0;if(!frame||!ready)return;
  const html=shown(),selected=live?null:board.selection?.id||null,key=html+'\u0000'+selected;if(key===lastShown)return;lastShown=key;
  frame.contentWindow?.postMessage({__lc:1,type:'render',html,animate:true,selected,version:live?null:board.version||null},'*');
 };
 const schedule=()=>{if(!queued)queued=requestAnimationFrame(post);};
 const refresh=()=>{
  if(preview)return Promise.resolve();
  loading||=request('/api/canvas').then(s=>{board=s;if(s.live&&!live)live={...s.live,html:s.html};}).catch(e=>{error=e.message;}).finally(()=>{loading=null;paint();});
  return loading;
 };
 const act=async(p,body)=>{error='';try{const s=await request(p,'POST',body);if(s&&'html' in s)board=s;else await refresh();}catch(e){error=e.message;onError(e);}paint();};
 const select=id=>{board={...board,selection:id?{id,version:board.version}:null};paint();act('/api/canvas/select',{id:id||null,version:board.version});};
 const onMessage=e=>{
  if(!frame||e.source!==frame.contentWindow)return;const d=e.data;if(d?.__lc!==1)return;
  if(d.type==='ready'){ready=true;lastShown=null;post();}
  if(d.type==='select'&&!live&&board.version){const id=typeof d.id==='string'&&d.id.length<=200?d.id:null;if(id!==(board.selection?.id||null))select(id);}
 };
 const who=by=>by?.kind==='user'?'あなた':by?.title||'エージェント';
 const logHTML=()=>{
  const items=board.versions.slice(-6).map(v=>`<li class="canvas-msg is-version${v.by?.kind==='user'?' is-user-edit':''}"><b>v${v.n}</b> ${escape(v.caption)}<span class="canvas-tool">${escape(who(v.by))}</span></li>`);
  const reply=lastReply();if(reply&&!live)items.push(`<li class="canvas-msg is-assistant">${escape(reply)}</li>`);
  if(live)items.push(`<li class="canvas-msg is-assistant is-live">${escape(who(live.by))}が${live.action==='create'?'描いています':'手直ししています'}${live.caption?`<span class="canvas-tool">${escape(live.caption)}</span>`:''}</li>`);
  return items.join('')||'<li class="canvas-empty">話しかけると、会話や仕事のエージェントがここに描きます。例: 「夜空を飛ぶロケットを描いて」「LEDを光らせる回路図」。作品をクリックすると、その部分を選んで「これ」と指せます。</li>';
 };
 const paint=()=>{
  if(!root)return;
  const log=q('.canvas-log');if(log){const follow=log.scrollHeight-log.scrollTop-log.clientHeight<60;log.innerHTML=logHTML();if(follow)log.scrollTop=log.scrollHeight;}
  q('.canvas-version').textContent=live?`${who(live.by)}が${live.action==='create'?'描いています…':'手直し中…'}`:board.version?`v${board.version} · ${board.caption}`:'まだ何もありません';
  root.classList.toggle('is-live',!!live);
  const sel=q('.canvas-selection'),id=board.selection?.id;
  if(sel){sel.hidden=!id||!!live;if(id)q('.canvas-selection-id').textContent=id;}
  q('[data-canvas-action="undo"]').disabled=!!live||board.versions.length<2;
  const stop=q('[data-canvas-action="stop"]');if(stop)stop.hidden=!live;
  q('[data-canvas-action="send"]').disabled=sending;
  const err=q('.canvas-error');err.hidden=!error;err.textContent=error;
  schedule();
 };
 const send=async()=>{
  const input=q('#canvas-input'),text=input?.value.trim();if(!text||sending)return;
  sending=true;error='';paint();
  try{await say(text);input.value='';}catch(e){error=e.message;onError(e);}
  finally{sending=false;paint();q('#canvas-input')?.focus();}
 };
 const expand=(on=!root?.classList.contains('is-expanded'))=>{if(!root)return;root.classList.toggle('is-expanded',on);document.body.classList.toggle('canvas-expanded',on);
  const b=q('[data-canvas-action="expand"]');if(b){b.setAttribute('aria-pressed',String(on));b.title=on?'元の大きさに戻す':'大きく表示';b.setAttribute('aria-label',b.title);}};
 const actions={send,stop:()=>onStop(live?.by),
  undo:()=>act('/api/canvas/edit',{action:'revert'}),
  remove:()=>{const id=board.selection?.id;if(id)act('/api/canvas/edit',{action:'remove',id});},
  deselect:()=>select(null),expand:()=>expand()};
 const onClick=e=>{const el=e.target.closest('[data-canvas-action]');if(el&&root.contains(el)){e.preventDefault();actions[el.dataset.canvasAction]?.();}};
 const onKey=e=>{if(e.key==='Escape'&&root?.classList.contains('is-expanded')){expand(false);return;}if(e.target.id==='canvas-input'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}};
 const selectionHTML=`<p class="canvas-selection" hidden><span>選択中: <b class="canvas-selection-id"></b></span><button type="button" class="text-button" data-canvas-action="remove">消す</button><button type="button" class="text-button" data-canvas-action="deselect">選択をやめる</button></p>`;
 return {
  /** layout 'page' fills a view; 'card' is a compact panel (frame, latest activity, one-line composer). */
  html({layout='page',title='キャンバス',expandable=false}={}){
   const frameHTML=preview?'<p class="canvas-preview-note">プレビュー表示ではキャンバスを動かせません。Teporaを起動して開いてください。</p>':'<iframe class="canvas-frame" title="キャンバスの作品" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/canvas/frame"></iframe>';
   const stop=`<button type="button" class="button secondary" data-canvas-action="stop" aria-label="止める" title="止める" hidden>${icon('stop')}</button>`;
   if(layout==='card')return `<section id="canvas-view" class="canvas-view is-card" aria-labelledby="canvas-title">
 <header class="canvas-card-head"><h2 id="canvas-title">${escape(title)}</h2><p class="canvas-version" aria-live="polite"></p>
  <div class="canvas-card-tools"><button type="button" class="icon-button" data-canvas-action="undo" aria-label="ひとつ戻す" title="ひとつ戻す">${icon('undo')}</button>${expandable?`<button type="button" class="icon-button" data-canvas-action="expand" aria-pressed="false" aria-label="大きく表示" title="大きく表示">${icon('expand')}</button>`:''}</div></header>
 <div class="canvas-stage">${frameHTML}</div>
 <div class="canvas-side">
  <ol class="canvas-log"></ol>
  ${selectionHTML}
  <p class="canvas-error" role="alert" hidden></p>
  <div class="canvas-compose is-inline">
   <label class="visually-hidden" for="canvas-input">会話に話しかける</label>
   <textarea id="canvas-input" rows="1" maxlength="4000" placeholder="例: 夜空を飛ぶロケットを描いて"></textarea>
   <button type="button" class="button" data-canvas-action="send" aria-label="送る" title="送る">${icon('send')}</button>${stop}
  </div>
 </div>
</section>`;
   return `<section id="canvas-view" class="canvas-view" aria-labelledby="canvas-title">
 <div class="canvas-side">
  <header class="canvas-head"><h1 id="canvas-title">キャンバス</h1><p>会話と仕事のエージェントが描く、ひとつの作品です。クリックで部分を選べます。</p></header>
  <ol class="canvas-log"></ol>
  ${selectionHTML}
  <p class="canvas-error" role="alert" hidden></p>
  <div class="canvas-compose">
   <label class="visually-hidden" for="canvas-input">会話に話しかける</label>
   <textarea id="canvas-input" rows="3" maxlength="4000" placeholder="例: 夜空を飛ぶロケットを描いて"></textarea>
   <p class="canvas-hint">Enterで送信 · Shift+Enterで改行</p>
   <div class="canvas-row">
    <button type="button" class="text-button" data-canvas-action="undo">${icon('undo')}<span>ひとつ戻す</span></button>
    <button type="button" class="button" data-canvas-action="send">${icon('send')}<span>送る</span></button>${stop}
   </div>
  </div>
 </div>
 <div class="canvas-stage">
  <p class="canvas-version" aria-live="polite"></p>
  ${frameHTML}
 </div>
</section>`;
  },
  mount(host){
   this.unmount();root=host.querySelector('#canvas-view');if(!root)return;
   frame=root.querySelector('.canvas-frame');ready=false;lastShown=null;
   root.addEventListener('click',onClick);root.addEventListener('keydown',onKey);addEventListener('message',onMessage);paint();refresh();
  },
  unmount(){if(root){expand(false);root.removeEventListener('click',onClick);root.removeEventListener('keydown',onKey);}removeEventListener('message',onMessage);root=null;frame=null;ready=false;},
  /** Board snapshot from bootstrap. */
  accept(snapshot){if(snapshot&&typeof snapshot==='object'){board={...board,...snapshot};if(!snapshot.live)live=null;paint();}},
  /** canvas.updated / canvas.stream from the event stream. */
  event(type,data){
   if(type==='canvas.updated'){if(data.version!==board.version||data.revision!==board.revision)refresh();return;}
   if(type!=='canvas.stream')return;
   if(data.kind==='start'){live={turn:data.turn,action:data.action,by:data.by,caption:data.caption||'',html:data.action==='create'?'':board.html};}
   else if(!live||live.turn!==data.turn){if(data.kind==='end')refresh();return;}
   else if(data.kind==='html')live.html=String(data.html||'');
   else if(data.kind==='op'){try{live.html=canvasApplyOps(live.html,[data.op]).html;}catch{}}
   else if(data.kind==='end'){live.done=true;refresh().then(()=>{if(live?.done)live=null;paint();});return;}
   else if(data.kind==='abort')live=null;
   paint();
  },
  repaint:paint,
  mounted:()=>!!root&&root.isConnected,
  busy:()=>!!live||sending,
  live:()=>live?{action:live.action,by:live.by,caption:live.caption}:null,
  stop:()=>onStop(live?.by)
 };
}
