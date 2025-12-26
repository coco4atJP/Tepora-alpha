# Tepora Application

このディレクトリには、Tepora アプリケーションを動作させるためのすべてのコードが含まれています。

## ディレクトリ構成

```
Tepora-app/
├── backend/          # Python FastAPI バックエンドサーバー
├── frontend/         # React + Vite フロントエンド（Tauri デスクトップアプリ含む）
├── scripts/          # ビルド・デプロイ用スクリプト
└── Taskfile.yml      # タスクランナー設定
```

## クイックスタート

### 前提条件

- **Python 3.11+** + [`uv`](https://github.com/astral-sh/uv)
- **Node.js 18+** + npm
- **Rust** (Tauri ビルド時のみ)
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

これにより、バックエンド (http://localhost:8000) とフロントエンド (http://localhost:5173) の両方が起動します。

## タスク一覧

| タスク | 説明 |
|--------|------|
| `task dev` | 開発サーバー起動（backend + frontend） |
| `task dev-backend` | バックエンドのみ起動 |
| `task dev-frontend` | フロントエンドのみ起動 |
| `task dev-tauri` | Tauri デスクトップアプリとして起動 |
| `task test` | 全テスト実行 |
| `task lint` | リンター実行 |
| `task build` | プロダクションビルド |
| `task install` | 依存関係インストール |
| `task clean` | ビルド成果物削除 |

## ビルドスクリプト

- `scripts/build_sidecar.py` - PyInstaller によるバックエンドのサイドカービルド
- `scripts/prepare_fallback.py` - フォールバックバイナリの準備

詳細なドキュメントは [`../docs/`](../docs/) を参照してください。
