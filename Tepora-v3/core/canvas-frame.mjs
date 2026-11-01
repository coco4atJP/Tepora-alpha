/** The canvas iframe document. It is served from its own route because the app page's CSP
 * (script-src 'self') would also govern a srcdoc frame. Only the nonce'd runtime below may run:
 * model markup is inserted as inert content, so its scripts and on* handlers never execute.
 */
export function canvasFrameCsp(nonce,origin){
 return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}; sandbox allow-scripts`;
}

const CANVAS_FRAME_RUNTIME=`(()=>{
 const root=document.getElementById('lc-root');let shown=new Set(),flashed=null;
 addEventListener('message',e=>{
  if(e.source!==parent)return;const d=e.data;
  if(!d||d.__lc!==1||d.type!=='render'||typeof d.html!=='string')return;
  root.innerHTML=d.html;
  const ids=new Set();
  for(const el of root.querySelectorAll('[data-id]')){
   const id=el.getAttribute('data-id');ids.add(id);
   if(d.animate&&!shown.has(id)){el.classList.add('lc-grow');el.addEventListener('animationend',()=>el.classList.remove('lc-grow'),{once:true});}
  }
  shown=ids;root.dataset.empty=String(!d.html.trim());
  const sel=typeof d.selected==='string'?d.selected:null;root.dataset.selectable=String(d.version!=null);
  if(sel)for(const el of root.querySelectorAll('[data-id]'))if(el.getAttribute('data-id')===sel){el.setAttribute('data-lc-selected','');break;}
  // Pictures sit on the app's own ground (letterbox included); other HTML keeps the paper so its text stays legible.
  root.dataset.kind=root.firstElementChild?.localName==='svg'&&root.children.length===1?'svg':'html';
  const ground=typeof d.ground==='string'&&/^#[0-9a-f]{3,8}$|^rgba?\([\d.,\s%]+\)$/i.test(d.ground)?d.ground:'';
  document.body.style.background=root.dataset.kind==='svg'?ground:'';
  // What an agent just edited for the user flashes once, so the eye finds the change.
  const ed=typeof d.edited==='string'?d.edited:null,key=ed&&d.version+'\u0000'+ed;
  if(ed&&key!==flashed){flashed=key;for(const el of root.querySelectorAll('[data-id]'))if(el.getAttribute('data-id')===ed){el.setAttribute('data-lc-edited','');setTimeout(()=>el.removeAttribute('data-lc-edited'),1600);break;}}
  parent.postMessage({__lc:1,type:'rendered',version:d.version??null},'*');
 });
 // A click names the nearest piece with a data-id: that is what "this" means to the agent.
 root.addEventListener('click',e=>{
  if(root.dataset.selectable!=='true')return;
  const el=e.target.closest?.('[data-id]');const id=el&&root.contains(el)?el.getAttribute('data-id'):null;
  parent.postMessage({__lc:1,type:'select',id},'*');
 });
 parent.postMessage({__lc:1,type:'ready'},'*');
})();`;

export function canvasFrameDocument(nonce){
 return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Canvas</title>
<style>html,body{margin:0;width:100%;height:100%;background:#fffdf8;color:#2f2924;font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',system-ui,sans-serif}
#lc-root{width:100%;height:100%;overflow:auto}#lc-root>svg{display:block;width:100%;height:100%}
#lc-root[data-empty="true"]::before{content:"ここに作品が現れます";display:grid;place-items:center;height:100%;color:#a89a8a;font-size:15px}
.lc-grow{animation:lc-grow .42s cubic-bezier(.2,.8,.2,1) both;transform-box:fill-box;transform-origin:center}
@keyframes lc-grow{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}
#lc-root[data-selectable="true"] [data-id]{cursor:pointer}
[data-lc-selected]{outline:2px solid #e2a12a;outline-offset:3px;filter:drop-shadow(0 0 2px #e2a12a) drop-shadow(0 0 1px #e2a12a)}
[data-lc-edited]{animation:lc-edited 1.5s ease-out both}
@keyframes lc-edited{0%{filter:drop-shadow(0 0 0 #d4583a)}25%{filter:drop-shadow(0 0 6px #d4583a) drop-shadow(0 0 2px #d4583a)}100%{filter:drop-shadow(0 0 0 rgba(212,88,58,0))}}
@media (prefers-reduced-motion:reduce){.lc-grow,[data-lc-edited]{animation:none}[data-lc-edited]{outline:2px dashed #d4583a;outline-offset:3px}}</style></head>
<body><div id="lc-root" data-empty="true"></div><script nonce="${nonce}">${CANVAS_FRAME_RUNTIME}</script></body></html>`;
}

/** A still of one canvas version for an agent to look at. Same paper and sizing as the live frame, but no
 * runtime at all: the CSP allows no script and no network, and anything that could navigate is removed. */
export function canvasSnapshotDocument(html){
 const body=String(html).replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<(meta|base|link|iframe|frame|object|embed|portal)\b[^>]*>/gi,'');
 return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:">
<style>html,body{margin:0;width:100%;min-height:100%;background:#fffdf8;color:#2f2924;font-family:'Hiragino Sans','Yu Gothic','Noto Sans JP',system-ui,sans-serif}
#lc-root{width:100%;min-height:100vh}#lc-root>svg:first-child{display:block;width:100%;height:100vh}</style></head>
<body><div id="lc-root">${body}</div></body></html>`;
}
