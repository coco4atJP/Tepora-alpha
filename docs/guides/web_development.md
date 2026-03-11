# ⚠️ Tepora Web Interface API & Architecture Guide / Tepora Web API・アーキテクチャガイド

[English](#english) | [日本語](#japanese)

> [!IMPORTANT]
> This document pertains to the **development web interface**.
> Tepora's recommended runtime environment is the **Tauri desktop app**.
> For local development setup instructions, see [development.md](./development.md). The backend has been migrated to Rust (`Tepora-app/backend-rs`). Descriptions related to Python/FastAPI are considered legacy.
> ------
> このドキュメントは、**開発用Webインターフェース**に関するものです。
> Teporaの推奨実行環境は **Tauriデスクトップアプリ** です。
> ローカル開発環境の立ち上げ手順については、[development.md](./development.md) を参照してください。バックエンドは Rust (`Tepora-app/backend-rs`) に移行済みです。Python/FastAPIに関する記述はレガシー扱いです。

<div id="english"></div>

# Tepora Web Interface - Setup Guide (English)

## 🎯 Overview
Tepora now supports a Web interface! It offers a modern and easy-to-use UI.

## 🏗️ Architecture

### Backend
- **Axum** - Web framework built in Rust
- **WebSocket** - Real-time streaming communications
- **Tokio** - Asynchronous runtime

### Frontend
- **React 19** - UI library
- **TypeScript** - Type safety
- **Vite 7** - Extremely fast build tool
- **Tailwind CSS v4** - Modern styling (via Vite plugin)
- **TanStack Query** - Async state management and caching
- **Lucide React** - Icon library

For detailed technical stacks and version information, please refer to [ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

## 🎨 Features

### Chat Modes
- **💬 CHAT**: The character agent responds directly.
- **🔍 SEARCH**: Gets the latest information using basic web searches.
- **🤖 AGENT**: The agent model executes tasks using tools.

> [!NOTE]
> The model in use can be changed from the settings screen.

### Real-time Functionality
- **WebSocket Streaming**: Responses appear in real-time.
- **Connection Status**: Visually confirm the connection status.
- **EM-LLM Stats**: View the status of the memory system over time.

### UI/UX
- **Dark Mode**: Comes standard with an eye-friendly dark theme.
- **Responsive Design**: UI reflows for windows and supports mobile layouts.
- **Keyboard Shortcuts**: Enter to send, Shift+Enter for new line.
- **Animations**: Smooth message display transitions.

## 📁 Project Structure

```
Tepora_Project/
├── Taskfile.yml               # Task runner definitions
├── Tepora-app/
│   ├── backend-rs/
│   │   ├── Cargo.toml         # Rust dependencies
│   │   └── src/
│   │       ├── api.rs         # API routing
│   │       ├── ws.rs          # WebSocket processing
│   │       ├── mcp.rs         # MCP management
│   │       └── models.rs      # Model management
│   └── frontend/
│       ├── package.json       # Node.js dependencies
│       ├── vite.config.ts     # Vite configurations
│       ├── tsconfig.json      # TypeScript configurations
│       └── src/
│           ├── main.tsx       # React entry point
│           ├── App.tsx        # Main app component
│           ├── components/    # UI components
│           ├── context/       # React Context
│           ├── hooks/         # Custom hooks
│           ├── pages/         # Page components
│           ├── types/         # TypeScript definitions
│           └── utils/         # Utilities
└── docs/                      # Documentation
```

## 📝 For Developers

### API Endpoints
For detailed API specifications, please refer to the "Data Flow and API Specifications" section in [ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

**Main Endpoints Overview:**
- `GET /health` - Health check
- `GET /api/config` - Get configuration info
- `POST /api/config` - Update configuration
- `WS /ws` - Chat communication and status notifications

#### WebSocket Message Format

**To Server (Client → Server):**
```json
{
  "message": "User's input",
  "mode": "chat" // "chat" | "search" | "agent", etc.
}
```

**From Server (Server → Client):**
```json
{
  "type": "chunk", // "chunk" | "status" | "error" | "stats" | "done"
  "message": "AI's response",
  "data": { }
}
```

### Customizations
#### Editing System Prompts
Edit `agents.yaml` directly to update the agent's `system_prompt`.

## 📄 License
The same license as the existing Tepora project applies.

## 🙏 Acknowledgments
- [Axum](https://github.com/tokio-rs/axum)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [TanStack Query](https://tanstack.com/query)
- [Lucide](https://lucide.dev/)

---

<div id="japanese"></div>

# Tepora Web Interface - セットアップガイド (日本語)

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
  "mode": "chat" // "chat" | "search" | "agent" など
}
```

**受信（サーバー→クライアント）:**
```json
{
  "type": "chunk", // "chunk" | "status" | "error" | "stats" | "done"
  "message": "AIの応答",
  "data": { }
}
```

### カスタマイズ
#### システムプロンプトの変更
`agents.yaml` を直接編集してエージェントの `system_prompt` を更新します。

## 📄 ライセンス
既存のTeporaプロジェクトと同じライセンスが適用されます。

## 🙏 謝辞
- [Axum](https://github.com/tokio-rs/axum)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [Tailwind CSS](https://tailwindcss.com/)
- [TanStack Query](https://tanstack.com/query)
- [Lucide](https://lucide.dev/)
