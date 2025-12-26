# ⚠️ Tepora Web Interface - 開発者向けガイド (Development Only)

> [!IMPORTANT]
> このドキュメントは、**開発用Webインターフェース**に関するものです。
> Teporaの推奨実行環境は **Tauriデスクトップアプリ** です。
> 一般的な利用や本番環境については、デスクトップ版のセットアップ手順を参照してください。

# Tepora Web Interface - セットアップガイド

## 🎯 概要

TeporaがWebインターフェースに対応しました！モダンで使いやすいUIを提供します。

## 🏗️ アーキテクチャ

### バックエンド
- **FastAPI** - 高速な非同期Webフレームワーク
- **WebSocket** - リアルタイムストリーミング通信
- **Uvicorn** - ASGIサーバー

### フロントエンド
- **React 18** - UIライブラリ
- **TypeScript** - 型安全性
- **Vite** - 高速ビルドツール
- **Tailwind CSS** - モダンなスタイリング
- **Lucide React** - アイコンライブラリ

## 📦 セットアップ

### 1. Python依存関係のインストール

```bash
cd backend
pip install -r requirements.txt
```

### 2. フロントエンド依存関係のインストール

```bash
cd frontend
npm install
```

## 🚀 起動方法

### Option 1: 自動起動スクリプト（推奨）

#### Windows
```bash
# プロジェクトルートで実行
start_app.bat
```

これで、バックエンドとフロントエンドの両方が起動します。

### Option 2: 手動起動

#### バックエンドサーバー起動
```bash
# プロジェクトルートで実行
scripts\start_backend.bat
```

サーバーは `http://localhost:8000` で起動します。
- API仕様: `http://localhost:8000/docs`
- WebSocket: `ws://localhost:8000/ws`

#### フロントエンド開発サーバー起動
```bash
# プロジェクトルートで実行
scripts\start_frontend.bat
```

フロントエンドは `http://localhost:5173` で起動します。

### 3. ブラウザでアクセス

ブラウザで `http://localhost:5173` を開きます。

## 🎨 機能

### チャットモード
- **💬 CHAT**: キャラクターエージェント (Gemma 3N) が直接応答
- **🔍 SEARCH**: Web検索を使用して最新情報を取得
- **🤖 AGENT**: プロフェッショナルエージェント (Jan-nano) がツールを使用してタスクを実行

### リアルタイム機能
- **WebSocketストリーミング**: 応答がリアルタイムで表示
- **接続ステータス**: 接続状態を視覚的に確認
- **EM-LLM統計**: メモリシステムの状態を表示

### UI/UX
- **ダークモード**: 目に優しいダークテーマ
- **レスポンシブデザイン**: モバイルでも使いやすい
- **キーボードショートカット**: Enter送信、Shift+Enterで改行
- **アニメーション**: スムーズなメッセージ表示

## 📁 プロジェクト構造

```
Tepora_Project/
├── start_app.bat              # アプリ起動スクリプト (Windows)
├── backend/
│   ├── server.py              # FastAPIバックエンド
│   ├── requirements.txt       # Python依存関係
│   ├── config.yml             # 設定ファイル
│   └── src/
│       └── core/              # コアロジック
│           ├── app/           # アプリケーション層
│           ├── graph/         # LangGraphロジック
│           ├── em_llm/        # エピソード記憶システム
│           └── ...
├── frontend/
│   ├── package.json           # Node.js依存関係
│   ├── vite.config.ts         # Vite設定
│   ├── tsconfig.json          # TypeScript設定
│   ├── tailwind.config.js     # Tailwind CSS設定
│   └── src/
│       ├── main.tsx           # Reactエントリーポイント
│       ├── App.tsx            # メインアプリコンポーネント
│       ├── components/        # UIコンポーネント
│       ├── hooks/             # カスタムフック
│       ├── types/             # TypeScript型定義
│       └── styles/            # スタイル
└── scripts/
    ├── start_backend.bat      # バックエンド起動
    └── start_frontend.bat     # フロントエンド起動
```

## 🔧 トラブルシューティング

### ポートが既に使用されている
```bash
# ポート8000が使用中の場合
# backend/server.py の最下部を編集:
uvicorn.run(app, host="0.0.0.0", port=8001)
```

### WebSocket接続エラー
- バックエンドサーバーが起動していることを確認
- ファイアウォール設定を確認
- ブラウザのコンソールでエラーメッセージを確認

### フロントエンドビルドエラー
```bash
# node_modulesを削除して再インストール
cd frontend
rm -rf node_modules
npm install
```

## 🚢 本番環境デプロイ

### フロントエンドビルド
```bash
cd frontend
npm run build
```

ビルド成果物は `frontend/dist/` に生成されます。

### サーバー設定
`backend/server.py` の最下部を編集：
```python
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        log_level="info"
    )
```

## 📝 開発者向け情報

### API エンドポイント

#### REST API
- `GET /health` - ヘルスチェック
- `GET /api/config` - 設定情報取得
- `POST /api/config` - 設定更新
- `GET /api/logs` - ログファイル一覧
- `GET /api/logs/{filename}` - ログ内容取得

#### WebSocket
- `WS /ws` - チャット通信と状態通知

**メッセージフォーマット（送信）:**
```json
{
  "message": "ユーザーの入力",
  "mode": "direct" | "search" | "agent"
}
```

**メッセージフォーマット（受信）:**
```json
{
  "type": "chunk" | "status" | "error" | "stats" | "done",
  "message": "AIの応答",
  "data": { ... }
}
```

### カスタマイズ

#### テーマカラーの変更
`frontend/tailwind.config.js` の `primary` カラーを編集

#### システムプロンプトの変更
`backend/src/core/config/prompts.py` を編集

## 📄 ライセンス

既存のTeporaプロジェクトと同じライセンスが適用されます。

## 🙏 謝辞

- [FastAPI](https://fastapi.tiangolo.com/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Lucide](https://lucide.dev/)
