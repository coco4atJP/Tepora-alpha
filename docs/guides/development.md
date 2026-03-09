# Tepora 開発ガイド

このドキュメントでは、Teporaプロジェクトの開発環境構築、実行方法、テスト方法について解説します。
本プロジェクトは **Desktop First** (Tauri + Local Rust Backend) を主軸としていますが、開発の利便性のためにWebブラウザでの動作も一部サポートしています。

## 🛠️ 前提条件 (Prerequisites)

以下のツールがインストールされている必要があります。

- **Node.js**: 18.0.0 以上
- **Rust**: 最新の安定版 (バックエンド / Tauriのビルドに必要)
- **Visual Studio Code** (推奨エディタ)

## 🚀 環境構築 (Setup)

### 1. リポジトリのクローン
```bash
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora
```

### 2. バックエンド (Rust) のセットアップ
```powershell
cd Tepora-app
task install-backend
```

### 3. フロントエンド (React + Tauri) のセットアップ
```powershell
cd Tepora-app
task install-frontend
```

### 4. セットアップ診断
依存関係を入れたら、まず `task doctor` でローカル環境の前提を確認してください。

```powershell
cd Tepora-app
task doctor
```

`task doctor` は次を検査します。

- Node.js 18+ と npm
- Rust toolchain (`cargo`, `rustc`)
- `task` コマンドと `Tepora-app/Taskfile.yml`
- `frontend/node_modules` とローカル Tauri CLI
- `npm config get legacy-peer-deps` の設定値

## 💻 開発時の実行方法 (Running in Development)

開発時は、バックエンドとフロントエンドを別々に起動するか、Tauri開発モードを使用します。

### A. デスクトップアプリとして開発 (推奨)
Tauri 環境で実行します。WebViewとネイティブAPIの連携を含めた完全な動作確認が可能です。

```powershell
cd Tepora-app/frontend
npm run build:sidecar
npm run tauri dev
```
このコマンドは以下を行います：
1. Rust バックエンド（サイドカー）のビルド
2. Vite サーバーの起動
3. アプリウィンドウの表示

※ `tauri dev` は外部バイナリを自動でリビルドしないため、バックエンド変更時は `npm run build:sidecar` (または `task build-sidecar`) が必要です。

### B. Webブラウザで開発 (UI調整向け)
UIの調整だけを高速に行いたい場合、ブラウザモードが便利です。ただし、Tauri固有のAPI (ファイル操作など) は動作しません。

**推奨: Taskfileを使用**
プロジェクトルートで `task` コマンドを使用します。
```powershell
task dev
```
Task定義の正本は `Tepora-app/Taskfile.yml` です。ルートの `Taskfile.yml` は互換ラッパーとして同じコマンド名を委譲します。
環境依存の起動失敗がある場合は、先に `task doctor` を実行して不足ツールや設定警告を確認してください。

**代替: 個別起動 (手動)**
個別に起動する場合は、環境変数を手動で合わせる必要があります。

**ターミナル1 (バックエンド)**
```powershell
cd Tepora-app/backend-rs
# 固定ポートを指定して起動
$env:PORT="8000"; cargo run
```

**ターミナル2 (フロントエンド)**
```powershell
cd Tepora-app/frontend
npm run dev
```
ブラウザで `http://localhost:5173` にアクセスします。

### C. Windows 開発者モードの有効化 (Windows)

Windows 環境で未署名のビルド済みアプリ(.msi/.exe)をテストする場合や、一部の権限を使用する場合、Windows 開発者モードの有効化が必要になることがあります。

Windowsの「設定」アプリから「プライバシーとセキュリティ」>「開発者向け」を開き、「開発者モード」を有効にしてください。

## 🧪 テストの実行 (Testing)

### バックエンド (Cargo)
```powershell
cd Tepora-app/backend-rs
cargo test
```

### フロントエンド (Vitest)
```powershell
cd Tepora-app/frontend
npm run test
```

### dev_sync 疑似E2E
```powershell
cd Tepora-app
npm run test:dev-sync
```

### 差分ベースのテスト実行
```powershell
cd Tepora-app

# 現在の working tree 差分から必要なテストだけ回す
task test:changed

# staged changes のみを基準にする場合
npm run test:changed -- --staged

# 任意のファイル集合を手動指定する場合
npm run test:changed -- --dry-run --file frontend/src/test/example.test.ts --file backend-rs/src/lib.rs
```

`task test:changed` は以下の方針で選択実行します。

- `backend-rs/` の差分: backend の `cargo test --all-targets`
- `frontend/src/` のみの差分: `vitest related --run`
- frontend 設定や `package.json` 差分: frontend 全テスト
- `scripts/` / `tests/` / Taskfile 差分: アプリルートの Node テスト

