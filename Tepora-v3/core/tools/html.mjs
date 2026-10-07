/** HTML → compact Markdown for agents: keeps headings, lists, tables, code and links (absolute URLs),
 * drops scripts, styles and page chrome. Dependency-free and tolerant of broken markup. */
const NAMED={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',copy:'©',reg:'®',trade:'™',hellip:'…',mdash:'—',ndash:'–',laquo:'«',raquo:'»',ldquo:'“',rdquo:'”',lsquo:'‘',rsquo:'’',bull:'•',middot:'·',times:'×',divide:'÷',deg:'°',yen:'¥',euro:'€',pound:'£',cent:'¢',sect:'§',para:'¶',larr:'←',rarr:'→',uarr:'↑',darr:'↓',zwj:'',zwnj:'',shy:''};
export function decodeEntities(s){
 return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);?/gi,(m,e)=>{
  if(e[0]==='#'){const n=e[1]==='x'||e[1]==='X'?parseInt(e.slice(2),16):parseInt(e.slice(1),10);return Number.isFinite(n)&&n>0&&n<0x110000?String.fromCodePoint(n):m;}
  const v=NAMED[e.toLowerCase()];return v===undefined?m:v;
 });
}
const DROP=['script','style','noscript','template','svg','canvas','iframe','object','embed','head','select','button','dialog'];
const CHROME=['nav','footer','aside','header','form'];
const BLOCK=new Set(['p','div','section','article','main','header','footer','aside','nav','form','fieldset','figure','figcaption','address','details','summary','dl','dt','dd','center','hr']);
function attr(attrs,name){const m=new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,'i').exec(attrs);return m?decodeEntities(m[1]??m[2]??m[3]??''):null;}
function absolute(href,base){
 if(!href)return null;const h=href.trim();if(/^(javascript|data|mailto|tel):/i.test(h))return h.startsWith('mailto:')?h:null;
 try{return new URL(h,base).href;}catch{return null;}
}
function strip(html,tags){for(const t of tags)html=html.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`,'gi'),' ');return html;}
function pickMain(html){
 const candidates=[];
 for(const tag of ['main','article']){const re=new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`,'gi');let m;while((m=re.exec(html)))candidates.push(m[1]);}
 const textLen=s=>s.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').length;
 const best=candidates.sort((a,b)=>textLen(b)-textLen(a))[0];
 const body=(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)||[,html])[1];
 return best&&textLen(best)>Math.min(800,textLen(body)*0.25)?best:strip(body,CHROME);
}
export function htmlToMarkdown(html,{url='',main=true}={}){
 html=String(html).slice(0,6_000_000).replace(/<!--[\s\S]*?-->/g,'').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g,'');
 const title=decodeEntities((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)||[])[1]||'').replace(/\s+/g,' ').trim();
 const description=attr((/<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i.exec(html)||[''])[0],'content')||'';
 const base=attr((/<base\b[^>]*>/i.exec(html)||[''])[0],'href')||url;
 html=strip(html,DROP);if(main)html=pickMain(html);
 const out=[];let line='',pre=0,listStack=[],link=null,table=null,row=null,cell=null,quote=0;
 const emit=s=>{if(cell){cell.push(s);return;}if(link){link.text+=s;return;}line+=s;};
 const flush=(blank=false)=>{
  let t=pre?line:line.replace(/[ \t]+/g,' ').trim();
  const lead=/^( +)(?:-|\d+\.) /.exec(line);if(lead&&!pre&&t)t=lead[1]+t;
  if(t)out.push((quote?'> '.repeat(quote):'')+t);
  if(blank&&out.at(-1)!=='')out.push('');line='';
 };
 const re=/<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;let m;
 while((m=re.exec(html))){
  if(m[4]!==undefined){let text=decodeEntities(m[4]);if(!pre)text=text.replace(/\s+/g,' ');emit(text);continue;}
  const close=m[1]==='/',tag=m[2].toLowerCase(),attrs=m[3]||'';
  if(/^h[1-6]$/.test(tag)){flush(true);if(!close)line='#'.repeat(Number(tag[1]))+' ';else flush(true);continue;}
  if(tag==='br'){if(cell)cell.push(' ');else{flush();}continue;}
  if(tag==='pre'){if(!close){flush(true);pre++;out.push('```');}else{flush();pre=Math.max(0,pre-1);out.push('```','');}continue;}
  if(tag==='code'&&!pre){emit('`');continue;}
  if(tag==='blockquote'){flush(true);quote+=close?-1:1;quote=Math.max(0,quote);continue;}
  if(tag==='ul'||tag==='ol'){flush();if(!close)listStack.push({ordered:tag==='ol',n:0});else{listStack.pop();if(!listStack.length)flush(true);}continue;}
  if(tag==='li'){flush();if(!close){const l=listStack.at(-1);const indent='  '.repeat(Math.max(0,listStack.length-1));line=indent+(l?.ordered?`${++l.n}. `:'- ');}continue;}
  if(tag==='table'){flush(true);if(!close)table=[];else if(table){const rows=table.filter(r=>r.some(c=>c));if(rows.length){const w=Math.max(...rows.map(r=>r.length));rows.forEach((r,i)=>{out.push('| '+[...r,...Array(w-r.length).fill('')].join(' | ')+' |');if(i===0)out.push('|'+' --- |'.repeat(w));});out.push('');}table=null;}continue;}
  if(tag==='tr'){if(table){if(!close){row=[];table.push(row);}else row=null;}else flush();continue;}
  if(tag==='td'||tag==='th'){if(row){if(!close){cell=[];}else if(cell){row.push(cell.join('').replace(/\s+/g,' ').replace(/\|/g,'\\|').trim());cell=null;}}else emit(' ');continue;}
  if(tag==='a'){
   if(!close){const href=absolute(attr(attrs,'href'),base);link={href,text:''};}
   else if(link){const {href,text}=link;link=null;const t=text.replace(/\s+/g,' ').trim();
    if(href&&t&&!href.startsWith(base+'#')&&!/^#/.test(attr(attrs,'href')||''))emit(`[${t}](${href})`);else emit(t);}
   continue;
  }
  if(tag==='img'){const alt=(attr(attrs,'alt')||'').trim();if(alt)emit(`[image: ${alt}]`);continue;}
  if(tag==='input'||tag==='textarea'){const label=attr(attrs,'placeholder')||attr(attrs,'aria-label')||attr(attrs,'name');const type=(attr(attrs,'type')||'text').toLowerCase();if(label&&!['hidden','submit','button'].includes(type))emit(` [input: ${label}] `);continue;}
  if(BLOCK.has(tag)){if(listStack.length&&/^\s*(?:-|\d+\.)\s*$/.test(line))continue;flush(tag==='p'||tag==='section'||tag==='article'||tag==='hr');if(tag==='hr'&&!close)out.push('---');continue;}
 }
 flush();
 const body=out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
 return {title,description,markdown:body};
}
/** DuckDuckGo's HTML results page → [{title,url,snippet}]. */
export function parseDuckDuckGo(html){
 const results=[],clean=s=>decodeEntities(String(s||'').replace(/<[^>]+>/g,'')).replace(/\s+/g,' ').trim();
 for(const block of String(html).split(/class="[^"]*\bresult\b[^"]*"/).slice(1)){
  const a=/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);if(!a)continue;
  let href=decodeEntities(a[1]);const u=/[?&]uddg=([^&]+)/.exec(href);if(u)href=decodeURIComponent(u[1]);else if(href.startsWith('//'))href='https:'+href;
  if(/duckduckgo\.com\/y\.js/.test(href)||results.some(r=>r.url===href))continue;
  const snippet=/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
  results.push({title:clean(a[2]),url:href,snippet:clean(snippet?.[1])});if(results.length>=30)break;
 }
 return results;
}
