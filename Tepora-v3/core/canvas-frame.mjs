/** The canvas iframe document. It is served from its own route because the app page's CSP
 * (script-src 'self') would also govern a srcdoc frame. Only the nonce'd runtime below may run:
 * model markup is inserted as inert content, so its scripts and on* handlers never execute.
 */
export function canvasFrameCsp(nonce,origin){
 return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}; sandbox allow-scripts`;
}

const CANVAS_FRAME_RUNTIME=`(()=>{
 const root=document.getElementById('lc-root');let shown=new Set();
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
[data-lc-selected]{outline:3px solid #e8762b;outline-offset:3px;filter:drop-shadow(0 0 3px #e8762b) drop-shadow(0 0 1px #e8762b)}
@media (prefers-reduced-motion:reduce){.lc-grow{animation:none}}</style></head>
<body><div id="lc-root" data-empty="true"></div><script nonce="${nonce}">${CANVAS_FRAME_RUNTIME}</script></body></html>`;
}
