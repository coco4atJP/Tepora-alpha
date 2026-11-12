/** A fake decision endpoint driven by a function: `answer(question, state, name)` returns a probability for noul
 * questions or an option name for choice questions. `question` is always in Tepora's System One shape.
 * `protocol` picks the wire format: 'system-one' (Jev, Liquid d1, Perplexity, Laya…; accepts /systemone and a path
 * ending in /decisions), 'openai-decisions' or 'gemini-decisions'. `refuse` makes OpenAI refuse every question and
 * Gemini answer its 400 safety block. Every request is recorded as {path, headers, body}. */
import http from 'node:http';
export async function decisionModel(answer,{protocol='system-one',refuse=false}={}){
 const requests=[];
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  const path=req.url.split('?')[0];
  if(!(path.endsWith('/decisions')||protocol==='system-one'&&path.endsWith('/systemone'))){res.writeHead(404);return res.end('{}');}
  const body=JSON.parse(raw);requests.push({path,headers:req.headers,body});
  let questions,state;
  if(protocol==='openai-decisions'){
   state=body.input;
   questions=Object.fromEntries(body.questions.map(q=>[q.name,q.type==='predicate'?{type:'noul',instructions:q.instructions}:
    q.type==='choice'?{type:'choice',instructions:q.instructions,criteria:Object.fromEntries(q.choices.map(c=>[c.value,c.description]))}:
    {type:'score',instructions:q.instructions,criteria:q.levels.map(l=>l.label)}]));
  } else if(protocol==='gemini-decisions'){
   if(!req.headers['x-goog-api-key'])return send(res,401,{error:{code:401,message:'API key missing',status:'UNAUTHENTICATED'}});
   if(Object.values(body.questions).some(q=>q.type==='noul'&&q.criteria&&!('true_description' in q.criteria)))return send(res,400,{error:{code:400,message:'Invalid criteria',status:'INVALID_ARGUMENT'}});
   if(refuse)return send(res,400,{error:{code:'safety',message:'Request blocked due to safety violations.'}});
   state=body.input;questions=body.questions;
  } else {state=body.state;questions=body.questions;}
  const answers={};
  for(const [name,q] of Object.entries(questions)){
   const v=answer(q,state,name);
   if(q.type==='noul')answers[name]={type:'noul',noul:v};
   else if(q.type==='choice'){const keys=Object.keys(q.criteria),probs=Object.fromEntries(keys.map(k=>[k,k===v?0.9:0.1/(keys.length-1)]));answers[name]={type:'choice',choice:v,probabilities:probs,confidence:0.9};}
   else answers[name]={type:'score',score:v,probabilities:{}};
  }
  if(protocol!=='openai-decisions')return send(res,200,{model:body.model,answers,usage:{input_tokens:10,output_tokens:0}});
  send(res,200,{model:body.model,answers:Object.entries(answers).map(([name,a])=>refuse?{type:'refusal',name}:
   a.type==='noul'?{type:'predicate',name,probability:a.noul}:
   a.type==='choice'?{type:'choice',name,choice:a.choice,probabilities:Object.entries(a.probabilities).map(([value,probability])=>({value,probability})),confidence:a.confidence}:
   {type:'score',name,score:a.score,probabilities:[]})});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
