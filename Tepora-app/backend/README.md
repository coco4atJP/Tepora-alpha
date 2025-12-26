# Tepora Backend

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Tepora Backend (English)

Local-first personal AI agent backend powered by LangGraph and EM-LLM.

## Overview
This is the core logic of the Tepora system. It handles the AI agent's thought process, memory management, tool execution, and communication with the frontend via WebSocket. It is designed with a modular architecture to ensure scalability and maintainability.

## Directory Structure
```
backend/
├── server.py                   # Main entry point (Delegates to tepora_server)
├── config.yml                  # System configuration file
├── pyproject.toml              # Project settings and dependencies
├── models/                     # Store GGUF models here
└── src/
    ├── tepora_server/          # Web Server & API Layer (FastAPI)
    └── core/                   # Business Logic Layer
        ├── app/                # Application Management
        ├── graph/              # LangGraph State Machine
        ├── em_llm/             # Episodic Memory System
        ├── llm_manager.py      # LLM Process Manager
        ├── tool_manager.py     # Tool Execution Manager
        └── ...
```

## Installation

### Prerequisites
- Python 3.10+
- `uv` package manager (recommended)
- GPU drivers (CUDA) or Metal (macOS) for hardware acceleration

### Setup Steps

1. **Install uv** (if not already installed)
   ```bash
   # Windows (PowerShell)
   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

   # Non-Windows
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **Install Dependencies**
   Navigate to the backend directory and sync dependencies.
   ```bash
   cd Tepora-app/backend
   uv sync
   ```
   *Note: If you encounter issues with `llama-cpp-python` installation, you may need to set environment variables for your hardware (e.g., `CMAKE_ARGS="-DGGML_CUDA=on"` for NVIDIA GPUs).*

3. **Prepare Models**
   Download the required GGUF models and place them in `Tepora-app/backend/models/`.
   Check `config.yml` for the expected filenames.

## Usage

### Running the Server
To start the backend server independently (useful for backend development):

```bash
uv run server.py
```
The server will start at `http://localhost:8000`.

### API Documentation
Once the server is running, you can access the auto-generated API docs at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## Testing

We use `pytest` for testing.

```bash
# Run all tests
uv run pytest tests/ -v

# Run specific test file
uv run pytest tests/test_graph.py -v
```

## Key Modules

- **`src.core.graph`**: Defines the agent's behavior using LangGraph. It manages the state transitions between conversation, thinking (ReAct), and tool execution.
- **`src.core.em_llm`**: Implements the Episodic Memory system. It segments conversations based on "surprise" (logprobs) and stores them in ChromaDB.
- **`src.core.llm_manager`**: Manages multiple `llama.cpp` server processes. It dynamically loads/unloads models to optimize resource usage.
- **`src.core.tool_manager`**: Handles tool execution. It supports both native Python tools and external MCP (Model Context Protocol) servers.

---

<div id="japanese"></div>

# Tepora Backend (日本語)

LangGraphとEM-LLMを搭載した、ローカルファーストなパーソナルAIエージェントのバックエンドシステムです。

## 概要
Teporaシステムの頭脳部分にあたります。AIエージェントの思考プロセス、記憶管理、ツール実行、およびWebSocketを通じたフロントエンドとの通信を担います。拡張性と保守性を重視したモジュラーアーキテクチャで設計されています。

## ディレクトリ構造
```
backend/
├── server.py                   # エントリーポイント (tepora_serverに処理を委譲)
├── config.yml                  # システム設定ファイル
├── pyproject.toml              # プロジェクト設定・依存関係
├── models/                     # GGUFモデル格納場所
└── src/
    ├── tepora_server/          # Webサーバー & API層 (FastAPI)
    └── core/                   # ビジネスロジック層
        ├── app/                # アプリケーション管理
        ├── graph/              # LangGraph ステートマシン
        ├── em_llm/             # エピソード記憶システム
        ├── llm_manager.py      # LLMプロセス管理
        ├── tool_manager.py     # ツール実行管理
        └── ...
```

## インストール

### 前提条件
- Python 3.10以上
- `uv` パッケージマネージャ（推奨）
- ハードウェアアクセラレーション用のGPUドライバ (CUDA) または Metal (macOS)

### セットアップ手順

1. **uvのインストール** (未インストールの場合)
   ```bash
   # Windows (PowerShell)
   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

   # その他のOS
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

2. **依存関係のインストール**
   バックエンドディレクトリに移動して同期します。
   ```bash
   cd Tepora-app/backend
   uv sync
   ```
   *注意: `llama-cpp-python` のインストールで問題が発生する場合、ハードウェアに合わせて環境変数を設定する必要があるかもしれません（例: NVIDIA GPUの場合は `CMAKE_ARGS="-DGGML_CUDA=on"`）。*

3. **モデルの準備**
   必要なGGUFモデルをダウンロードし、`Tepora-app/backend/models/` に配置してください。
   期待されるファイル名は `config.yml` を確認してください。

## 使い方

### サーバーの起動
バックエンドサーバーを単独で起動する場合（バックエンド開発時に便利です）：

```bash
uv run server.py
```
サーバーは `http://localhost:8000` で起動します。

### APIドキュメント
サーバー起動後、以下のURLで自動生成されたAPIドキュメントにアクセスできます：
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## テスト

テストには `pytest` を使用しています。

```bash
# 全テストの実行
uv run pytest tests/ -v

# 特定のファイルのテスト実行
uv run pytest tests/test_graph.py -v
```

## 主要モジュール解説

- **`src.core.graph`**: LangGraphを使用してエージェントの振る舞いを定義します。会話、思考（ReAct）、ツール実行の間の状態遷移を管理します。
- **`src.core.em_llm`**: エピソード記憶システムを実装しています。「驚き（Logprobs）」に基づいて会話をセグメント化し、ChromaDBに保存します。
- **`src.core.llm_manager`**: 複数の `llama.cpp` サーバープロセスを管理します。リソース使用量を最適化するために、モデルを動的にロード/アンロードします。
- **`src.core.tool_manager`**: ツール実行を処理します。Pythonで書かれたネイティブツールと、外部のMCP (Model Context Protocol) サーバーの両方をサポートしています。
