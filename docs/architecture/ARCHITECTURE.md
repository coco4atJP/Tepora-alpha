# Tepora Project - アーキテクチャ概要 (Rust版)

**バージョン**: 4.0  
**最終更新日**: 2026-02-05  
**対象**: Rustバックエンド (`Tepora-app/backend-rs`) への完全移行後

---

## 1. 概要

Tepora は **ローカルファースト** を前提としたデスクトップAIエージェントです。  
フロントエンドは Tauri + React、バックエンドは Rust (Axum/Tokio) で構成されます。

---

## 2. 技術スタック

- **Frontend**: React 19, TypeScript, Vite 7, Tailwind CSS v4
- **Desktop**: Tauri
- **Backend**: Rust 2021, Axum, Tokio
- **Storage**: SQLite (sqlx + WAL pool), ローカルファイル
- **Tooling**: MCP (rmcp client)
- **Model管理**: GGUF + Llama.cpp 系ワークフロー

---

## 3. ディレクトリ構成

```
Tepora_Project/
├── Tepora-app/
│   ├── backend-rs/          # Rust backend
│   │   ├── src/
│   │   │   ├── api.rs       # REST API
│   │   │   ├── ws.rs        # WebSocket/ストリーミング
│   │   │   ├── mcp.rs       # MCP管理
│   │   │   ├── models.rs    # モデル管理
│   │   │   ├── config.rs    # 設定/パス管理
│   │   │   ├── history.rs   # チャット履歴/セッション
│   │   │   ├── state.rs     # アプリケーション状態
│   │   │   ├── security.rs  # 認証・セキュリティ
│   │   │   └── search.rs    # Web検索ロジック
│   │   └── Cargo.toml
│   ├── frontend/            # React UI
│   └── scripts/             # sidecar/dev補助 (Node)
├── docs/
│   ├── architecture/        # 現行アーキテクチャ
│   └── legacy/              # 旧資料
└── Taskfile.yml
```

---

## 4. 実行モデル

- Rustバックエンドは **ローカルで動作**し、動的ポートを割り当てます。
- 起動時に `TEPORA_PORT=xxxx` を標準出力へ通知します。
- フロントエンドは環境変数でAPIポートを受け取ります。

---

## 5. 設定と永続化

### 5.1 設定ファイル

- `config.yml` は **ユーザーデータディレクトリ**に保存されます。
- `config.yml` と `secrets.yaml` を結合して読み込みます。

### 5.2 ユーザーデータ保存先

- Windows: `%LOCALAPPDATA%/Tepora`
- macOS: `~/Library/Application Support/Tepora`
- Linux: `$XDG_DATA_HOME/tepora` または `~/.local/share/tepora`

### 5.3 主要データ

- `tepora_core.db` (SQLite): セッション・チャット履歴
- `models.json`: モデル管理メタデータ
- `logs/`: ログファイル

---

## 6. API

### 6.1 REST

- `/health` 健康確認
- `/api/config` 設定の取得・更新
- `/api/sessions` セッション管理
- `/api/setup/*` 初期セットアップ・モデル管理
- `/api/mcp/*` MCPサーバ管理

### 6.2 WebSocket

- `/ws` でチャットストリーミングを提供
- `chunk` / `done` / `error` / `status` などのイベントを配信

---

## 7. MCP (Tooling)

- MCPサーバ設定は `config.yml` に保存
- レジストリ取得とインストールは `mcp_registry.rs` / `mcp_installer.rs` が担当
- 実行時は `mcp.rs` がポリシーと許可制御を行う

---

## 8. モデル管理

- Hugging Face からのダウンロード対応
- ポリシーに応じて **確認フロー** を挟む
- `models.json` に登録し、役割別(キャラクター/埋め込み)に割り当て

---

## 9. セキュリティ

- APIアクセスは `x-api-key` で制御
- MCP実行は許可制 (approve/revoke + policy)
- URLフェッチは denylist とスキーム制限を適用

---

## 10. 開発・ビルド

### 10.1 開発起動

```
task dev
```

### 10.2 サイドカー生成

```
task build-sidecar
```

### 10.3 品質ゲート

```
task quality
```

---

## 11. レガシー資料

Python/LangChain時代の資料は `docs/legacy/` に保存されています。
