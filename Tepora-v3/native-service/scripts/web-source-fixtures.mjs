// Only pure JS/mocked network sources. Never contacts a web provider or reads keys.
import {writeFileSync} from 'node:fs';
import {htmlToMarkdown,decodeEntities,parseDuckDuckGo} from '../../core/tools/html.mjs';
import {WebTools} from '../../core/tools/web.mjs';
import {splitSections} from '../../core/agent/decisions.mjs';
if(!process.argv.includes('--current-decodes')&&process.version!=='v22.16.0')throw new Error('Frozen baseline regeneration requires Node v22.16.0; use --current-decodes only for the separate current-runtime vectors.');
const html=[
 '<html><head><title> A &amp; B </title><meta name="description" content="Summary &copy;"></head><body><nav>nav</nav><main><h1>Hello</h1><p>Text <a href="../next?q=1&amp;x=2">link</a> and <code>x</code>.</p></main><footer>gone</footer></body></html>',
 '<h1>title</h1><p>one<br>two</p><section><h2>Other</h2><p>more</p></section><hr>tail',
 '<ul><li>A<ul><li>B</li><li><p>C</p></li></ul></li><li>D</li></ul><ol><li>first</li><li>second</li></ol>',
 '<table><tr><th>A</th><th>B</th></tr><tr><td>x|y</td><td><a href="/a">link</a><br>line</td><td>third</td></tr><tr><td></td></tr></table>',
 '<blockquote><p>one</p><blockquote>two</blockquote>end</blockquote><pre> a\n  b\t\n&lt;c&gt;</pre><code>x</code>',
 '<div>one<a href="/a">a<a href="/b">b</a>c</a>end</div>',
 '<body><header>hdr</header><article>'+('long actual article '.repeat(80))+'</article><aside>aside</aside><main>short</main></body>',
 '<body><main>x</main>'+('rest '.repeat(900))+'</body>',
 '<html><head><base href="/relative/"></head><body><a href="https://absolute.test/">absolute</a><a href="/b">b</a></body></html>',
 '<a href="#local">same</a><a href="mailto:a@b">mail</a><a href="MAILTO:a@b">upper mail</a><a href="javascript:alert(1)">bad</a><a href="data:x">data</a><a href="tel:1">tel</a>',
 '<img alt="Picture &amp; caption"><input placeholder="Type here"><input type=hidden name=secret><textarea aria-label="Long text">hello</textarea>',
 '<p>literal \ue000\ue100 lone \ud800 &#xDFFF; &#x1f600; &#x110000; &#0; &#65x &AMP &notAnEntity;</p>',
 '<!-- gone --><![CDATA[gone]]><p>yes</p><script>fake</script><SCRIPT>also</SCRIPT><ſcript>visible</ſcript><style>css</style><noscript>gone</noscript>',
 '<p title="a > b">attribute > edge</p>stray < tail <bad/><custom-tag>keep</custom-tag>',
 '<TITLE>title\r\n x</TITLE><META NAME=\'description\' CONTENT=\'desc\'><p>\ufeff\u0085\u00a0 spaces\u2028done</p>',
 '<form><input name=query>form</form><nav>nav</nav><p>body</p>',
 '<table><tr><td>a<table><tr><td>nested</td></tr></table>end</td></tr></table>',
 '<a href="https://x.example/a">Absolute without base</a>',
 '<p><a href="./日本語?q=😀">unicode</a><a href="file:///tmp/x">file data</a><a href="//x.test/a">scheme relative</a></p>',
 '<h6>Six</h6><h7>Seven</h7><dl><dt>Term</dt><dd>Definition</dd></dl>',
];
const htmlCases=[];for(const [i,markup] of html.entries())for(const main of [true,false]){const url=i===17?'':'https://example.test/base/page';htmlCases.push({html:markup,url,main,expected:htmlToMarkdown(markup,{url,main})});}
const entities=['&amp; &AMP &lt &unknown; &#x41; &#65; &#xD800; &#x10FFFF;','&copyreg &copy1; &nbsp; &#x0; &#0000065; &#999999999999999999999999999;','literal \ud800\ue000\ue100 &shy;&zwj;&zwnj; &apos; &quot;'];
const ddgBlock=(url,title='Title',snippet='Snippet')=>`<div class="result"><a class="result__a" href="${url}">${title}</a><div class="result__snippet">${snippet}</div></div>`;
const ddg=[ddgBlock('//example.test/a','A &amp; B','<b>best</b> snippet'),ddgBlock('/l/?uddg=https%3A%2F%2Fa.test%2Fx%3Fa%3D1%26b%3D2')+ddgBlock('https://a.test/x?a=1&amp;b=2'),ddgBlock('https://duckduckgo.com/y.js?ad')+ddgBlock('https://ok.test/'),ddgBlock('/l/?uddg=%ED%A0%80'),ddgBlock('/l/?uddg=%ZZ'),'<div class="result"><a href="x" class="result__a">wrong attribute order</a></div>',Array.from({length:33},(_,i)=>ddgBlock('https://x.test/'+i)).join(''),ddgBlock('/l/?uddg=raw\ud800')];
const duck=ddg.map(html=>{try{return {html,expected:parseDuckDuckGo(html)}}catch{return {html,error:true}}});
const decodeRows=[
 {type:'text/plain',bytes:[239,187,191,65,240,159,152,128]},
 {type:'text/plain; charset=bogus',bytes:[239,187,191,65,255]},
 {type:'text/plain; charset=windows-1252',bytes:[128,145,146,233]},
 {type:'text/plain; charset=shift_jis',bytes:[147,250,150,123,140,234]},
 {type:'text/plain; charset=utf-16le',bytes:[255,254,65,0,61,216,0,222]},
 {type:'text/plain; charset=utf-16be',bytes:[254,255,0,65,216,61,222,0]},
 {type:'text/plain; charset=utf-16le',bytes:[254,255,0,65]},
 {type:'text/plain; charset=iso-8859-1',bytes:[128,160,255]},
 {type:'text/plain; charset=iso-8859-16',bytes:[164,165,166]},
 {type:'text/plain; charset=x-user-defined',bytes:[128,255]},
 {type:'text/plain',bytes:[...Buffer.from('<meta charset="windows-1252">'),128,233]},
];
for(const label of ['ibm866','iso-8859-2','iso-8859-3','iso-8859-4','iso-8859-5','iso-8859-6','iso-8859-7','iso-8859-8','iso-8859-8-i','iso-8859-10','iso-8859-13','iso-8859-14','iso-8859-15','koi8-r','koi8-u','macintosh','windows-874','windows-1250','windows-1251','windows-1252','windows-1253','windows-1254','windows-1255','windows-1256','windows-1257','windows-1258','x-mac-cyrillic'])decodeRows.push({type:'text/plain; charset='+label,bytes:Array.from({length:256},(_,i)=>i)});
const decodes=[];for(const row of decodeRows){const web=new WebTools({network:{request:async()=>new Response(new Uint8Array(row.bytes),{headers:{'content-type':row.type}})}});const doc=await web.page('https://decode.test/');const label=/charset=([\w-]+)/i.exec(row.type)?.[1]||(/<meta[^>]+charset=["']?([\w-]+)/i.exec(Buffer.from(row.bytes).subarray(0,4000).toString('latin1'))||[])[1]||'utf-8';let canonical=null;try{canonical=new TextDecoder(label).encoding;}catch{}decodes.push({...row,label,canonical,supported:canonical!==null,expected:doc.text});}
if(process.argv.includes('--current-decodes')){writeFileSync(new URL('../src/agent/web/fixtures/decodes-current.json',import.meta.url),JSON.stringify({nodeVersion:process.version,unicodeVersion:process.versions.unicode,decodes},null,2)+'\n');console.log('Wrote current decoder vectors '+process.version);process.exit(0);}
const pages=[];for(const [text,offset,budget] of [['abc\nend',0,6000],['😀日本語 abc\n'.repeat(900),0,500],['a'.repeat(599)+'😀tail',600,500],['short',999,500],['short',1e30,500],['one\n'.repeat(3000),0,6000]]){const doc={url:'https://page.test/',title:'Title',type:'text/plain',text,at:1};const web=new WebTools({});web.page=async()=>doc;const expected=await web.tools()[1].run({url:doc.url,offset,max_tokens:budget},{signal:new AbortController().signal});pages.push({doc,offset,budget,expected});}
const focuses=[];for(const method of ['lexical','decision'])for(const scores of [[0,0,0,0],[0.9,0.8,0.2,0.6],[0.3,0.2,0.1,0],[-0.5,0,0,0]]){
 const text=['# One\n'+('A '.repeat(800)),'## Two\n'+('B '.repeat(800)),'## Three\n'+('C '.repeat(100)),'## Four\n'+('D '.repeat(100))].join('\n');const sections=splitSections(text);const web=new WebTools({decisions:{relevance:async()=>({scores,method})}});focuses.push({sections,scores,method,maxTokens:600,expected:await web.focus({text},'query',{maxTokens:600})});
}
writeFileSync(new URL('../src/agent/web/fixtures/source.json',import.meta.url),JSON.stringify({nodeVersion:process.version,unicodeVersion:process.versions.unicode,html:htmlCases,entities:entities.map(text=>({text,expected:decodeEntities(text)})),duck,decodes,pages,focuses},null,2)+'\n');
const definitions=new WebTools({}).tools().map(({run,summarize,...d})=>d);writeFileSync(new URL('../src/agent/web/catalog.json',import.meta.url),JSON.stringify(definitions,null,2)+'\n');
console.log(JSON.stringify({html:htmlCases.length,entities:entities.length,duck:duck.length,decodes:decodes.length,pages:pages.length,focuses:focuses.length}));
