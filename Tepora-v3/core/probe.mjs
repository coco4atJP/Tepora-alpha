import {randomUUID} from 'node:crypto';
import {invariant} from './policy.mjs';
import {destination} from './context.mjs';
/** Real model protocol probe: no filesystem/process/network tools, nonce cannot be guessed.
 * Passing proves this minimal round trip, not all agent capabilities or task quality.
 */
export async function probeRuntime(runtime,settings,signal) {
  const nonce=randomUUID(),start=performance.now();
  const schema={type:'function',function:{name:'tepora_probe',description:'Echo the exact challenge in a safe capability test.',
    parameters:{type:'object',properties:{challenge:{type:'string'}},required:['challenge'],additionalProperties:false}}};
  const messages=[{role:'system',content:'This is a safe tool protocol test. Call tepora_probe with the challenge. After the tool responds, reply with only the receipt string it returned.'},
    {role:'user',content:`Challenge: ${nonce}`}];
  const a=await runtime.chat(messages,{tools:[schema],signal,maxTokens:200});
  invariant(a.tool_calls?.length===1&&a.tool_calls[0].function?.name==='tepora_probe','This model did not produce the required tool call',422);
  let args;try{args=JSON.parse(a.tool_calls[0].function.arguments);}catch{throw new Error('Tool arguments are not valid JSON');}
  invariant(args?.challenge===nonce,'Model changed the tool challenge',422);
  const receipt=randomUUID();
  messages.push({...a,role:'assistant'},{role:'tool',tool_call_id:a.tool_calls[0].id,content:JSON.stringify({receipt})});
  const b=await runtime.chat(messages,{tools:[],signal,maxTokens:200});
  invariant(typeof b.content==='string'&&b.content.includes(receipt)&&!b.tool_calls?.length,'Model did not use the returned tool result',422);
  return {passed:true,destination:destination(settings),model:settings.model,checkedAt:new Date().toISOString(),
    latencyMs:Math.round(performance.now()-start),evidence:['structured-tool-call','arguments-round-trip','tool-result-consumption'],
    limitation:'This safe two-call probe does not certify task quality, vision, performance under load, or arbitrary tool support.'};
}
