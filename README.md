![log](https://github.com/coco4atJP/tepora-alpha/blob/main/Tepora_logo.png)

# Tepora (Beta v2.0)

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Tepora (English)

> Think, remember, and grow by your side.
> Welcome to Tepora, your personal AI agent.

## 📖 What is Tepora?

Tepora is a special AI agent system that works exclusively for you on your computer. Not someone on the other side of the internet, but right by your side, protecting your important information while supporting your daily chats and complex tasks.

Tepora aims to be more than just a "useful tool."
Just as humans remember surprising events, Tepora has its own memory system, **EM-LLM**, at its heart. It remembers important moments from your conversations as "episodes" and deepens its understanding of you over time, just like a living partner.

## ✨ Key Features

#### 🤝 Two in One! Unique Agents
Inside Tepora, there are two agents with different personalities.
- **Character Agent**: A friendly mood maker who is good at casual daily chats!
- **Professional Agent**: A cool worker who skillfully uses tools to solve specialized tasks such as research and analysis!

By combining their strengths, they can respond to a wide range of requests, from fun chats to slightly difficult tasks.

#### 🧠 EM-LLM System that Remembers "Surprises"
Tepora is amazing because it doesn't just log conversations. Based on ideas from a paper presented at ICLR 2025, it catches "surprises" in conversations and remembers particularly important events as episodes. So, the longer you are together, the deeper it understands you.

#### ⚙️ Good at Thinking According to the Situation!
"Should I answer this normally? Or search? Should I use a tool?"... Such complex thought processes are elegantly managed by a system called `LangGraph`. It understands the intent of your words and always chooses the optimal action.

#### 🔧 Infinite Possibilities with "Tools"!
What Tepora can do expands infinitely by adding "tools," such as web searches and file operations. It supports native tools written in Python as well as MCP tools that link with external programs. Please make it smarter to your liking!

#### 💻 Comfortable Dialogue with Modern Web UI!
We provide a beautiful and easy-to-use Web interface. You can enjoy smooth conversations with a streaming display where you can see Tepora's replies in real time.

## 🚀 Quick Start

Here is a step-by-step guide to get ready to talk to Tepora.

### 1. Requirements
- Python 3.10 or higher
- Node.js 18 or higher
- A powerful CPU or GPU (required to run the GGUF models that serve as Tepora's brain)
- uv (Recommended package manager)
- Rust (for Tauri development)

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora/Tepora-app

# Install backend dependencies
cd backend
uv sync

# Install frontend dependencies
cd ../frontend
npm install
```

### 3. Model Placement
Please place the GGUF model files that will be Tepora's brain in the `Tepora-app/backend/models/` folder. By default, it is waiting for the following models:

- **Character**: unsloth/gemma-3n-E4B-it-GGUF (`gemma-3n-E4B-it-IQ4_XS.gguf`)
- **Professional**: Menlo/Jan-nano-128k-gguf (`jan-nano-128k-iQ4_XS.gguf`)
- **Memory/Embedding**: Google/embeddinggemma-gguf (`embeddinggemma-300M-Q8_0.gguf`)

### 4. Wake Up Tepora (Desktop App)

The recommended way to launch is as a Tauri desktop app.

```bash
# From Tepora-app/frontend
cd frontend
npm run tauri dev
```

This will launch the desktop app with the backend (Sidecar) and frontend integrated.

#### Development Web Mode (Legacy/Dev)
If you want to use it from a web browser for development purposes, you can use the following script.

```bash
# From the project root
scripts/legacy/start_app.bat
```

*Note: The `scripts/` directory at the project root contains legacy scripts. Modern build scripts are located in `Tepora-app/scripts/`.*

Web mode starts at `http://localhost:5173`.
**Note**: Web mode is currently positioned for development and debugging purposes.

## 💬 How to Talk
Tepora is waiting for your words. You can select 3 modes from the Web UI.

| Mode | Tepora's Action |
|:---|:---|
| **💬 CHAT** | Daily conversation with the Character Agent |
| **🔍 SEARCH** | Searches the Web and summarizes the results clearly |
| **🤖 AGENT** | The Professional Agent uses tools to challenge complex tasks |

## 🛠️ For Developers

Tepora's heart consists of beautifully organized modules.

- **`docs/`**: Detailed design documents and plans.
  - [Comprehensive Architecture Specification](docs/architecture/ARCHITECTURE.md)
  - [Design Document V2](docs/architecture/design_document_v2.md)
  - [Developer Guide](docs/guides/developer_guide.md)
- **`Tepora-app/backend/src/tepora_server/`**: Web server and API entry point
- **`Tepora-app/backend/src/core/app/`**: Tepora's core logic and application management
- **`Tepora-app/backend/src/core/graph/`**: Uses LangGraph to build Tepora's thought circuits
- **`Tepora-app/backend/src/core/em_llm/`**: The part that remembers "surprises," essentially Tepora's heart
- **`Tepora-app/backend/src/core/llm_manager.py`**: A commander that smartly switches multiple brains (models)
- **`Tepora-app/backend/src/core/tool_manager.py`**: Entry point for adding new abilities (tools)
- **`Tepora-app/backend/src/core/config/`**: Detailed settings such as model personality and memory quirks
- **`Tepora-app/frontend/`**: Modern Web UI built with React + TypeScript

## 📜 License

Tepora is released under the Apache License 2.0. See `LICENSE` for details.
Each machine learning model follows the license of its respective provider.

---

<div id="japanese"></div>

# Tepora (日本語)

> あなたの隣で、思考し、記憶し、成長する。
> パーソナルAIエージェント、Teporaへようこそ。

## 📖 Teporaちゃんってどんな子？

Teporaは、あなたのパソコンの中であなただけのために働く、特別なAIエージェントシステムです。インターネットの向こう側の誰かではなく、あなたのすぐそばで、大切な情報を守りながら、日々のおしゃべりや複雑なタスクをサポートします。

Teporaが目指すのは、ただの「便利な道具」ではありません。
人間が「あっ！」と驚くような出来事を忘れないように、Teporaも独自の記憶システム**EM-LLM**を心臓部に持っています。あなたとの会話の中で生まれた大切な瞬間を「エピソード」として記憶し、時間をかけてあなたへの理解を深めていく、まるで生きているパートナーなんです。

## ✨ Teporaちゃんのすごいところ

#### 🤝 ふたりでひとつ！個性豊かなエージェント
Teporaの中には、性格の違うふたりのエージェントがいます。
- **キャラクターエージェントちゃん**: 親しみやすく、日常の何気ないおしゃべりが得意なムードメーカー！
- **プロフェッショナルエージェントさん**: ツールを華麗に使いこなし、調査や分析などの専門的なタスクを解決するクールな仕事人！

このふたりが力を合わせることで、楽しいおしゃべりから、ちょっと難しいお願いごとまで、幅広く応えてくれます。

#### 🧠 「びっくり！」を記憶するEM-LLMシステム
ただ会話をログとして覚えるだけじゃないのがTeporaのすごいところ。ICLR 2025で発表された論文のアイデアを元に、会話の中の「驚き」をキャッチして、特に重要だった出来事をエピソードとして記憶します。だから、長く一緒にいればいるほど、あなたのことをもっと深く理解できるようになるんです。

#### ⚙️ 状況に応じて考えるのが得意！
「このお願いは、普通に答える？それとも検索？ツールを使うべき？」…そんな複雑な思考プロセスは、`LangGraph`というシステムで、とってもエレガントに管理されています。あなたの言葉の意図を汲み取って、いつでも最適な行動を選びます。

#### 🔧 「ツール」で可能性は無限大！
Web検索やファイル操作など、Teporaにできることは「ツール」を追加することで無限に広がります。Pythonで書かれたネイティブツールはもちろん、外部のプログラムと連携するMCPツールにも対応。あなた好みに、どんどん賢くしてあげてください！

#### 💻 モダンなWeb UIで快適な対話を！
美しく使いやすいWebインターフェースを提供しています。リアルタイムでTeporaの返信が見えるストリーミング表示で、スムーズな会話を楽しめます。

## 🚀 はじめましてのごあいさつ (Quick Start)

Teporaとお話しするための準備を、ステップバイステップでご案内します。

### 1. 必要なもの
- Python 3.10 以上
- Node.js 18 以上
- パワフルなCPU、またはGPU（Teporaの頭脳になるGGUFモデルを動かすために必要です）
- uv（推奨パッケージマネージャ）
- Rust（Tauri開発用）

### 2. お迎えの準備
```bash
# TeporaのおうちをあなたのPCに作ります
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora/Tepora-app

# バックエンドの依存関係をインストール
cd backend
uv sync

# フロントエンドの依存関係をインストール
cd ../frontend
npm install
```

### 3. モデルの配置
Teporaの頭脳となるGGUFモデルファイルを、`Tepora-app/backend/models/` フォルダの中に置いてあげてください。デフォルトでは、以下のモデルたちを待っています。

- **キャラクター担当**: unsloth/gemma-3n-E4B-it-GGUF (`gemma-3n-E4B-it-IQ4_XS.gguf`)
- **プロフェッショナル担当**: Menlo/Jan-nano-128k-gguf (`jan-nano-128k-iQ4_XS.gguf`)
- **記憶・埋め込み担当**: Google/embeddinggemma-gguf (`embeddinggemma-300M-Q8_0.gguf`)

### 4. Teporaを起こす (Desktop App)

推奨される起動方法は、Tauriデスクトップアプリとしての起動です。

```bash
# Tepora-app/frontend ディレクトリから実行
cd frontend
npm run tauri dev
```

これで、バックエンド（Sidecar）とフロントエンドが統合されたデスクトップアプリが起動します。

#### 開発用 Webモード (Legacy/Dev)
開発目的でWebブラウザから利用したい場合は、以下のスクリプトを使用できます。

```bash
# プロジェクトルートディレクトリで実行
scripts/legacy/start_app.bat
```

*注意: プロジェクトルートの `scripts/` ディレクトリにはレガシースクリプトが含まれています。最新のビルドスクリプトは `Tepora-app/scripts/` にあります。*

Webモードは `http://localhost:5173` で起動します。
**注意**: Webモードは現在、開発およびデバッグ用途として位置づけられています。


## 💬 おはなしのしかた
Teporaは、あなたの言葉を待っています。Web UIから3つのモードを選択できます。

| モード | Teporaの行動 |
|:---|:---|
| **💬 CHAT** | キャラクターエージェントちゃんとの日常会話 |
| **🔍 SEARCH** | Webで検索して、結果を分かりやすくまとめてくれます |
| **🤖 AGENT** | プロさんがツールを駆使して、複雑なタスクに挑戦します |

## 🛠️ もっとTeporaを知りたい開発者さんへ

Teporaの心臓部は、美しく整理されたモジュールで構成されています。

- **`docs/`**: 詳細な設計書や計画書が格納されています。
  - [包括的アーキテクチャ仕様書 (Architecture)](docs/architecture/ARCHITECTURE.md)
  - [設計ドキュメント V2 (Design Doc)](docs/architecture/design_document_v2.md)
  - [開発者ガイド (Developer Guide)](docs/guides/developer_guide.md)
  - [リファクタリング計画 (Refactoring Plan)](docs/planning/refactoring_plan.md)
- **`Tepora-app/backend/src/tepora_server/`**: WebサーバーとAPIのエントリーポイント
- **`Tepora-app/backend/src/core/app/`**: Teporaのコアロジックとアプリケーション管理
- **`Tepora-app/backend/src/core/graph/`**: LangGraphを使って、Teporaの思考回路を組み立てています
- **`Tepora-app/backend/src/core/em_llm/`**: 「驚き」を記憶する、Teporaの心とも言える部分です
- **`Tepora-app/backend/src/core/llm_manager.py`**: 複数の頭脳（モデル）を賢く切り替える司令塔です
- **`Tepora-app/backend/src/core/tool_manager.py`**: 新しい能力（ツール）を追加するための入り口です
- **`Tepora-app/backend/src/core/config/`**: モデルの性格や記憶のクセなど、細かい設定ができます
- **`Tepora-app/frontend/`**: React + TypeScript で構築されたモダンなWeb UI


## 📜 ライセンス

Teporaは Apache License 2.0 のもとで公開されています。詳細は `LICENSE` をご確認ください。
各機械学習モデルは、それぞれの提供元のライセンスに従います。
