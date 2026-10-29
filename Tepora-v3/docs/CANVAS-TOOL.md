# キャンバスをツール呼び出しとして組み込む設計（Tepora V3）

ブランチ: `luni/canvas-tool-integration`（基点 `luni/canvas-placement-work` = 案C）
目的: キャンバスを「別画面のおまけ」ではなく、computer use と同じ層のエージェント能力にする。会話（キャラクター）も仕事（ワークエージェント）も同じ `canvas` ツールで描き、ユーザーは同じ作品を見て、直接操作した結果が次のターンの文脈に戻る。モード・プリセット・選択肢はなく、媒体（絵・回路・スライド・図・3D・混在）はモデルが選ぶ。

## 1. computer use の現状の配線（調査結果）

| 層 | computer use | 場所 |
|---|---|---|
| 能力オブジェクト | `ComputerUse`（設定 `computer-config`、`available()`、`info()`、セッションごとのブラウザページ） | core/computer/index.mjs |
| 生成と注入 | `startServer` が `new ComputerUse(store,…)` を作り `AgentRuntime` に渡す | core/server.mjs |
| ツール登録 | `computerTool(cu)` → `{name:'computer',group:'core',available,description,parameters(action enum),summarize,ephemeral,ephemeralKey,run}` を `this.tools.register()` | core/agent/runtime.mjs（コンストラクタ） |
| ツールセット | `TOOLSETS.worker/lean` に `computer`。`main`（会話）には無く、会話は `sessions_spawn` で委任 | core/tools/registry.mjs |
| 除外 | `excludedTools()` が未登録/利用不可の `computer`/`media` を外す。ツールセットはセッション存続中固定（キャッシュ接頭辞を守る） | runtime.mjs / loop.mjs `prompt()` |
| プロンプト | 環境欄に `computer.info()`、ワーカー向けに使い方の段落（`has('computer')`） | core/agent/prompts.mjs |
| 実行 | Rust `ExecutionCore` が段階を決め、JS ホストが `prepareTool → beforeTool(hook) → authorizeTool(Policy) → executeTool(def.run(args,toolContext)) → afterTool → recordTools` を実行 | core/agent/loop.mjs |
| 承認・方針 | `Policy.check(session,name,args)`: ユーザー規則（tool名/正規表現）で allow/ask/deny。ask は `approval` 文書と `approval.updated` イベント | core/agent/policy.mjs |
| 結果 | `{text, images?, data?}`。`record()` が transcript の `tool` 行に保存、`ephemeralKey` で古い観測を畳む | loop.mjs `record()` |
| UI への流れ | `store.emit()` → `/api/events` SSE（`session.entry` 等の内部イベントは除外）→ app.mjs の `bridge.on` | server.mjs / web/app.mjs |
| 中断 | `ctx.signal`（停止・終了で abort）、`interrupted` 付きで記録 | loop.mjs |
| 永続化 | 設定は `store.value()`、成果物は `store.artifact()`（Rust ドメイン、改訂履歴あり） | core/store.mjs |
| Rust 側 | ツールの登録・実行は JS。native-core は段階制御とプロトコル復号のみ。native-service の Rust エージェントホスト（移行中）は computer も持たない | native-core / native-service |

## 2. canvas と computer use の層ごとの対応

| 層 | canvas の実装 | 統合点 |
|---|---|---|
| 能力オブジェクト | `CanvasBoard`（共有キャンバス・セッションストア）。設定 `canvas-config {enabled}`、`available()`、`info()`、`snapshot()` | 新規 core/canvas-board.mjs |
| サーバー側の DOM | ブラウザ外でも op を適用できるよう、依存なしの小さな HTML 断片パーサー（`canvasApplyOps` の Parser として注入） | 新規 core/canvas-dom.mjs、既存 web/canvas-engine.mjs を共用 |
| 生成と注入 | `startServer` が `new CanvasBoard(store)` を作り `AgentRuntime({canvas})` へ | server.mjs |
| ツール登録 | `canvasTool(board)`: `name:'canvas'`、action = `read / create / patch / revert`（名前に `.` は使えないため computer と同じ action enum 方式） | runtime.mjs コンストラクタ |
| ツールセット | `main`・`worker`・`lean` すべてに `canvas`。会話もワーカーも直接描ける | registry.mjs `TOOLSETS`、`excludedTools()` |
| ルーティング | 会話: ホームの入力 → main セッション → `canvas` 呼び出し。仕事: `sessions_spawn` されたワーカー → `canvas`。どちらも同じ Policy/hook/記録の経路 | 変更不要（既存のループ） |
| UI へのイベント | 確定: `canvas.updated`（版番号・見出し・誰が）を `store.emit`（イベントログに残る、HTML は含めない）。途中経過: `canvas.stream`（start / html / op / end / abort）を `store.broadcast`（保存しない） | board → SSE → app.mjs → `canvasView` |
| 共有ストア | 単一のボード `main`: 版ログ（追記のみ、`by: agent/user`、セッションID）、選択、未通知のユーザー操作。`store.put('canvas',…)` で永続化 | canvas-board.mjs |
| 方針・能力 | `available()`（`canvas-config.enabled`）で提示/非提示。Policy は名前 `canvas` で自動適用（例: `{tool:'canvas',action:'ask',match:'"create"'}`） | 既存 Policy、`/api/canvas/config` |
| プロンプト | 環境欄に「Canvas: 共有キャンバス vN」、どちらのセッションにも短い使い方（いつ使うか・create と patch の使い分け・data-id 規約） | prompts.mjs |
| ユーザー操作の還流 | 画面のクリック選択・削除・巻き戻しを `/api/canvas/select`・`/api/canvas/edit` で記録。少し待ってまとめて、最後に描いたセッションと main に `mode:'notify'`（文脈のみ、起こさない）で届ける。`canvas read` でも最新の選択と操作を返す | board → `AgentRuntime.send(...notify)` |
| 中断・舵取り | 実行中の create/patch は `ctx.signal` で中断でき、中断時は確定しない（`abort` を流し、画面は直前の版へ）。ステア入力は次のステップで届く。ユーザーが途中で編集しても op は data-id 指定なので基本は合流、厳密にしたい時は `expected_version` で 409 | tool run / board |
| 永続化 | ボード文書（最新 30 版の HTML・見出し・作者）を `canvas` 種別で保存。再起動後も同じ作品と版ログ。書き出し（export）対象への追加は保留 | store |

