# Tepora 開発ガイド

このドキュメントでは、Teporaプロジェクトの開発環境構築、実行方法、テスト方法について解説します。
本プロジェクトは **Desktop First** (Tauri + Local Python Backend) を主軸としていますが、開発の利便性のためにWebブラウザでの動作も一部サポートしています。

## 🛠️ 前提条件 (Prerequisites)

以下のツールがインストールされている必要があります。

- **Python**: 3.10 以上
- **Node.js**: 20.0 以上 (推奨)
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
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```
**注意**: `llama-cpp-python` のインストールにはC++ビルドツールが必要になる場合があります。GPUサポートを有効にする場合は、適切なビルド引数を指定してください。

### 3. フロントエンド (React + Tauri) のセットアップ
```powershell
cd frontend
npm install
```

## 💻 開発時の実行方法 (Running in Development)

開発時は、バックエンドとフロントエンドを別々に起動するか、Tauri開発モードを使用します。

### A. デスクトップアプリとして開発 (推奨)
Tauri 環境で実行します。WebViewとネイティブAPIの連携を含めた完全な動作確認が可能です。

```powershell
cd frontend
npm run tauri dev
```
このコマンドは以下を自動で行います：
1. Vite サーバーの起動
2. Python バックエンドの起動 (Sidecar として)
3. アプリウィンドウの表示

### B. Webブラウザで開発 (UI調整向け)
UIの調整だけを高速に行いたい場合、ブラウザモードが便利です。ただし、Tauri固有のAPI (ファイル操作など) は動作しません。

**ターミナル1 (バックエンド)**
```powershell
cd backend
source venv/bin/activate  # or .\venv\Scripts\activate
python server.py
# または
uvicorn server:app --reload --port 8000
```

**ターミナル2 (フロントエンド)**
```powershell
cd frontend
npm run dev
```
ブラウザで `http://localhost:5173` にアクセスします。

### C. 統合起動スクリプト (Windows)
プロジェクトルートにある `start_app.bat` は、簡易的に両方を立ち上げるスクリプトです。
```powershell
.\start_app.bat
```

## 🧪 テストの実行 (Testing)

### バックエンド (Pytest)
```powershell
cd backend
pytest tests/
```

### フロントエンド (Vitest)
```powershell
cd frontend
npm run test
```

## 📦 ビルドと配布 (Build & Distribution)

Tauri アプリケーションとしてインストーラーを作成します。

```powershell
cd frontend
npm run tauri build
```
このコマンドは以下の処理を行います：
1. React アプリのビルド (`frontend/dist` 生成)
2. Python バックエンドの実行ファイル化 (PyInstaller で `tepora-backend` 生成)
3. Tauri アプリのバンドル (MSI インストーラー等の生成)

生成物は `frontend/src-tauri/target/release/bundle` に出力されます。

## 📁 主要なディレクトリ構造
詳細なアーキテクチャは [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) を参照してください。

- `backend/src/tepora_server`: FastAPI Webサーバー実装
- `backend/src/core`: ビジネスロジック (LangGraph, EM-LLM)
- `frontend/src`: React コンポーネント
- `frontend/src-tauri`: Tauri 設定と Rust コード
