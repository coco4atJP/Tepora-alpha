# Tepora Project 厳格レビュー（2026-02-21）

**レビュー種別**: フルプロジェクト（backend-rs / frontend / MCP / setup / セキュリティ / 品質ゲート）  
**レビュー方針**: 「見た目で動く」ではなく、壊れ方・運用事故・セキュリティ劣化を優先して判定。  
**結論**: 直近で多くの改善は入っていますが、**MCP実行結果の欠落**と**モデル管理のデータ整合性**は、現状のままでは実運用で重大事故になり得ます。

---

## 1. 自動チェック結果（実測）

### Backend (`Tepora-app/backend-rs`)
- `cargo check`: ✅ pass
- `cargo clippy --all-features -- -D warnings`: ✅ pass
- `cargo test`: ✅ pass（**243 passed / 0 failed**）
- `cargo fmt -- --check`: ❌ fail（format差分あり）
- `cargo audit`: ❌ fail（**1件**）
  - `RUSTSEC-2023-0071` (`rsa 0.9.10`, sqlx経由)

### Frontend (`Tepora-app/frontend`)
- `npm run typecheck`: ✅ pass
- `npm run lint`: ✅ pass
- `npm test -- --run`: ✅ pass（**22 files, 196 tests passed**）
- `npm audit --audit-level=moderate`: ✅ pass（0 vulnerabilities）

---

## 2. 重大指摘（Critical）

### C-1. MCPツールの成功時出力が捨てられている（実質的な機能欠損）
- **根拠**
  - `format_tool_result` の success 側で `result.content` を実際に組み立てていない: `Tepora-app/backend-rs/src/mcp/mod.rs:846`, `Tepora-app/backend-rs/src/mcp/mod.rs:857`, `Tepora-app/backend-rs/src/mcp/mod.rs:862`, `Tepora-app/backend-rs/src/mcp/mod.rs:868`
  - MCP実行結果はそのままエージェント実行結果に使われる: `Tepora-app/backend-rs/src/tools/manager.rs:55`
- **影響**
  - MCPが「成功」しても実データがLLM側に届かず、推論品質が崩れる。
  - 「Tool executed successfully (no output)」固定応答に寄るため、調査系・取得系ツールが実質無効化される。
- **修正方針**
  - `CallToolResult.content` の型を正規に分解して文字列化。
  - error/success双方のフォーマット単体テストを追加。

### C-2. モデル更新フローが重複登録を生み、削除時に実ファイル喪失が起こり得る
- **根拠**
  - ダウンロード時は常に `add_model_entry` で新規追加: `Tepora-app/backend-rs/src/models/manager.rs:226`
  - 既存ID衝突時は `unique_model_id` で別ID採番（重複共存）: `Tepora-app/backend-rs/src/models/manager.rs:843`
  - UIの更新操作は同じ download API を再呼び出し: `Tepora-app/frontend/src/features/settings/components/subcomponents/ModelListOverlay.tsx:63`
  - 削除時は該当IDの `file_path` を無条件削除: `Tepora-app/backend-rs/src/models/manager.rs:263`, `Tepora-app/backend-rs/src/models/manager.rs:265`
- **影響**
  - 同一ファイルを参照する複数モデルIDが生成されうる。
  - そのうち1件削除で共有実体ファイルが消え、残存エントリが壊れる（ロード失敗）。
- **修正方針**
  - `repo_id + filename + role`（またはファイルハッシュ）で**upsert**に変更。
  - ファイル削除前に参照カウント（同一 `file_path` の残数）を確認。

---

## 3. 重要指摘（Major）

### M-1. セッション整合性: `default` 仮想セッションが実DBと乖離しやすい
- **根拠**
  - フロント初期セッションIDは `"default"`: `Tepora-app/frontend/src/stores/sessionStore.ts:52`
  - 送信時はそのIDをそのままWS送信: `Tepora-app/frontend/src/stores/websocketStore.ts:419`
  - サーバー側WSの初期セッションも `"default"`: `Tepora-app/backend-rs/src/server/ws/handler.rs:96`
  - 履歴保存時、セッション存在の厳密確認なし（`UPDATE`結果未検証）: `Tepora-app/backend-rs/src/history/mod.rs:197`
  - history DB接続で foreign key 明示有効化なし: `Tepora-app/backend-rs/src/history/mod.rs:40`
- **影響**
  - 「表示上は会話したがセッション一覧に載らない」状態が発生し得る。
  - 将来的にFK厳格化した際、既存挙動が即時に壊れるリスクが高い。
- **修正方針**
  - 初回接続時にセッションを必ず作成・確定（`default` を実体化するか廃止）。
  - DB側は `foreign_keys` 有効化、`add_message` をトランザクション化。

### M-2. WebSocket 認証/Origin拒否が「アップグレード後」実行
- **根拠**
  - `ws_handler` は条件に関係なく `on_upgrade` 実行: `Tepora-app/backend-rs/src/server/ws/handler.rs:35`
  - 不正時の拒否はアップグレード後に close: `Tepora-app/backend-rs/src/server/ws/handler.rs:43`, `Tepora-app/backend-rs/src/server/ws/handler.rs:53`
- **影響**
  - 未認証でも 101 握手までは成立し、接続スパムの負荷面積が増える。
  - ログノイズ増大、障害解析のS/N悪化。
- **修正方針**
  - HTTP段階で `401/403` を返して upgrade 自体を拒否。

