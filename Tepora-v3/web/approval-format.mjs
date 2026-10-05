/** Plain-language summaries of operations that wait for approval. The raw request is still shown
 * on demand; this only makes the decision readable. Shared by the service and the screen.
 */
const approvalShort=(value,max=160)=>{const s=String(value??'').replace(/\s+/g,' ').trim();return s.length>max?s.slice(0,max-1)+'…':s;};
const approvalBase=value=>String(value||'').split(/[\\/]/).pop();
const APPROVAL_MEDIA={image:'画像',image_edit:'画像の編集',video:'動画',tts:'読み上げ音声'};
const APPROVAL_DOMAINS={device:'このPC',lan:'LAN内の機器',cloud:'クラウド'};

/** How much deliberate effort saying yes should take. Operations that act on this PC or can cost
 * money are held for a moment; the rest take one tap. This only shapes the gesture: what is
 * replayed is still exactly the request that was shown. */
export const approvalFriction=tone=>tone==='host'||tone==='cost'?'hold':'tap';

// Where an operation reaches, in words. The slip says it instead of relying on colour.
const APPROVAL_SCOPE={host:'このPC',cost:'クラウド・費用',send:'外へ送る',screen:'画面操作',tool:'外部の道具'};

/** {title, detail, impact, tone, scope} where tone is host|cost|send|screen|tool. */
export function describeApproval(request){const d=approvalBody(request);return {...d,scope:APPROVAL_SCOPE[d.tone]||''};}
function approvalBody({name,args={}}={}){
 const a=args&&typeof args==='object'?args:{};
 switch(name){
  case 'run_command':return {title:'このPCでコマンドを実行',detail:approvalShort([approvalBase(a.executable),...(Array.isArray(a.args)?a.args:[])].join(' '),200),impact:'保護されていない旧方式で、このPC上で直接動きます。',tone:'host'};
  case 'mcp_call':return {title:`道具「${approvalShort(a.tool,60)}」を使う`,detail:`接続: ${approvalShort(a.server,60)}${a.arguments&&Object.keys(a.arguments).length?` · 入力: ${approvalShort(Object.keys(a.arguments).join('、'),80)}`:''}`,impact:'接続した道具が外部に影響する場合があります。',tone:'tool'};
  case 'mcp_tools':return {title:'接続した道具の一覧を取得',detail:`接続: ${approvalShort(a.server,60)}`,impact:'道具のサーバーを起動または接続します。',tone:'tool'};
  case 'computer_open':return {title:a.htmlArtifactId?'作った画面を専用ブラウザで開く':'専用ブラウザでページを開く',detail:approvalShort(a.url||a.htmlArtifactId||'',160),impact:'Teporaが用意した専用ブラウザだけを使います。',tone:'screen'};
  case 'computer_action':return {title:'画面を操作',detail:approvalShort([a.action||a.type,a.target||a.element||a.text].filter(Boolean).join(' · '),160),impact:'いま表示中の画面に対する操作です。',tone:'screen'};
  case 'computer_screenshot':return {title:'画面を撮影して読み取る',detail:'',impact:'表示中の内容がモデルに渡ります。',tone:'screen'};
  case 'generate_media':return {title:`${APPROVAL_MEDIA[a.kind]||'生成物'}をつくる`,detail:approvalShort(a.prompt,200),impact:`${approvalShort(a.recipient,40)}（${APPROVAL_DOMAINS[a.domain]||a.domain||''}）へ送ります。${a.domain==='cloud'?'費用がかかる場合があります。':''}`,tone:a.domain==='cloud'?'cost':'send'};
  case 'capability_disclosure':return {title:`${approvalShort(a.recipient,40)}へ内容を渡す`,detail:approvalShort(typeof a.payload==='string'?a.payload:JSON.stringify(a.payload||{}),200),impact:`送り先: ${APPROVAL_DOMAINS[a.domain]||a.domain||'外部'}`,tone:'send'};
  case 'delegate_to_codex':return {title:'Codexに仕事を渡す',detail:approvalShort(a.input,200),impact:'Codexで選んだ接続先へ依頼内容が送られます。',tone:'host'};
  case 'codex_operation':return {title:'Codexの操作を許可',detail:approvalShort(a.command||a.reason||JSON.stringify(a),200),impact:'このPC上でCodexが操作します。',tone:'host'};
  default:return {title:approvalShort(name||'操作',60),detail:approvalShort(JSON.stringify(a),200),impact:'',tone:'tool'};
 }
}
