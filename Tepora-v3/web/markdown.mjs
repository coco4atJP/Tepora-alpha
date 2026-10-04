/** A small Markdown subset for untrusted model and worker text. Everything is escaped first;
 * formatting only wraps already-escaped text. Links are shown as text plus their address and
 * never become clickable, so a report cannot dress up a destination.
 */
const MD_ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const mdEscape=s=>String(s??'').replace(/[&<>"']/g,c=>MD_ESC[c]);
const MD_LIST=/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const MD_RULE=/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MD_TABLE_SEP=/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function mdInline(text){
 return String(text).split(/(`[^`\n]+`)/g).map(part=>{
  if(/^`[^`\n]+`$/.test(part))return `<code>${mdEscape(part.slice(1,-1))}</code>`;
  return mdEscape(part)
   .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g,'<span class="md-link">$1</span><span class="md-url">（$2）</span>')
   .replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_\n]+)__/g,'<strong>$1</strong>')
   .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g,'$1<em>$2</em>')
   .replace(/~~([^~\n]+)~~/g,'<del>$1</del>');
 }).join('');
}
const mdCells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());

/** @param {{headings?:'html'|'text'}} options  'text' keeps chat bubbles out of the page outline. */
export function renderMarkdown(source,{headings='html',depth=0}={}){
 const lines=String(source??'').slice(0,200000).replace(/\r\n?/g,'\n').split('\n'),out=[],para=[];
 const flush=()=>{if(para.length){out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);para.length=0;}};
 for(let i=0;i<lines.length;){
  const line=lines[i];let m;
  if((m=line.match(/^\s*```\s*[\w+.-]{0,24}\s*$/))){flush();const code=[];i++;while(i<lines.length&&!/^\s*```\s*$/.test(lines[i]))code.push(lines[i++]);i++;out.push(`<pre><code>${mdEscape(code.join('\n'))}</code></pre>`);continue;}
  if(!line.trim()){flush();i++;continue;}
  if((m=line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/))){flush();const level=m[1].length;
   out.push(headings==='html'?`<h${level}>${mdInline(m[2])}</h${level}>`:`<p class="md-heading md-h${level}"><strong>${mdInline(m[2])}</strong></p>`);i++;continue;}
  if(MD_RULE.test(line)){flush();out.push('<hr>');i++;continue;}
  if(/^\s*>/.test(line)){flush();const quote=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quote.push(lines[i++].replace(/^\s*>\s?/,''));
   out.push(`<blockquote>${depth<3?renderMarkdown(quote.join('\n'),{headings,depth:depth+1}):`<p>${quote.map(mdInline).join('<br>')}</p>`}</blockquote>`);continue;}
  if(/\|/.test(line)&&i+1<lines.length&&MD_TABLE_SEP.test(lines[i+1])){flush();const head=mdCells(line);i+=2;const rows=[];
   while(i<lines.length&&/\|/.test(lines[i])&&lines[i].trim())rows.push(mdCells(lines[i++]));
   out.push(`<div class="md-table"><table><thead><tr>${head.map(c=>`<th>${mdInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${head.map((_,n)=>`<td>${mdInline(r[n]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);continue;}
  if((m=line.match(MD_LIST))){flush();const items=[],ordered=/\d/.test(m[2]),startAt=ordered?parseInt(m[2],10):1;
   // Two levels: indented items (any marker) belong to the previous top-level item.
   while(i<lines.length){const item=lines[i].match(MD_LIST);
    if(item){let text=item[3],check='';const box=text.match(/^\[([ xX])\]\s+(.*)$/);if(box){check=box[1]===' '?'☐ ':'☑ ';text=box[2];}
     const entry={text,check,ordered:/\d/.test(item[2]),children:[]};
     if(item[1].length>=2&&items.length)items.at(-1).children.push(entry);
     else if(entry.ordered===ordered)items.push(entry);else break;i++;continue;}
    if(items.length&&/^\s{2,}\S/.test(lines[i])){const host=items.at(-1).children.at(-1)||items.at(-1);host.text+='\n'+lines[i].trim();i++;continue;}
    break;}
   const li=it=>`<li>${mdEscape(it.check)}${it.text.split('\n').map(mdInline).join('<br>')}${it.children.length?`<${it.children[0].ordered?'ol':'ul'}>${it.children.map(li).join('')}</${it.children[0].ordered?'ol':'ul'}>`:''}</li>`;
   out.push(ordered?`<ol${startAt>1?` start="${startAt}"`:''}>${items.map(li).join('')}</ol>`:`<ul>${items.map(li).join('')}</ul>`);continue;}
  para.push(line);i++;
 }
 flush();return out.join('');
}
/** Standalone document for an artifact frame: same subset, real headings, paper styling. */
export function markdownDocument(source,title=''){
 return `<html lang="ja"><meta charset="utf-8"><title>${mdEscape(title)}</title><style>
 body{margin:0;background:#fbf8f2;color:#2b2722;font:16px/1.85 "Hiragino Sans","Yu Gothic UI","Yu Gothic",system-ui,sans-serif;padding:clamp(20px,5vw,56px)}
 main{max-width:42rem;margin:auto}h1,h2,h3,h4{font-family:"Hiragino Mincho ProN","Yu Mincho","YuMincho",serif;font-weight:600;line-height:1.45;margin:1.6em 0 .6em}
 h1{font-size:1.9rem;margin-top:0}h2{font-size:1.4rem;border-bottom:1px solid #e6ded1;padding-bottom:.3em}h3{font-size:1.15rem}
 p,ul,ol,blockquote,pre,.md-table{margin:0 0 1em}ul,ol{padding-left:1.4em}li{margin:.2em 0}li>ul,li>ol{margin:.2em 0}
 code{font:.9em ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:#f1ebe0;border-radius:4px;padding:.1em .35em}
 pre{background:#f1ebe0;border-radius:10px;padding:1em;overflow:auto}pre code{background:none;padding:0}
 blockquote{border-left:3px solid #d9cdbb;margin-left:0;padding:.1em 1em;color:#5c544a}hr{border:0;border-top:1px solid #e6ded1;margin:2em 0}
 table{border-collapse:collapse;width:100%;font-size:.94em}th,td{border-bottom:1px solid #e6ded1;padding:.45em .6em;text-align:left;vertical-align:top}th{font-weight:600}
 .md-table{overflow:auto}.md-url{color:#8a8173;font-size:.85em;word-break:break-all}
 @media(prefers-color-scheme:dark){body{background:#1d1b18;color:#ece6dc}h2,th,td,hr{border-color:#3a352e}code,pre{background:#2a2622}blockquote{border-color:#4a443b;color:#b9b0a3}.md-url{color:#9d9487}}
 </style><body><main>${renderMarkdown(source)}</main></body></html>`;
}
