# Tepora Project 厳格レビュー（2026-02-20）

**レビュー種別**: フルプロジェクト（backend-rs / frontend / setupフロー / security / CI）  
**レビュー方針**: 厳しめ。動作不全・セキュリティ・運用上の詰まりを優先。  
**結論**: **現状は「機能の見た目」と「実際の契約」がズレている箇所があり、特にモデル追加フローは実運用で破綻する可能性が高い。**

---

## 1. 自動チェック結果（実測）

### Backend
- `cargo check`: ✅ pass
- `cargo fmt -- --check`: ✅ pass
- `cargo clippy -- -D warnings`: ✅ pass
- `cargo test`: ✅ pass（**235 passed / 0 failed**）
- `cargo audit --ignore RUSTSEC-2023-0071`: ✅ pass（監査DB更新・lock走査完了）

### Frontend
- `npm run typecheck`: ✅ pass
- `npm test -- --run`: ✅ pass（**22 files, 194 tests passed**）
- `npm run lint`: ❌ fail（`@eslint/js` が見つからず起動不能）
  - `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@eslint/js' imported from .../eslint.config.js`
- `npm audit --audit-level=moderate`: ❌ 11件（moderate/high）
  - 主に `eslint` / `typescript-eslint` 系の依存連鎖（`ajv`, `minimatch`）

---

## 2. 重大指摘（Critical）

### C-1. モデル追加フローがフロント/バックで契約崩壊している
- **影響**: モデル追加UIが成功したように見えて実処理されない、または入力時点で詰まる。
- **根拠**
  - フロントは `check` に `repo_id`/`filename` を送って `exists` を期待: `Tepora-app/frontend/src/features/settings/components/subcomponents/AddModelForm.tsx:58`
  - しかしバックは `model_id` を要求し既存モデル照会のみ: `Tepora-app/backend-rs/src/server/handlers/setup.rs:99`, `Tepora-app/backend-rs/src/server/handlers/setup.rs:516`
  - フロントは `download` で実ダウンロード/進捗/409同意を期待: `Tepora-app/frontend/src/features/settings/components/subcomponents/AddModelForm.tsx:316`
  - しかしバックは placeholder で常に `{"success": true}` を返すだけ: `Tepora-app/backend-rs/src/server/handlers/setup.rs:526`
  - フロントはローカル登録で `file_path` を送る: `Tepora-app/frontend/src/features/settings/components/subcomponents/AddModelForm.tsx:194`
  - しかしバックは `path` しか受け取らない: `Tepora-app/backend-rs/src/server/handlers/setup.rs:111`, `Tepora-app/backend-rs/src/server/handlers/setup.rs:544`
- **所見**: これは単なる改善ではなく、**機能破綻**です。UIとAPIが別物になっています。
- **推奨修正**
  1. `setup` API契約を1箇所に固定（OpenAPI/型共有）。
  2. `AddModelForm` を `setup/run` 系に寄せるか、`setup/model/download` を本実装化。
  3. ローカル登録は `path` に統一し、role/display_nameを受けるならバック側DTOも拡張。

### C-2. ログ取得APIにパストラバーサルが成立する
- **影響**: `../` を含む `filename` でログ外ファイルを読み出せる可能性。
- **根拠**
  - `path = log_dir.join(filename)`: `Tepora-app/backend-rs/src/server/handlers/logs.rs:49`
  - `starts_with(log_dir)` で判定: `Tepora-app/backend-rs/src/server/handlers/logs.rs:51`
  - そのまま `read_to_string(path)`: `Tepora-app/backend-rs/src/server/handlers/logs.rs:59`
- **問題点**: `starts_with` は `..` 正規化を保証しないため、防御として不十分。
- **推奨修正**
  1. `canonicalize` 後にルート配下判定。
  2. `filename` はベース名のみ許可（区切り文字・`..`・絶対パス拒否）。

### C-3. モデルダウンロード保存先にパストラバーサル（任意パス書き込み）
- **影響**: 悪意ある `filename` で想定外パスに保存される可能性（設定ファイル上書き等）。
- **根拠**
  - `filename` は payload からほぼ無加工で採用: `Tepora-app/backend-rs/src/server/handlers/setup.rs:699`
  - 非空チェックのみ: `Tepora-app/backend-rs/src/server/handlers/setup.rs:727`
  - 保存先は `base.join(filename)`: `Tepora-app/backend-rs/src/models/manager.rs:425`
- **推奨修正**
  1. `filename` は `Path::file_name()` で正規化し、親参照/絶対パス拒否。
  2. 保存先 `canonicalize` 後に `models/{role}` 配下判定。
  3. `repo_id`/`filename` に対するサーバー側バリデーション強化。

---

## 3. 重要指摘（Major）

### M-1. Setup readiness 判定が embedding を無視しており、状態遷移が誤る
- **影響**: embedding未配置でも「セットアップ完了」扱いになりうる。
- **根拠**
  - backendが `is_ready: text_ok` を返す: `Tepora-app/backend-rs/src/server/handlers/setup.rs:196`
  - しかし `has_missing` は `text && embedding` 前提: `Tepora-app/backend-rs/src/server/handlers/setup.rs:193`
  - Appは `is_ready` のみで wizard 表示判定: `Tepora-app/frontend/src/App.tsx:134`
  - Setup reducer も `is_ready` で `COMPLETE` 遷移: `Tepora-app/frontend/src/features/settings/components/SetupWizard/reducer.ts:46`
