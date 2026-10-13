/** Real-model evaluation of the agent harness. Each case runs as a work agent in a fresh folder; the result is
 * checked against files and artifacts, and the run's cost profile is recorded: steps, tool errors, tokens, cache
 * hit rate, clears and compactions, recoveries, money and time. Local and LAN models by default; a cloud API needs
 * --allow-cloud. Nothing here is a benchmark against other agents: it is a regression suite for this harness.
 *
 *   node scripts/eval-agent.mjs --list
 *   node scripts/eval-agent.mjs --run --url http://127.0.0.1:8080/v1 --model qwen3 [--protocol chat-completions]
 *        [--key-env OPENAI_API_KEY] [--allow-cloud] [--cases a,b] [--repeat 3] [--timeout 300] [--context 32768] [--out report.json]
 *        [--decision liquid|laya|<System One base URL>] [--decision-model d1:free] [--decision-key-env LIQUID_API_KEY]
 *        [--state DIR] keep the record (episodes, learnt policy) in DIR across runs and models instead of a fresh folder
 *        [--dream]     dream once after the run (with --state, the record of earlier runs counts too)
 *        [--rounds 3]  run → record → dream → run again (Dream-RSI): after each round the decision-model episodes are
 *                      labelled with the cases' verdicts and the harness policy is re-fitted for the next round
 */
import {readFile,mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Store} from '../core/store.mjs';
import {NetworkPolicy} from '../core/network-policy.mjs';
import {ProviderRegistry} from '../core/provider-registry.mjs';
import {AgentRuntime} from '../core/agent/runtime.mjs';
import {Capabilities} from '../core/capabilities.mjs';
import {invariant} from '../core/policy.mjs';
import {evaluateChecks} from './eval-checks.mjs';
import {budgetCost} from '../core/model-usage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),get=key=>{const i=args.lastIndexOf(key);return i<0?undefined:args[i+1];};
const all=JSON.parse(await readFile(path.join(root,'evals/workflows.json'),'utf8'));
if(args.includes('--list')){for(const c of all)console.log(`${c.id}\t${c.input}`);process.exit(0);}
invariant(args.includes('--run'),'Pass --list to see the cases, or --run with --url and --model to evaluate a model.');
const url=get('--url'),model=get('--model'),protocol=get('--protocol')||'chat-completions';invariant(url&&model,'--url and --model are required');
const host=new URL(url).hostname,domain=/^(localhost|127\.|\[?::1)/.test(host)?'device':/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)?'lan':'cloud';
invariant(domain!=='cloud'||args.includes('--allow-cloud'),'This URL is a cloud API: add --allow-cloud to send the cases there.');
const wanted=get('--cases')?.split(',')||null,cases=all.filter(c=>!wanted||wanted.includes(c.id)),repeat=Number(get('--repeat')??1),rounds=Number(get('--rounds')??1),timeoutMs=Number(get('--timeout')??300)*1000;
invariant(cases.length>0&&(!wanted||wanted.every(id=>all.some(c=>c.id===id))),'Select one or more known cases; unknown case IDs are not allowed.');
invariant(Number.isSafeInteger(repeat)&&repeat>0&&Number.isSafeInteger(rounds)&&rounds>0,'--repeat and --rounds must be positive integers');
invariant(Number.isFinite(timeoutMs)&&timeoutMs>0,'--timeout must be positive and finite');

/** Deterministic fixture files some cases start from. */
function generate(kind){
 if(kind!=='log')return '';
 const lines=[],errors={400:['03:14:15','connection reset by peer'],950:['05:02:11','timeout talking to db'],1300:['06:40:00','retry budget exhausted'],1720:['08:12:09','connection reset by peer'],2100:['09:30:30','index rebuild failed'],2450:['10:05:44','timeout talking to db'],2900:['11:58:02','disk quota exceeded']};
 for(let i=1;i<=3000;i++){const t=new Date(Date.UTC(2026,0,1,0,0,i*14)).toISOString().slice(11,19);lines.push(errors[i]?`${errors[i][0]} ERROR ${errors[i][1]}`:`${t} INFO request ${i} served in ${(i*37)%250} ms`);}
 return lines.join('\n')+'\n';
}
const directory=get('--state')?path.resolve(get('--state')):await mkdtemp(path.join(os.tmpdir(),'tepora-eval-'));await mkdir(directory,{recursive:true});
const store=new Store(directory),network=new NetworkPolicy(store),registry=new ProviderRegistry(store,network);
const context=get('--context')?Number(get('--context')):null;
registry.save({profiles:[{id:'eval',protocol,baseUrl:url,model,domain,capabilities:{tools:true},...(get('--key-env')?{apiKeyEnv:get('--key-env')}:{}),...(context?{contextTokens:context}:{})}],routes:{main:{primary:'eval'}}},registry.get().revision);
/** Optional decision model (completion check, web_fetch questions, computer use). Liquid d1 is a cloud API, so it
 * also needs --allow-cloud. */
