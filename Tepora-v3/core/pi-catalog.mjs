import {builtinModels} from '@earendil-works/pi-ai/providers/all';

/** Narrow metadata supplement for Pi 1.5.0's OpenCode snapshot.
 * Pi 1.5.0 renamed `minimax-m3.1-flash-free` → `minimax-m3.1-flash` (paid) and already
 * uses `/inference/go/openai/v1` for OpenAI-compatible Go models. Tepora only adds
 * reasoning-replay overrides for tool continuation on MiniMax and Step 5.
 * Keep Pi's authentication, API adapters, streaming and native replay unchanged.
 * These entries describe supported text/image inputs, not Pi video support.
 */
export function teporaPiModels(options){
 const models=builtinModels(options),go=models.getProvider('opencode-go');
 const base=id=>{const m=models.getModel('opencode-go',id);if(!m)throw new Error(`pi-ai catalog is missing opencode-go/${id}; update core/pi-catalog.mjs for this SDK version`);return m;};
 const withReplay=id=>({...base(id),compat:{...base(id).compat,requiresReasoningContentOnAssistantMessages:true}});
 const definitions=[withReplay('minimax-m3.1-flash'),withReplay('step-5-preview')];
 const merge=list=>[...list.filter(m=>!definitions.some(x=>x.id===m.id)),...structuredClone(definitions)];
 models.setProvider({...go,getModels:()=>merge(go.getModels()),getAllModels:()=>merge(go.getAllModels())});
 return models;
}
