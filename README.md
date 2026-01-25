このリポジトリは開発中のため、予告なく仕様が変更される場合があります。

![log](https://github.com/coco4atJP/tepora-alpha/blob/main/Tepora_logo.png)

# Tepora （v3.0 beta）

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

#### 🧠 「びっくり！」を記憶するEM-LLMシステム
ICLR 2025で発表された論文のアイデアを元に、会話の中の「驚き（Surprise）」をキャッチして、重要な出来事をエピソードとして記憶します。長く一緒にいればいるほど、あなたのことを深く理解できるようになります。

#### ⚙️ 並行処理に対応したステートレス・コア
V2アーキテクチャでは、ステートレスな `LLMService` と `TeporaApp` ファサードにより、複数の会話セッションをより安定して並行処理できるようになりました。

#### 🔧 MCP対応で無限の可能性
Web検索やファイル操作などの「ツール」を自由に追加できます。Pythonで書かれたネイティブツールに加え、業界標準の **Model Context Protocol (MCP)** にも対応。あなた好みにどんどん拡張できます。

#### 💻 洗練されたデスクトップアプリ
Tauri を採用したデスクトップアプリとして提供されます。美しく使いやすい UI で、OS と密接に連携した快適な対話を体験できます。

## 🚀 はじめましてのごあいさつ (Quick Start)

Teporaとお話しするための準備を、ステップバイステップでご案内します。

### 1. 必要なもの
- **Python 3.11** 以上
- **Node.js 18** 以上
- **Rust** (Tauriビルドに必要)
- **uv** (推奨パッケージマネージャ)
- パワフルなCPU、またはGPU（GGUFモデルを動かすために必要です）

### 2. お迎えの準備
```powershell
# Teporaのリポジトリをクローンします
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora

# バックエンドのセットアップ (uv使用を推奨)
cd Tepora-app/backend
uv sync

# フロントエンドのセットアップ
cd ../frontend
npm ci --legacy-peer-deps
```

### 3. モデルの配置
`Tepora-app/backend/models/` フォルダの中に、使用したい GGUF モデルを配置してください。

### 4. Teporaを起こす (Desktop App)
推奨される起動方法は、Tauri デスクトップアプリとしての実行です。

```powershell
cd Tepora-app/frontend
npm run tauri dev
```
これで、バックエンド（Sidecar）とフロントエンドが統合されたデスクトップアプリが起動します。

### 5. 配布用アプリのビルド (Build)
Tepora を配布可能な形式（.exe, .dmg, .debなど）にビルドするには、以下の手順を実行します。

```powershell
cd Tepora-app/frontend
npm run tauri build
```
ビルドが完了すると、`Tepora-app/frontend/src-tauri/target/release/bundle/` にインストーラーが生成されます。

---

## 🛠️ 開発者の方へ

Teporaの心臓部は、モジュール化された現代的なアーキテクチャで構成されています。

### 📂 主要ディレクトリ構造
- **`Tepora-app/backend/src/core/`**: アプリケーションのコアロジック
    - `llm/`: ステートレスなLLM実行基盤 (`LLMService`)
    - `graph/`: LangGraph による思考プロセスの制御 (`TeporaGraph`)
    - `em_llm/`: エピソード記憶の実装
    - `tools/`: ツールおよび MCP の管理
- **`Tepora-app/frontend/src/`**: React + TypeScript + Zustand による Web UI
- **`docs/`**: 詳細なドキュメント
    - [包括的アーキテクチャ仕様書 (Architecture)](docs/architecture/ARCHITECTURE.md)
    - [開発者ガイド (Development Guide)](docs/guides/development.md)

詳細は [包括的アーキテクチャ仕様書](docs/architecture/ARCHITECTURE.md) を参照してください。

## 📜 ライセンス

Teporaは Apache License 2.0 のもとで公開されています。詳細は `LICENSE` をご確認ください。
各機械学習モデルは、それぞれの提供元のライセンスに従います。
