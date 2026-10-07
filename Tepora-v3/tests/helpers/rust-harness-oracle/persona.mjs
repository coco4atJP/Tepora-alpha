// TEST-ONLY frozen JavaScript oracle from the current published19008a1 migration snapshot.
// Production imports are forbidden. Only imports/environment shims were adjusted.
/** The persona is the response side of the character: its name, its free instructions and its voice.
 * It is independent of the avatar (what the character looks like on the stage).
 */
import {defaultVoice,validateVoice,voiceStyleForPrompt} from './voice-lines.mjs';

/** The first persona. The voice starts as the polite pack, which is the text the screen has always used. */
export function defaultPersonas(characterName='Tepora'){
 return {revision:0,
  character:{name:String(characterName||'Tepora').slice(0,80),instructions:'落ち着いた親しみやすい会話。仕事はワーカーへ渡し、会話を続けられるようにする。',voice:defaultVoice()},
  worker:{name:'Tepora Worker',instructions:'依頼の範囲内で検証可能な成果を作る。確認が必要なときは質問し、結果を根拠とともに報告する。'}};
}
/** Older stored personas have no voice; they get the default without being rewritten. */
export function normalizePersonas(personas){
 if(!personas)return personas;
 return {...personas,character:{...personas.character,voice:personas.character?.voice||defaultVoice()}};
}
/** Check a patch to the character persona's voice against what it was. */
export function nextVoice(value,previous){
 return value===undefined?(previous||defaultVoice()):validateVoice(value,previous||defaultVoice());
}
/** What the model sees of a persona: name, instructions and a short style. Lines written for the screen never go to the model. */
export function personaForPrompt(persona){
 if(!persona)return persona;
 const {name,instructions,voice}=persona,out={name,instructions};
 if(voice)out.style=voiceStyleForPrompt(voice);
 return out;
}