### M-3. リンク安全性がコンポーネント間で不一致（`RagContextPanel` 側が未防御）
- **根拠**
  - `RagContextPanel` は `url/link` を素通し: `Tepora-app/frontend/src/features/chat/RagContextPanel.tsx:35`, `Tepora-app/frontend/src/features/chat/RagContextPanel.tsx:37`
  - そのまま `href` に設定: `Tepora-app/frontend/src/features/chat/RagContextPanel.tsx:165`
  - 対照として `SearchResults` には protocol 検証あり: `Tepora-app/frontend/src/features/chat/SearchResults.tsx:39`, `Tepora-app/frontend/src/features/chat/SearchResults.tsx:45`
- **影響**
  - 外部データが混入したときに不正スキーム遷移の踏み台になる可能性が残る。
- **修正方針**
  - URLサニタイズ関数を共通ユーティリティ化し、両コンポーネントで統一適用。

### M-4. setup API が失敗を隠して成功応答を返す箇所がある
- **根拠**
  - active model 更新結果を破棄して常に success: `Tepora-app/backend-rs/src/server/handlers/setup.rs:513`, `Tepora-app/backend-rs/src/server/handlers/setup.rs:516`
  - character role 設定でも active config 更新失敗を握り潰し: `Tepora-app/backend-rs/src/server/handlers/setup.rs:463`, `Tepora-app/backend-rs/src/server/handlers/setup.rs:466`
- **影響**
  - フロントは成功表示、実際は設定反映失敗という不整合が起こる。
- **修正方針**
  - `update_active_model_config` の `Result` をそのまま伝播。
  - UI側へエラー原因を返し、再試行導線を持たせる。

### M-5. MCP設定パース失敗時に `unwrap_or_default` で無言リセット
- **根拠**
  - 更新時: `serde_json::from_value(...).unwrap_or_default()`: `Tepora-app/backend-rs/src/mcp/mod.rs:342`
  - 読み込み時: `serde_json::from_str(...).unwrap_or_default()`: `Tepora-app/backend-rs/src/mcp/mod.rs:757`
- **影響**
  - 形式不正入力で設定が空に近い状態へフォールバックし、サーバー群が消えたように見える。
- **修正方針**
  - パースエラーを `BadRequest` で返却し、既存設定を保持。

---

## 4. 中程度指摘（Medium）

### Md-1. `/api/status` が未認証公開かつメトリクス定義が不正確
- **根拠**
  - ルータで公開: `Tepora-app/backend-rs/src/server/router.rs:27`
  - `require_api_key` なし: `Tepora-app/backend-rs/src/server/handlers/health.rs:35`
  - `total_messages` は `default` 固定で集計: `Tepora-app/backend-rs/src/server/handlers/health.rs:38`
- **影響**
  - 内部状態の露出範囲が広い。
  - 運用上の指標として誤解を生む（全セッション合計ではない）。
- **修正方針**
  - 少なくとも desktop 以外では認証必須化。
  - 集計定義を全体メッセージ数へ統一。

### Md-2. 依存面積: `sqlx` の `macros` feature が audit 警告連鎖を引き込み
- **根拠**
  - `sqlx` に `macros` を有効化: `Tepora-app/backend-rs/Cargo.toml:21`
  - プロジェクト内で `query!` 系マクロ利用は確認できず（grepベース）。
  - `cargo audit` で `RUSTSEC-2023-0071` 検出（`sqlx-mysql -> rsa` 経路）。
- **影響**
  - 実利用していない機能由来の脆弱性アラートを背負い続ける。
- **修正方針**
  - `macros` feature 除去可否を検証し、不要なら削除。
  - 除去不可の場合は `audit` 例外の根拠を明文化。

### Md-3. i18n検査スクリプトが現行ディレクトリ構成と不整合で実行不能
- **根拠**
  - 参照先が旧パス (`frontend/...`) 固定: `find_i18n_issues.js:18`, `find_i18n_issues.js:19`, `find_i18n_issues.js:20`
  - 実行時 `ENOENT` で即失敗（`Tepora-app/frontend` 構成との不一致）。
- **影響**
  - 翻訳品質チェックの自動化が壊れている。
- **修正方針**
  - ルート相対パスを `Tepora-app/frontend/...` に更新。
  - 可能ならCLI引数でルート指定可能にして再利用性を上げる。

---

## 5. 良い点（維持推奨）

- 2/20時点での重大欠陥（model check/download契約、logs/model filename安全性）はかなり修正済み。
- Backend: `check / clippy / test` が全通過し、回帰耐性は改善傾向。
- Frontend: lint・typecheck・test が現時点で成立しており、品質ゲートは復旧済み。
- URL安全化を `SearchResults` に導入しており、横展開すれば防御水準を底上げできる。

---

## 6. 優先度付き改善計画

### P0（即時）
1. `mcp::format_tool_result` を修正し、MCP結果本文を正しく返す。
2. モデル更新の upsert 化 + 参照カウント付き削除に変更。
3. `setup_set_active_model` / `setup_set_character_role` のエラー握り潰しを廃止。

### P1（今スプリント）
1. セッション生成・保存の整合を再設計（`default` の実体化または撤廃）。
2. WS 認証を upgrade 前判定へ移行。
3. `RagContextPanel` を含む全外部リンクに共通URLサニタイズ適用。

### P2（次スプリント）
1. `sqlx` feature最小化（`macros`見直し）と `cargo audit` 運用ルール整備。
2. `find_i18n_issues.js` を現行構成対応 + CI組み込み。
3. `/api/status` の認証方針と指標定義を再整理。

---

## 7. 追加メモ（レビュー範囲）

- 本レビューは静的読解 + コマンド実行ベース。UIの手動操作E2Eは未実施。
- 既存の未コミット変更（ユーザー作業中ファイル）には手を入れていません。

