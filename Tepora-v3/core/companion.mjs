import {invariant} from './policy.mjs';
/** Navigation is durable; choosing a focus never executes or resumes a job. */
export class Companion {
 constructor(store){this.store=store;}
 snapshot(){return this.store.value('companion')||{revision:0,focusJobId:null,returnStack:[]};}
 check(revision){const s=this.snapshot();invariant(Number.isInteger(revision)&&revision===s.revision,'対象が変わりました。送信先を確認してください。',409);return s;}
 save(s){const next={...s,revision:s.revision+1};this.store.value('companion',next);this.store.emit('companion.updated',next);return next;}
 focus(jobId,{expectedRevision,pushReturn=false}={}){const s=this.check(expectedRevision);invariant(jobId===null||this.store.get('job',jobId),'仕事が見つかりません。',404);const stack=s.returnStack.filter(id=>id!==jobId);if(pushReturn&&s.focusJobId&&s.focusJobId!==jobId)stack.push(s.focusJobId);return this.save({...s,focusJobId:jobId,returnStack:[...new Set(stack)].slice(-20)});}
 back(expectedRevision){const s=this.check(expectedRevision),stack=s.returnStack.filter(id=>this.store.get('job',id));return this.save({...s,focusJobId:stack.pop()||null,returnStack:stack});}
}
