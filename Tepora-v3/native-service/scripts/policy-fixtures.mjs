// Frozen ECMAScript oracle for native matcher tests. Test-only Node use; no
// subprocess or JS engine is part of the native service's runtime path.
import {writeFileSync} from 'node:fs';
import {validateRules,Policy} from '../../core/agent/policy.mjs';
const cases=[];
function add(label,rules,name,args){
 let normalized,error,decision;
 try{normalized=validateRules(rules);const p=new Policy({store:{list:()=>[]},settings:()=>({policy:{rules:normalized}})});const rule=p.rule(name,args);decision={action:rule?.action||'allow',note:rule?.note||'',rule:rule||null};}catch(e){error=true;}
 cases.push({label,rules,name,args,...(error?{error}:{normalized,decision})});
}
const args=[{},null,false,0,'',[],{message:'HELLO secret SECRET'},{message:'ababa'},{message:'😀'},{message:'ſKkSsßéÉΣσς'},{message:'\ud800'},{message:'\ue000\ue100'},{message:'a\nb\r\nc'},{'10':'ten','2':'two',z:1,a:2},{message:'\\ud800'}];
const patterns=[
 '', 'secret', '(?<=message":")HELLO', '(?<!foo)secret', 'secret(?= SECRET)', 'secret(?!x)',
 '(SECRET) \\1', '(?<word>secret) \\k<word>', '(ab)+\\1', '(a|(b))\\2c',
 '"message":".."', '"message":"."', '😀+', '[😀]', '[^😀]', '\\ud83d', '\\ude00',
 '\\ud800', '\\\\ud800', '[\\ud800-\\udfff]', '\\w+', '\\bſ\\b', 'k', 's', 'é', 'σ',
 '\\p{Letter}', '\\u{1F600}', '\\a', '\\8', '\\123', '[\\b]', '(a)\\10', '[a-\\d]',
 '^\\{', '\\}$', '10.*2', '2.*10', '(?=a)*', 'a{', 'a{1,2}', '[]', '[^]',
 '^.*$', 'a|', '(?:ab)?', '()', '[', '(?i)a', '(?<x>a)(?<x>b)', '(?>a)', 'a++',
];
for(const pattern of patterns)for(const [i,argsValue] of args.entries())add(`${JSON.stringify(pattern)} args${i}`,[{tool:'*',action:'deny',match:pattern}],'write',argsValue);
for(const [label,rules,name,value] of [
 ['default',[],'write',{}],
 ['first wins',[{tool:'write',action:'allow'},{tool:'*',action:'deny'}],'write',{}],
 ['prefix',[{tool:'sessions_*',action:'ask',note:'check'},{tool:'*',action:'deny'}],'sessions_send',{}],
 ['middle-star-is-literal',[{tool:'ses*s',action:'deny'}],'sessions',{}],
 ['empty-prefix',[{tool:'*',action:'ask'}],'anything',{}],
 ['case-sensitive-tool',[{tool:'WRITE',action:'deny'}],'write',{}],
 ['later-invalid',[{tool:'*',action:'allow'},{tool:'*',action:'deny',match:'['}],'write',{}],
 ['coerced-note',[{tool:'*',action:'ask',note:['a',null,{},['b',null]]}],'write',{}],
 ['sliced-note',[{tool:'*',action:'ask',note:'a'.repeat(199)+'😀'}],'write',{}],
 ['pua-pattern',[{tool:'*',action:'deny',match:'\ue000\ue100'}],'write',{x:'\ue000\ue100'}],
 ['raw-lone-pattern',[{tool:'*',action:'deny',match:'\ud800'}],'write',{x:'\ud800'}],
 ['unicode-tool',[{tool:'書く',action:'ask'}],'write',{}],
 ['invalid-action',[{tool:'*',action:'never'}],'write',{}],
 ['invalid-match',[{tool:'*',action:'deny',match:123}],'write',{}],
 ['false-note',[{tool:'*',action:'ask',note:0,match:''}],'write',{}],
])add(label,rules,name,value);
const target=new URL('../src/agent/policy/source-fixtures.json',import.meta.url);
writeFileSync(target,JSON.stringify(cases,null,2)+'\n');
console.log(`Wrote ${cases.length} policy fixtures to ${target.pathname}`);
