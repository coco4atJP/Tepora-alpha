// Pure source oracle: fake stores/capabilities only, no model, socket or key.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {SemanticMemory,cosine} from '../../core/semantic.mjs';
const docs=[
{id:'first',content:'ＡＢＣ café dogs 日本語 珈琲',title:'oldest',confirmed:true,scope:'private'},
{id:'second',content:'abc cafe dog tea 日本',confirmed:true,scope:'shared'},
{id:'unconfirmed',content:'abc dog',confirmed:false,scope:'shared'},
{id:'literal',content:'literal \ue000 marker and \ud800 isolated',confirmed:true,scope:'private'}];
const out={sourceHashes:{},search:[],cosine:[],hash:[]};
for(const path of ['core/semantic.mjs','core/search.mjs','core/policy.mjs'])out.sourceHashes[path]=createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex');
for(const query of ['ABC','dog','日本語','珈琲','tea','absent','\ud800','\ue000','café','\ufeff\u2000','\u0085','x'.repeat(4001),null,4])for(const options of [{},{recipientPrivate:false},{recipientPrivate:false,share:true},{limit:1},{limit:0},{limit:31}]){
 const state={list:k=>k==='memory'?structuredClone(docs):[],get:(k,id)=>k==='memory'?structuredClone(docs.find(d=>d.id===id)):null};
 try{out.search.push({query,options,docs,result:await new SemanticMemory(state,{pin(){throw Error('none')}}).search(query,options)});}catch(e){out.search.push({query,options,docs,error:{status:e.status||500,message:e.message}});}
}
for(const [a,b] of [[[1,0],[1,0]],[[1,0],[0,1]],[[-1,0],[1,0]],[[2,3],[4,5]],[[],[]],[[1],[1,2]],[[0,0],[1,0]],[[1,'x'],[1,2]],[[1e308],[1e308]],[[1e-308],[1e-308]]]){
 try{out.cosine.push({a,b,result:cosine(a,b)});}catch(e){out.cosine.push({a,b,error:{status:e.status||500,message:e.message}});}
}
for(const content of ['', 'plain', '\ud800', '\udc00', 'literal \ue000 marker', '\ue000\ud800', 'a😀b'])out.hash.push({content,result:createHash('sha256').update(content).digest('hex')});
await writeFile(new URL('../src/semantic/fixtures/source.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log(`semantic oracle: ${out.search.length} searches, ${out.cosine.length} cosine cases, ${out.hash.length} hashes`);