## 3. ツール仕様（モデル向け）

```
canvas(action, ...)
- read                       → 描画ガイド（全文）、現在の版 n、見出し、HTML、版一覧、ユーザーの選択と直近の直接操作
- create  {html, summary}    → 新しい作品（初回、全く別の案、別媒体での作り直し）
- patch   {ops, summary}
          ops: set{id,attrs?,style?,text?} / add{parent,html,before?} / remove{id} / replace{id,html}
- revert  {version}          → その版の写しを新しい版として追加（何も消さない）
```
結果は短い文（`v3 を作りました（4件中4件適用）` など）と `data:{version,caption}`。`read` の結果は ephemeral（古い read は畳まれる）。

**コンパクト化**: 毎ターン送るのはツール説明（約 270 字）とスキーマ、会話向けの一行（`Draw visuals yourself with canvas, not via agents.`）だけ。媒体ごとの描き方（絵・回路・スライド・UI・グラフ）、op の書式、レイアウトの約束は `CANVAS_GUIDE` として `read` の先頭で返す（説明文に「描く前に read」と書く）。read は ephemeral なのでガイドが文脈に溜まらない。会話リクエストの増分は1,490 字 / 推定約 470 トークン → **673 字 / 推定約 213 トークン**（tepora-demo/measure-prompt.mjs、推定は Tepora の 3.16 字/トークン）。実モデル（OpenCode Go の deepseek-v4.1-flash）の prompt_tokens では **395 → 170 トークン**（description の拒否文追加前に計測）。

**read 前の描画は一度だけ拒否**: 実モデルは「read first」を飛ばして create し、data-id の無い・枠に収まらない絵を描いた（選択できない）。そこでセッションごとに read 済みかを覚え、未読の create/patch は描かずに「Not drawn yet: read the canvas first」とガイド＋現状を返す（同じ呼び出しをやり直せば通る）。revert は対象外。ストリームは run 開始時に始まるので、拒否時にライブ表示は出ない。

**選択と編集済み**: エージェントの patch が選択中の要素（その中身、その中への add、それを包む replace を含む）を変えたら、選択を外し、ボードの `edited:{id,version}` を立てる（UI は「編集済み」バッジと要素の一瞬のハイライト）。patch の結果に一文で伝え、さらに次の文脈ノートに `their selection "flame" was edited by 会話 in v3, so it is no longer selected` を載せる（このイベント単独では誰も起こさず、次のノートに相乗りする）。別の要素の編集では選択は残る。

## 4. 「生で描く」ことについて
プロバイダーのツール引数は現状 Rust 復号器がまとめて返すため、トークン単位では流れない。最小スライスでは、ツールの実行時に作品を要素単位（create）/ op 単位（patch）で `canvas.stream` として順に流し、画面上で育っていく様子を見せる（合計 1〜2 秒程度、中断可能）。本当の引数ストリーミングは native-core の復号器に tool 引数の差分イベントを足す必要があり、後回し。

## 5. 最小の縦切り（このブランチで実装する範囲）
1. core/canvas-dom.mjs、core/canvas-board.mjs（版ログ・選択・ユーザー操作・永続化・ストリーム）、`canvasTool`
2. runtime への登録、TOOLSETS への追加、excludedTools、プロンプト
3. server: `GET /api/canvas`、`POST /api/canvas/select`、`POST /api/canvas/edit`（remove / revert）、`PUT /api/canvas/config`、スナップショットに `canvas`
4. web: カードが共有ボードを購読（`canvas.updated` / `canvas.stream`）、フレーム内クリックで選択、選択の削除・巻き戻し。カードの入力欄は会話（main）へ送る
5. テスト: ボード（版ログ・op 適用・永続化・通知）、ツール経由（会話・ワーカーの両経路、Policy deny）、UI 縮約

## 6. 一本化
旧 `/api/canvas/turn`（ツールなしでテキストプロトコルをストリームする専用経路）と、それを支えた `core/canvas.mjs`・クライアント側の版ログ/ターン状態機械・`docs/CANVAS.md` は廃止した。描画はすべて `canvas` ツール経由。ツール非対応モデルではキャンバスは使えない（他のツールと同じ扱い）。

## 7. 後回し
- 本当のツール引数ストリーミング（Rust 復号器）
- `screenshot`（computer の `render` を使えば可能。視覚モデルで自己確認する時）
- 複数ボード（作品ごと・仕事ごと）と、仕事一覧での作品の切り替え
- native-service（Rust ホスト）への canvas 移植（computer も未移植）
- export/import への `canvas` 種別の追加、テキストの直接編集、ドラッグ移動などの豊かな直接操作
