# ⚠️ Tepora Web Interface - 開発者向けガイド (Development Only)

> [!IMPORTANT]
> このドキュメントは、**開発用Webインターフェース**に関するものです。
> Teporaの推奨実行環境は **Tauriデスクトップアプリ** です。
> 一般的な利用や本番環境については、デスクトップ版のセットアップ手順を参照してください。
> バックエンドは Rust (`Tepora-app/backend-rs`) に移行済みです。Python/FastAPIに関する記述はレガシー扱いです。

# Tepora Web Interface - セットアップガイド

## 🎯 概要

TeporaがWebインターフェースに対応しました！モダンで使いやすいUIを提供します。

## 🏗️ アーキテクチャ

### バックエンド
- **Axum** - Rust製のWebフレームワーク
- **WebSocket** - リアルタイムストリーミング通信
- **Tokio** - 非同期ランタイム

### フロントエンド
- **React 19** - UIライブラリ
- **TypeScript** - 型安全性
- **Vite 7** - 高速ビルドツール
- **Tailwind CSS v4** - モダンなスタイリング（Viteプラグイン方式）
- **TanStack Query** - 非同期状態管理・キャッシュ
- **Lucide React** - アイコンライブラリ

詳細な技術スタック・バージョン情報は [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) を参照してください。

## 📦 セットアップ

### 1. Rust依存関係の取得

```bash
cd Tepora-app/backend-rs
cargo fetch
```

### 2. フロントエンド依存関係のインストール

```bash
cd Tepora-app/frontend
npm ci --legacy-peer-deps
```

## 🚀 起動方法

### Option 1: Taskfile を使用（推奨）

プロジェクトルートで `task` コマンドを使用します。

```bash
# バックエンドとフロントエンドを同期起動
task dev-sync
```

これで、バックエンドとフロントエンドの両方が起動します。

### Option 2: 手動起動

#### バックエンドサーバー起動
```bash
cd Tepora-app/backend-rs
cargo run
```

サーバーは起動時に `TEPORA_PORT=xxxx` を出力します。
- API: `http://localhost:{port}`
- WebSocket: `ws://localhost:{port}/ws`

#### フロントエンド開発サーバー起動
```bash
cd Tepora-app/frontend
npm run dev
```

フロントエンドは `http://localhost:5173` で起動します。

### 3. ブラウザでアクセス

ブラウザで `http://localhost:5173` を開きます。

## 🎨 機能

### チャットモード
- **💬 CHAT**: キャラクターエージェントが直接応答
- **🔍 SEARCH**: Web検索を使用して最新情報を取得
- **🤖 AGENT**: エージェントモデルがツールを使用してタスクを実行

> [!NOTE]
> 使用するモデルは設定画面から変更可能です。

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
├── Taskfile.yml               # タスクランナー定義
├── Tepora-app/
│   ├── backend-rs/
│   │   ├── Cargo.toml         # Rust依存関係
│   │   └── src/
│   │       ├── api.rs         # APIルーティング
│   │       ├── ws.rs          # WebSocket処理
│   │       ├── mcp.rs         # MCP管理
│   │       └── models.rs      # モデル管理
│   └── frontend/
│       ├── package.json       # Node.js依存関係
│       ├── vite.config.ts     # Vite設定
│       ├── tsconfig.json      # TypeScript設定
│       └── src/
│           ├── main.tsx       # Reactエントリーポイント
│           ├── App.tsx        # メインアプリコンポーネント
│           ├── components/    # UIコンポーネント
│           ├── context/       # React Context
│           ├── hooks/         # カスタムフック
│           ├── pages/         # ページコンポーネント
│           ├── types/         # TypeScript型定義
│           └── utils/         # ユーティリティ
└── docs/                      # ドキュメント
```

## 🔧 トラブルシューティング

### ポートが既に使用されている
```bash
# 任意のポートで起動
$env:PORT="8001"; cargo run
```

### WebSocket接続エラー
- バックエンドサーバーが起動していることを確認
- ファイアウォール設定を確認
- ブラウザのコンソールでエラーメッセージを確認

### フロントエンドビルドエラー
```bash
# node_modulesを削除して再インストール
cd Tepora-app/frontend
rm -rf node_modules
npm ci --legacy-peer-deps
```

## 🚢 本番環境デプロイ

### フロントエンドビルド
```bash
cd Tepora-app/frontend
npm run build
```

ビルド成果物は `Tepora-app/frontend/dist/` に生成されます。

## 📝 開発者向け情報

### API エンドポイント

詳細なAPI仕様は [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) の「データフローとAPI仕様」セクションを参照してください。

**主要エンドポイント概要:**
- `GET /health` - ヘルスチェック
- `GET /api/config` - 設定情報取得
- `POST /api/config` - 設定更新
- `WS /ws` - チャット通信と状態通知

#### WebSocket メッセージフォーマット

**送信（クライアント→サーバー）:**
```json
{
  "message": "ユーザーの入力",
  "mode": "direct" | "search" | "agent"
}
```

**受信（サーバー→クライアント）:**
```json
{
  "type": "chunk" | "status" | "error" | "stats" | "done",
  "message": "AIの応答",
  "data": { ... }
}
```

### カスタマイズ

#### システムプロンプトの変更
`/api/config` 経由で `custom_agents` の `system_prompt` を更新します。

## 📄 ライセンス

既存のTeporaプロジェクトと同じライセンスが適用されます。

## 🙏 謝辞

- [Axum](https://github.com/tokio-rs/axum)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [TanStack Query](https://tanstack.com/query)
- [Lucide](https://lucide.dev/)
