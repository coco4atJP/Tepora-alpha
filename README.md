![Tepora Header](image/Tepora_log.png)

# Tepora (v0.4.5 Beta)

Tepora は、Rust バックエンドと React + Tauri フロントエンドで構成された、local-first なデスクトップ AI パートナーです。会話履歴、エピソード記憶、モデル設定、MCP 連携をローカルに保持しつつ、必要に応じて Web 検索や外部モデルプロバイダーも扱えます。

## 特徴

- **Local-first desktop app**: 推奨実行環境は Tauri デスクトップアプリです。Rust 製の Axum バックエンドを sidecar として起動し、HTTP / WebSocket でフロントエンドと接続します。
- **複数の LLM ローダー**: セットアップウィザードから `llama.cpp`、`Ollama`、`LM Studio` を選択できます。ランタイムには OpenAI-compatible クライアントも実装されています。
- **記憶と継続性**: EM-LLM ベースのエピソード記憶、RAG、セッション履歴、記憶圧縮ジョブを備えています。
- **エージェント実行**: Chat / Search / Agent の 3 モード、Agent Skills、MCP サーバー連携、ツール承認フローを提供します。
- **運用と保守**: `task doctor`、`task test:arch`、`task test:ws-replay`、`task test:behavior`、`task test:changed` など、現行の開発フローに沿ったタスクを整備しています。

## ネットワーク利用について

Tepora は **local-first** ですが、**always-offline** ではありません。

- `llama.cpp` やローカルの Ollama / LM Studio を使う会話はオフライン構成で運用できます。
- モデルダウンロード、Web 検索、ネットワーク越しの MCP サーバー、OpenAI-compatible エンドポイントを使う場合は、明示的な設定と権限付与が必要です。
- `privacy.lockdown.enabled` や `privacy.allow_web_search` によって、外部アクセスを抑制できます。

## リポジトリ構成

```text
Tepora_Project/
├── Tepora-app/
│   ├── backend-rs/      # Rust backend (Axum, GraphRuntime, MCP, Models, Memory)
│   ├── frontend/        # React frontend + Tauri shell
│   ├── scripts/         # build/dev/test helper scripts
│   └── Taskfile.yml     # canonical task definitions
├── docs/                # architecture, guides, operations
├── scripts/             # root-level helper scripts
└── Taskfile.yml         # wrapper that delegates to Tepora-app/Taskfile.yml
```

## クイックスタート

### 前提条件

- Node.js 18+
- Rust stable
- [Task](https://taskfile.dev/)

### セットアップ

```bash
git clone https://github.com/coco4atJP/Tepora.git
cd Tepora
task install
task doctor
```

### 開発起動

```bash
# Browser-oriented dev (backend + frontend with dynamic port sync)
task dev

# Tauri desktop dev
task dev-tauri
```

### 代表的な検証コマンド

```bash
task test
task test:changed
task test:arch
task test:ws-replay
task test:behavior
task test:flaky
task quality
```

## ドキュメント

- [アーキテクチャ仕様書](docs/architecture/ARCHITECTURE.md)
- [開発ガイド](docs/guides/development.md)
- [Web 開発ガイド](docs/guides/web_development.md)
- [設定運用ガイド](docs/operations/CONFIGURATION_GUIDE.md)
- [ユーザーガイド](docs/user_guide.md)

## ライセンス

[LICENSE](LICENSE) を参照してください。
