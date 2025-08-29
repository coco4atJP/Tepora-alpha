# AI Agent Core Framework (Alpha v1.0)

A modular framework for building sophisticated, multi-agent conversational AI systems. This project leverages local LLMs, dynamic resource management, and an extensible tool system to create powerful and autonomous agents.

## ✨ Key Features

*   **Multi-Agent Architecture**: Utilizes a two-agent design:
    *   **Planner Agent (`Gemma-3N`)**: A "character" agent that interprets user requests and creates a structured JSON "Order".
    *   **Executor Agent (`Jan-nano`)**: A professional, no-nonsense agent that executes the order using a ReAct (Reasoning+Acting) loop.
*   **Dynamic LLM Management**: The `LLMManager` dynamically loads and unloads Hugging Face models into VRAM, allowing the use of multiple powerful models on consumer-grade GPUs.
*   **Extensible Tool System**: The `ToolManager` integrates:
    *   **Native Tools**: Python-based tools like the `GoogleCustomSearchTool`.
    *   **MCP (Multi-Server Client Protocol) Tools**: A custom protocol to communicate with tools running as separate processes, allowing for language-agnostic tool development.
*   **Stateful, Graph-Based Execution**: Built on `LangGraph`, the agent's logic is defined as a state graph, enabling complex, conditional flows for different user commands.
*   **Multiple Interaction Modes**:
    *   **Direct Chat**: For simple, direct conversations.
    *   **Search Mode (`/search`)**: A dedicated flow for web searches and summarization.
    *   **Agent Mode (`/agentmode`)**: Engages the full multi-agent ReAct loop for complex tasks.
*   **Configuration-Driven**: Centralized configuration for prompts, model parameters, API keys, and tool settings.

## 🏗️ Architecture Overview

The application follows a state-driven, graph-based execution model.

1.  **`main.py`**: The entry point. It initializes the `LLMManager`, `ToolManager`, and the `AgentCore` graph. It then enters a command-line loop to accept user input.
2.  **`agent_core/graph.py`**: The heart of the agent. It uses `LangGraph` to define the execution flow.
    *   **Routing**: The `route_by_command` function first directs the user input to one of three main branches: `direct_answer`, `search`, or `agent_mode`.
    *   **Agent Mode Flow**:
        1.  `generate_order_node`: The Planner Agent (Gemma) creates a JSON plan.
        2.  `agent_reasoning_node`: The Executor Agent (Jan-nano) begins a ReAct loop, using tools to execute the plan.
        3.  `tool_node`: Executes the tool chosen by the agent via the `ToolManager`.
        4.  `synthesize_final_response_node`: Once the ReAct loop is complete, the final technical report is translated into a user-friendly response.
3.  **`agent_core/llm_manager.py`**: Manages the lifecycle of LLMs. It loads a model into GPU VRAM only when it's needed and unloads it afterward to free up resources, enabling the use of different models for different tasks.
4.  **`agent_core/tool_manager.py`**: A unified interface for all tools. It discovers and manages native Python tools and external tools connected via MCP. It handles both synchronous and asynchronous tool execution.

## 🚀 Getting Started

### Prerequisites

*   Python 3.10+
*   An NVIDIA GPU with CUDA or an AMD GPU with ROCm for model acceleration. A CPU-only mode is available but will be very slow.
*   Git

