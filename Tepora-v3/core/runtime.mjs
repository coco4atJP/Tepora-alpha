import {boundedJSON} from './transport.mjs';
import { DecisionClient } from './decision.mjs';
import { endpoint, invariant } from './policy.mjs';
export const PROVIDERS = Object.freeze([
  {id:'llama.cpp', name:'llama.cpp', url:'http://127.0.0.1:8080/v1'},
  {id:'vllm', name:'vLLM', url:'http://127.0.0.1:8000/v1'},
  {id:'ollama', name:'Ollama', url:'http://127.0.0.1:11434/v1'},
  {id:'lmstudio', name:'LM Studio', url:'http://127.0.0.1:1234/v1'},
]);
export async function* sseData(body) {
  const decoder = new TextDecoder(); let buffer = '', data = [],frameChars=0;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk,{stream:true});
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,index).replace(/\r$/,''); buffer = buffer.slice(index+1);
      if (!line && data.length) { yield data.join('\n'); data = [];frameChars=0; }
      else if(line.startsWith('data:')){frameChars+=line.length;invariant(frameChars<2_000_000,'Upstream stream frame is too large',502);data.push(line.slice(5).trimStart());}
    }
    invariant(buffer.length < 2_000_000, 'Upstream stream frame is too large',502);
  }
  buffer += decoder.decode();
  if(buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
  if(data.length) yield data.join('\n');
}
export class Runtime {
  constructor(settings, key='', fetcher=fetch) { this.settings=structuredClone(settings); this.key=key; this.fetch=fetcher; }
  headers() { return {'Content-Type':'application/json', ...(this.key ? {Authorization:`Bearer ${this.key}`} : {})}; }
  url(suffix) { return `${endpoint(this.settings.baseUrl,this.settings.allowCloud).href.replace(/\/$/,'')}/${suffix}`; }
  async models(signal) {
    const r = await this.fetch(this.url('models'),{headers:this.headers(),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(4000)]),redirect:'error'});
    invariant(r.ok,`Runtime returned HTTP ${r.status}`,502);
    const b=await boundedJSON(r);invariant(Array.isArray(b.data)&&b.data.length<=1000,'Invalid model list',502);return b.data.map(x=>x?.id).filter(x=>typeof x==='string');
  }
  async chat(messages, {tools=[], onDelta=()=>{}, signal, maxTokens}={}) {
    const model = this.settings.model || (await this.models(signal))[0];
    invariant(model,'モデルが見つかりません。接続設定でモデルを選択してください。',409);
    const response = await this.fetch(this.url('chat/completions'), {
      method:'POST',headers:this.headers(),redirect:'error',signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(180000)]),
      body:JSON.stringify({model,messages,stream:true,max_tokens:maxTokens||this.settings.maxTokens,...(tools.length ? {tools,tool_choice:'auto'}:{})})
    });
    invariant(response.ok,`Model request failed (HTTP ${response.status}). モデル・認証・tool calling対応を確認してください。`,502);
    if(!(response.headers.get('content-type')||'').includes('text/event-stream')) {
      const b=await boundedJSON(response),choice=b.choices?.[0],m=choice?.message;
      invariant(choice?.finish_reason!=='length','Model output was truncated at the token limit; task is not complete',502);
      invariant(choice?.finish_reason!=='content_filter','Model output was stopped by the provider; task is not complete',502);
      invariant(m&&typeof m==='object'&&!Array.isArray(m),'No assistant message in runtime response',502);
      invariant(m.content===undefined||m.content===null||typeof m.content==='string'&&m.content.length<200000,'Invalid model message',502);
      if(m.tool_calls){invariant(Array.isArray(m.tool_calls)&&m.tool_calls.length<=16&&m.tool_calls.every(c=>typeof c?.id==='string'&&c.id.length>0&&typeof c.function?.name==='string'&&typeof c.function.arguments==='string'&&c.function.arguments.length<220000),'Invalid tool calls',502);}
      invariant(!m.refusal,'Model refused this request',502);if(m.content) onDelta(m.content);return m;
    }
    let content='', calls=new Map(), completed=false, truncated=false, refused=false;
    for await(const data of sseData(response.body)) {
      if(data === '[DONE]') {completed=true;break;}
      let packet; try{packet=JSON.parse(data);}catch{throw new Error('Malformed model SSE event');}
      const choice=packet.choices?.[0]; if(!choice) continue;
      if(choice.finish_reason){completed=true;truncated ||= choice.finish_reason==='length';refused ||= choice.finish_reason==='content_filter';}
      const delta=choice.delta||{};refused ||= Boolean(delta.refusal);
      if(typeof delta.content === 'string') {content+=delta.content; invariant(content.length<200000,'Model output exceeded limit');onDelta(delta.content);}
      for(const c of delta.tool_calls||[]) {
        invariant(Number.isSafeInteger(c.index)&&c.index>=0&&c.index<16,'Invalid tool-call index',502);
        const item=calls.get(c.index)||{id:'',type:'function',function:{name:'',arguments:''}};
        if(c.id) item.id=c.id; if(c.function?.name) item.function.name+=c.function.name;
        if(c.function?.arguments) item.function.arguments+=c.function.arguments;
        invariant(item.function.arguments.length<220000,'Tool arguments exceeded limit');
        calls.set(c.index,item);
      }
    }
    invariant(completed,'Connection ended before the model completed its response',502);
    invariant(!refused,'Model output was refused or filtered; task is not complete',502);
    invariant(!truncated,'Model output was truncated at the token limit; task is not complete',502);
    const tool_calls=[...calls.values()];
    invariant(tool_calls.every(c=>c.id && c.function.name),'Incomplete tool call metadata',502);
    invariant(tool_calls.length<=16&&new Set(tool_calls.map(c=>c.id)).size===tool_calls.length,'Invalid number or duplicate tool calls');
    return {role:'assistant',content:content||null,...(tool_calls.length?{tool_calls}: {})};
  }
  async decide(state,signal) {
    this.decisionClient ||= new DecisionClient({url:this.settings.decisionUrl,model:this.settings.decisionModel||'multilingual'},this.fetch);
    const result=await this.decisionClient.decide(state,undefined,signal);
    return result ? {...result.answers.intent,advisory:true,model:result.model} : null;
  }
}
export async function discover() {
  return Promise.all(PROVIDERS.map(async p=>{try {const models=await new Runtime({baseUrl:p.url,allowCloud:false}).models(); return {...p,available:true,models};}catch{return {...p,available:false,models:[]};}}));
}
