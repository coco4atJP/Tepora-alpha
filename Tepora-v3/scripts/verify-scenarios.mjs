import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,access} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {groups,cases} from '../spec/answers.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const meta=JSON.parse(await readFile(path.join(root,'spec/source.json'),'utf8'));
const raw=gunzipSync(await readFile(path.join(root,'spec/Tepora_V3_100_Scenarios_v2.json.gz')));
assert.equal(createHash('sha256').update(raw).digest('hex'),meta.sha256,'The source specification changed.');
const input=JSON.parse(raw);
const ids=new Set(input.scenarios.map(s=>s.id));
assert.equal(ids.size,100);assert.equal(cases.length,100);
const seen=new Set(),answers=[];
for(const [id,groupList,remaining,explicitStatus] of cases){
 assert(ids.has(id)&&!seen.has(id),`Unknown or duplicate scenario ${id}`);seen.add(id);
 const refs=groupList?groupList.split(' '):[];
 const files=[],tests=[],implemented=[];
 for(const ref of refs){
  assert(groups[ref],`Unknown evidence group ${ref}`);
  const group=groups[ref];files.push(...group.files);tests.push(...group.tests);implemented.push(group.answer);
  for(const file of [...group.files,...group.tests])await access(path.join(root,file));
 }
 const scenario=input.scenarios.find(s=>s.id===id);
 const status=explicitStatus||(refs.length?'partial':'not_implemented');
 assert(['mechanism_tested','partial','not_implemented'].includes(status));
 if(status!=='mechanism_tested')assert(remaining,`${id} must name its remaining acceptance work`);
 answers.push({id,situation:scenario.situation,requirement:scenario.requirement,
  acceptanceTest:scenario.acceptance_test,status,implemented,sourceFiles:[...new Set(files)],
  verificationFiles:[...new Set(tests)],remaining,
  evidenceLimit:'This is implementation traceability, not a real-user or real-model E2E pass.'});
}
assert.deepEqual([...seen].sort(),[...ids].sort());
const counts=Object.fromEntries(['mechanism_tested','partial','not_implemented'].map(s=>[s,answers.filter(a=>a.status===s).length]));
const report={version:'3.0.0-beta.10',source:meta,counts,fictionalPersonas:true,realModelE2E:false,
 claim:'Code/test references cover mechanisms only. The 100 journeys are not claimed to have passed.',
 scenarios:answers};
const out=path.resolve(process.argv[2]||path.join(root,'validation'));
await mkdir(out,{recursive:true});
await writeFile(path.join(out,'scenario-answers.json'),JSON.stringify(report,null,2));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows=answers.map(a=>`<tr><td>${a.id}</td><td><strong>${esc(a.situation)}</strong><p>${esc(a.requirement)}</p></td><td>${a.implemented.map(esc).join('<br><br>')||'未実装'}<p class="files">${a.sourceFiles.map(esc).join('<br>')}</p></td><td><b>${esc(a.status)}</b><p>${esc(a.remaining||'表示プリセットの検証・権限制約を自動試験。実利用者試験ではありません。')}</p><details><summary>検証コード</summary>${a.verificationFiles.map(esc).join('<br>')}</details></td></tr>`).join('');
const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tepora V3 — 100場面への実装回答</title><style>body{font-family:system-ui,sans-serif;line-height:1.7;margin:40px;color:#202329;background:#f7f8fa}main{max-width:1500px;margin:auto}h1{font-size:28px}p{margin:.6em 0}table{border-collapse:collapse;width:100%;background:white}th,td{padding:20px;text-align:left;vertical-align:top;border-bottom:1px solid #dce1e5}th{background:#e8edef;position:sticky;top:0}td:first-child{white-space:nowrap}td:nth-child(2){width:26%}td:nth-child(3){width:38%}.files{font:12px ui-monospace,monospace;color:#52717b;overflow-wrap:anywhere}details{font-size:13px}@media(max-width:850px){body{margin:16px}table,tbody,tr,td{display:block}thead{display:none}tr{margin-bottom:20px}td,td:nth-child(2),td:nth-child(3){width:auto}}</style><main><h1>100場面への実装回答</h1><p>Tepora 3.0.0-beta.10 · 原仕様SHA-256: <code>${meta.sha256}</code></p><p>機構の限定試験: ${counts.mechanism_tested} / 部分実装: ${counts.partial} / 未実装: ${counts.not_implemented}。これは100件の実利用試験に合格したという意味ではありません。</p><p>各行を元の受け入れ条件・実装ファイル・検証コード・残作業に結び付けています。モデル精度、実GPU、実サービス、ネイティブ実機の確認は別に必要です。</p><table><thead><tr><th>ID</th><th>場面と要求</th><th>現在の実装</th><th>残る受け入れ条件</th></tr></thead><tbody>${rows}</tbody></table></main></html>`;
await writeFile(path.join(out,'scenario-answers.html'),html);
if(process.argv.includes('--extract'))await writeFile(path.join(out,meta.source),raw);
console.log(JSON.stringify({scenarios:100,counts,sourceSha256:meta.sha256,realModelE2E:false}));
