# Developer Guide / 開発者ガイド

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Developer Guide (English)

This guide provides comprehensive information for developers contributing to the Tepora project.

## 1. Environment Setup

### Prerequisites
- **OS**: Windows 10/11, macOS, or Linux
- **Python**: 3.10 or higher
- **Node.js**: 18.0.0 or higher
- **Rust**: Latest stable (required for Tauri)
- **Git**: Version control

### Tools Installation

#### uv (Python Package Manager)
Tepora uses `uv` for fast and reliable Python dependency management.
```bash
# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

#### Rust & Tauri
Follow the official [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) guide to install Rust and system dependencies.

## 2. Project Structure

Tepora adopts a monorepo-like structure within the `Tepora-app` directory.

```
Tepora_Project/
├── Tepora-app/
│   ├── backend/           # Python Backend (FastAPI + LangGraph)
│   │   ├── models/        # Place GGUF models here
│   │   ├── src/           # Source code
│   │   └── tests/         # Unit tests
│   ├── frontend/          # React Frontend + Tauri
│   │   ├── src/           # React components & hooks
│   │   └── src-tauri/     # Rust Tauri configuration
│   └── scripts/           # Build & utility scripts (e.g., build_sidecar.py)
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
npm run tauri dev
```
This command starts the frontend dev server and compiles/runs the Rust/Python backend sidecar.

### Option B: Split Development (Backend & Frontend Separate)
Useful when focusing on backend logic or frontend UI specifically.

**Terminal 1: Backend**
```bash
cd Tepora-app/backend
uv run server.py
```
The server starts at `http://localhost:8000`.

**Terminal 2: Frontend (Web Mode)**
```bash
cd Tepora-app/frontend
npm run dev
```
The web UI starts at `http://localhost:5173`.
*Note: In this mode, some Tauri-specific features (like system tray or native notifications) may not work.*

## 4. Testing

### Backend Tests
We use `pytest`. Ensure you are in the `Tepora-app/backend` directory.

```bash
# Run all tests
uv run pytest tests/

# Run with verbose output
uv run pytest tests/ -v
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

1. **Native Tools**: Create a tool class in `Tepora-app/backend/src/core/tools/native.py`.
   - Inherit from `BaseTool` defined in `tools/base.py`
2. **MCP Tools**: Configure external MCP servers in `config/mcp_tools_config.json`
   - See `tools/mcp.py` for the `McpToolProvider` implementation
3. Register the tool in `Tepora-app/backend/src/core/tool_manager.py`.
4. If necessary, update the `agent_profiles` in `config.yml` to allow the new tool.

**Tool directory structure:**
```
src/core/tools/
├── __init__.py     # Tool exports
├── base.py         # BaseTool abstract class
├── native.py       # Built-in Python tools (e.g., Google Search)
└── mcp.py          # MCP tool provider (McpToolProvider)
```

### Modifying Agent Behavior
- **Prompt Engineering**: Edit system prompts in `Tepora-app/backend/src/core/config/prompts.py`.
- **Graph Logic**: Modify the state machine in `Tepora-app/backend/src/core/graph/`.

---

<div id="japanese"></div>

# 開発者ガイド (日本語)

Teporaプロジェクトに貢献する開発者のための包括的なガイドです。

## 1. 環境構築

### 必須要件
- **OS**: Windows 10/11, macOS, または Linux
- **Python**: 3.10 以上
- **Node.js**: 18.0.0 以上
- **Rust**: 最新の安定版 (Tauriに必要)
- **Git**: バージョン管理

### ツールのインストール

#### uv (Pythonパッケージマネージャ)
Teporaでは、高速で信頼性の高いPython依存関係管理のために `uv` を使用します。
```bash
# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

#### Rust & Tauri
公式の [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) ガイドに従って、Rustとシステム依存関係をインストールしてください。

## 2. プロジェクト構造

Teporaは `Tepora-app` ディレクトリ内でモノレポのような構造を採用しています。

```
Tepora_Project/
├── Tepora-app/
│   ├── backend/           # Pythonバックエンド (FastAPI + LangGraph)
│   │   ├── models/        # GGUFモデルはここに配置
│   │   ├── src/           # ソースコード
│   │   └── tests/         # ユニットテスト
│   ├── frontend/          # Reactフロントエンド + Tauri
│   │   ├── src/           # Reactコンポーネント & フック
│   │   └── src-tauri/     # Rust Tauri設定
│   └── scripts/           # ビルド・ユーティリティスクリプト (例: build_sidecar.py)
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
npm run tauri dev
```
このコマンドは、フロントエンド開発サーバーを起動し、Rust/Pythonバックエンド（サイドカー）をコンパイルして実行します。

### パターン B: 分割開発 (バックエンド・フロントエンド別々)
バックエンドロジック、あるいはフロントエンドUIのみに集中したい場合に便利です。

**ターミナル 1: バックエンド**
```bash
cd Tepora-app/backend
uv run server.py
```
サーバーは `http://localhost:8000` で起動します。

**ターミナル 2: フロントエンド (Webモード)**
```bash
cd Tepora-app/frontend
npm run dev
```
Web UIは `http://localhost:5173` で起動します。
*注意: このモードでは、Tauri固有の機能（システムトレイやネイティブ通知など）は動作しない場合があります。*

## 4. テスト

### バックエンドテスト
`pytest` を使用します。`Tepora-app/backend` ディレクトリにいることを確認してください。

```bash
# 全テストの実行
uv run pytest tests/

# 詳細表示付きで実行
uv run pytest tests/ -v
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

1. **ネイティブツール**: `Tepora-app/backend/src/core/tools/native.py` にツールクラスを作成します。
   - `tools/base.py` で定義された `BaseTool` を継承
2. **MCPツール**: 外部MCPサーバーを `config/mcp_tools_config.json` で設定
   - `McpToolProvider` の実装は `tools/mcp.py` を参照
3. `Tepora-app/backend/src/core/tool_manager.py` にツールを登録します。
4. 必要であれば、`config.yml` の `agent_profiles` を更新して新しいツールを許可します。

**ツールディレクトリ構造:**
```
src/core/tools/
├── __init__.py     # ツールのエクスポート
├── base.py         # BaseTool抽象クラス
├── native.py       # 組み込みPythonツール (例: Google検索)
└── mcp.py          # MCPツールプロバイダ (McpToolProvider)
```

### エージェントの挙動変更
- **プロンプトエンジニアリング**: `Tepora-app/backend/src/core/config/prompts.py` 内のシステムプロンプトを編集します。
- **グラフロジック**: `Tepora-app/backend/src/core/graph/` 内のステートマシンを変更します。
