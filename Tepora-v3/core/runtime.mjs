import { endpoint, invariant } from './policy.mjs';
export const PROVIDERS = Object.freeze([
  {id:'llama.cpp', name:'llama.cpp', url:'http://127.0.0.1:8080/v1'},
  {id:'vllm', name:'vLLM', url:'http://127.0.0.1:8000/v1'},
  {id:'ollama', name:'Ollama', url:'http://127.0.0.1:11434/v1'},
  {id:'lmstudio', name:'LM Studio', url:'http://127.0.0.1:1234/v1'},
]);
export async function* sseData(body) {
  const decoder = new TextDecoder(); let buffer = '', data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk,{stream:true});
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,index).replace(/\r$/,''); buffer = buffer.slice(index+1);
      if (!line && data.length) { yield data.join('\n'); data = []; }
      else if(line.startsWith('data:')) data.push(line.slice(5).trimStart());
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
    const b = await r.json(); return (b.data||[]).map(x=>x.id).filter(x=>typeof x === 'string');
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
      const b=await response.json(); const m=b.choices?.[0]?.message;
      invariant(m,'No assistant message in runtime response',502); if(m.content) onDelta(m.content); return m;
    }
    let content='', calls=new Map(), completed=false, truncated=false;
    for await(const data of sseData(response.body)) {
      if(data === '[DONE]') {completed=true;break;}
      let packet; try{packet=JSON.parse(data);}catch{throw new Error('Malformed model SSE event');}
      const choice=packet.choices?.[0]; if(!choice) continue;
      if(choice.finish_reason){completed=true;truncated ||= choice.finish_reason==='length';}
      const delta=choice.delta||{};
      if(typeof delta.content === 'string') {content+=delta.content; invariant(content.length<200000,'Model output exceeded limit');onDelta(delta.content);}
      for(const c of delta.tool_calls||[]) {
        const item=calls.get(c.index)||{id:'',type:'function',function:{name:'',arguments:''}};
        if(c.id) item.id=c.id; if(c.function?.name) item.function.name+=c.function.name;
        if(c.function?.arguments) item.function.arguments+=c.function.arguments;
        invariant(item.function.arguments.length<220000,'Tool arguments exceeded limit');
        calls.set(c.index,item);
      }
    }
    invariant(completed,'Connection ended before the model completed its response',502);
    invariant(!truncated,'Model output was truncated at the token limit; task is not complete',502);
    const tool_calls=[...calls.values()];
    invariant(tool_calls.every(c=>c.id && c.function.name),'Incomplete tool call metadata',502);
    invariant(tool_calls.length<=16,'Too many tool calls');
    return {role:'assistant',content:content||null,...(tool_calls.length?{tool_calls}: {})};
  }
  async decide(state,signal) {
    if(!this.settings.decisionUrl) return null;
    const url=endpoint(this.settings.decisionUrl,this.settings.allowCloud);
    const r=await this.fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(5000)]),body:JSON.stringify({model:this.settings.decisionModel,state,questions:{intent:{type:'choice',instructions:'Classify the user request. This is advisory routing, NOT a security authorization.',criteria:{conversation:'Conversation or explanation',artifact:'Create or update a document or visual artifact',computer:'Computer or file operation',research:'Research and information gathering'}}},samples:'auto'})});
    invariant(r.ok,`Decision service returned HTTP ${r.status}`,502);
    const body=await r.json(), answer=body.answers?.intent||body.results?.intent||body.intent;
    invariant(answer && ['conversation','artifact','computer','research'].includes(answer.choice),'Unsupported System One response',502);
    return {choice:answer.choice,confidence:typeof answer.confidence==='number'?answer.confidence:null};
  }
}
export async function discover() {
  return Promise.all(PROVIDERS.map(async p=>{try {const models=await new Runtime({baseUrl:p.url,allowCloud:false}).models(); return {...p,available:true,models};}catch{return {...p,available:false,models:[]};}}));
}