let capabilities=null;const decision=get('--decision');
if(decision){
 const preset={liquid:{baseUrl:'https://api.liquid.ai/decisions/v1',model:'d1:free',domain:'cloud',apiKeyEnv:'LIQUID_API_KEY',maxParallel:1},laya:{baseUrl:'http://127.0.0.1:8767/v1',model:'multilingual',domain:'device'}}[decision]
  ||{baseUrl:decision,model:'multilingual',domain:/^https?:\/\/(localhost|127\.)/.test(decision)?'device':'cloud'};
 invariant(preset.domain!=='cloud'||args.includes('--allow-cloud'),'The decision model is a cloud API: add --allow-cloud.');
 capabilities=new Capabilities(store,network);
 capabilities.save({profiles:[{id:'decision',name:'eval decision',protocol:'system-one',...preset,...(get('--decision-model')?{model:get('--decision-model')}:{}),...(get('--decision-key-env')?{apiKeyEnv:get('--decision-key-env')}:{}),enabled:true}],routes:{decision:'decision'}},capabilities.get().revision);
}
const rt=new AgentRuntime(store,{registry,network,capabilities,workRoot:path.join(directory,'work'),autoStart:false});
const results=[],dreams=[];
try{
 for(let round=1;round<=rounds;round++){
 for(let r=0;r<repeat;r++)for(const c of cases){
  const cwd=await mkdtemp(path.join(directory,'case-'));
  for(const f of c.setup||[]){const file=path.join(cwd,f.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,f.content??generate(f.generate));}
  // Complete setup before spawn starts inference; respect the filesystem birth-time tolerance.
  if(c.setup?.length)await new Promise(x=>setTimeout(x,1100));
  const started=Date.now(),s=await rt.spawn(null,{task:c.input,title:c.id,cwd});
  let end;for(;;){end=rt.sessions.get(s.id);if(['done','stopped'].includes(end.status))break;if(Date.now()-started>timeoutMs){rt.stop(s.id,'eval timeout');end=rt.sessions.get(s.id);break;}await new Promise(x=>setTimeout(x,100));}
  const checks=await evaluateChecks(c,s.cwd,store,rt.sessions.entries(s.id,{types:['tool']}),s.id),st=end.stats||{},events=rt.sessions.entries(s.id,{types:['event']}).map(e=>e.event);
  if(end.status!=='done')checks.push({type:'completion',ok:false,detail:`Session ${end.status}: ${end.note||''}`});
  const passed=checks.every(x=>x.ok);
  rt.dreamer.labelSession(s.id,{final:passed?1:0,source:'eval'});
  const result={id:c.id,round,run:r+1,policy:rt.dreamer.policy().revision,selfChecks:events.filter(e=>e==='self-check').length,reflected:!!end.reflection,passed,status:end.status,latencyMs:Date.now()-started,steps:st.steps||0,toolCalls:st.toolCalls||0,toolErrors:st.toolErrors||0,
   inputTokens:st.input||0,outputTokens:st.output||0,cacheHitRate:st.input?Math.round(100*(st.cacheRead||0)/st.input):null,clears:st.clears||0,compactions:st.compactions||0,
   decisions:events.filter(e=>/^decision|^completion/.test(e)).length,recoveries:events.filter(e=>['overflow','waiting','escalated','input-truncated','no-vision','bad-request','crash'].includes(e)),costUsd:budgetCost(st.cost||0,st.modelUsage),unknownCostCalls:st.modelUsage?.unknownCostCalls??st.unknownCostCalls??0,
   failed:checks.filter(x=>!x.ok).map(x=>`${x.path||x.title}: ${x.detail}`),report:String(end.result||end.note||'').slice(0,300)};
  results.push(result);console.log(JSON.stringify(result));
 }
 if(rounds>1||args.includes('--dream')){const d=await rt.dreamer.dream({reason:`eval round ${round}`});dreams.push({round,adopted:d.adopted,changes:d.changes,notes:d.notes,episodes:d.episodes,replayed:d.replayed});console.log(JSON.stringify({dream:round,adopted:d.adopted,changes:d.changes,notes:d.notes}));}
 }
}finally{
 await rt.close();
 const sum=(k)=>results.reduce((n,x)=>n+(x[k]||0),0),passed=results.filter(x=>x.passed).length;
 const expected=cases.length*repeat*rounds;
 if(results.length!==expected||passed!==expected)process.exitCode=1;
 const report={schema:3,model,url,protocol,domain,platform:process.platform,createdAt:new Date().toISOString(),passed,total:results.length,expected,
  policy:rt.dreamer.policy(),dreams,totals:{steps:sum('steps'),toolErrors:sum('toolErrors'),inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),costUsd:sum('costUsd'),unknownCostCalls:sum('unknownCostCalls'),latencyMs:sum('latencyMs')},results,
  limitations:'A small, unblinded regression suite run on one machine. Not a comparison with other agents or proof of general capability.'};
 const output=get('--out')||path.join(directory,'report.json');await writeFile(output,JSON.stringify(report,null,2));
 const md=`# Agent eval: ${model}\n\n${passed}/${results.length} passed · ${report.totals.steps} steps · ${report.totals.inputTokens.toLocaleString()} input tokens · $${report.totals.costUsd.toFixed(4)} known estimated cost (${report.totals.unknownCostCalls} dispatches with unknown cost)\n\n| case | pass | steps | tool errors | cache | clears/compactions | s |\n|---|---|---|---|---|---|---|\n`+
  results.map(x=>`| ${rounds>1?'R'+x.round+' ':''}${x.id}${repeat>1?' #'+x.run:''} | ${x.passed?'✓':'✗ '+x.failed.join('; ')} | ${x.steps} | ${x.toolErrors} | ${x.cacheHitRate??'-'}% | ${x.clears}/${x.compactions} | ${(x.latencyMs/1000).toFixed(1)} |`).join('\n')+'\n'+(dreams.length?`\n## Dreaming between rounds\n\n`+dreams.map(d=>`- after round ${d.round}: ${d.adopted?d.changes.map(c=>`${c.kind} ${c.field} ${typeof c.from==='object'?JSON.stringify(c.from):c.from} → ${c.to}`).join('; '):'no change — '+d.notes.join(' ')}`).join('\n')+'\n':'');
 await writeFile(output.replace(/\.json$/,'')+'.md',md);store.close();
 console.log(JSON.stringify({report:output,passed,total:results.length,workspace:directory}));
}
