/** A System One endpoint (the decision-model API of Liquid d1 and the Laya worker) driven by a function:
 * `answer(question, state, name)` returns a probability for noul questions or an option name for choice questions. */
import http from 'node:http';
export async function decisionModel(answer){
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  if(!req.url.endsWith('/systemone')){res.writeHead(404);return res.end('{}');}
  const body=JSON.parse(raw);requests.push(body);const answers={};
  for(const [name,q] of Object.entries(body.questions)){
   const v=answer(q,body.state,name);
   if(q.type==='noul')answers[name]={type:'noul',noul:v};
   else if(q.type==='choice'){const keys=Object.keys(q.criteria),probs=Object.fromEntries(keys.map(k=>[k,k===v?0.9:0.1/(keys.length-1)]));answers[name]={type:'choice',choice:v,probabilities:probs,confidence:0.9};}
   else answers[name]={type:'score',score:v,probabilities:{}};
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({model:body.model,answers,usage:{input_tokens:10,output_tokens:0}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/v1`,requests,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