- **推奨修正**
  1. `is_ready` の定義を明文化（最低 `text_ok && embedding_ok` か、loader別条件）。
  2. フロントは `has_missing` も併用して判定。

### M-2. フロント lint が常時失敗し品質ゲートが崩れている
- **影響**: Lint品質保証が実行不能。CIも詰まる。
- **根拠**
  - `eslint.config.js` は `@eslint/js` を import: `Tepora-app/frontend/eslint.config.js:1`
  - `package.json` の devDependencies に `@eslint/js` がない: `Tepora-app/frontend/package.json:45`
  - 実行結果: `npm run lint` で `ERR_MODULE_NOT_FOUND`
- **推奨修正**
  1. `@eslint/js` を明示追加して lock 更新。
  2. `task quality` / CI で再確認。

### M-3. 履歴取得がスケールしない（N+1 + 全件取得後メモリ切り詰め）
- **影響**: セッション数/メッセージ数増大時に遅延・DB負荷・メモリ増加。
- **根拠**
  - `list_sessions` で各sessionごとに `COUNT(*)`（N+1）: `Tepora-app/backend-rs/src/history/mod.rs:143`
  - `get_history` は全件 `fetch_all` 後に in-memory limit: `Tepora-app/backend-rs/src/history/mod.rs:225`, `Tepora-app/backend-rs/src/history/mod.rs:248`
- **推奨修正**
  1. `list_sessions` は JOIN/集約で一括取得。
  2. `get_history` は SQLで `LIMIT` + 必要なら逆順取得後反転。
  3. ページングAPIを導入。

### M-4. テストがAPI契約不整合を検知できていない
- **影響**: 既に壊れている契約差分がユニットテストをすり抜ける。
- **根拠**
  - AddModelForm test は `check => {exists: true}` を前提モック: `Tepora-app/frontend/src/features/settings/components/subcomponents/__tests__/AddModelForm.test.tsx:58`
  - `download` も URL文字列ベースの成功モック: `Tepora-app/frontend/src/features/settings/components/subcomponents/__tests__/AddModelForm.test.tsx:94`
- **推奨修正**
  1. APIモックを backend DTO に一致させる。
  2. `setup` 系は契約テスト（schema test）を追加。

---

## 4. 中程度指摘（Medium）

### Md-1. セッショントークンを `window` グローバルに置いている
- **影響**: 将来XSSや不正スクリプト混入時にトークン窃取の被害面積が拡大。
- **根拠**
  - `window.__tepora_session_token` へ保存: `Tepora-app/frontend/src/utils/sessionToken.ts:53`
  - 認証ヘッダがそこから直接読まれる: `Tepora-app/frontend/src/utils/api.ts:48`
  - さらに env fallback (`VITE_API_KEY`) を許容: `Tepora-app/frontend/src/utils/sessionToken.ts:44`, `Tepora-app/frontend/src/utils/api.ts:54`
- **推奨修正**
  1. tokenはモジュール内メモリのみで管理（global公開しない）。
  2. productionでは `VITE_API_KEY` fallbackを無効化。

### Md-2. Search結果リンクのスキーム検証がない
- **影響**: 不正URL（例: `javascript:`）混入時のクリックリスク。
- **根拠**
  - URLをほぼ素通し: `Tepora-app/frontend/src/features/chat/SearchResults.tsx:41`
  - そのまま `href` に反映: `Tepora-app/frontend/src/features/chat/SearchResults.tsx:67`
- **推奨修正**
  1. `http/https` のみ許可して他は `#` にフォールバック。
  2. 表示前にURL正規化ユーティリティを共通化。

---

## 5. 良い点（維持すべき点）

- Rust側テストが厚い（235件）うえ、`clippy -D warnings` も通っている。
- フロントテストも194件通過しており、状態管理系の単体テストが充実。
- `tools/manager` の SSRF 対策は比較的丁寧で、private/loopback/documentation range を明示的に遮断している。
- 設定値の secret 分離・マスキング実装があり、設定APIの基本設計は良い。

---

## 6. 優先度付き改善計画（提案）

### P0（今すぐ）
1. モデル追加API契約を統一（`AddModelForm` と `setup` handlers を一致）。
2. `setup_download_model` placeholder 解消（実装 or route廃止）。
3. `logs` のパス検証を canonicalize ベースへ修正。
4. `model_storage_path` への filename 正規化・拒否ルール追加。

### P1（今スプリント）
1. `is_ready` 判定を embedding含めて再定義し、App/Reducerを同期。
2. `@eslint/js` 追加で lint gate 復旧。
3. 履歴系クエリのN+1解消とSQL limit化。

### P2（次スプリント）
1. AddModel関連の契約テストを追加（frontend/backed DTOの自動検証）。
2. token保持戦略見直し（global排除）。
3. URL検証ユーティリティを導入し、外部リンク全体に適用。

---

## 7. 総評

コア（Rustテスト群・構造）は一定水準に達していますが、**「機能が存在するように見えるが実契約が崩れている」** 部分が複数あり、特にモデル管理系はユーザー影響が大きいです。  
最優先は **P0の契約修正 + パス安全性修正** で、ここを解消するとプロジェクトの信頼性は大きく上がります。
