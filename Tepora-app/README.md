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
| `task lint` | リンター実行 |
| `task build` | プロダクションビルド |
| `task install` | 依存関係インストール |
| `task clean` | ビルド成果物削除 |

## ビルドスクリプト

- `scripts/build_sidecar.mjs` - Rust バックエンドのサイドカービルド
- `scripts/prepare_fallback.py` - フォールバックバイナリの準備（任意）

詳細なドキュメントは [`../docs/`](../docs/) を参照してください。
