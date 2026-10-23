/** One recorded utterance and one exact recipient. Cloud audio is never sent
 * by opening settings, starting capture, retrying, or falling back from local.
 */
export class TranscriptionRequest {
 constructor(request){this.request=request;this.pending=null;}
 get reviewing(){return this.pending?.phase==='review';}
 cancel(){const task=this.pending;this.pending=null;if(task){task.controller.abort();task.reject(Object.assign(Error('音声認識を取り消しました。'),{name:'AbortError'}));}}
 run(audio,profile,{owns,onReview}){
  this.cancel();
  return new Promise((resolve,reject)=>{
   const task={audio,profile,owns,resolve,reject,controller:new AbortController(),phase:profile.domain==='device'?'ready':'review'};this.pending=task;
   if(task.phase==='review')onReview(profile,audio.size);else this.dispatch(task);
  });
 }
 confirm(){const task=this.pending;if(!task||task.phase!=='review')return false;if(!task.owns())throw Error('下書きか会話が変わりました。録音を取り消して確認し直してください。');this.dispatch(task);return true;}
 async dispatch(task){
  task.phase='sending';
  try{
   if(!task.owns())throw Object.assign(Error('録音の宛先が変わりました。'),{name:'AbortError'});
   const value=await this.request(task.audio,{'X-Tepora-Audio-Profile':task.profile.identity,...(task.profile.domain==='device'?{}:{'X-Tepora-Audio-Consent':'true'})},task.controller.signal);
   if(this.pending!==task||task.controller.signal.aborted||!task.owns())throw Object.assign(Error('古い音声応答を破棄しました。'),{name:'AbortError'});
   task.resolve(value);
  }catch(error){task.reject(error);}finally{if(this.pending===task)this.pending=null;}
 }
}
