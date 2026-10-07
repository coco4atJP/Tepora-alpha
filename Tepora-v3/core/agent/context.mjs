/** Rust owns canonical context rendering, clearing, sequence repair and token costs.
 * This facade only retrieves the transcript through the unchanged session API. */
import {nativeCompute} from '../native-state.mjs';
export const SMALL_RESULT_TOKENS=300;
export const LONG_ARG_CHARS=400;
export const stubText=entry=>nativeCompute('context.stubText',{entry});
export const reportStub=entry=>nativeCompute('context.reportStub',{entry});
export const shrinkValue=(value,ref)=>typeof value!=='string'&&(value===null||typeof value!=='object')?value:nativeCompute('context.shrinkValue',{value,ref});
export const shrinkArgs=(json,ref)=>typeof json!=='string'?json:nativeCompute('context.shrinkArgs',{json,ref});
export const repairSequence=messages=>nativeCompute('context.repairSequence',{messages});
export class ContextAssembler{
 constructor(sessions){this.sessions=sessions;}
 view(id){
  const checkpoint=this.sessions.latest(id,'checkpoint');
  const from=checkpoint?checkpoint.upTo+1:1;
  return nativeCompute('context.view',{checkpoint,entries:this.sessions.entries(id,{from})});
 }
 isCleared(entry,view,latest){return nativeCompute('context.isCleared',{entry,view,latest:[...latest]});}
 renderEntries(view,{clearUpTo=view.clearUpTo,vision=true}={}){
  return nativeCompute('context.renderEntries',{view,clearUpTo,vision});
 }
 build(id,{system,clearUpTo,vision=true}={}){
  const built=nativeCompute('context.build',{view:this.view(id),system,clearUpTo,vision});
  // Undefined is absent from JSON, but remains an own property of the public JS API.
  if(system===undefined)built.messages[0].content=undefined;
  return built;
 }
}
