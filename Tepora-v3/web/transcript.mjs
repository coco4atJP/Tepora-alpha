/** Keep unchanged messages (and their selection, focus and open details) in place.
 * Render callbacks return one trusted, escaped root element; keys describe its
 * presentation, not just its ID, so replayed snapshots can still update a row.
 */
const transcriptHosts=new WeakMap();
export function reconcileTranscript(host,rows){
 const previous=transcriptHosts.get(host)||new Map(),next=new Map();
 for(const row of rows){
  let entry=previous.get(row.id);
  if(!entry||entry.key!==row.key){
   const template=host.ownerDocument.createElement('template');template.innerHTML=row.html();
   const node=template.content.firstElementChild;
   if(!node)throw new Error('A transcript row needs a root element.');
   if(!entry&&previous.size&&row.arrive)node.classList.add('is-arriving');
   entry={key:row.key,node};
  }
  next.set(row.id,entry);
 }
 // Evict removed/changed nodes before ordering, avoiding moves of every later
 // message when a single worker question changes. Never retain hidden content.
 for(const [id,entry] of previous)if(next.get(id)!==entry)entry.node.remove();
 let cursor=host.firstChild;
 for(const {node} of next.values()){
  if(node!==cursor)host.insertBefore(node,cursor);
  cursor=node.nextSibling;
 }
 while(cursor){const old=cursor;cursor=cursor.nextSibling;old.remove();}
 transcriptHosts.set(host,next);
}

const transcriptTimeFormat=new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit'});
const transcriptDayFormat=new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'short'});
// Only timestamp labels are retained, bounded independently of history length.
const transcriptDates=new Map();
export function dialogueTimestamp(value){
 if(value&&transcriptDates.has(value))return transcriptDates.get(value);
 const at=new Date(value||Date.now()),time=at.getTime();
 const result=Number.isNaN(time)?{time:null,stamp:'',label:''}:{time,stamp:transcriptTimeFormat.format(at),label:transcriptDayFormat.format(at)};
 if(value){if(transcriptDates.size>=2048)transcriptDates.delete(transcriptDates.keys().next().value);transcriptDates.set(value,result);}
 return result;
}

/** One visible paint per frame, always using the latest state. A final committed
 * message can cancel the queued draft so it never appears again after completion.
 */
export function createFramePainter(paint,{request=fn=>requestAnimationFrame(fn),cancel=id=>cancelAnimationFrame(id)}={}){
 let frame=null;
 return {
  schedule(){if(frame===null)frame=request(()=>{frame=null;paint();});},
  cancel(){if(frame!==null){cancel(frame);frame=null;}}
 };
}
