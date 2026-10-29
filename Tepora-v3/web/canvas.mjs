import {canvasInitialState,canvasStartTurn,canvasReduce,canvasFinishTurn,canvasRevert,canvasTurnBody,canvasLatest} from './canvas-engine.mjs';
/** The canvas view: a request log and composer beside one sandboxed artifact frame.
 * State lives here (in memory, per window) so switching views keeps the artifact; the server keeps nothing.
 */
export function createCanvasView({stream,escape,icon,preview=false,onError=()=>{}}){
 let state=canvasInitialState(),root=null,frame=null,ready=false,controller=null,queued=0,lastShown=null;
 const q=s=>root?.querySelector(s);
 const post=()=>{
  queued=0;if(!frame||!ready||state.shown===lastShown)return;lastShown=state.shown;
  frame.contentWindow?.postMessage({__lc:1,type:'render',html:state.shown,animate:true,version:canvasLatest(state.versions)?.n??null},'*');
 };
 const schedule=()=>{if(!queued)queued=requestAnimationFrame(post);};
 const onMessage=e=>{
  if(!frame||e.source!==frame.contentWindow)return;const d=e.data;
  if(d?.__lc===1&&d.type==='ready'){ready=true;lastShown=null;post();}
 };
 const logHTML=()=>{
  const items=state.messages.map(m=>`<li class="canvas-msg is-${m.role}">${escape(m.text)}</li>`);
  const t=state.turn;
  if(t)items.push(`<li class="canvas-msg is-assistant is-live">${escape(t.reply||(t.tool?'':'考えています…'))}${t.tool?`<span class="canvas-tool">${t.tool==='create_artifact'?'描いています':'手直ししています'}${t.summary?`: ${escape(t.summary)}`:''}</span>`:''}</li>`);
  return items.join('')||'<li class="canvas-empty">作りたいものを書いてください。例: 「夜空を飛ぶロケットを描いて」「LEDを光らせる回路図」</li>';
 };
 const paint=()=>{
  if(!root)return;
  const log=q('.canvas-log');if(log){const follow=log.scrollHeight-log.scrollTop-log.clientHeight<60;log.innerHTML=logHTML();if(follow)log.scrollTop=log.scrollHeight;}
  const v=canvasLatest(state.versions),busy=!!state.turn;
  q('.canvas-version').textContent=v?`v${v.n} · ${v.caption}`:'まだ何もありません';
  q('[data-canvas-action="send"]').hidden=busy;q('[data-canvas-action="stop"]').hidden=!busy;
  q('[data-canvas-action="undo"]').disabled=busy||state.versions.length<2;
  q('#canvas-input').disabled=busy;
  const err=q('.canvas-error');err.hidden=!state.error;err.textContent=state.error;
  schedule();
 };
 const send=async()=>{
  const input=q('#canvas-input'),text=input?.value.trim();if(!text||state.turn)return;
  const body=canvasTurnBody(state,text);input.value='';
  state=canvasStartTurn(state,text);paint();
  controller=new AbortController();
  try{await stream('/api/canvas/turn',body,event=>{state=canvasReduce(state,event);paint();},{signal:controller.signal});state=canvasFinishTurn(state);}
  catch(error){state=canvasFinishTurn(state,error.name==='AbortError'?'止めました。':error.message);if(error.name!=='AbortError')onError(error);}
  finally{controller=null;paint();q('#canvas-input')?.focus();}
 };
 const actions={send,stop:()=>controller?.abort(),undo:()=>{state=canvasRevert(state);paint();}};
 const onClick=e=>{const el=e.target.closest('[data-canvas-action]');if(el&&root.contains(el)){e.preventDefault();actions[el.dataset.canvasAction]?.();}};
 const onKey=e=>{if(e.target.id==='canvas-input'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}};
 return {
  html(){
   return `<section id="canvas-view" class="canvas-view" aria-labelledby="canvas-title">
 <div class="canvas-side">
  <header class="canvas-head"><h1 id="canvas-title">キャンバス</h1><p>話しかけて、一枚の作品を一緒に育てます。</p></header>
  <ol class="canvas-log" aria-live="polite"></ol>
  <p class="canvas-error" role="alert" hidden></p>
  <div class="canvas-compose">
   <label class="visually-hidden" for="canvas-input">キャンバスへの依頼</label>
   <textarea id="canvas-input" rows="3" maxlength="4000" placeholder="例: 夜空を飛ぶロケットを描いて"></textarea>
   <p class="canvas-hint">Enterで送信 · Shift+Enterで改行</p>
   <div class="canvas-row">
    <button type="button" class="text-button" data-canvas-action="undo">${icon('undo')}<span>ひとつ戻す</span></button>
    <button type="button" class="button" data-canvas-action="send">${icon('send')}<span>送る</span></button>
    <button type="button" class="button secondary" data-canvas-action="stop" hidden>${icon('stop')}<span>止める</span></button>
   </div>
  </div>
 </div>
 <div class="canvas-stage">
  <p class="canvas-version"></p>
  ${preview?'<p class="canvas-preview-note">プレビュー表示ではキャンバスを動かせません。Teporaを起動して開いてください。</p>':'<iframe class="canvas-frame" title="キャンバスの作品" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/canvas/frame"></iframe>'}
 </div>
</section>`;
  },
  mount(host){
   this.unmount();root=host.querySelector('#canvas-view');if(!root)return;
   frame=root.querySelector('.canvas-frame');ready=false;lastShown=null;
   root.addEventListener('click',onClick);root.addEventListener('keydown',onKey);addEventListener('message',onMessage);paint();
  },
  unmount(){if(root){root.removeEventListener('click',onClick);root.removeEventListener('keydown',onKey);}removeEventListener('message',onMessage);root=null;frame=null;ready=false;},
  mounted:()=>!!root&&root.isConnected,
  busy:()=>!!state.turn,
  stop:()=>controller?.abort()
 };
}
