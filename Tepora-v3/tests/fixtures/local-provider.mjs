/** Scripted HTTP protocol peer for product-flow regression tests. Not an LLM. */
import http from 'node:http';
export async function createFixtureProvider({models=[],mode='normal'}={}){
 let installed=[...models];const requests=[];const timers=new Set();
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const b of req)text+=b;const body=text?JSON.parse(text):{};
  requests.push({path:req.url,body,authorization:req.headers.authorization});
  const json=value=>{if(res.destroyed)return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/api/tags')return json({models:installed.map(name=>({name,size:512000,digest:'fixture-digest',...(name.endsWith(':cloud')?{remote_host:'example.org'}:{})}))});
  if(req.url==='/v1/models')return json({data:installed.map(id=>({id}))});
  if(req.url==='/api/pull'){
   res.writeHead(200,{'Content-Type':'application/x-ndjson'});
   if(mode==='error-pull')return res.end(JSON.stringify({error:'fixture download failure'})+'\n');
   if(mode==='oversize-pull')return res.end(JSON.stringify({digest:'x',total:99_000_000_000,completed:0})+'\n');
   res.write(JSON.stringify({digest:'fixture',total:512000,completed:128000})+'\n');
   if(mode==='truncated-pull')return res.end();
   if(mode==='slow-pull')return;
   installed.push(body.model);res.end(JSON.stringify({digest:'fixture',total:512000,completed:512000})+'\n'+JSON.stringify({status:'success'})+'\n');return;
  }
  if(req.url==='/v1/chat/completions'){
   const messages=body.messages||[],challenge=messages.find(m=>m.role==='user'&&/^Challenge:/.test(m.content))?.content.slice(11);
   const respond=()=>{
    const finish=message=>json({choices:[{message,finish_reason:message.tool_calls?.length?'tool_calls':'stop'}]});
    const call=(id,name,args)=>finish({role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    if(challenge){
     if(mode==='bad-probe')return finish({role:'assistant',content:'I cannot use tools.'});
     const tool=messages.findLast(m=>m.role==='tool');
     if(!tool)return call('probe','tepora_probe',{challenge});
     return finish({role:'assistant',content:JSON.parse(tool.content).receipt});
    }
    const source=messages.find(m=>m.role==='system')?.content.match(/attached input files.*?: (\[.*?\])\. When/)?.[1];
    const files=source?JSON.parse(source):[],tools=messages.filter(m=>m.role==='tool');
    if(files.length&&!tools.length)return call('read','input_read',{id:files[0].id});
    if(files.length&&tools.length===1){const data=JSON.parse(tools[0].content);return call('publish','artifact_publish',{title:'確認メモ',kind:'text',content:'資料に記載された内容:\n'+data.content});}
    return finish({role:'assistant',content:'確認メモを用意しました。内容を確認してください。'});
   };
   if(mode==='slow-probe'){const timer=setTimeout(()=>{timers.delete(timer);respond();},150);timers.add(timer);return;}
   respond();return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}`,requests,
  close:async()=>{for(const t of timers)clearTimeout(t);server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
