# Tepora Application

このディレクトリには、Tepora アプリケーションを動作させるためのすべてのコードが含まれています。

## ディレクトリ構成

```
Tepora-app/
├── backend-rs/       # Rust バックエンドサーバー
├── frontend/         # React + Vite フロントエンド（Tauri デスクトップアプリ含む）
├── scripts/          # ビルド・デプロイ用スクリプト
└── Taskfile.yml      # タスクランナー設定
```

## クイックスタート

### 前提条件

- **Rust** (バックエンド / Tauri ビルド)
- **Node.js 18+** + npm
- **Task** ([Taskfile](https://taskfile.dev/))

### 依存関係のインストール

```bash
cd Tepora-app
task install
```

セットアップ後に環境診断をしたい場合は、次を実行してください。

```bash
task doctor
```

`task doctor` は Node.js / npm / Rust / cargo / Task の存在確認に加え、`frontend/node_modules`、ローカル Tauri CLI、`legacy-peer-deps` 設定を診断します。

コミット前の軽い検証は `task pre-commit`、push 前の全量検証は `task pre-commit:full` を使います。
差分から必要なテストだけ回したい場合は `task test:changed` を使います。`task test:arch` は backend のレイヤー違反を静的に検査し、`task test:ws-replay` は固定入力列で WebSocket セッションを deterministic replay します。`task test:behavior` は fixture ベースの Model Behavior A/B 評価を実行し、`task test:flaky` は隔離レーン対象の suite を複数回実行して flaky を検知します。
commit 形式の検証は `task commitlint`、release notes の生成は `task release-notes -- --from <tag> --to HEAD --version <label>` を使います。

### 開発サーバーの起動

```bash
task dev
```

これにより、バックエンド（動的ポート）とフロントエンド (`http://localhost:5173`) の両方が起動します。
バックエンド起動時に表示される `TEPORA_PORT=xxxx` が、フロントエンド側に自動同期されます。

固定ポートでバックエンドを起動したい場合は、別ターミナルで次を実行してください。

```bash
cd Tepora-app/backend-rs
$env:PORT="8000"; cargo run
```

## タスク一覧

| タスク | 説明 |
|--------|------|
| `task dev` | 開発サーバー起動（`dev-sync` のエイリアス） |
| `task dev-backend` | バックエンドのみ起動 |
| `task dev-frontend` | フロントエンドのみ起動 |
| `task dev-sync` | 動的ポート同期で開発サーバー起動 |
| `task dev-tauri` | Tauri デスクトップアプリとして起動 |
| `task test` | 全テスト実行 |
| `task test:changed` | 差分に応じたテストのみ実行 |
| `task test:arch` | backend のレイヤー適合テストを実行 |
| `task test:flaky` | flaky 検知用の quarantine lane を実行 |
| `task lint` | リンター実行 |
| `task build` | プロダクションビルド |
| `task install` | 依存関係インストール |
| `task doctor` | 開発環境の診断 |
| `task commitlint` | conventional commits を検証 |
| `task release-notes` | conventional commits から release notes を生成 |
| `task pre-commit` | 差分向けの高速 pre-commit チェック |
| `task pre-commit:full` | 全量の pre-push チェック |
| `task clean` | ビルド成果物削除 |

## ビルドスクリプト

- `scripts/build_sidecar.mjs` - Rust バックエンドのサイドカービルド
- `scripts/prepare_fallback.py` - フォールバックバイナリの準備（任意）

詳細なドキュメントは [`../docs/`](../docs/) を参照してください。

