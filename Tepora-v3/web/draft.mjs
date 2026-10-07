/** UTF-16 range edits, matching browser selectionStart/selectionEnd.
 * This is a draft editor, not an executor. Recognized speech never dispatches a tool.
 */
export class VoiceDraft {
  constructor(content='') {this.content=content;this.revision=0;this.history=[];this.seen=new Set();}
  snapshot() {return {content:this.content,revision:this.revision};}
  manual(content) {
    if(typeof content!=='string'||content.length>32000) throw new Error('Invalid draft');
    this.history.push(this.snapshot());this.history=this.history.slice(-20);
    this.content=content;this.revision++;return this.snapshot();
  }
  apply({baseRevision,utteranceId,edits}) {
    if(this.seen.has(utteranceId)) return {duplicate:true,...this.snapshot()};
    if(baseRevision!==this.revision) throw new Error('Draft changed; voice edit was not applied.');
    if(typeof utteranceId!=='string'||!utteranceId||!Array.isArray(edits)||edits.length>32) throw new Error('Invalid voice edit');
    const sorted=[...edits].sort((a,b)=>a.start-b.start);
    let end=-1;
    for(const edit of sorted) {
      if(!Number.isInteger(edit.start)||!Number.isInteger(edit.end)||edit.start<0||
        edit.start<end||edit.end<edit.start||edit.end>this.content.length||typeof edit.text!=='string')
        throw new Error('Invalid or overlapping draft edit');
      end=edit.end;
    }
    let content=this.content;
    for(const edit of sorted.reverse()) content=content.slice(0,edit.start)+edit.text+content.slice(edit.end);
    if(content.length>32000) throw new Error('Draft exceeds size limit');
    this.manual(content);
    this.seen.add(utteranceId);
    if(this.seen.size>1024) this.seen.delete(this.seen.values().next().value);
    return this.snapshot();
  }
  undo() {
    if(!this.history.length) throw new Error('Nothing to undo');
    this.content=this.history.pop().content;this.revision++;return this.snapshot();
  }
}
