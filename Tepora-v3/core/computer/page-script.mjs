/** Runs inside the page. Lists the controls a person could use (visible, enabled or not), gives each a stable
 * ref (data-tepora-ref, kept while the node lives), and returns the text a person would see in the viewport.
 * Open shadow roots and same-origin iframes are included. Nothing on the page is changed except the ref attribute. */
export const OBSERVE=`(() => {
 const MAX=500, out=[], seen=new Set();
 const W=innerWidth, H=innerHeight;
 window.__teporaNext=window.__teporaNext||1;
 const SEL='a[href],button,input:not([type=hidden]),select,textarea,summary,label[for],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=treeitem],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
 const TAG={A:'link',BUTTON:'button',SELECT:'combobox',TEXTAREA:'textbox',SUMMARY:'button',OPTION:'option',LABEL:'label'};
 const INPUT={checkbox:'checkbox',radio:'radio',submit:'button',button:'button',reset:'button',image:'button',range:'slider',file:'file',search:'searchbox',email:'textbox',password:'password',number:'textbox',tel:'textbox',url:'textbox',text:'textbox',date:'date',time:'time','datetime-local':'date',month:'date',week:'date',color:'color'};
 const clean=s=>String(s||'').replace(/\\s+/g,' ').trim();
 const role=el=>el.getAttribute('role')||(el.tagName==='INPUT'?INPUT[(el.type||'text').toLowerCase()]||'textbox':TAG[el.tagName])||(el.isContentEditable?'textbox':'')||'button';
 const labelOf=el=>{
  const by=el.getAttribute('aria-labelledby');if(by){const t=by.split(/\\s+/).map(id=>el.ownerDocument.getElementById(id)?.innerText||'').join(' ');if(clean(t))return clean(t);}
  const lab=el.labels&&el.labels[0];let lt='';
  if(lab){const c=lab.cloneNode(true);c.querySelectorAll('input,select,textarea,option').forEach(x=>x.remove());lt=c.textContent;}
  return clean(el.getAttribute('aria-label')||lt||el.getAttribute('title')||el.getAttribute('alt')||el.getAttribute('placeholder')||
   (el.tagName==='INPUT'&&['submit','button','reset'].includes(el.type)?el.value:'')||(el.tagName==='SELECT'?'':el.innerText||el.textContent)||el.querySelector?.('img[alt]')?.getAttribute('alt')||el.getAttribute('name')||'');
 };
 const visible=(el,dx,dy)=>{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return null;const s=getComputedStyle(el);if(s.visibility==='hidden'||s.display==='none'||Number(s.opacity)===0)return null;return {x:r.left+dx,y:r.top+dy,w:r.width,h:r.height};};
 const scan=(root,dx,dy)=>{
  for(const el of root.querySelectorAll(SEL)){
   if(out.length>=MAX)return;if(seen.has(el))continue;seen.add(el);
   const r=visible(el,dx,dy);if(!r)continue;
   if(el.tagName==='LABEL'&&el.control)continue;
   let ref=el.getAttribute('data-tepora-ref');if(!ref){ref='e'+(window.__teporaNext++);el.setAttribute('data-tepora-ref',ref);}
   const rl=role(el),type=(el.type||'').toLowerCase();
   const item={ref,role:rl,name:labelOf(el).slice(0,140),x:Math.round(r.x+r.w/2),y:Math.round(r.y+r.h/2),inView:r.y+r.h>0&&r.y<H&&r.x+r.w>0&&r.x<W};
   if(['textbox','searchbox','password','combobox','slider','date','time','color'].includes(rl)&&el.tagName!=='A'){item.value=rl==='password'?(el.value?'••••':''):clean(el.tagName==='SELECT'?el.options[el.selectedIndex]?.text:el.isContentEditable?el.innerText:el.value).slice(0,200);}
   if(el.tagName==='SELECT')item.options=[...el.options].slice(0,30).map(o=>clean(o.text).slice(0,60));
   if(rl==='checkbox'||rl==='radio'||rl==='switch')item.checked=!!(el.checked||el.getAttribute('aria-checked')==='true');
   if(el.getAttribute('aria-selected')==='true')item.selected=true;
   if(el.getAttribute('aria-expanded'))item.expanded=el.getAttribute('aria-expanded')==='true';
   if(el.disabled||el.getAttribute('aria-disabled')==='true')item.disabled=true;
   if(el.tagName==='A'){const h=el.getAttribute('href')||'';item.href=h.length>120?h.slice(0,120)+'…':h;}
   if(document.activeElement===el)item.focused=true;
   if(type==='file')item.file=true;
   out.push(item);
  }
  for(const el of root.querySelectorAll('*')){
   if(el.shadowRoot)scan(el.shadowRoot,dx,dy);
   if(el.tagName==='IFRAME'){try{const d=el.contentDocument;if(d){const r=el.getBoundingClientRect();scan(d,dx+r.left,dy+r.top);}}catch{}}
  }
 };
 scan(document,0,0);
 // Text a person sees in the viewport, block by block.
 const lines=[];let size=0;
 const walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT,{acceptNode:n=>{
  const p=n.parentElement;if(!p||!clean(n.textContent))return NodeFilter.FILTER_REJECT;
  if(/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName))return NodeFilter.FILTER_REJECT;
  const r=p.getBoundingClientRect();if(r.bottom<0||r.top>H||r.width<1)return NodeFilter.FILTER_REJECT;
  const s=getComputedStyle(p);return s.visibility==='hidden'||s.display==='none'?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
 let last=null;
 while(walker.nextNode()&&size<4000){const n=walker.currentNode,t=clean(n.textContent);const block=n.parentElement.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,div,section,article,label,button,a,span');
  if(block===last&&lines.length){lines[lines.length-1]+=' '+t;}else{lines.push(t);last=block;}size+=t.length;}
 const dialog=document.querySelector('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]');
 return {url:location.href,title:document.title,elements:out,text:lines.join('\\n').slice(0,4000),
  scroll:{y:Math.round(scrollY),height:Math.round(document.documentElement.scrollHeight),viewport:H,width:W},
  dialog:dialog?clean(dialog.getAttribute('aria-label')||dialog.innerText).slice(0,300):null,ready:document.readyState};
})()`;
/** Waits until the DOM has been quiet for a moment (or a cap), after an action. */
export const SETTLE=`new Promise(resolve=>{let last=Date.now();const mo=new MutationObserver(()=>{last=Date.now();});
 mo.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});const t0=Date.now();
 const tick=()=>{if(Date.now()-last>=350&&document.readyState!=='loading'||Date.now()-t0>4000){mo.disconnect();resolve(true);}else setTimeout(tick,100);};setTimeout(tick,150);})`;
