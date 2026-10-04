/** "あなたの番": everything that waits for the person, in one stack. Approvals stay exact —
 * the plain summary sits on top of the unmodified request, which is one click away.
 */
import {describeApproval} from './approval-format.mjs';
import {questionIsCurrent} from './dialogue-state.mjs';
import {escape} from './ui.mjs';

export function ago(iso,now=Date.now()){
 const t=Date.parse(iso);if(Number.isNaN(t))return '';const s=Math.max(0,(now-t)/1000);
 if(s<60)return 'たった今';if(s<3600)return `${Math.floor(s/60)}分前`;if(s<86400)return `${Math.floor(s/3600)}時間前`;
 const d=new Date(t);return d.toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
/** Everything waiting for the person, most blocking first. Proposals wait for a yes before they run. */
export function inboxItems({approvals=[],jobs=[],dialogue=null,routines=[],plans=[]}={}){
 const items=[],work=jobs.filter(j=>!(j.kind==='chat'&&j.characterSessionId)&&j.kind!=='demo'),byId=new Map(jobs.map(j=>[j.id,j]));
 for(const a of approvals)if(a.status==='pending')items.push({kind:'approval',id:a.id,at:a.createdAt,approval:a,job:byId.get(a.jobId)||null});
 for(const m of dialogue?.messages||[])if(m.kind==='worker-question'&&questionIsCurrent(m,jobs))items.push({kind:'question',id:m.id,at:m.at,message:m,job:byId.get(m.jobId)||null});
 for(const j of work)if(j.status==='review')items.push({kind:'review',id:j.id,at:j.endedAt||j.createdAt,job:j});
 for(const j of work)if(['failed','interrupted','blocked'].includes(j.status))items.push({kind:'trouble',id:j.id,at:j.endedAt||j.createdAt,job:j});
 for(const p of plans)if(p.status==='proposed')items.push({kind:'proposal',id:p.id,at:p.createdAt,proposal:p,type:'plan'});
 for(const r of routines)if(r.status==='proposed')items.push({kind:'proposal',id:r.id,at:r.createdAt,proposal:r,type:'routine'});
 const order={approval:0,question:1,review:2,trouble:3,proposal:4};
 return items.sort((a,b)=>order[a.kind]-order[b.kind]||String(a.at||'').localeCompare(String(b.at||'')));
}
export const attentionCount=state=>inboxItems(state).length;

const inboxButton=(action,label,cls='button small',extra='')=>`<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const inboxWhen=iso=>`<time datetime="${escape(iso||'')}">${escape(ago(iso))}</time>`;
function inboxApproval({approval:a,job}){
 const d=describeApproval(a);
 return `<article class="inbox-item tone-${d.tone}" data-kind="approval">
  <header><strong>${escape(d.title)}</strong>${inboxWhen(a.createdAt)}</header>
  ${d.detail?`<p class="inbox-detail"><code>${escape(d.detail)}</code></p>`:''}
  <p class="inbox-meta">${escape(job?.title||a.jobTitle||'仕事')}${d.impact?` — ${escape(d.impact)}`:''}</p>
  <div class="inbox-actions">${inboxButton('approve','許可する','button small',`data-id="${escape(a.id)}"`)}${inboxButton('deny','許可しない','button small secondary',`data-id="${escape(a.id)}"`)}</div>
  <details class="inbox-raw"><summary>依頼の中身をそのまま見る</summary><pre>${escape(a.name)}\n${escape(JSON.stringify(a.args,null,2))}</pre></details>
 </article>`;
}
function inboxQuestion({message:m,job}){
 return `<article class="inbox-item" data-kind="question">
  <header><strong>${escape(job?.title||'仕事')}</strong>${inboxWhen(m.at)}</header>
  <p class="inbox-quote">${escape(m.content)}</p>
  <div class="inbox-actions">${inboxButton('reply-worker-question','回答する','button small',`data-id="${escape(m.id)}"`)}</div>
 </article>`;
}
function inboxReview({job}){
 return `<article class="inbox-item" data-kind="review">
  <header><strong>${escape(job.title)}</strong>${inboxWhen(job.endedAt||job.createdAt)}</header>
  <div class="inbox-actions">${inboxButton('open-work','結果を見る','button small',`data-id="${escape(job.id)}"`)}${inboxButton('accept','確認した','text-button',`data-id="${escape(job.id)}"`)}</div>
 </article>`;
}
function inboxTrouble({job}){
 const reason=job.note||{failed:'失敗しました',interrupted:'中断しました',blocked:'条件を待っています'}[job.status];
 return `<article class="inbox-item tone-${job.status==='failed'?'danger':'attention'}" data-kind="trouble">
  <header><strong>${escape(job.title)}</strong>${inboxWhen(job.endedAt||job.createdAt)}</header>
  <p class="inbox-meta">${escape(reason)}</p>
  <div class="inbox-actions">${job.resumeBlocked?'':inboxButton('resume','再開','button small secondary',`data-id="${escape(job.id)}"`)}${inboxButton('task','詳細','text-button',`data-id="${escape(job.id)}"`)}</div>
 </article>`;
}
function inboxProposal({proposal:x,type}){
 return `<article class="inbox-item" data-kind="proposal">
  <header><strong>${escape(x.title)}</strong>${inboxWhen(x.createdAt)}</header>
  <p class="inbox-meta">${type==='plan'?'プランの提案':'くりかえしの提案'} — 有効にするまで実行しません</p>
  <div class="inbox-actions">${inboxButton('proposals','内容を見る','button small secondary')}</div>
 </article>`;
}
const INBOX_GROUPS=[['approval','承認',inboxApproval],['question','質問',inboxQuestion],['review','結果の確認',inboxReview],['trouble','止まっている仕事',inboxTrouble],['proposal','提案',inboxProposal]];
export function inboxHTML(items){
 if(!items.length)return '<p class="inbox-empty">いまは、ありません。</p>';
 const approvals=items.filter(i=>i.kind==='approval').length;
 return `<div class="inbox">${INBOX_GROUPS.map(([kind,label,render])=>{const list=items.filter(i=>i.kind===kind);if(!list.length)return '';
  return `<section class="inbox-group"><h3><span>${label}</span>${kind==='approval'&&approvals>1?`<span class="inbox-batch">${inboxButton('approve-all','まとめて確認…','text-button')}${inboxButton('deny-all','すべて許可しない','text-button')}</span>`:''}</h3>${list.map(render).join('')}</section>`;}).join('')}</div>`;
}