### Installation

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd AIagent_Project 1
    ```

2.  **Install dependencies:**
    It is recommended to use a virtual environment.
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows, use `venv\Scripts\activate`
    pip install -r requirements.txt
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the project root by copying the example file:
    ```bash
    cp .env.example .env
    ```
    Now, edit the `.env` file and add your API keys:
    ```
    # .env
    GOOGLE_CUSTOM_SEARCH_API_KEY="your_google_api_key"
    GOOGLE_CUSTOM_SEARCH_ENGINE_ID="your_google_cx_id"
    ```

### Running the Agent

Launch the agent from the project root directory:
```bash
python main.py
```

## 🤖 Usage

Once the agent is running, you can interact with it in the terminal.

*   **Direct Chat:**
    > You: `Hello, how are you?`

*   **Search Mode:**
    > You: `/search What is LangGraph?`

*   **Agent Mode (for complex tasks):**
    > You: `/agentmode Research the current price of Bitcoin and find the latest news about it.`

*   **Exit the application:**
    > You: `exit`

## 🧩 Core Components

*   **`main.py`**: Application entry point, initialization, and main conversation loop.
*   **`agent_core/graph.py`**: Defines the `LangGraph` execution graph, nodes, and edges. Contains the core logic for all agent modes.
*   **`agent_core/state.py`**: Defines the `AgentState` TypedDict, which represents the state passed between nodes in the graph.
*   **`agent_core/llm_manager.py`**: Handles dynamic loading/unloading of Hugging Face models to manage VRAM.
*   **`agent_core/tool_manager.py`**: Discovers, manages, and provides a unified execution interface for all tools (native and MCP).
*   **`agent_core/config.py`**: Centralized configuration for model IDs, generation parameters, prompts, personas, and API keys.

## 🛠️ Tool System

The agent can use two types of tools.

### Native Tools

These are Python classes that inherit from `langchain_core.tools.BaseTool`, like the `GoogleCustomSearchTool` in `tool_manager.py`. They are loaded directly by the `ToolManager`.

### MCP (Multi-Server Client Protocol) Tools

This system allows the agent to use tools running in separate processes, which can be written in any language.

1.  **Configuration**: Define your tool servers in `mcp_tools_config.json`.
    ```json
    {
      "mcpServers": {
        "my_tool_server": {
          "command": "python",
          "args": ["-m", "path.to.your.tool_server"],
          "env": {}
        }
      }
    }
    ```
2.  **Discovery**: The `ToolManager` will start the process defined in the config, connect to it via `stdio`, and discover the tools it provides using the MCP protocol.
3.  **Naming**: MCP tools are automatically named `server_name_tool_name` to avoid conflicts.

## ⚙️ Configuration

*   **`.env`**: Stores secrets like API keys. Not committed to version control.
*   **`agent_core/config.py`**: The main configuration file.
    *   `GEMMA_3N_MODEL_ID`, `JAN_NANO_MODEL_ID`: Set the Hugging Face model identifiers.
    *   `USE_..._QUANTIZATION`: Enable/disable 4-bit quantization for each model.
    *   `..._PARAMS`: Configure generation parameters (temperature, top_p, etc.) for each model.
    *   `PERSONA_PROMPTS`: Define different character personas for the agent.
    *   `ACTIVE_PERSONA`: Select the current persona.
    *   `BASE_SYSTEM_PROMPTS`: Define the core functional prompts for tasks like summarization, ReAct reasoning, etc.
*   **`mcp_tools_config.json`**: Configures external tool servers.

## 🗺️ Roadmap

*   [ ] Add support for GGUF models for more efficient CPU/GPU execution.
*   [ ] Implement a more robust error recovery mechanism within the ReAct loop.
*   [ ] Develop a simple web-based UI (e.g., using Gradio or Streamlit).
*   [ ] Expand the library of native and MCP tools.
*   [ ] Add persistent memory/database integration for long-term conversation history.

## 📜 License

This project is licensed under the MIT License. See the `LICENSE` file for details.


# AIエージェントコアフレームワーク (アルファ版 v1.0)

洗練されたマルチエージェント対話型AIシステムを構築するためのモジュール式フレームワークです。このプロジェクトでは、ローカルLLM、動的リソース管理、拡張可能なツールシステムを活用し、強力で自律的なエージェントを構築します。

## ✨ 主な機能

* **マルチエージェントアーキテクチャ**: 2エージェント設計を採用:
* **プランナーエージェント (`Gemma-3N`)**: ユーザーリクエストを解釈し、構造化されたJSON形式の「オーダー」を作成する「キャラクター」エージェント。
* **エグゼキューターエージェント (`Jan-nano`)**: ReAct (推論+行動) ループを用いてオーダーを実行する、プロフェッショナルで実用的なエージェント。
* **動的LLM管理**: `LLMManager` は、Hugging FaceモデルをVRAMに動的にロード/アンロードすることで、コンシューマーグレードのGPU上で複数の強力なモデルを使用できるようにします。
* **拡張可能なツールシステム**: `ToolManager` は以下を統合します。
* **ネイティブツール**: `GoogleCustomSearchTool` などの Python ベースのツール。
* **MCP (Multi-Server Client Protocol) ツール**: 別プロセスとして実行されているツールと通信するためのカスタムプロトコル。言語に依存しないツール開発を可能にします。
* **ステートフルなグラフベースの実行**: `LangGraph` を基盤とするエージェントのロジックは状態グラフとして定義され、さまざまなユーザーコマンドに対して複雑な条件付きフローを実現します。
* **複数のインタラクションモード**:
* **ダイレクトチャット**: シンプルで直接的な会話が可能です。
* **検索モード (`/search`)**: Web 検索と要約専用のフローです。
* **エージェントモード (`/agentmode`)**: 複雑なタスクのために、完全なマルチエージェント ReAct ループを実行します。
* **構成駆動型**: プロンプト、モデルパラメータ、API キー、ツール設定を一元的に構成します。

## 🏗️ アーキテクチャの概要

このアプリケーションは、状態駆動型のグラフベースの実行モデルに従います。

1. **`main.py`**: エントリポイント。`LLMManager`、`ToolManager`、`AgentCore` グラフを初期化します。その後、コマンドラインループに入り、ユーザー入力を受け付けます。
2. **`agent_core/graph.py`**: エージェントの中核部分。`LangGraph` を使用して実行フローを定義します。
* **ルーティング**: `route_by_command` 関数は、まずユーザー入力を 3 つの主要なブランチ (`direct_answer`、`search`、`agent_mode`) のいずれかに誘導します。
* **エージェントモードフロー**:
1. `generate_order_node`: プランナーエージェント (Gemma) が JSON プランを作成します。
2. `agent_reasoning_node`: Executor Agent (Jan-nano) は、ツールを使用して計画を実行する ReAct ループを開始します。
3. `tool_node`: エージェントが `ToolManager` を介して選択したツールを実行します。
4. `synthesize_final_response_node`: ReAct ループが完了すると、最終的な技術レポートがユーザーフレンドリーなレスポンスに変換されます。
3. **`agent_core/llm_manager.py`**: LLM のライフサイクルを管理します。必要な場合にのみモデルを GPU VRAM にロードし、その後アンロードしてリソースを解放することで、異なるタスクに異なるモデルを使用できるようにします。
4. **`agent_core/tool_manager.py`**: すべてのツールのための統一インターフェースです。ネイティブ Python ツールと MCP 経由で接続された外部ツールを検出および管理します。同期および非同期の両方のツール実行を処理します。

## 🚀 はじめに

### 前提条件

* Python 3.10 以上
* モデル高速化のために、CUDA 対応の NVIDIA GPU または ROCm 対応の AMD GPU。CPU のみのモードも利用可能ですが、非常に遅くなります。
* Git

### インストール

1. **リポジトリのクローンを作成します:**
```bash
git clone <リポジトリの URL>
cd AIagent_Project 1
```

2. **依存関係をインストールします:**
仮想環境の使用を推奨します。
```bash
python -m venv venv
source venv/bin/activate # Windows では `venv\Scripts\activate` を使用します
pip install -r requirements.txt
```

3. **環境変数の設定:**
サンプルファイルをコピーして、プロジェクトルートに `.env` ファイルを作成します:
```bash
cp .env.example .env
```
次に、`.env` ファイルを編集して API キーを追加します:
```
# .env
GOOGLE_CUSTOM_SEARCH_API_KEY="your_google_api_key"
GOOGLE_CUSTOM_SEARCH_ENGINE_ID="your_google_cx_id"
```

### エージェントの実行

プロジェクトルートディレクトリからエージェントを起動します:
```bash
python main.py
```

## 🤖使用方法

エージェントが起動したら、ターミナルで操作できます。

* **直接チャット:**
> あなた: 「こんにちは、お元気ですか？」

* **検索モード:**
> あなた: 「/search LangGraph とは？」

* **エージェントモード (複雑なタスク向け):**
> あなた: 「/agentmode ビットコインの現在の価格を調べ、最新ニュースを見つけます。」

* **アプリケーションを終了する:**
> あなた: 「exit」

## 🧩 コアコンポーネント

* **`main.py`**: アプリケーションのエントリポイント、初期化、およびメインの会話ループ。
* **`agent_core/graph.py`**: `LangGraph` 実行グラフ、ノード、エッジを定義します。すべてのエージェントモードのコアロジックが含まれています。
* **`agent_core/state.py`**: グラフ内のノード間で渡される状態を表す `AgentState` TypedDict を定義します。
* **`agent_core/llm_manager.py`**: Hugging Face モデルの動的なロード/アンロードを処理して VRAM を管理します。
* **`agent_core/tool_manager.py`**: すべてのツール (ネイティブおよび MCP) の統合実行インターフェースを検出、管理、および提供します。
* **`agent_core/config.py`**: モデル ID、生成パラメータ、プロンプト、ペルソナ、API キーの一元的な構成。

## 🛠️ ツールシステム

エージェントは2種類のツールを使用できます。

### ネイティブツール

これらは、`tool_manager.py` の `GoogleCustomSearchTool` のように、`langchain_core.tools.BaseTool` から継承された Python クラスです。これらは `ToolManager` によって直接ロードされます。

### MCP (Multi-Server Client Protocol) ツール

このシステムにより、エージェントは別プロセスで実行されるツールを使用できます。ツールは任意の言語で記述できます。

1. **設定**: `mcp_tools_config.json` でツールサーバーを定義します。
```json
{
"mcpServers": {
"my_tool_server": {
"command": "python",
"args": ["-m", "path.to.your.tool_server"],
"env": {}
}
}
}
```
2. **検出**: `ToolManager` は設定で定義されたプロセスを起動し、`stdio` 経由で接続し、MCP プロトコルを使用してそのプロセスが提供するツールを検出します。
3. **命名**: MCP ツールは、競合を避けるため、自動的に `server_name_tool_name` という名前が付けられます。

## ⚙️ 設定

* **`.env`**: API キーなどのシークレットを保存します。バージョン管理にはコミットされません。
* **`agent_core/config.py`**: メインの設定ファイルです。
* `GEMMA_3N_MODEL_ID`, `JAN_NANO_MODEL_ID`: Hugging Face モデルの識別子を設定します。
* `USE_..._QUANTIZATION`: 各モデルの4ビット量子化を有効/無効にします。
* `..._PARAMS`: 各モデルの生成パラメータ（温度、top_p など）を設定します。
* `PERSONA_PROMPTS`: エージェントの異なるキャラクターペルソナを定義します。
* `ACTIVE_PERSONA`: 現在のペルソナを選択します。
* `BASE_SYSTEM_PROMPTS`: 要約、ReAct 推論などのタスクにおけるコア機能プロンプトを定義します。
* **`mcp_tools_config.json`**: 外部ツールサーバーを設定します。

## 🗺️ ロードマップ

* [ ] CPU/GPU 実行の効率化のため、GGUF モデルのサポートを追加します。
* [ ] ReActループ内により堅牢なエラー回復メカニズムを実装する。
* [ ] シンプルなWebベースのUIを開発する（例：GradioまたはStreamlitを使用）。
* [ ] ネイティブツールとMCPツールのライブラリを拡張する。
* [ ] 長期的な会話履歴を保存するための永続メモリ/データベース統合を追加する。

## 📜 ライセンス

このプロジェクトはMITライセンスに基づきライセンスされています。詳細は`LICENSE`ファイルをご覧ください。
