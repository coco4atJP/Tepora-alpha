/** Optional real computer-use check. A real Chromium-family browser (headless) operates a local fixture page:
 * direct actions, then the decision loop with a deterministic chooser, then a screenshot. On macOS it also builds
 * the Accessibility helper and reports its permissions. No public site, model, login or download is involved.
 * usage: node scripts/check-computer.mjs [output folder]
 */
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {Browser,findBrowser} from '../core/computer/browser.mjs';
import {runGoal} from '../core/computer/decide.mjs';
import {Desktop,desktopSupported} from '../core/computer/desktop.mjs';

const out=path.resolve(process.argv[2]||'validation/computer-live');await mkdir(out,{recursive:true});
const executable=findBrowser(process.env.TEPORA_BROWSER||'');
if(!executable){console.log(JSON.stringify({skipped:true,reason:'No Chrome, Edge, Brave or Chromium found'}));process.exit(0);}
const page=`<!doctype html><title>Fixture</title><label>お名前 <input id=n></label><label><input type=checkbox id=a> 同意</label>
<button onclick="s.textContent=a.checked?'送信済み: '+n.value:'同意が必要'">送信</button><p id=s>未送信</p>`;
const server=http.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(page);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const dir=await mkdtemp(path.join(os.tmpdir(),'tepora-computer-live-'));
const browser=new Browser({executable,profileDir:path.join(dir,'profile'),headless:true});
const report={executable,checks:[],createdAt:new Date().toISOString()};
const check=async(name,fn)=>{const t0=Date.now();try{const detail=await fn();report.checks.push({name,ok:true,ms:Date.now()-t0,detail});}catch(e){report.checks.push({name,ok:false,ms:Date.now()-t0,error:e.message});}};
try{
 const p=await browser.page('check');
 await check('open and observe',async()=>{await p.goto(`http://127.0.0.1:${server.address().port}/`);const o=await p.observe();assert.equal(o.title,'Fixture');return o.elements.map(e=>`${e.ref} ${e.role} ${e.name}`);});
 await check('direct actions',async()=>{const o=await p.observe();await p.fill(o.elements.find(e=>e.role==='textbox').ref,'直接');await p.click(o.elements.find(e=>e.role==='checkbox').ref);await p.click(o.elements.find(e=>e.name==='送信').ref);await p.settle(3000);assert.match((await p.observe()).text,/送信済み: 直接/);return 'filled, checked, sent';});
 await check('decision loop (deterministic chooser)',async()=>{
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  const choose=async(state,criteria)=>{const keys=Object.keys(criteria),box=state.controls.find(c=>c.name==='同意');
   const id=keys.find(k=>k.startsWith('fill_'))||(box&&!box.checked?keys.find(k=>criteria[k].includes('"同意"')):null)||(/送信済み/.test(state.visible_text)?'done':keys.find(k=>criteria[k].includes('"送信"')))||'blocked';
   return {choice:id,probabilities:{[id]:0.95},method:'fixture'};};
  const surface={observe:()=>p.observe(),settle:()=>p.settle(3000),act:c=>c.op==='click'?p.click(c.ref):c.op==='fill'?p.fill(c.ref,c.value):c.op==='key'?p.key(c.value):null};
  const r=await runGoal(surface,{goal:'名前を入れて同意し送信する',inputs:{'お名前':'判断'},checks:[{text_includes:'送信済み: 判断'}]},{choose});
  assert.equal(r.status,'completed');return r.steps.map(s=>s.action);
 });
 await check('screenshot',async()=>{const s=await p.screenshot();await writeFile(path.join(out,'screen.jpg'),Buffer.from(s.base64,'base64'));return `${s.width}x${s.height}`;});
 if(desktopSupported())await check('macOS accessibility helper',async()=>{const d=new Desktop({binDir:path.join(dir,'bin')});try{return {...await d.status(),windows:(await d.windows()).length};}finally{d.close();}});
}finally{
 await browser.close();server.close();await rm(dir,{recursive:true,force:true});
 report.passed=report.checks.filter(c=>c.ok).length;report.total=report.checks.length;
 await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({report:path.join(out,'report.json'),passed:report.passed,total:report.total,failed:report.checks.filter(c=>!c.ok).map(c=>`${c.name}: ${c.error}`)}));
 if(report.passed!==report.total)process.exitCode=1;
}
