/** An OpenAI-compatible model server driven by a script. Not an LLM: each request is answered by
 * `handler(body, state)`, which returns {content, calls:[{name,args|arguments}], finish, usage, delayMs}. */
import http from 'node:http';
export async function scriptedModel(handler,{context=null,stream=true}={}){
 const requests=[];let down=false;
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const b of req)text+=b;
  if(req.url==='/props'){if(!context){res.writeHead(404);return res.end('{}');}res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({default_generation_settings:{n_ctx:context},total_slots:1}));}
  if(!req.url.endsWith('/chat/completions')){res.writeHead(404);return res.end('{}');}
  if(down){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'down'}}));}
  const body=JSON.parse(text||'{}');requests.push(body);
  let r;try{r=await handler(body,{index:requests.length-1,requests});}catch(e){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:String(e.message)}}));}
  if(r?.status){res.writeHead(r.status,{'Content-Type':'application/json',...(r.headers||{})});return res.end(JSON.stringify(r.body||{error:{message:r.message||'error'}}));}
  if(r?.delayMs)await new Promise(x=>setTimeout(x,r.delayMs));
  const calls=(r.calls||[]).map((c,i)=>({index:i,id:c.id||`call_${requests.length}_${i}`,type:'function',function:{name:c.name,arguments:c.arguments??JSON.stringify(c.args||{})}}));
  const finish=r.finish||(calls.length?'tool_calls':'stop');
  const usage=r.usage||{prompt_tokens:0,completion_tokens:20};
  if(!stream||body.stream===false){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:r.content??null,...(calls.length?{tool_calls:calls}:{})},finish_reason:finish}],usage}));}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=o=>res.write(`data: ${JSON.stringify(o)}\n\n`);
  const content=r.content||'';for(let i=0;i<content.length;i+=7)send({choices:[{delta:{content:content.slice(i,i+7)}}]});
  for(const c of calls){const a=c.function.arguments;send({choices:[{delta:{tool_calls:[{index:c.index,id:c.id,type:'function',function:{name:c.function.name,arguments:''}}]}}]});for(let i=0;i<a.length;i+=11)send({choices:[{delta:{tool_calls:[{index:c.index,function:{arguments:a.slice(i,i+11)}}]}}]});}
  send({choices:[{delta:{},finish_reason:finish}]});send({choices:[],usage});res.end('data: [DONE]\n\n');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/v1`;
 return {url,requests,setDown:v=>{down=v;},close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
/** Last message of a role in a request body. */
export const last=(body,role)=>[...body.messages].reverse().find(m=>m.role===role);
export const toolResults=body=>body.messages.filter(m=>m.role==='tool');
