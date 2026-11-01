/** A small, dependency-free HTML fragment tree for the service side of the canvas.
 * It implements just the DOM subset the canvas patch engine (web/canvas-engine.mjs) uses, so agent edits can be
 * applied and versioned without a browser. Nothing here executes markup: it is parsed into plain objects only.
 */
const VOID=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
const RAW=new Set(['style','script','textarea','title']);
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
const decode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>e[0]==='#'?String.fromCodePoint(e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):Number(e.slice(1))):ENTITIES[e.toLowerCase()]??m);
const escText=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\u00a0/g,'&nbsp;');
const same=(a,b)=>a.toLowerCase()===String(b).toLowerCase();
const escAttr=s=>s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/\u00a0/g,'&nbsp;');

class Text{
 constructor(value,doc,raw=false){this.nodeType=3;this.nodeValue=value;this.ownerDocument=doc;this.parentNode=null;this.raw=raw;}
 get textContent(){return this.nodeValue;}
 serialize(){return this.raw?this.nodeValue:escText(this.nodeValue);}
}
class Element{
 constructor(tag,doc){this.nodeType=1;this.tagName=tag;this.attrs=[];this.childNodes=[];this.ownerDocument=doc;this.parentNode=null;}
 get localName(){return this.tagName.toLowerCase();}
 get children(){return this.childNodes.filter(n=>n.nodeType===1);}
 get firstChild(){return this.childNodes[0]||null;}
 get firstElementChild(){return this.children[0]||null;}
 get parentElement(){return this.parentNode?.nodeType===1?this.parentNode:null;}
 get id(){return this.getAttribute('id')||'';}
 getAttribute(name){const a=this.attrs.find(([k])=>same(k,name));return a?a[1]:null;}
 hasAttribute(name){return this.attrs.some(([k])=>same(k,name));}
 setAttribute(name,value){if(!/^[^\s"'<>/=\x00-\x1f]+$/.test(String(name)))throw new Error(`invalid attribute name: ${String(name).slice(0,40)}`);const a=this.attrs.find(([k])=>same(k,name));if(a)a[1]=String(value);else this.attrs.push([String(name),String(value)]);}
 removeAttribute(name){this.attrs=this.attrs.filter(([k])=>!same(k,name));}
 get textContent(){return this.childNodes.map(n=>n.textContent).join('');}
 set textContent(v){for(const n of this.childNodes)n.parentNode=null;this.childNodes=[];this.appendChild(new Text(String(v),this.ownerDocument,false));}
 appendChild(node){node.parentNode?.removeChild(node);node.parentNode=this;this.childNodes.push(node);return node;}
 insertBefore(node,ref){if(!ref)return this.appendChild(node);node.parentNode?.removeChild(node);const i=this.childNodes.indexOf(ref);node.parentNode=this;this.childNodes.splice(i<0?this.childNodes.length:i,0,node);return node;}
 removeChild(node){const i=this.childNodes.indexOf(node);if(i>=0)this.childNodes.splice(i,1);node.parentNode=null;return node;}
 remove(){this.parentNode?.removeChild(this);}
 insertAdjacentHTML(position,html){
  const nodes=parseNodes(String(html),this.ownerDocument),parent=this.parentNode;
  if(position==='beforeend')for(const n of nodes)this.appendChild(n);
  else if(position==='afterbegin'){const first=this.firstChild;for(const n of nodes)this.insertBefore(n,first);}
  else{
   if(!parent)throw new Error('insertAdjacentHTML: element has no parent');
   const ref=position==='beforebegin'?this:parent.childNodes[parent.childNodes.indexOf(this)+1]||null;
   for(const n of nodes)parent.insertBefore(n,ref);
  }
 }
 *descendants(){for(const n of this.childNodes)if(n.nodeType===1){yield n;yield* n.descendants();}}
 querySelectorAll(selector){const test=compileSelector(selector);return [...this.descendants()].filter(test);}
 querySelector(selector){const test=compileSelector(selector);for(const el of this.descendants())if(test(el))return el;return null;}
 get innerHTML(){return this.childNodes.map(n=>n.serialize()).join('');}
 get outerHTML(){return this.serialize();}
 serialize(){
  const open=`<${this.tagName}${this.attrs.map(([k,v])=>` ${k}="${escAttr(v)}"`).join('')}>`;
  return VOID.has(this.localName)?open:`${open}${this.innerHTML}</${this.tagName}>`;
 }
}

/** Attribute selectors only: `[a]`, `[a="v"]`, comma lists. That is all the canvas engine asks for. */
function compileSelector(selector){
 const parts=[];
 for(const m of String(selector).matchAll(/\[\s*([\w:-]+)\s*(?:=\s*"((?:[^"\\]|\\.)*)")?\s*\]/g))parts.push({name:m[1].toLowerCase(),value:m[2]===undefined?null:m[2].replace(/\\(.)/g,'$1')});
 if(!parts.length)throw new Error(`Unsupported selector: ${selector}`);
 return el=>parts.some(p=>p.value===null?el.hasAttribute(p.name):el.getAttribute(p.name)===p.value);
}

function parseNodes(html,doc){
 const root=new Element('#fragment',doc),stack=[root];let i=0;
 const top=()=>stack[stack.length-1];
 const text=s=>{if(s)top().appendChild(new Text(decode(s),doc,false));};
 while(i<html.length){
  const lt=html.indexOf('<',i);
  if(lt<0){text(html.slice(i));break;}
  text(html.slice(i,lt));i=lt;
  if(html.startsWith('<!--',i)){const e=html.indexOf('-->',i+4);i=e<0?html.length:e+3;continue;}
  if(html[i+1]==='!'||html[i+1]==='?'){const e=html.indexOf('>',i);i=e<0?html.length:e+1;continue;}
  const close=/^<\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(html.slice(i,i+200));
  if(close){
   const name=close[1].toLowerCase();i+=close[0].length;
   for(let k=stack.length-1;k>0;k--)if(stack[k].localName===name){stack.length=k;break;}
   continue;
  }
  const open=/^<([a-zA-Z][\w:-]*)/.exec(html.slice(i,i+200));
  if(!open){text('<');i++;continue;}
  i+=open[0].length;
  const el=new Element(open[1],doc);let selfClose=false;
  for(;;){
   const ws=/^[\s]*/.exec(html.slice(i))[0];i+=ws.length;
   if(i>=html.length)break;
   if(html.startsWith('/>',i)){selfClose=true;i+=2;break;}
   if(html[i]==='>'){i++;break;}
   if(html[i]==='/'){i++;continue;}
   const a=/^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/.exec(html.slice(i));
   if(!a){i++;continue;}
   i+=a[0].length;const name=a[1];
   if(!el.hasAttribute(name))el.attrs.push([name,decode(a[2]??a[3]??a[4]??'')]);
  }
  top().appendChild(el);
  if(selfClose||VOID.has(el.localName))continue;
  if(RAW.has(el.localName)){
   const re=new RegExp(`</${el.localName}\\s*>`,'i'),rest=html.slice(i),m=re.exec(rest);
   const body=m?rest.slice(0,m.index):rest;if(body)el.appendChild(new Text(body,doc,true));
   i+=m?m.index+m[0].length:rest.length;continue;
  }
  stack.push(el);
 }
 const nodes=[...root.childNodes];for(const n of nodes)n.parentNode=null;return nodes;
}

class FragmentDocument{
 constructor(){this.body=new Element('body',this);}
 createTextNode(v){return new Text(String(v),this,false);}
}
/** DOMParser stand-in: parseFromString(html) → {body}. Only the <body> content is kept. */
export class CanvasParser{
 parseFromString(source){
  const s=String(source),b=/<body[^>]*>/i.exec(s),e=s.toLowerCase().lastIndexOf('</body>');
  const inner=b?s.slice(b.index+b[0].length,e>b.index?e:s.length):s;
  const doc=new FragmentDocument();for(const n of parseNodes(inner,doc))doc.body.appendChild(n);return doc;
 }
}
