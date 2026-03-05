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
cd Tepora-app/backend-rs
cargo fetch
```

### 3. フロントエンド (React + Tauri) のセットアップ
```powershell
cd Tepora-app/frontend
npm ci --legacy-peer-deps
```

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