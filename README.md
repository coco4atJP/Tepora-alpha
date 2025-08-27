# Tepora (Alpha v0.5)

Teporaは、LangGraphを基盤とした柔軟で拡張性の高いAIエージェントアプリケーションです。
ユーザーの要求に応じて、シンプルな対話、Web検索、複雑なタスク解決を自律的に切り替え、実行します。

## ✨ 主な機能

- **マルチモーダルな対話エンジン**:
  - **ダイレクト応答**: 通常のチャットボットとしての自然な対話。
  - **検索＆要約**: `/search` コマンドでWebを検索し、結果を要約して回答。
  - **エージェントモード**: `/agentmode` コマンドでReAct（Reason-Act）ループを開始し、ツールを駆使して複雑なタスクを段階的に解決。

- **動的なワークフロー制御**:
  - LangGraphを利用し、ユーザーの入力に応じて最適な実行パス（ノード）へ動的にルーティングします。

- **拡張可能なツールシステム**:
  - **ネイティブツール**: Google Custom Search APIなどのPythonで直接実装されたツールを標準搭載。
  - **MCP（Multi-Server Client Protocol）**: 別プロセスで動作する外部ツールサーバーと標準入出力を介して連携。これにより、言語や環境に依存しないツール拡張が可能です。

- **柔軟なLLM管理**:
  - Hugging Faceで公開されている複数のLLM（Gemma 3N, Jan-nanoなど）をサポート。
  - VRAMを効率的に利用するため、モデルの動的なロード/アンロードに対応しています。
  - モデルごとの量子化設定も柔軟に切り替え可能です。

- **設定駆動型の設計**:
  - LLMのモデルID、生成パラメータ、各種プロンプト、APIキーなどを `agent_core/config.py` に集約。挙動のカスタマイズが容易です。

## 🏛️ アーキテクチャ概要

```
Tepora/
├── agent_core/
│   ├── config.py         # 全体の設定（プロンプト、モデルID、APIキー設定）
│   ├── graph.py          # LangGraphの実行グラフ定義（エージェントの頭脳）
│   ├── llm_manager.py    # LLMのロード/アンロード管理
│   ├── state.py          # グラフ内で受け渡される状態の型定義
│   └── tool_manager.py   # ネイティブ/MCPツールの発見・実行管理
├── main.py               # アプリケーションのエントリーポイント
├── mcp_tools_config.json # MCPツールサーバーの接続設定
├── .env.example          # 環境変数ファイルのテンプレート
└── requirements.txt      # 依存パッケージリスト
```

- **`main.py`**: アプリケーションの起動、LLMとツールの初期化、対話ループを管理します。
- **`agent_core/graph.py`**: エージェントの思考と行動のフローを定義する最も中心的なモジュールです。ノード（処理単位）とエッジ（処理の流れ）を組み合わせてワークフローを構築します。
- **`agent_core/tool_manager.py`**: `native_google_search`のような内部ツールと、`mcp_tools_config.json`で定義された外部ツールを統一的に扱います。
- **`agent_core/llm_manager.py`**: `transformers`ライブラリを介して、指定されたモデルをGPUにロードし、LangChainが利用できる形式で提供します。

## 🚀 セットアップ

### 1. リポジトリのクローン

```bash
git clone <your-repository-url>
cd Tepora
```

### 2. 仮想環境の構築と有効化

```bash
# Windows
python -m venv venv
.\venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### 3. 依存パッケージのインストール

```bash
pip install -r requirements.txt
```

### 4. 環境変数の設定

プロジェクトルートに `.env` ファイルを作成し、`.env.example` を参考に以下の内容を記述します。
Google Custom Search APIを利用するために、APIキーと検索エンジンIDが必要です。

```ini
# .env
GOOGLE_CUSTOM_SEARCH_API_KEY="ここにあなたのAPIキーを入力"
GOOGLE_CUSTOM_SEARCH_ENGINE_ID="ここにあなたの検索エンジンIDを入力"
```

### 5. (オプション) MCPツールサーバーの設定

外部ツールを利用する場合は、`mcp_tools_config.json` を編集して、ツールサーバーを起動するためのコマンドを定義します。

```json
{
  "mcpServers": {
    "my_tool_server": {
      "command": "python",
      "args": ["-m", "my_tools.server"],
      "env": {}
    }
  }
}
```

## 🏃‍♀️ 使い方

以下のコマンドでエージェントを起動します。

```bash
python main.py
```

起動後、コンソールで対話を開始できます。

- **ダイレクトに応答させる**:
  > 今日の天気は？

- **Web検索を実行させる**:
  > /search LangGraphの最新情報

- **エージェントモードで複雑なタスクを依頼する**:
  > /agentmode 最新のAI研究トレンドを調べて、主要な3つのトピックを要約して

- **終了する**:
  > exit

## 🔧 カスタマイズ

### LLMの変更
`agent_core/config.py` を編集することで、使用するモデルや生成パラメータ（temperature, top_pなど）を変更できます。

### プロンプトの変更
エージェントの思考方法や応答スタイルは、`agent_core/config.py` 内のプロンプトテンプレートを編集することで調整できます。

- `REACT_SYSTEM_PROMPT`: エージェントモードの基本動作を定義します。
- `SEARCH_SUMMARY_SYSTEM_PROMPT`: 検索結果の要約方法を定義します。
- `SYNTHESIS_SYSTEM_PROMPT`: エージェントの最終報告をユーザーフレンドリーな形式に変換する方法を定義します。

## 📜 ライセンス

このプロジェクトは MIT License の下で公開されています。