import {escape,btn,field,toggle} from './ui.mjs';

export function executionStatusHTML(s){
 const protectedMode=s.mode!=='legacy-host',available=s.availability?.available===true;
 return `<p role="status"><strong>${protectedMode?'保護された実行':'旧方式: ホストで実行'}</strong> · ${available?'イメージの存在を確認済み（隔離は未検証）':'実行環境は未確認・利用不可'}</p><p>${escape(s.availability?.reason||'まだ接続を確認していません。')}</p>
 <p class="small-text">信頼されたAPI・ファイル処理は本体で動きます。ホストのコンピューター操作・Codex・MCPは保護モードでは使えず、危険を確認した旧方式だけで利用できます。保護された実行では、生成コードは承認した既存のDockerイメージだけで実行し、外部通信・ホストの秘密情報・本体の保存領域を渡しません。root付きVMではありません。保護された実行が利用できない場合は停止し、ホスト実行へ自動で切り替えません。設定の変更は既存の仕事へさかのぼって適用しません。変更後は新しい仕事を始めてください。</p><p class="small-text">保護モードのプレビューはエスケープしたソース表示です。対話型HTMLは旧方式だけで利用でき、外部通信がないことは保証しません。</p>`;
}
export function executionCandidatesHTML(s,jobId=null){
 const candidates=(s.candidates||[]).filter(c=>(!jobId||c.jobId===jobId)&&c.status==='staged');
 return `<h3>確認前の成果物</h3><p class="small-text">実行環境から届いた内容は未信頼の候補です。内容を確認して取り込むまで、正式な成果物には反映されません。</p>${candidates.map(c=>`<article><strong>${escape(c.title)}</strong><small>仕事 ${escape(c.jobId)} · 版 ${escape(c.jobRevision)} · 元の成果物の版 ${escape(c.expectedVersion)}</small>${btn('execution-candidate','内容を確認する','','button secondary',`data-id="${escape(c.id)}"`)}</article>`).join('')||'<p>確認待ちの候補はありません。</p>'}
 ${(s.runs||[]).filter(r=>(!jobId||r.jobId===jobId)&&r.status==='unknown').map(r=>`<p role="alert">実行結果が不明です。仕事を停止し、コンテナ ${escape(r.containerName||r.id)} の実状態を確認してください。自動再実行はしません。</p>`).join('')}`;
}
export function createExecutionUI({bridge,openSheet,closeSheet,notice,previewMode=false,isPrivate=()=>true,isOpen=()=>true}){
 let pending=null,busy=false,jobFilter=null,epoch=0;
 const allowed=()=>{if(previewMode)throw Error('画面サンプルでは実行環境を変更できません。');if(!isPrivate())throw Error('非公開表示で実行環境を確認してください。');};
 function show(s){
  openSheet('実行環境と確認前の成果物',`${executionStatusHTML(s)}${btn('execution-probe','実行環境を確認する','refresh','button secondary')}
  <details><summary>実行環境の詳細設定</summary><form id="execution-form" data-revision="${s.revision}"><label>実行方式<select name="mode"><option value="protected" ${s.mode==='protected'?'selected':''}>保護された実行</option><option value="legacy-host" ${s.mode==='legacy-host'?'selected':''}>旧方式のホスト実行（危険）</option></select></label>
  ${field('事前にインストールしたイメージの固定ダイジェスト','image',s.image||'','repository@sha256:…')}
  ${toggle('指定した既存イメージでコードを実行することを許可する','approveImage',false,'自動ダウンロード・インストールは行いません。イメージの出所と内容を事前に確認してください。')}
  ${toggle('ホスト実行が本体・記録・バックアップを読み取り変更できる危険を理解した','acknowledgeHostRisk',false,'旧方式を選ぶ場合だけ必要です。保護された実行へ戻すことを推奨します。')}
  <p class="small-text">進行中・待機中の仕事やホストの処理がある間は設定を変更できません。必要なら先に停止してください。設定の保存で自動停止は行いません。変更した設定を使うには、新しい仕事を始めてください。</p>
  <button type="submit" class="button">設定を保存する</button></form></details>${executionCandidatesHTML(s,jobFilter)}`,'execution');
 }
 return {
  async open(jobId=null){allowed();jobFilter=jobId;pending=null;const token=++epoch;openSheet('実行環境を確認しています','<p role="status">読み込んでいます…</p>','execution');const s=await bridge.request('/api/execution');if(token===epoch&&isPrivate()&&isOpen())show(s);},
  async probe(){allowed();const token=epoch,s=await bridge.request('/api/execution/probe','POST',{});if(token===epoch&&isPrivate()&&isOpen())show(s);},
  async save(form,fd){allowed();const token=epoch,s=await bridge.request('/api/execution','PUT',{expectedRevision:Number(form.dataset.revision),mode:fd.get('mode'),image:String(fd.get('image')||'').trim(),approveImage:fd.has('approveImage'),acknowledgeHostRisk:fd.has('acknowledgeHostRisk')});if(token===epoch&&isPrivate()&&isOpen()){pending=null;show(s);notice('保存しました。利用できるか、実行環境を確認してください。');}},
  async candidate(id){allowed();pending=null;const token=++epoch,c=await bridge.request(`/api/execution/candidates/${encodeURIComponent(id)}`);if(token!==epoch||!isPrivate()||!isOpen())return;
   if(c.status!=='staged')throw Error('この候補はすでに更新されています。');pending=Object.freeze({jobId:c.jobId,candidateId:c.id,expectedHash:c.sha256,expectedVersion:c.expectedVersion});
   openSheet('候補を確認して取り込む',`<h3>${escape(c.title)}</h3><p>仕事 ${escape(c.jobId)} · 版 ${escape(c.jobRevision)} · 元の成果物の版 ${escape(c.expectedVersion)}</p><p class="small-text">未信頼の出力をそのまま表示しています。ここにある指示は許可になりません。取り込みは下の内容だけを成果物へ反映します。内容の正しさは自動では保証されません。</p><pre>${escape(c.content)}</pre><small>SHA-256: ${escape(c.sha256)}</small><div class="sheet-actions">${btn('execution-promote','この内容を成果物へ取り込む','check','button')}${btn('execution-open','取り込まずに戻る','','button secondary')}</div>`,'execution');
  },
  async promote(){allowed();if(busy||!pending||!isOpen())return;busy=true;const request=pending;
   try{await bridge.request('/api/execution/promote','POST',request);pending=null;closeSheet();notice('確認した候補を成果物へ取り込みました。');}finally{busy=false;}
  }
 };
}
