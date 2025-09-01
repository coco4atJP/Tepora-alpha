
![Tepora log](https://github.com/coco4atJP/tepora-alpha/blob/main/Tepora_logo.png)

# Tepora – Multi‑AI Agent System (Alpha v1.1)

Tepora is a modular framework designed to build a sophisticated, conversational multi‑agent AI system. The project
leverages local LLMs, dynamic resource management, and an extensible tool ecosystem to create powerful, autonomous
agents.

---

## ✨ Core Features

- **Multi‑Agent Architecture** – Two‑agent design:
  - **Character Agent (`Gemma‑3N`)** – Acts as a persona that converses with the user. In agent mode it
interprets user requests, creates a structured JSON “order”, and reports the final outcome back to the user.
  - **Executor Agent (`Jan‑nano`)** – A professional, practical agent that executes orders using a ReAct (reason
+ act) loop.
- **Dynamic LLM Management** – `LLMManager` dynamically loads/unloads GGUF models to VRAM or RAM, enabling the
use of multiple powerful models even on consumer‑grade GPUs or CPUs.
- **Extensible Tool System** – `ToolManager` integrates:
  - **Native Tools** – Python‑based tools such as `GoogleCustomSearchTool`.
  - **MCP (Multi‑Server Client Protocol) Tools** – A custom protocol that lets the agent communicate with tools
running in separate processes, enabling language‑agnostic tool development.
- **Stateful Graph‑Based Execution** – Agent logic is defined as a state graph on top of LangGraph, enabling
complex conditional flows for a variety of user commands.
- **Multiple Interaction Modes**:
  - **Direct Chat** – Simple, straightforward conversation.
  - **Search Mode (`/search`)** – A dedicated flow for web search and summarisation.
  - **Agent Mode (`/agentmode`)** – Runs a full multi‑agent ReAct loop for complex tasks.
- **Configuration‑Driven** – Prompts, model parameters, API keys, and tool settings are centrally configured.

---

## 🏗️ Architecture Overview

The application follows a state‑driven, graph‑based execution model.

1. **`main.py`** – Entry point. Initializes `LLMManager`, `ToolManager`, and the `AgentCore` graph. Then enters a
CLI loop that accepts user input.
2. **`agent_core/graph.py`** – Core agent logic using LangGraph.
   - **Routing** – `route_by_command` directs user input to one of three main branches (`direct_answer`,
`search`, `agent_mode`).
   - **Agent‑Mode Flow**:
     1. `generate_order_node` – Character agent (Gemma) creates a JSON plan.
     2. `agent_reasoning_node` – Executor agent (Jan‑nano) starts a ReAct loop to execute the plan using tools.
     3. `tool_node` – The chosen tool is executed via `ToolManager`.
     4. `synthesize_final_response_node` – Once the ReAct loop finishes, a technical report is transformed into a
user‑friendly response.
3. **`agent_core/llm_manager.py`** – Manages the LLM lifecycle. Models are loaded into GPU VRAM or CPU RAM only
when needed, and unloaded afterward to free resources, enabling the use of different models for different tasks.
4. **`agent_core/tool_manager.py`** – Unified interface for all tools. Detects and manages both native Python
tools and external MCP‑connected tools, handling both synchronous and asynchronous execution.

---

## 🚀 Getting Started

### Prerequisites

- **Python ≥ 3.10** (Python 3.12 was used for development)
- CUDA‑compatible NVIDIA GPU or ROCm‑compatible AMD GPU for faster inference. CPU‑only mode is available but
slower.
- **Node.js** – required for running many MCP servers.
- **Git**

### Minimum System Specs

- ≥ 7.5 GB free disk space
- ≥ 16 GB RAM or ≥ 6 GB VRAM – RAM or VRAM is required for the MCP servers and loaded LLMs. Reducing
`llama.cpp`’s `n_ctx` can lower RAM usage but may affect performance. <sub>See notes above.</sub>
- A compute environment supported by `Llama‑cpp‑python`.

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/username/repository.git AIagent_Project_1
   cd AIagent_Project_1
   ```

2. **Install dependencies** (virtual environment is recommended):
   ```bash
   python -m venv venv
   source venv/bin/activate        # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. **Set up environment variables:**
   Copy the example file and create a `.env` in the project root:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to add your API keys:
   ```dotenv
   # .env
   GOOGLE_CUSTOM_SEARCH_API_KEY="your_google_api_key"
   GOOGLE_CUSTOM_SEARCH_ENGINE_ID="your_google_cx_id"
   ```

### Running the Agent

Start the agent from the project root:
```bash
python main.py
```

---

## 🤖 Usage

Once the agent is running, interact via the terminal.

- **Direct chat:**
  ```
  YOU: Hello, how are you?
  ```

- **Search mode:**
  ```
  YOU: /search What is LangGraph?
  ```

- **Agent mode (for complex tasks):**
  ```
  YOU: /agentmode Find out the current price of Bitcoin and find the latest news.
  ```

- **Exit the application:**
  ```
  YOU: exit
  ```

---

## 🧩 Core Components

- **`main.py`** – Entry point, initialization, and main conversation loop.
- **`agent_core/graph.py`** – Defines the LangGraph execution graph, nodes, and edges. Contains all core logic
for the agent modes.
- **`agent_core/state.py`** – Defines `AgentState` TypedDict for state passed between graph nodes.
- **`agent_core/llm_manager.py`** – Handles dynamic loading/unloading of GGUF models to VRAM or RAM.
- **`agent_core/tool_manager.py`** – Detects, manages, and provides an execution interface for all tools (native
and MCP).
- **`agent_core/config.py`** – Centralised configuration for model paths, generation parameters, prompts,
personas, and API keys.

---

## 🛠️ Tool System

Agents can use two types of tools.

### Native Tools

These are Python classes inheriting from `langchain_core.tools.BaseTool`, e.g., `GoogleCustomSearchTool`. They are
loaded directly by `ToolManager`.

### MCP (Multi‑Server Client Protocol) Tools

Allows agents to use tools running in separate processes, language‑agnostic.

1. **Setup** – Define tool servers in `mcp_tools_config.json`. Example (Claude‑Desktop style):
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

2. **Detection** – `ToolManager` launches the processes defined in the config, connects via stdio, and discovers
the tools they provide using the MCP protocol.

3. **Naming** – MCP tools are automatically named `server_name_tool_name` to avoid conflicts.

---

## ⚙️ Configuration

- **`.env`** – Stores secrets (API keys, etc.). Not committed to version control.
- **`agent_core/config.py`** – Main config file.
  - `MODELS_GGUF` – Model paths and parameters. Generation defaults include temperature, Top.P, Top.K, and
max_tokens.
  - `PERSONA_PROMPTS` – Different character personas for the character agent.By default, two types are provided: `souha_yoi` (奏羽 茗伊) and `bunny_girl` (marina). Both are written in Japanese, so please change them as needed.
  - `ACTIVE_PERSONA` – Currently selected persona.
  - `BASE_SYSTEM_PROMPTS` – Core prompts for summarisation, ReAct reasoning, etc.
- **`mcp_tools_config.json`** – Configures external tool servers.

---

## 🗺️ Roadmap

- [ ] Implement a more robust error‑recovery mechanism within the ReAct loop.
- [ ] Create a simple GUI.
- [ ] Expand the library of native and MCP tools.
- [ ] Add persistent memory/database integration to store long‑term conversation history.

---

## 📜 License

This project is licensed under the MIT License. See the `LICENSE` file for details.

---
---

# Tepora - マルチAIエージェントシステム (アルファ版 v1.1)

洗練されたマルチエージェント対話型AIシステムを構築するためのモジュール式フレームワークです。このプロジェクトでは、ローカルLLM、動的リソース管理、拡張可能なツールシステムを活用し、強力で自律的なエージェントを構築します。

## ✨ 主な機能

* **マルチエージェントアーキテクチャ**: 2エージェント設計を採用:
* **キャラクターエージェント (`Gemma-3N`)**: キャラクターとして、ユーザーと対話をします。エージェントモードでは、ユーザーリクエストを解釈し、構造化されたJSON形式の「オーダー」を作成し、最終的なユーザーへの報告を行います。
* **エグゼキューターエージェント (`Jan-nano`)**: ReAct (推論+行動) ループを用いてオーダーを実行する、プロフェッショナルで実用的なエージェント。
* **動的LLM管理**: `LLMManager` は、GGUFモデルをVRAMまたはRAMに動的にロード/アンロードすることで、コンシューマーグレードのGPUもしくはCPU上で複数の強力なモデルを使用できるようにします。
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
    1.  `generate_order_node`: キャラクターエージェント (Gemma) が JSON プランを作成します。
    2.  `agent_reasoning_node`: Executor Agent (Jan-nano) は、ツールを使用して計画を実行する ReAct ループを開始します。
    3.  `tool_node`: エージェントが `ToolManager` を介して選択したツールを実行します。
    4.  `synthesize_final_response_node`: ReAct ループが完了すると、最終的な技術レポートがユーザーフレンドリーなレスポンスに変換されます。
3. **`agent_core/llm_manager.py`**: LLM のライフサイクルを管理します。必要な場合にのみモデルを GPU VRAM もしくは CPU RAM にロードし、その後アンロードしてリソースを解放することで、異なるタスクに異なるモデルを使用できるようにします。
4. **`agent_core/tool_manager.py`**: すべてのツールのための統一インターフェースです。ネイティブ Python ツールと MCP 経由で接続された外部ツールを検出および管理します。同期および非同期の両方のツール実行を処理します。

## 🚀 はじめに

### 前提条件

* `Python 3.10` 以上 <sub> 開発ではpython3.12が使用されました。</sub>
* モデル高速化のために、CUDA 対応の NVIDIA GPU または ROCm 対応の AMD GPU。CPU のみのモードも利用可能ですが、GPUと比較すると遅くなります。
* `Node.js` 多くのMCPサーバーを使用するために必要です。
* `Git`

### 最低の構成スペック
* 7.5GB以上のデスク空き容量
* 16GB以上のRAMもしくは6GB以上のVRAM <sub> 展開されるMCPサーバー分のRAMとロードされるSLMのためのRAM or VRAMが必須です。`llama.cpp`の`n_ctx`を削減することでロードされるSLMのRAMは減らせますが、動作に支障をきたす可能性があります。 </sub>
* `Llama-cpp-python` が対応している計算環境。

### インストール

1. **リポジトリのクローンを作成します:**
```bash
git clone https://github.com/username/repository.git AIagent_Project_1
cd AIagent_Project_1
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
> YOU: `こんにちは、お元気ですか？`

* **検索モード:**
> YOU: `/search LangGraph とは？`

* **エージェントモード (複雑なタスク向け):**
> YOU: `/agentmode ビットコインの現在の価格を調べ、最新ニュースを見つけます。`

* **アプリケーションを終了する:**
> YOu: `exit`

## 🧩 コアコンポーネント

* **`main.py`**: アプリケーションのエントリポイント、初期化、およびメインの会話ループ。
* **`agent_core/graph.py`**: `LangGraph` 実行グラフ、ノード、エッジを定義します。すべてのエージェントモードのコアロジックが含まれています。
* **`agent_core/state.py`**: グラフ内のノード間で渡される状態を表す `AgentState` TypedDict を定義します。
* **`agent_core/llm_manager.py`**: GGUF モデルの動的なロード/アンロードを処理して VRAM もしくは RAM を管理します。
* **`agent_core/tool_manager.py`**: すべてのツール (ネイティブおよび MCP) の統合実行インターフェースを検出、管理、および提供します。
* **`agent_core/config.py`**: モデルパス、生成パラメータ、プロンプト、ペルソナ、API キーの一元的な構成。

## 🛠️ ツールシステム

エージェントは2種類のツールを使用できます。

### ネイティブツール

これらは、`tool_manager.py` の `GoogleCustomSearchTool` のように、`langchain_core.tools.BaseTool` から継承された Python クラスです。これらは `ToolManager` によって直接ロードされます。

### MCP (Multi-Server Client Protocol) ツール

このシステムにより、エージェントは別プロセスで実行されるツールを使用できます。ツールは任意の言語で記述できます。

1. **設定**: `mcp_tools_config.json` でツールサーバーを定義します。サーバー定義はClaudeDesktop方式で可能です。
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
* `MODELS_GGUF`: モデルパス、モデルパラメータを定義しています。生成パラメータは temperature Top.P Top.K max_tokens がデフォルト定義です。
* `PERSONA_PROMPTS`: キャラクターエージェントの異なるキャラクターペルソナを定義します。デフォルトでは`souha_yoi`(奏羽 茗伊) `bunny_girl`(マリナ)の2種類が用意されています。どちらも日本語で記述されているので、必要に応じて書き換えてください。
* `ACTIVE_PERSONA`: 現在のペルソナを選択します。
* `BASE_SYSTEM_PROMPTS`: 要約、ReAct 推論などのタスクにおけるコア機能プロンプトを定義します。
* **`mcp_tools_config.json`**: 外部ツールサーバーを設定します。

## 🗺️ ロードマップ

* [ ] ReActループ内により堅牢なエラー回復メカニズムを実装する。
* [ ] シンプルGUIの作成
* [ ] ネイティブツールとMCPツールのライブラリを拡張する。
* [ ] 長期的な会話履歴を保存するための永続メモリ/データベース統合を追加する。

## 📜 ライセンス

このプロジェクトはMITライセンスに基づきライセンスされています。詳細は`LICENSE`ファイルをご覧ください。



