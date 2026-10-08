// Reconcile frozen actual-runtime vectors; no network and no decoder guesses.
import {readFileSync,writeFileSync} from 'node:fs';
const read=name=>JSON.parse(readFileSync(new URL('../src/agent/'+name,import.meta.url),'utf8'));
const old=read('web/fixtures/source.json'),current=read('web/fixtures/decodes-current.json'),tables={};
if(old.nodeVersion!=='v22.16.0')throw new Error('Unexpected source baseline: '+old.nodeVersion);
for(const row of old.decodes){
 if(!row.supported||row.bytes.length!==256||!row.bytes.every((b,i)=>b===i))continue;
 const expected=row.canonical==='windows-1252'?current.decodes.find(r=>r.canonical==='windows-1252'&&r.bytes.length===256).expected:row.expected;
 if(expected.length!==256)throw new Error('Not a single-byte mapping: '+row.canonical);
 tables[row.canonical.toLowerCase()]=expected;
}
const data={baseline:old.nodeVersion,windows1252:current.nodeVersion,tables};
writeFileSync(new URL('../src/agent/web/single-byte-tables.json',import.meta.url),JSON.stringify(data,null,2).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+'\n');
console.log(`Wrote ${Object.keys(tables).length} source-backed tables`);
