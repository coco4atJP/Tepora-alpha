# Tepora 開発ガイド

このドキュメントでは、Teporaプロジェクトの開発環境構築、実行方法、テスト方法について解説します。
本プロジェクトは **Desktop First** (Tauri + Local Python Backend) を主軸としていますが、開発の利便性のためにWebブラウザでの動作も一部サポートしています。

## 🛠️ 前提条件 (Prerequisites)

以下のツールがインストールされている必要があります。

- **Python**: 3.10 以上
- **Node.js**: 18.0.0 以上
- **Rust**: 最新の安定版 (Tauriのビルドに必要)
- **Visual Studio Code** (推奨エディタ)

## 🚀 環境構築 (Setup)

### 1. リポジトリのクローン
```bash
git clone https://github.com/your-org/tepora.git
cd tepora
```

### 2. バックエンド (Python) のセットアップ
```powershell
cd Tepora-app/backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```
**注意**: `llama-cpp-python` のインストールにはC++ビルドツールが必要になる場合があります。GPUサポートを有効にする場合は、適切なビルド引数を指定してください。

**推奨**: `uv` パッケージマネージャーを使用する場合:
```powershell
cd Tepora-app/backend
uv sync
```

### 3. フロントエンド (React + Tauri) のセットアップ
```powershell
cd Tepora-app/frontend
npm install
```

## 💻 開発時の実行方法 (Running in Development)

開発時は、バックエンドとフロントエンドを別々に起動するか、Tauri開発モードを使用します。

### A. デスクトップアプリとして開発 (推奨)
Tauri 環境で実行します。WebViewとネイティブAPIの連携を含めた完全な動作確認が可能です。

```powershell
cd Tepora-app/frontend
npm run tauri dev
```
このコマンドは以下を自動で行います：
1. Vite サーバーの起動
2. Python バックエンドの起動 (Sidecar として)
3. アプリウィンドウの表示

### B. Webブラウザで開発 (UI調整向け)
UIの調整だけを高速に行いたい場合、ブラウザモードが便利です。ただし、Tauri固有のAPI (ファイル操作など) は動作しません。

**推奨: Taskfileを使用**
プロジェクトルートで `task` コマンドを使用します。
```powershell
task dev-sync
```

**代替: 個別起動 (手動)**
個別に起動する場合は、環境変数を手動で合わせる必要があります。

**ターミナル1 (バックエンド)**
```powershell
cd Tepora-app/backend
# 固定ポートを指定して起動
$env:PORT="8000"; uv run server.py
```

**ターミナル2 (フロントエンド)**
```powershell
cd Tepora-app/frontend
npm run dev
```
ブラウザで `http://localhost:5173` にアクセスします。

## 🧪 テストの実行 (Testing)

### バックエンド (Pytest)
```powershell
cd Tepora-app/backend
uv run pytest tests/
```

### フロントエンド (Vitest)
```powershell
cd Tepora-app/frontend
npm run test
```

## 📦 ビルドと配布 (Build & Distribution)

Tauri アプリケーションとしてインストーラーを作成します。

```powershell
cd Tepora-app/frontend
npm run tauri build
```
このコマンドは以下の処理を行います：
1. React アプリのビルド (`frontend/dist` 生成)
2. Python バックエンドの実行ファイル化 (PyInstaller で `tepora-backend` 生成)
3. Tauri アプリのバンドル (MSI インストーラー等の生成)

生成物は `Tepora-app/frontend/src-tauri/target/release/bundle` に出力されます。

## 📁 主要なディレクトリ構造
詳細なアーキテクチャは [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) を参照してください。

- `Tepora-app/backend/src/tepora_server`: FastAPI Webサーバー実装
- `Tepora-app/backend/src/core`: ビジネスロジック (LangGraph, EM-LLM)
- `Tepora-app/frontend/src`: React コンポーネント
- `Tepora-app/frontend/src-tauri`: Tauri 設定と Rust コード
