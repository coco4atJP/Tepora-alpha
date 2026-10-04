/** One status vocabulary for the conversation, the work list, the inbox and the home stage.
 * "処理終了" deliberately differs from "確認済み": a worker finishing is not the person accepting it.
 */
export const STATUS_LABELS=Object.freeze({queued:'順番待ち',running:'作業中',waiting_approval:'承認待ち',paused:'一時停止',interrupted:'中断',blocked:'条件待ち',failed:'失敗',cancelled:'取り消し',review:'確認待ち',completed:'処理終了'});
const TONES={queued:'active',running:'active',waiting_approval:'attention',paused:'idle',interrupted:'attention',blocked:'attention',failed:'danger',cancelled:'idle',review:'attention',completed:'done'};

/** {label,tone} for a job. Tones: active, attention, danger, done, idle. */
export function jobStatus(job={}){
 const status=job.status||'';
 if(status==='paused'&&job.pendingQuestionId)return {label:'回答待ち',tone:'attention'};
 if(status==='completed'&&job.verification?.status==='accepted-by-user')return {label:'確認済み',tone:'done'};
 if(status==='running'&&job.pendingApprovals>0)return {label:'作業中',tone:'active',note:`承認待ち ${job.pendingApprovals}件`};
 return {label:STATUS_LABELS[status]||status||'不明',tone:TONES[status]||'idle'};
}
/** Statuses that ask something of the person. Order is the order shown in the inbox. */
export const ATTENTION_ORDER=['waiting_approval','question','review','failed','interrupted','blocked'];
export function needsPerson(job={}){
 if(job.status==='waiting_approval'||job.pendingApprovals>0)return 'waiting_approval';
 if(job.status==='paused'&&job.pendingQuestionId)return 'question';
 if(['review','failed','interrupted','blocked'].includes(job.status))return job.status;
 return null;
}
export const isActive=job=>['queued','running','waiting_approval'].includes(job?.status);
