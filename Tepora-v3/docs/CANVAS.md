# Tepora V3 × 会話キャンバス 統合設計

対象: `coco4atJP/Tepora-alpha` ブランチ `rust/v3-core-migration`（b409955）の `Tepora-v3/`
移植元: `/workspace/live-canvas`（Vite + React + TS の単体アプリ）
作業ブランチ: `luni/canvas-integration`（ローカルのみ・未push）

## 1. 置き場所
- **ナビの独立ビュー「キャンバス」**（ホーム／仕事の隣）。M1 ではここに置く。会話（キャラクター）や仕事（エージェント）の状態機械には混ぜない。
- サーバ: `core/canvas.mjs`（プロトコル・プロンプト・ストリーム解析）＋ `core/canvas-frame.mjs`（サンドボックス frame 文書）。`core/server.mjs` に 2 ルート追加。
- Web: `web/canvas-engine.mjs`（純粋ロジック）＋ `web/canvas.mjs`（ビュー）。V3 の方針どおり **React は持ち込まず素の ESM**、`core/frontend.mjs` のバンドルに追加（トップレベル名は `canvas*` で衝突回避）。

## 2. 既存レイヤの再利用
| live-canvas | Tepora V3 で使うもの |
|---|---|
| `llm.ts`（OpenAI/Anthropic/Gemini 直叩き、ブラウザに API キー） | **`registry.invoke('work', …)`**。プロバイダ選択・ルーティング・リトライ・ネットワーク方針・秘密情報管理は Tepora に一任。キーはブラウザに出ない。`work` 未設定なら main にフォールバック |
| `.env` のキー | Tepora の設定画面のプロバイダ登録（`/api/providers`） |
| 会話状態（React state） | M1: クライアントのメモリ内。サーバはステートレス（毎ターン artifact・履歴・版一覧を送る） |
| 音声（Realtime/STT/TTS） | 後続で `voice.mjs` / realtime-voice を再利用（M5） |
| セッション/認証 | 既存の Host/Origin/Cookie/CSRF チェックをそのまま通る |

## 3. 移植するもの／置き換えるもの
- **移植**: パッチエンジン（`patch.ts` の set/add/remove/replace、別名正規化、fuzzy id、style 解析、取りこぼし子要素の保持）、版ログ（追加・復元・巻き戻しは「新しい版を積む」）、システムプロンプト（2D: 絵・回路・UI・図表のみに縮約）、成長アニメ。
- **置き換え**:
  - ネイティブ tool calling → **テキストプロトコル**（`onDelta` はテキストのみ・全プロバイダでストリーム可能にするため）
    - create: `<reply>…</reply><summary>…</summary>` の後に生 HTML
    - patch: 同じタグの後に「1 行 1 JSON op」
  - `srcdoc` iframe → **`GET /canvas/frame`**（メインの CSP が `script-src 'self'` のため）。毎回新しい nonce、`sandbox allow-scripts`（opaque origin）、`connect-src 'none'`、`frame-ancestors` は自 origin。モデル由来の `<script>`・`on*` は実行されない。
  - React UI → 素の DOM ビュー（既存の `escape`/`icon`/`notice` を使用）。
- **M1 では見送り**: 3D（three.js）、スライド、クリック選択、ステアリング/下書き、AI カーソル、音声、永続化。

## 4. ツール／イベントの対応
`POST /api/canvas/turn` が NDJSON（1 行 1 イベント）で返す。

| live-canvas | V3 イベント | クライアント処理（`canvasReduce`） |
|---|---|---|
| ターン開始 | `turn{mode}` | create/patch の別を表示 |
| — | `route{model,domain}` | （表示用） |
| 返答テキスト | `reply{delta}` | 吹き出しに追記 |
| `create_artifact` 開始 | `tool.start{name,summary}` | 「描いています: …」 |
| html 引数のストリーム | `tool.html{delta}` | 途中 HTML を frame に即描画 |
| `patch_artifact` の各 op | `tool.op{op}` | ベース版に op を再適用して描画 |
| ツール完了 | `tool.end{name,args}` | 版を確定（変化なしの patch は版を積まない） |
| プロバイダのリトライ | `reset` | 途中出力を破棄しベースに戻す |
| 失敗 | `error{error}` | メッセージ表示、最後の確定版に戻す |
| 完了 | `done{mode}` | ターン終了 |

同時実行は 1 ターン（429）、切断で abort、モデル未登録は 409、入力上限超過は 400/413。

## 5. ファイル別計画（M1 実装済み）
- `core/canvas.mjs` 新規: 上限値、プロンプト、モード判定、入力検証、メッセージ構築、create/patch ストリームパーサ、`runCanvasTurn`
- `core/canvas-frame.mjs` 新規: frame の CSP と文書（nonce 付き最小ランタイム、`e.source===parent` のみ受理）
- `core/server.mjs` 変更: `GET /canvas/frame`、`POST /api/canvas/turn`
- `core/frontend.mjs` 変更: バンドル順に `canvas-engine`, `canvas`
- `web/bridge.mjs` 変更: `bridge.stream()`（CSRF 付き POST + NDJSON 読み取り）
- `web/canvas-engine.mjs` 新規: パッチエンジン、版ログ、状態リデューサ
- `web/canvas.mjs` 新規: ビュー（ログ・入力・送る/止める/ひとつ戻す・frame）
- `web/app.mjs` 変更: ナビ追加、ビューの mount/unmount、idle 判定除外
- `web/styles.css` 変更: キャンバス用スタイル
- `tests/canvas.test.mjs` 新規: 11 テスト
- 後続: `native/` Rust サービスの同等ルート、`docs/ARCHITECTURE` 追記、`store` への版保存

## 6. リスク
- **テキストプロトコルの逸脱**: モデルがフェンスや散文を混ぜる → パーサは許容的（フェンス除去、非 JSON 行は返答扱い、`<`/`|` 漏れ行は無視）。小型モデルでは patch の質が落ちる可能性。
- **リトライ時の二重出力**: `reset` で吸収済み。
- **サンドボックス**: model HTML は opaque origin・通信不可・nonce 外スクリプト不可。ただし CSS による見た目の偽装は可能（frame 内に閉じる）。将来スクリプトを許すなら別途ポリシー判断が必要。
- **ネイティブ Rust サービス**: M1 は Node サーバのみ。Rust 側起動時はキャンバスが 404。
- **永続化なし**: リロードで作品が消える（M1 の仕様）。
- **DOM 依存の `canvasApplyOps`** は Node 単体テスト対象外（jsdom 等の依存を増やさない方針）。実 Chrome でのスモークで確認。

## 7. マイルストーン（最小の縦切りから）
1. **M1（実装済み）**: テキスト依頼 → `work` ルートで create/patch をストリーム → サンドボックス描画。版表示・ひとつ戻す・停止。
2. M2: 永続化（`store` の artifact リビジョンに保存、再読込で復元、版一覧 UI）
3. M3: クリック選択（frame → 親へ data-id 送信 → 「これを赤く」）、ステアリング/下書き
4. M4: 3D（three.js を vendoring し nonce で配信）、スライド
5. M5: 音声（`voice.mjs`/realtime-voice 経由の話しかけ操作、AI カーソル）
6. M6: Rust ネイティブサービスのルート同等化、サンドボックス方針の統一、ARCHITECTURE 文書化

## 8. 確認したいこと
- 置き場所はナビ独立ビューでよいか、それとも「仕事」の中のパネルにするか。
- モデル生成スクリプト（アニメ等）を将来許可するか。
- 永続化の単位（キャンバスごと／会話セッションに紐付け）。
