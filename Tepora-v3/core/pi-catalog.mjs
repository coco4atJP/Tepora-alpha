import {builtinModels} from '@earendil-works/pi-ai/providers/all';

/** Narrow metadata supplement for Pi 1.3.0's older OpenCode snapshot.
 * IDs/endpoints/prices: https://opencode.ai/v2/docs/console/go/ (2026-10-21).
 * Context/output limits: https://models.dev/api.json (2026-10-21).
 * Keep Pi's authentication, API adapters, streaming and native replay unchanged.
 * These entries describe supported text/image inputs, not Pi video support.
 */
export function teporaPiModels(options){
 const models=builtinModels(options),go=models.getProvider('opencode-go');
 const definitions=[
  {...models.getModel('opencode-go','deepseek-v4.1-flash'),baseUrl:'https://opencode.ai/inference/go/openai/v1',cost:{input:.30,output:1.20,cacheRead:.006,cacheWrite:0}},
  ...['mimo-v2.6-flash','muse-spark-1.3-contributor'].map(id=>({...models.getModel('opencode-go',id),baseUrl:'https://opencode.ai/inference/go/openai/v1'})),
  {...models.getModel('opencode','minimax-m3'),provider:'opencode-go',id:'minimax-m3.1-flash-free',name:'MiniMax M3.1 Flash Free',baseUrl:'https://opencode.ai/inference/go/openai/v1',contextWindow:1000000,maxTokens:512000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsStore:false,supportsDeveloperRole:false,supportsStrictMode:false,maxTokensField:'max_tokens',requiresReasoningContentOnAssistantMessages:true}},
  {...models.getModel('opencode-go','step-5-preview-free'),id:'step-5-preview',name:'Step 5 Preview',baseUrl:'https://opencode.ai/inference/go/openai/v1',cost:{input:1,output:2.70,cacheRead:.10,cacheWrite:0},compat:{...models.getModel('opencode-go','step-5-preview-free').compat,requiresReasoningContentOnAssistantMessages:true}}
 ];
 const merge=list=>[...list.filter(m=>!definitions.some(x=>x.id===m.id)),...structuredClone(definitions)];
 models.setProvider({...go,getModels:()=>merge(go.getModels()),getAllModels:()=>merge(go.getAllModels())});
 return models;
}
