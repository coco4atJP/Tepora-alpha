# AGENTS.md - Project Context & Rules

このファイルは、このプロジェクトに参加するAIエージェント（あなた）のためのガイドラインです。作業を開始する前に必ず確認してください。

## 1. プロジェクト概要
- **名前**: Tepora (Tepora-app)
- **目的**: ローカルで動作する、高機能かつカスタマイズ可能なAIキャラクターチャットアプリケーション。
- **スタック**:
    - **Backend**: Rust (Axum, Tokio) - `Tepora-app/backend-rs/`
    - **Frontend**: React (TypeScript, Vite) - `Tepora-app/frontend/`
    - **Desktop**: Tauri v1/v2 - `Tepora-app/src-tauri/`
- **言語**: ユーザーとの対話は原則 **日本語** で行ってください。

## 2. コーディング規約

### Rust (Backend)
- **エラー処理**: `unwrap()` / `expect()` は原則禁止。`Result` 型と `?` 演算子を使用し、エラーを適切に伝播させること。エラー型には `crate::errors::ApiError` を使用する。
- **非同期**: `tokio` ランタイムを使用。ブロッキング操作は避ける。
- **モジュール**: 機能ごとに `src/` 下のモジュールに分割する（例: `api.rs`, `ws.rs`, `models.rs`）。

### TypeScript (Frontend)
- **型安全性**: `any` 型の使用は避け、インターフェースを定義すること。
- **コンポーネント**: React Functional Components (FC) を使用。Hooks (`use...`) を活用する。
- **スタイリング**: CSS Modules または Tailwind CSS (プロジェクト設定に従う) を使用。

## 3. アーキテクチャルール
- **API通信**: フロントエンドとバックエンドの通信には、Tauriの `invoke` コマンドまたは REST API (`Axum`) を使用する。
- **状態管理**:
    - バックエンド: `AppState` 構造体 (`Arc<AppState>`) で共有状態を管理。
    - フロントエンド: React Context または Jotai/Zustand 等を使用。

## 4. エージェントスキル (`.agents/skills/`)
特定のタスクを実行する際は、以下のスキル手順に従ってください：

- **Tauriコマンド追加**: `.agents/skills/create-tauri-command/SKILL.md`
- **バックエンドツール追加**: `.agents/skills/add-backend-tool/SKILL.md`
- **ドキュメント更新**: `.agents/skills/update-architecture-docs/SKILL.md`

## 5. 禁止事項
- **破壊的変更**: ユーザーの既存データ（`config.yml`, 履歴DB）を破壊するような変更は、ユーザーの明示的な許可なく行わないこと。
- **外部通信**: ユーザーの許可なく外部サーバーへデータを送信しないこと（プライバシー重視）。
