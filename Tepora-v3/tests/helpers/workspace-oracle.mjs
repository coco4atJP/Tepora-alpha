// Frozen workspace-domain source oracle from da6a483. Test-only: persistence is
// still Rust; these original methods independently check the domain migration.
import {Store} from '../../core/store.mjs';
import {randomUUID} from 'node:crypto';
import {text,invariant} from '../../core/policy.mjs';
const EXPORT_KINDS = ['memory','artifact','revision','skill','job','message','checkpoint','effect','asset','note','evidence','routine','plan'];
export class WorkspaceOracle extends Store {
  memory(content,{source='user',confirmed=true,scope='private',title=''}={}) {
    const doc={id:randomUUID(),content:text(content,'memory',32000),title:title.slice(0,160),
      source,confirmed,scope:scope==='shared'?'shared':'private',createdAt:new Date().toISOString()};
    this.put('memory',doc);this.emit('memory.updated',doc);return doc;
  }
  artifact(title,content,{id=randomUUID(),kind='html',jobId=null,expectedVersion}={}) {
    text(content,'artifact',200000);text(title,'title',160);
    invariant(['html','markdown','text'].includes(kind),'Unsupported artifact type');
    const doc=this.db.call('artifact.put',{doc:{id,title,content,kind,jobId,updatedAt:new Date().toISOString()},expectedVersion});
    this.emit('artifact.updated',doc);return doc;
  }
  snapshot() {
    return {seq:this.seq,artifacts:this.list('artifact'),display:this.value('display'),skills:this.list('skill'),mcp:this.list('mcp'),
      memories:this.list('memory'),settings:this.settings};
  }
  export() {
    const collections=Object.fromEntries(EXPORT_KINDS.map(k=>[k,this.list(k).filter(d=>k!=='skill'||d.source!=='shared')]));
    const sharedReferences=this.list('skill').filter(d=>d.source==='shared').map(d=>({name:d.name,sourcePath:d.sourcePath,sha256:d.sha256}));
    return {format:'tepora-v3-context',version:2,exportedAt:new Date().toISOString(),collections,sharedReferences,
      display:this.value('display'),
      dialogueArchive:{version:1,session:this.value('dialogue-session'),personas:this.value('dialogue-personas'),messages:this.list('dialogue-message').reverse(),questions:this.list('worker-question'),archives:this.list('dialogue-archive')},
      // Compatibility for readers of beta.1; collections is the authoritative v2 payload.
      memories:collections.memory,artifacts:collections.artifact,skills:collections.skill};
  }
  import(bundle) {
    invariant(bundle?.format==='tepora-v3-context' && [1,2].includes(bundle.version),'Invalid context format');
    const collections=bundle.version===2 ? bundle.collections : {
      memory:bundle.memories||[]};
    invariant(collections && typeof collections==='object' && !Array.isArray(collections),'Invalid collections');
    const ids=new Map(),prepared=[];
    // Dialogue backups are readable archives only. Never restore active identities, jobs,
    // question routing, provider grants or result-sharing permissions from imported content.
    const dialogueArchives=[];
    if(bundle.dialogueArchive){
      const archive=bundle.dialogueArchive;
      invariant(archive&&archive.version===1&&Array.isArray(archive.messages)&&Array.isArray(archive.archives||[])&&(archive.archives||[]).length<=1000,'Invalid dialogue archive');
      for(const source of [archive,...(archive.archives||[])]){
        invariant(source&&Array.isArray(source.messages)&&source.messages.length<=100000,'Invalid dialogue archive');
        const messages=source.messages.map(m=>{
          invariant(m&&['user','assistant','tool','system'].includes(m.role),'Invalid archived dialogue role');
          text(m.content,'archived dialogue content',100000);
          return {role:m.role,content:m.content,kind:String(m.kind||'archive').slice(0,80),at:String(m.at||'').slice(0,100),sourceJobId:typeof (m.jobId||m.sourceJobId)==='string'?(m.jobId||m.sourceJobId).slice(0,300):null,sourceQuestionId:typeof (m.questionId||m.sourceQuestionId)==='string'?(m.questionId||m.sourceQuestionId).slice(0,300):null,readOnly:true};
        });
        const personas={};for(const role of ['character','worker'])if(source.personas?.[role]){const p=source.personas[role];personas[role]={name:text(p.name,'archived persona name',80),instructions:typeof p.instructions==='string'&&p.instructions.length<=8000?p.instructions:''};}
        const sourceSessionId=source.session?.id||source.sourceSessionId;
        dialogueArchives.push({id:randomUUID(),sourceSessionId:typeof sourceSessionId==='string'?sourceSessionId.slice(0,300):null,personas,messages,importedAt:new Date().toISOString(),readOnly:true,note:'Imported dialogue archive. No live session, question, execution or sharing permission was restored.'});
      }
    }
    for(const kind of EXPORT_KINDS) {
      const docs=collections[kind]||[];
      invariant(Array.isArray(docs)&&docs.length<=100000,'Too many documents');
      for(const raw of docs) {
        invariant(raw&&typeof raw==='object'&&!Array.isArray(raw),'Invalid document');
        const d=structuredClone(raw),old=d.id||randomUUID();
        invariant(typeof old==='string'&&!ids.has(`${kind}:${old}`),'Duplicate id in import');
        d.id=randomUUID();ids.set(`${kind}:${old}`,d.id);
        if(['memory','artifact','revision','skill','message'].includes(kind))
          text(d.content,'content',kind==='memory'?32000:200000);
        if(['artifact','revision'].includes(kind)) {
          invariant(['text','markdown','html'].includes(d.kind),'Invalid artifact kind');
          text(d.title,'title',160);
          invariant(Number.isSafeInteger(d.version)&&d.version>0,'Invalid artifact version');
        }
        if(kind==='memory') Object.assign(d,{confirmed:false,scope:'private',source:'import'});
        if(kind==='skill') Object.assign(d,{enabled:false,source:'import'});
        if(kind==='routine'){
          invariant(d.lastJobId==null||typeof d.lastJobId==='string','Invalid routine last job reference');
          Object.assign(d,{enabled:false,status:'proposed',runtime:null,destination:null,nextAt:null});
        }
        if(kind==='plan')Object.assign(d,{status:'proposed',jobs:{},runtime:null,destination:null});
        if(kind==='job') Object.assign(d,{status:'interrupted',approval:null,resumeBlocked:true,characterSessionId:null,dialogueSequence:0,pendingQuestionId:null,
          note:'移行した仕事です。外部操作の状態を確認するまで自動再開しません。'});
        prepared.push({kind,d,old});
      }
    }
    for(const {kind,d,old} of prepared) {
      if(d.jobId) d.jobId=ids.get(`job:${d.jobId}`)||null;
      if(d.artifactId) d.artifactId=ids.get(`artifact:${d.artifactId}`)||null;
      if(kind==='routine')d.lastJobId=typeof d.lastJobId==='string'?ids.get(`job:${d.lastJobId}`)||null:null;
      if(kind==='revision') d.id=`${d.artifactId}:${d.version}`;
      if(kind==='checkpoint') {d.id=ids.get(`job:${old}`)||d.id; d.imported=true;}
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const {kind,d} of prepared) this.put(kind,d);
      for(const archive of dialogueArchives)this.put('dialogue-archive',archive);
      this.db.exec('COMMIT');
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
    this.emit('snapshot',this.snapshot());
    return {imported:prepared.length,dialogueArchiveId:dialogueArchives[0]?.id||null,dialogueArchiveIds:dialogueArchives.map(a=>a.id),counts:Object.fromEntries(EXPORT_KINDS.map(k=>[k,prepared.filter(x=>x.kind===k).length])),
      note:'記憶は未確認・非共有、スキルは無効、仕事は中断状態で復元しました。接続先・認証・共通資産は変更しません。'};
  }
}
