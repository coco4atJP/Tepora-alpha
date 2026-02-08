# Tepora Project - アーキテクチャ概要 (Rust版)

**バージョン**: 4.5
**最終更新日**: 2026-05-20
**対象**: Rustバックエンド (`Tepora-app/backend-rs`) v4.5以降

---

## 1. 概要

Tepora は **ローカルファースト** を前提としたデスクトップAIエージェントです。  
フロントエンドは Tauri + React、バックエンドは Rust (Axum/Tokio) で構成され、高度なエピソード記憶システム (EM-LLM) と自律エージェント基盤 (LangGraph) を搭載しています。

---

## 2. 技術スタック

- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS v4
- **Desktop**: Tauri v2
- **Backend**: Rust 2021, Axum, Tokio
- **Logic**: LangGraph (Rust Port), A2A Protocol (Agent-to-Agent)
- **Storage**: SQLite (sqlx + WAL pool), Qdrant (Vector DB), ローカルファイル
- **ML Inference**: Llama.cpp (GGUF), Candle (Embeddings)
- **Tooling**: MCP (rmcp client)

---

## 3. ディレクトリ構成

```
Tepora_Project/
├── Tepora-app/
│   ├── backend-rs/          # Rust backend
│   │   ├── src/
│   │   │   ├── api.rs           # REST API Routes
│   │   │   ├── ws.rs            # WebSocket Handler
│   │   │   ├── main.rs          # Entry Point
│   │   │   ├── config.rs        # Configuration Management
│   │   │   ├── state.rs         # App State (Arc<AppState>)
│   │   │   ├── security.rs      # API Key / CORS
│   │   │   ├── logging.rs       # Tracing Setup
│   │   │   ├── errors.rs        # Error Handling
│   │   │   ├── setup_state.rs   # Setup Wizard State
│   │   │   ├── history.rs       # SQLite Chat History
│   │   │   ├── models.rs        # Model Management Logic
│   │   │   ├── llama.rs         # Llama.cpp Integration
│   │   │   ├── tooling.rs       # Tool Execution
│   │   │   ├── search.rs        # Web Search Logic
│   │   │   ├── vector_math.rs   # Vector Utilities
│   │   │   ├── mcp.rs           # MCP Core Logic
│   │   │   ├── mcp_registry.rs  # MCP Registry Client
│   │   │   ├── mcp_installer.rs # MCP Installation Logic
│   │   │   ├── rag/             # RAG Engine & Context Builder
│   │   │   ├── memory/          # Vector Memory (Qdrant)
│   │   │   ├── graph/           # LangGraph Implementation (Agent Control)
│   │   │   ├── a2a/             # Agent-to-Agent Protocol
│   │   │   ├── context/         # Context Window Management
│   │   │   └── em_llm/          # Episodic Memory (ICLR 2025)
│   │   └── Cargo.toml
│   ├── frontend/            # React UI
│   └── scripts/             # sidecar/dev helper scripts
├── docs/
│   ├── architecture/        # Current Architecture Docs
│   └── legacy/              # Archived Python Docs
└── Taskfile.yml
```

---

## 4. 実行モデル

- Rustバックエンドは **ローカルで動作**し、動的ポートを割り当てます。
- 起動時に `TEPORA_PORT=xxxx` を標準出力へ通知します。
- フロントエンドは環境変数 (`VITE_API_PORT`) またはデフォルトポート (8000) でAPIへ接続します。

---

## 5. 設定と永続化

### 5.1 設定ファイル

- `config.yml` は **ユーザーデータディレクトリ**に保存されます。
- `secrets.yaml` (APIキー等) と結合して読み込みます。

### 5.2 ユーザーデータ保存先

- Windows: `%LOCALAPPDATA%/Tepora`
- macOS: `~/Library/Application Support/Tepora`
- Linux: `$XDG_DATA_HOME/tepora` または `~/.local/share/tepora`

### 5.3 主要データストア

- `tepora_core.db` (SQLite): セッション・チャット履歴
- `qdrant_storage/` (Qdrant): ベクトルデータベース (RAG/Memory)
- `models.json`: モデル管理メタデータ
- `logs/`: システムログ

---

## 6. API

### 6.1 REST Endpoints

- **System**:
    - `/health` : 健康確認
    - `/api/status` : システム状態・バージョン
    - `/api/shutdown` : 安全なシャットダウン
    - `/api/logs` : ログファイル一覧・閲覧
- **Configuration**:
    - `/api/config` : 設定取得・更新
- **Session Management**:
    - `/api/sessions` : セッション一覧・作成
    - `/api/sessions/:id` : セッション詳細・メッセージ取得
- **Agents & Tools**:
    - `/api/custom-agents` : カスタムエージェント管理
    - `/api/tools` : 利用可能ツール一覧 (Native + MCP)
- **Setup Wizard**:
    - `/api/setup/*` : 初期設定、モデルダウンロード、環境チェック
- **MCP (Model Context Protocol)**:
    - `/api/mcp/status` : サーバー状態
    - `/api/mcp/config` : 構成管理
    - `/api/mcp/store` : レジストリ検索
    - `/api/mcp/install/*` : サーバーインストールフロー

### 6.2 WebSocket

- `/ws` : チャットストリーミング、エージェント状態通知、ツール実行ログ配信

---

## 7. MCP (Tooling)

- MCPサーバ設定は `config.yml` (または `mcp_config.json`) で管理されます。
- `mcp_registry.rs` が公式/コミュニティレジストリからの検索を担当します。
- `mcp_installer.rs` が `npm` / `pip` 等を用いたインストールと環境変数設定を自動化します。

---

## 8. モデル管理

- Hugging Face からの直接ダウンロード (GGUF形式) に対応。
- `setup_state.rs` がダウンロード進捗と整合性チェック (SHA256) を管理。
- 役割 (Role) ベースのモデル割り当て:
    - `character`: 主人格モデル
    - `embedding`: RAG/Memory用埋め込みモデル
    - `professional`: 特定タスク用専門モデル

---

## 9. 高度なアーキテクチャ (v4.5+)

### 9.1 Episodic Memory (EM-LLM)
- `em_llm/` モジュールにて ICLR 2025 論文に基づく「無限コンテキスト」を実現するエピソード記憶を実装。
- 驚き (Surprise) 指標に基づくイベント分割と、長期記憶への統合を行います。

### 9.2 Agent Graph & A2A
- `graph/` モジュールは Rust 版 LangGraph 実装を提供し、複雑なエージェントワークフローを状態マシンとして定義します。
- `a2a/` プロトコルにより、複数のエージェント（人格）間の対話と協調動作を標準化しています。

### 9.3 RAG & Vector Memory
- `rag/` エンジンと Qdrant (`memory/`) を統合し、ローカルドキュメントや会話履歴からの意味的検索を実現しています。

---

## 10. 開発・ビルド

### 10.1 開発起動

```bash
task dev  # Backend + Frontend (Hot Reload)
```

### 10.2 サイドカー生成

```bash
task build-sidecar
```

### 10.3 品質ゲート

```bash
task quality  # Lint, Test, Format
```

---

## 11. レガシー資料

Python/LangChain時代の資料は `docs/legacy/` にアーカイブされています。
