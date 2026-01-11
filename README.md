このリポジトリは不安定です。

![log](https://github.com/coco4atJP/tepora-alpha/blob/main/Tepora_logo.png)

# Tepora （v0.2.0-beta）

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

### 2. お迎えの準備
```bash
# TeporaのおうちをあなたのPCに作ります
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora

# Tepora専用のお部屋（仮想環境）を用意します
python -m venv .venv
.venv\Scripts\activate        # Windowsの場合
# source .venv/bin/activate   # macOS/Linuxの場合

# バックエンドの依存関係をインストール
cd backend
uv sync

# フロントエンドの依存関係をインストール
cd ../frontend
npm install
cd ..
```

### 3. モデルの配置
Teporaの頭脳となるGGUFモデルファイルを、`backend/models/` フォルダの中に置いてあげてください。デフォルトでは、以下のモデルたちを待っています。

- **キャラクター担当**: unsloth/gemma-3n-E4B-it-GGUF (`gemma-3n-E4B-it-IQ4_XS.gguf`)
- **プロフェッショナル担当**: Menlo/Jan-nano-128k-gguf (`jan-nano-128k-iQ4_XS.gguf`)
- **記憶・埋め込み担当**: Google/embeddinggemma-gguf (`embeddinggemma-300M-Q8_0.gguf`)

### 4. Teporaを起こす (Desktop App)

推奨される起動方法は、Tauriデスクトップアプリとしての起動です。

```bash
cd frontend
npm run tauri dev
```

これで、バックエンド（Sidecar）とフロントエンドが統合されたデスクトップアプリが起動します。

#### 開発用 Webモード (Legacy/Dev)
開発目的でWebブラウザから利用したい場合は、以下のスクリプトを使用できます。

```bash
# ルートディレクトリで実行
start_app.bat
```

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
  - [開発者ガイド (Development Guide)](docs/guides/development.md)
  - [リファクタリング計画 (Refactoring Plan)](docs/planning/refactoring_plan.md)
- **`backend/src/tepora_server/`**: WebサーバーとAPIのエントリーポイント
- **`backend/src/core/app/`**: Teporaのコアロジックとアプリケーション管理
- **`backend/src/core/graph/`**: LangGraphを使って、Teporaの思考回路を組み立てています
- **`backend/src/core/em_llm/`**: 「驚き」を記憶する、Teporaの心とも言える部分です
- **`backend/src/core/llm_manager.py`**: 複数の頭脳（モデル）を賢く切り替える司令塔です
- **`backend/src/core/tool_manager.py`**: 新しい能力（ツール）を追加するための入り口です
- **`backend/src/core/config/`**: モデルの性格や記憶のクセなど、細かい設定ができます
- **`frontend/`**: React + TypeScript で構築されたモダンなWeb UI


## 📜 ライセンス

Teporaは Apache License 2.0 のもとで公開されています。詳細は `LICENSE` をご確認ください。
各機械学習モデルは、それぞれの提供元のライセンスに従います。
