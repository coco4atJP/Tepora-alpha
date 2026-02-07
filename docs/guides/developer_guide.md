# Developer Guide / 開発者ガイド

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Developer Guide (English)

This guide provides comprehensive information for developers contributing to the Tepora project.

## 1. Environment Setup

### Prerequisites
- **OS**: Windows 10/11, macOS, or Linux
- **Node.js**: 18.0.0 or higher
- **Rust**: Latest stable (required for backend + Tauri)
- **Git**: Version control

### Tools Installation

#### Rust & Tauri
Follow the official [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) guide to install Rust and system dependencies.

## 2. Project Structure

Tepora adopts a monorepo-like structure within the `Tepora-app` directory.

```
Tepora_Project/
├── Tepora-app/
│   ├── backend-rs/        # Rust Backend
│   │   ├── src/           # Source code
│   ├── frontend/          # React Frontend + Tauri
│   │   ├── src/           # React components & hooks
│   │   └── src-tauri/     # Rust Tauri configuration
│   └── scripts/           # Build & utility scripts (e.g., build_sidecar.mjs)
├── docs/                  # Documentation
│   ├── architecture/      # Architecture & design docs
│   ├── guides/            # Developer guides
│   └── planning/          # Planning & audit docs
└── Taskfile.yml           # Task runner definitions
```

## 3. Development Workflow

### Option A: Full Desktop App (Recommended)
Run the full integrated application using Tauri. This mimics the production environment.

```bash
cd Tepora-app/frontend
npm run build:sidecar
npm run tauri dev
```
This command starts the frontend dev server. Note that you **must build the sidecar** manually before running Tauri dev if you have made changes to the backend, as `tauri dev` does not automatically rebuild the external binary sidecar.

### Option B: Split Development (Backend & Frontend Separate)
Useful when focusing on backend logic or frontend UI specifically.

**Terminal 1: Backend**
```bash
cd Tepora-app/backend-rs
cargo run
```
The server prints `TEPORA_PORT=xxxx` on startup.

**Terminal 2: Frontend (Web Mode)**
```bash
cd Tepora-app/frontend
npm run dev
```
The web UI starts at `http://localhost:5173`.
*Note: In this mode, some Tauri-specific features (like system tray or native notifications) may not work.*

## 4. Testing

### Backend Tests
```bash
cd Tepora-app/backend-rs
cargo test
```

### Frontend Tests
Automated frontend tests (Vitest) can be run via:
```bash
cd Tepora-app/frontend
npm run test
```

## 5. Adding New Features

### Adding a New Tool

Tepora's tool system is modular. To add a new tool:

1. **Native Tools**: Implement in `Tepora-app/backend-rs/src/tooling.rs`.
2. **MCP Tools**: Configure external MCP servers in `config/mcp_tools_config.json`
   - See `Tepora-app/backend-rs/src/mcp.rs` for the MCP manager
3. Register the tool in `Tepora-app/backend-rs/src/tooling.rs`.
4. If necessary, update the `agent_profiles` in `config.yml` to allow the new tool.

**Tool directory structure:**
```
backend-rs/src/
├── tooling.rs      # Native tools + tool router
├── mcp.rs          # MCP manager
└── search.rs       # Search provider implementations
```

### Modifying Agent Behavior
- **Prompt Engineering**: Edit system prompts in `Tepora-app/backend-rs/src/config.rs`.
- **Graph Logic**: Modify the execution flow in `Tepora-app/backend-rs/src/ws.rs`.

---

<div id="japanese"></div>

# 開発者ガイド (日本語)

Teporaプロジェクトに貢献する開発者のための包括的なガイドです。

## 1. 環境構築

### 必須要件
- **OS**: Windows 10/11, macOS, または Linux
- **Node.js**: 18.0.0 以上
- **Rust**: 最新の安定版 (バックエンド + Tauriに必要)
- **Git**: バージョン管理

### ツールのインストール

#### Rust & Tauri
公式の [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) ガイドに従って、Rustとシステム依存関係をインストールしてください。

## 2. プロジェクト構造

Teporaは `Tepora-app` ディレクトリ内でモノレポのような構造を採用しています。

```
Tepora_Project/
├── Tepora-app/
│   ├── backend-rs/        # Rustバックエンド
│   │   ├── src/           # ソースコード
│   ├── frontend/          # Reactフロントエンド + Tauri
│   │   ├── src/           # Reactコンポーネント & フック
│   │   └── src-tauri/     # Rust Tauri設定
│   └── scripts/           # ビルド・ユーティリティスクリプト (例: build_sidecar.mjs)
├── docs/                  # ドキュメント
│   ├── architecture/      # アーキテクチャ・設計
│   ├── guides/            # 開発者ガイド
│   └── planning/          # 計画・監査
└── Taskfile.yml           # タスクランナー定義
```

## 3. 開発ワークフロー

### パターン A: 完全なデスクトップアプリ (推奨)
Tauriを使用して統合されたアプリケーションを実行します。これは本番環境に最も近い状態です。

```bash
cd Tepora-app/frontend
npm run build:sidecar
npm run tauri dev
```
このコマンドはフロントエンド開発サーバーを起動します。**注意**: バックエンドに変更を加えた場合、Tauri devを実行する前にサイドカーを手動でビルドする必要があります。`tauri dev` は外部バイナリ（サイドカー）の自動再ビルドを行いません。

### パターン B: 分割開発 (バックエンド・フロントエンド別々)
バックエンドロジック、あるいはフロントエンドUIのみに集中したい場合に便利です。

**ターミナル 1: バックエンド**
```bash
cd Tepora-app/backend-rs
cargo run
```
サーバーは起動時に `TEPORA_PORT=xxxx` を出力します。

**ターミナル 2: フロントエンド (Webモード)**
```bash
cd Tepora-app/frontend
npm run dev
```
Web UIは `http://localhost:5173` で起動します。
*注意: このモードでは、Tauri固有の機能（システムトレイやネイティブ通知など）は動作しない場合があります。*

## 4. テスト

### バックエンドテスト
```bash
cd Tepora-app/backend-rs
cargo test
```

### フロントエンドテスト
自動化されたフロントエンドテスト（Vitest）は以下で実行可能です：
```bash
cd Tepora-app/frontend
npm run test
```

## 5. 新機能の追加

### 新しいツールの追加

Teporaのツールシステムはモジュラー設計です。新しいツールを追加するには：

1. **ネイティブツール**: `Tepora-app/backend-rs/src/tooling.rs` にツールを実装します。
2. **MCPツール**: 外部MCPサーバーを `config/mcp_tools_config.json` で設定
   - MCP管理は `Tepora-app/backend-rs/src/mcp.rs` を参照
3. `Tepora-app/backend-rs/src/tooling.rs` にツールを登録します。
4. 必要であれば、`config.yml` の `agent_profiles` を更新して新しいツールを許可します。

**ツールディレクトリ構造:**
```
backend-rs/src/
├── tooling.rs      # ネイティブツール + ルータ
├── mcp.rs          # MCPマネージャ
└── search.rs       # Searchプロバイダ実装
```

### エージェントの挙動変更
- **プロンプトエンジニアリング**: `Tepora-app/backend-rs/src/config.rs` 内の設定を編集します。
- **フロー制御**: `Tepora-app/backend-rs/src/ws.rs` の実行フローを変更します。
