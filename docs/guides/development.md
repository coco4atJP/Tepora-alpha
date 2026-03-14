# Tepora Development Guide / Tepora 開発ガイド

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Development Guide (English)

This document explains how to set up the development environment, run, and test the Tepora project.
This project primarily focuses on **Desktop First** (Tauri + Local Rust Backend), but partially supports web browser operation for development convenience.

> **Related Documents:**
> - [Extension Guide (developer_guide.md)](./developer_guide.md) - Adding new tools and modifying agent behavior
> - [Web API Specs (web_development.md)](./web_development.md) - API specifications and WebSocket formats
> - [Troubleshooting (troubleshooting.md)](./troubleshooting.md) - Error resolution and debugging

## 🛠️ Prerequisites

The following tools must be installed:

- **Node.js**: 18.0.0 or higher
- **Rust**: Latest stable (required for backend / Tauri builds)
- **Visual Studio Code** (Recommended editor)

## 🚀 Setup

### 1. Clone Repository
```bash
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora
```

### 2. Backend (Rust) Setup
```powershell
cd Tepora-app
task install-backend
```

### 3. Frontend (React + Tauri) Setup
```powershell
cd Tepora-app
task install-frontend
```

### 4. Setup Diagnostics
After installing dependencies, run `task doctor` to verify your local environment prerequisites.

```powershell
cd Tepora-app
task doctor
```

`task doctor` checks the following:
- Node.js 18+ and npm
- Rust toolchain (`cargo`, `rustc`)
- `task` command and `Tepora-app/Taskfile.yml`
- `frontend/node_modules` and local Tauri CLI
- `npm config get legacy-peer-deps` settings

## 💻 Running in Development

During development, you can either run the backend and frontend separately or use the Tauri development mode.

### A. Develop as a Desktop App (Recommended)
Run in the Tauri environment. This allows for full operation verification, including WebView and native API integration.

```powershell
cd Tepora-app/frontend
npm run build:sidecar
npm run tauri dev
```
This command does the following:
1. Builds the Rust backend (sidecar)
2. Starts the Vite server
3. Displays the app window

*Note: Since `tauri dev` does not automatically rebuild external binaries, you must run `npm run build:sidecar` (or `task build-sidecar`) when you modify the backend.*

### B. Develop in a Web Browser (For UI Adjustments)
The browser mode is convenient for quickly making UI adjustments. However, Tauri-specific APIs (such as file operations) will not work.

**Recommended: Use Taskfile**
Use the `task` command in the project root.
```powershell
task dev
```
The canonical definitions are in `Tepora-app/Taskfile.yml`. The root `Taskfile.yml` delegates the same command names as a compatibility wrapper. If you encounter environment-dependent startup failures, run `task doctor` first to check for missing tools or configuration warnings.

**Alternative: Manual Startup**
If starting individually, you must manually align the environment variables.
**Terminal 1 (Backend)**
```powershell
cd Tepora-app/backend-rs
# Start on a specific port
$env:PORT="8000"; cargo run
```
**Terminal 2 (Frontend)**
```powershell
cd Tepora-app/frontend
npm run dev
```
Access `http://localhost:5173` in your browser.

### C. Enable Windows Developer Mode (Windows)
When testing unsigned built apps (.msi/.exe) in a Windows environment, or when using certain privileges, you may need to enable Windows Developer Mode.
Open the Windows "Settings" app > "Privacy & security" > "For developers", and enable "Developer Mode".

## 🧪 Testing

### Backend (Cargo)
```powershell
cd Tepora-app/backend-rs
cargo test
```

### Frontend (Vitest)
```powershell
cd Tepora-app/frontend
npm run test
```

### dev_sync Pseudo E2E
```powershell
cd Tepora-app
npm run test:dev-sync
```

### Diff-based Test Execution
```powershell
cd Tepora-app
# Run only necessary tests based on the current working tree diff
task test:changed

# Use only staged changes as the baseline
npm run test:changed -- --staged

# Manually specify an arbitrary set of files
npm run test:changed -- --dry-run --file frontend/src/test/example.test.ts --file backend-rs/src/lib.rs
```
`task test:changed` executes based on these policies:
- `backend-rs/` diffs: Backend `cargo test --all-targets`
- `frontend/src/` only diffs: `vitest related --run`
- Frontend configs or `package.json` diffs: All frontend tests
- `scripts/`, `tests/`, or Taskfile diffs: App root Node tests

### WebSocket Deterministic Replay
`task test:ws-replay` feeds a fixed `WsIncomingMessage` sequence into the actual handler path and verifies that the JSON transcript is identical every time. It uses `perf_probe` and `set_session` to lock in a stable transcript that can be replayed even in sessions with history.
```powershell
cd Tepora-app
task test:ws-replay
```
Since the `history.messages[].id` in the history uses the DB's persistent ID rather than a random UUID, the replay results can be compared directly.

