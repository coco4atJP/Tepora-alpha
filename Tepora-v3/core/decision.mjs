import {invariant} from './policy.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
/** Decision wire formats. Tepora's own shape is System One; the other two are translated at the edge. */
export const DECISION_PROTOCOLS = Object.freeze(['system-one','openai-decisions','gemini-decisions']);
const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Route under `baseUrl` ('' when `baseUrl` already names the endpoint) and JSON body for one decision.
 * Scores from different providers are NOT interchangeable calibrated probabilities. */
export function decisionRequest(protocol,baseUrl,model,state,questions) {
  invariant(DECISION_PROTOCOLS.includes(protocol),'Not a decision protocol');
  invariant(record(questions)&&Object.keys(questions).length>=1&&Object.keys(questions).length<=16,'Invalid decision questions');
  for(const [key,q] of Object.entries(questions)) {
    invariant(QUESTION_KEY.test(key),'Invalid decision question key');
    invariant(record(q)&&['choice','noul','score'].includes(q.type),'Invalid decision type');
    if(q.type==='choice') invariant(record(q.criteria)&&Object.keys(q.criteria).length>=2&&Object.keys(q.criteria).length<=16,'Shortlist 2–16 candidates first');
    if(q.type==='score') invariant(Array.isArray(q.criteria)&&q.criteria.length>=2&&q.criteria.length<=10,'Invalid score levels');
  }
  const last=String(baseUrl).replace(/\/+$/,'').split('/').pop();
  const route=['systemone','decisions'].includes(last)?'':protocol==='system-one'?'/systemone':'/decisions';
  const input=typeof state==='string'?state:JSON.stringify(state);
  let body;
  if(protocol==='system-one') body={model,state,questions};
  else if(protocol==='gemini-decisions') {
    invariant(input.length>0,'Decision context is empty');
    body={model,input,questions:Object.fromEntries(Object.entries(questions).map(([key,q])=>[key,
      q.type==='noul'&&q.criteria?{...q,criteria:{true_description:q.criteria.true,false_description:q.criteria.false}}:q]))};
  } else body={model,input,questions:Object.entries(questions).map(([name,q])=>
    q.type==='noul'?{type:'predicate',name,instructions:(q.instructions||'')+(q.criteria?`\nYes means: ${q.criteria.true}\nNo means: ${q.criteria.false}`:'')}:
    q.type==='choice'?{type:'choice',name,instructions:q.instructions||'',choices:Object.entries(q.criteria).map(([value,description])=>({value,description}))}:
    {type:'score',name,instructions:q.instructions||'',levels:q.criteria.map(label=>({label}))})};
  invariant(Buffer.byteLength(JSON.stringify(body))<=65536,'Decision context exceeds budget',413);
  return {route,body};
}

/** OpenAI answers a list in its own types; return the System One answer map. */
function openaiAnswers(questions,body) {
  invariant(Array.isArray(body?.answers),'Decision response has no answers',502);
  const answers={};
  for(const a of body.answers) {
    invariant(record(a)&&typeof a.name==='string'&&Object.hasOwn(questions,a.name)&&!Object.hasOwn(answers,a.name),'Invalid decision answer names',502);
    // A refused question is the provider's judgement, not a service failure: the caller falls back.
    if(a.type==='refusal') throw Object.assign(new Error(`Decision refused: ${a.name}`),{status:502,knownRejected:true,refused:true});
    const extra=a.confidence===undefined?{}:{confidence:a.confidence};
    if(a.type==='predicate') answers[a.name]={type:'noul',noul:a.probability,...extra};
    else if(a.type==='choice') {
      invariant(Array.isArray(a.probabilities)&&a.probabilities.every(p=>record(p)&&typeof p.value==='string'),'Invalid distribution',502);
      answers[a.name]={type:'choice',choice:a.choice,probabilities:Object.fromEntries(a.probabilities.map(p=>[p.value,p.probability])),...extra};
    } else if(a.type==='score') {
      invariant(Array.isArray(a.probabilities)&&a.probabilities.every(record),'Invalid distribution',502);
      answers[a.name]={type:'score',score:a.score,probabilities:Object.fromEntries(a.probabilities.map(p=>[String(p.value),p.probability])),...extra};
    } else invariant(false,`Invalid decision answer: ${a.name}`,502);
  }
  return {model:body.model,answers};
}

/** Validate a provider response as typed System One answers. Gemini already answers in that shape. */
export function decisionAnswers(protocol,model,questions,raw) {
  const body=protocol==='openai-decisions'?openaiAnswers(questions,raw):raw;
  invariant(record(body?.answers),'Decision response has no answers',502);
  const answers={};
  for(const [key,q] of Object.entries(questions)) {
    const a=body.answers[key];
    invariant(record(a)&&a.type===q.type,`Invalid decision answer: ${key}`,502);
    if(q.type==='choice') {
      invariant(Object.hasOwn(q.criteria,a.choice),'Decision selected an unknown candidate',502);
      invariant(record(a.probabilities)&&Object.keys(a.probabilities).length===Object.keys(q.criteria).length,'Invalid distribution',502);
      let total=0;
      for(const label of Object.keys(q.criteria)) {
        const value=a.probabilities[label];
        invariant(Number.isFinite(value)&&value>=0&&value<=1,'Invalid decision probability',502);
        total+=value;
      }
      invariant(Math.abs(total-1)<0.02,'Distribution does not sum to one',502);
    } else {
      const value=q.type==='noul'?a.noul:a.score;
      invariant(Number.isFinite(value)&&value>=0&&value<=(q.type==='noul'?1:q.criteria.length-1),'Invalid decision score',502);
    }
    if(a.confidence!==undefined) invariant(Number.isFinite(a.confidence)&&a.confidence>=0&&a.confidence<=1,'Invalid confidence',502);
    answers[key]=a;
  }
  return {model:body.model||model,answers,advisory:true,calibration:'not-validated-for-Tepora'};
}