### WebSocket deterministic replay
`task test:ws-replay` は固定の `WsIncomingMessage` 列を実際の handler 経路に流し、JSON transcript が毎回同じになることを検証します。`perf_probe` と `set_session` を使って、履歴付きセッションでも replay 可能な安定 transcript を固定しています。

```powershell
cd Tepora-app
task test:ws-replay
```

履歴の `history.messages[].id` にはランダム UUID ではなく DB の永続 ID を使うため、再生結果をそのまま比較できます。
### Model Behavior A/B 評価
`task test:behavior` は rubric 付き dataset と variant 出力 JSON を比較し、Model Behavior の A/B 評価結果を Markdown で返します。既定の smoke dataset は `tests/evals/model_behavior.dataset.json` と `tests/evals/model_behavior.*.responses.json` にあります。

```powershell
cd Tepora-app
task test:behavior

# 任意の variant 出力で評価したい場合
npm run eval:behavior -- --dataset tests/evals/model_behavior.dataset.json --variant baseline=tests/evals/model_behavior.baseline.responses.json --variant candidate=tests/evals/model_behavior.candidate.responses.json --baseline baseline --candidate candidate --output-json tests/evals/reports/model_behavior.json --output-md tests/evals/reports/model_behavior.md --fail-on-regression
```

現在の scorer は `includes_all`, `excludes_all`, `exact_equals`, `regex_match`, `max_length`, `min_length`, `json_equals`, `json_path_equals` をサポートしています。

### レイヤー適合テスト
backend の `domain` / `application` / `infrastructure` には、アーキテクチャ仕様書の依存ルールに沿った import 制約テストを追加しています。`state` と `core` は基盤モジュールとして許可しつつ、上位層や `server` への逆流を検知します。

```powershell
cd Tepora-app
task test:arch
```

失敗時は `backend-rs/src/...` の `path:line` 単位で違反 import が表示されます。

### Workflow JSON ゴールデンテスト
backend の declarative workflow JSON は fixture ベースで固定化しています。

- 入力 fixture: `backend-rs/workflows/default.json`, `backend-rs/tests/fixtures/workflows/tool_node.json`
- canonical golden: `backend-rs/tests/fixtures/workflows/*.canonical.json`
- 実行: `cargo test graph::loader::tests --lib`

workflow JSON の shape を変える場合は、fixture と canonical golden を意図的に更新してください。

## 🧪 Flaky Test Quarantine

`task test:flaky` は `tests/flaky/quarantine-suites.json` に定義した suite を複数回実行し、
`stable_pass` / `flaky` / `stable_fail` を判定します。現在の既定対象は `dev_sync` 疑似 E2E です。

```powershell
# quarantine lane をローカルで確認
cd Tepora-app
task test:flaky
```

CI ではこの lane を non-blocking の warning job として実行し、JSON / Markdown report artifact を保存します。

## 📝 conventional commits / release notes

リリースノートは conventional commits から自動生成します。

```powershell
cd Tepora-app

# 直近コミットを conventional commits として検証
task commitlint

# 任意レンジから release notes を生成
task release-notes -- --from v0.4.0 --to HEAD --version vNext
```

CI では push / pull request ごとにコミットメッセージを検証し、tag push では release notes artifact を自動生成します。
## ✅ pre-commit 運用

軽い検証はコミット前、重い検証は push 前または手動で回す二段運用です。

```powershell
# 一般的なコミット前チェック（差分中心）
task pre-commit

# 明示的に fast を実行
task pre-commit:fast

# push 前のフル検証（全ファイル対象）
task pre-commit:full
```

フックをローカルに入れる場合は次を実行してください。

```powershell
task pre-commit:install
```

## 🧹 クリーンアップ (Cleanup)

```powershell
# 通常クリーン（Wasm fixture成果物の掃除を含む）
task clean

# Wasm fixture成果物のみ掃除
task clean-wasm-fixtures
```

## 📦 ビルドと配布 (Build & Distribution)

Tauri アプリケーションとしてインストーラーを作成します。

```powershell
cd Tepora-app/frontend
npm run build:app
```
このコマンドは以下の処理を行います：
1. React アプリのビルド (`frontend/dist` 生成)
2. Rust バックエンドのビルド (`tepora-backend` 生成)
3. Tauri アプリのバンドル (MSI インストーラー等の生成)

生成物は `Tepora-app/frontend/src-tauri/target/release/bundle` に出力されます。

## 📁 主要なディレクトリ構造
詳細なアーキテクチャは [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) を参照してください。

- `Tepora-app/backend-rs/src`: Rust バックエンド
- `Tepora-app/frontend/src`: React コンポーネント
- `Tepora-app/frontend/src-tauri`: Tauri 設定と Rust コード

