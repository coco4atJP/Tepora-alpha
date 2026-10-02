// Deterministic subprocess protocol fixture, NOT the Codex model/runtime.
import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const mode=process.env.TEPORA_CODEX_FIXTURE||'normal';let started=false,received=false,turn='turn-owned';
const event=(method,params)=>send({method,params:{threadId:'thread-owned',turnId:turn,...params}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){send({id:m.id,result:{userAgent:'fixture'}});return;}
 if(m.method==='initialized'){started=true;return;}
 if(m.method&&!started){send({id:m.id,error:{code:-32000,message:'Not initialized'}});return;}
 if(m.method==='account/read'){send({id:m.id,result:{account:{type:'apiKey'},requiresOpenaiAuth:true}});return;}
 if(['thread/start','thread/resume'].includes(m.method)){
  if(m.params.approvalPolicy!=='on-request')throw new Error('Unsafe approval policy');
  send({id:m.id,result:{thread:{id:m.params.threadId||'thread-owned'}}});return;
 }
 if(m.method==='turn/start'){
  if(m.params.sandboxPolicy.type!=='workspaceWrite'||m.params.sandboxPolicy.networkAccess!==false)throw new Error('Sandbox was not constrained');
  if(m.params.sandboxPolicy.readOnlyAccess.type!=='restricted')throw new Error('Read roots were not constrained');
  if(mode==='disconnect'){process.exit(2);return;}
  if(mode==='early')event('item/agentMessage/delta',{delta:'early '});
  if(mode==='approval'){
   event('item/started',{item:{id:'cmd',type:'commandExecution',command:'echo safe',cwd:m.params.cwd}});
   send({id:700,method:'item/commandExecution/requestApproval',params:{threadId:'thread-owned',turnId:turn,itemId:'cmd',command:'echo safe',cwd:m.params.cwd}});
  }
  send({id:m.id,result:{turn:{id:turn,status:'inProgress'}}});
  if(mode==='approval'||mode==='steer'||mode==='hang')return;
  event('item/agentMessage/delta',{delta:'finished'});
  event('item/completed',{item:{id:'msg',type:'agentMessage',text:'finished'}});
  event('turn/completed',{turn:{id:turn,status:'completed'}});return;
 }
 if(m.method==='turn/steer'){
  if(m.params.expectedTurnId!==turn)throw new Error('No expected turn guard');
  received=true;send({id:m.id,result:{turnId:turn}});
  event('item/agentMessage/delta',{delta:'changed: '+m.params.input[0].text});
  event('turn/completed',{turn:{id:turn,status:'completed'}});return;
 }
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});event('turn/completed',{turn:{id:turn,status:'interrupted'}});return;}
 if(m.id===700&&m.result){
  event('item/completed',{item:{id:'cmd',type:'commandExecution',exitCode:m.result.decision==='accept'?0:null,status:m.result.decision==='accept'?'completed':'declined'}});
  event('item/agentMessage/delta',{delta:'decision: '+m.result.decision});
  event('turn/completed',{turn:{id:turn,status:'completed'}});return;
 }
 if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Unsupported fixture method'}});
});