### Model Behavior A/B Evaluation
`task test:behavior` compares variants' output JSON against a dataset with a rubric, and returns the Model Behavior A/B evaluation results in Markdown. The default smoke dataset is located at `tests/evals/model_behavior.dataset.json` and `tests/evals/model_behavior.*.responses.json`.
```powershell
cd Tepora-app
task test:behavior

# To evaluate with an arbitrary variant output
npm run eval:behavior -- --dataset tests/evals/model_behavior.dataset.json --variant baseline=tests/evals/model_behavior.baseline.responses.json --variant candidate=tests/evals/model_behavior.candidate.responses.json --baseline baseline --candidate candidate --output-json tests/evals/reports/model_behavior.json --output-md tests/evals/reports/model_behavior.md --fail-on-regression
```
The current scorer supports `includes_all`, `excludes_all`, `exact_equals`, `regex_match`, `max_length`, `min_length`, `json_equals`, and `json_path_equals`.

### Layer Conformance Tests
Import constraint tests based on the dependency rules in the architecture specifications are added to the backend's `domain`, `application`, and `infrastructure` layers. `state` and `core` are permitted as foundational modules, while backflow into higher layers or `server` is detected.
```powershell
cd Tepora-app
task test:arch
```
Upon failure, violating imports will be displayed per `path:line` within `backend-rs/src/...`.

### Workflow JSON Golden Tests
The declarative workflow JSON in the backend is fixed using fixtures.
- Input fixtures: `backend-rs/workflows/default.json`, `backend-rs/tests/fixtures/workflows/tool_node.json`
- Canonical golden: `backend-rs/tests/fixtures/workflows/*.canonical.json`
- Execution: `cargo test graph::loader::tests --lib`
When changing the shape of the workflow JSON, intentionally update the fixtures and canonical golden files.

## 🧪 Flaky Test Quarantine
`task test:flaky` executes the suites defined in `tests/flaky/quarantine-suites.json` multiple times to determine if they are `stable_pass`, `flaky`, or `stable_fail`. The current default target is the `dev_sync` pseudo E2E.
```powershell
# Check the quarantine lane locally
cd Tepora-app
task test:flaky
```
In CI, this lane runs as a non-blocking warning job and saves JSON/Markdown report artifacts.

## 📝 Conventional Commits / Release Notes
Release notes are automatically generated from conventional commits.
```powershell
cd Tepora-app
# Verify the latest commit as conventional commits
task commitlint
# Generate release notes from an arbitrary range
task release-notes -- --from v0.4.5 --to HEAD --version vNext
```
In CI, commit messages are verified per push/pull request, and pushing a tag automatically generates a release notes artifact.

## ✅ Pre-commit Workflow
A two-stage workflow: lightweight verification before committing, and heavy verification before pushing or manually.
```powershell
# General pre-commit check (diff focused)
task pre-commit
# Explicitly run fast checks
task pre-commit:fast
# Full verification before push (all files)
task pre-commit:full
# Install local hooks
task pre-commit:install
```

## 🧹 Cleanup
```powershell
# Normal clean (including Wasm fixture artifacts)
task clean
# Clean only Wasm fixture artifacts
task clean-wasm-fixtures
```

## 📦 Build & Distribution
Creates an installer as a Tauri application.
```powershell
cd Tepora-app/frontend
npm run build:app
```
This command performs the following:
1. React app build (generates `frontend/dist`)
2. Rust backend build (generates `tepora-backend`)
3. Tauri app bundle (generates MSI installer, etc.)
The outputs are generated in `Tepora-app/frontend/src-tauri/target/release/bundle`.

---

<div id="japanese"></div>

# 開発ガイド (日本語)

このドキュメントでは、Teporaプロジェクトの開発環境構築、実行方法、テスト方法について解説します。
本プロジェクトは **Desktop First** (Tauri + Local Rust Backend) を主軸としていますが、開発の利便性のためにWebブラウザでの動作も一部サポートしています。

> **関連ドキュメント:**
> - [機能拡張ガイド (Developer Guide)](./developer_guide.md) - 新しいツールの追加やエージェントの挙動変更
> - [Web API仕様 (Web Development)](./web_development.md) - API仕様・WebSocketフォーマット
> - [トラブルシューティング](./troubleshooting.md) - エラー解決とデバッグ

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
Task定義の正本は `Tepora-app/Taskfile.yml` です。ルートの `Taskfile.yml` は互換ラッパーとして同じコマンド名を委譲します。環境依存の起動失敗がある場合は、先に `task doctor` を実行して不足ツールや設定警告を確認してください。

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
`task test:flaky` は `tests/flaky/quarantine-suites.json` に定義した suite を複数回実行し、`stable_pass` / `flaky` / `stable_fail` を判定します。現在の既定対象は `dev_sync` 疑似 E2E です。
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
task release-notes -- --from v0.4.5 --to HEAD --version vNext
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
# フックのインストール
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
