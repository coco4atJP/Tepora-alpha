import {invariant,text} from './policy.mjs';
import {normalizePersonas,defaultPersonas,nextVoice} from './persona.mjs';
export function configurePersonas(store,raw){
 invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid personas');
 const current=normalizePersonas(store.value('dialogue-personas')||defaultPersonas(store.settings.companion));
 invariant(raw.expectedRevision===current.revision,'人格設定が変更されています。読み直してください。',409);
 const persona=(value,previous,voice)=>{if(value===undefined)return previous;invariant(value&&typeof value==='object'&&!Array.isArray(value),'Invalid persona');
  invariant(typeof value.instructions==='string'&&value.instructions.length<=8000,'Invalid persona instructions');
  const out={name:text(value.name,'persona name',80),instructions:value.instructions};if(voice)out.voice=nextVoice(value.voice,previous.voice);return out;};
 const next={revision:current.revision+1,character:persona(raw.character,current.character,true),worker:persona(raw.worker,current.worker,false)};
 store.value('dialogue-personas',next);return next;
}
