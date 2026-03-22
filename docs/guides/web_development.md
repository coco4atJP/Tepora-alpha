# Tepora Web Interface / Browser Development Guide

[English](#english) | [日本語](#japanese)

> [!IMPORTANT]
> Tepora の推奨実行環境は **Tauri デスクトップアプリ** です。この文書は、React フロントエンドをブラウザで開発・確認するときの構成と API の要点をまとめたものです。

<div id="english"></div>

## English

### Overview

The current frontend runs in two environments:

- **Desktop mode**: Tauri launches the Rust backend as a sidecar and the UI prefers IPC-aware transport.
- **Browser development mode**: `task dev` starts the Rust backend plus Vite, and the UI connects over localhost HTTP / WebSocket.

The canonical frontend now boots from `/` and `/settings`. Legacy V1 code is archived under `src/legacy/`, is excluded from TypeScript/Vitest/ESLint targets, and is not part of the runtime path.

### Relevant structure

```text
Tepora-app/
├── backend-rs/
│   └── src/
│       ├── main.rs
│       ├── server/
│       │   ├── router.rs
│       │   ├── handlers/
│       │   └── ws/
│       ├── state/mod.rs
│       ├── llm/
│       ├── mcp/
│       ├── models/
│       └── context/
└── frontend/
    ├── src/
    │   ├── main.tsx
    │   ├── app/
    │   ├── features/
    │   ├── shared/
    │   ├── legacy/
    │   └── utils/
    └── src-tauri/
```

### Development commands

```bash
# Browser-oriented development
task dev

# Frontend only
task dev-frontend

# Backend only
task dev-backend

# Desktop/Tauri development
task dev-tauri
```

`task dev` runs `scripts/dev_sync.mjs`, starts the backend on a dynamic port, prints `TEPORA_PORT=...`, and injects the synchronized port into the frontend flow.

### Transport and auth

- REST base URL: `http://127.0.0.1:{port}`
- WebSocket URL: `ws://127.0.0.1:{port}/ws`
- REST auth: `x-api-key`
- WebSocket auth: `Sec-WebSocket-Protocol` with `tepora.v1` and `tepora-token.{hex-token}`

### Major API groups

- System: `/health`, `/api/status`, `/api/shutdown`, `/api/auth/refresh`
- Config and logs: `/api/config`, `/api/config/secrets/rotate`, `/api/logs`, `/api/logs/frontend`
- Sessions: `/api/sessions`, `/api/sessions/:id/messages`, `/api/sessions/:id/metrics`
- Setup and models: `/api/setup/*`
- Memory operations: `/api/memory/compress`, `/api/memory/compaction_jobs`, `/api/memory/decay`
- Security: `/api/security/*`, `/api/credentials/*`, `/api/backup/*`
- Agent Skills: `/api/agent-skills`
- MCP: `/api/mcp/*`

### WebSocket message families

Client to server:

```json
{
  "message": "user input",
  "mode": "chat",
  "sessionId": "optional-session-id",
  "attachments": [],
  "agentId": "optional-agent-id"
}
```

Server to client events include `chunk`, `status`, `activity`, `history`, `tool_confirmation_request`, `download_progress`, `done`, and `error`.

### Notes for frontend changes

- `src/app/` contains the canonical entry, router, and providers.
- `src/features/` and `src/shared/` contain the active frontend implementation.
- `src/legacy/` is an archive only and should not be used for runtime changes.
- Settings is split into editor model, model-management hooks, and layout subviews.
- Chat is split into screen state, transport/session lifecycle, and composer action hooks.
- Desktop startup behavior lives in `src/utils/sidecar.ts`.
- Transport and auth helpers for the active runtime live under `src/utils/`.

<div id="japanese"></div>

## 日本語

### 概要

現在のフロントエンドは 2 つの実行環境で動作します。

- **デスクトップモード**: Tauri が Rust バックエンドを sidecar 起動し、UI は IPC 寄りの transport を優先します。
- **ブラウザ開発モード**: `task dev` で Rust バックエンドと Vite を同時起動し、localhost の HTTP / WebSocket で接続します。

canonical frontend は `/` と `/settings` で起動します。旧 V1 コードは `src/legacy/` に退避されており、TypeScript/Vitest/ESLint の対象外で、runtime にも参加しません。

### 関連ディレクトリ

```text
Tepora-app/
├── backend-rs/
│   └── src/
│       ├── main.rs
│       ├── server/
│       │   ├── router.rs
│       │   ├── handlers/
│       │   └── ws/
│       ├── state/mod.rs
│       ├── llm/
│       ├── mcp/
│       ├── models/
│       └── context/
└── frontend/
    ├── src/
    │   ├── main.tsx
    │   ├── app/
    │   ├── features/
    │   ├── shared/
    │   ├── legacy/
    │   └── utils/
    └── src-tauri/
```

### 開発コマンド

```bash
# ブラウザ向け開発
task dev

# フロントエンドのみ
task dev-frontend

# バックエンドのみ
task dev-backend

# Tauri デスクトップ開発
task dev-tauri
```

`task dev` は `scripts/dev_sync.mjs` を介してバックエンドを動的ポートで起動し、`TEPORA_PORT=...` を検出してフロントエンドへ同期します。

### 通信と認証

- REST Base URL: `http://127.0.0.1:{port}`
- WebSocket URL: `ws://127.0.0.1:{port}/ws`
- REST 認証: `x-api-key`
- WebSocket 認証: `Sec-WebSocket-Protocol` に `tepora.v1` と `tepora-token.{hex-token}`

### 主な API グループ

- システム: `/health`, `/api/status`, `/api/shutdown`, `/api/auth/refresh`
- 設定とログ: `/api/config`, `/api/config/secrets/rotate`, `/api/logs`, `/api/logs/frontend`
- セッション: `/api/sessions`, `/api/sessions/:id/messages`, `/api/sessions/:id/metrics`
- セットアップとモデル: `/api/setup/*`
- メモリ保守: `/api/memory/compress`, `/api/memory/compaction_jobs`, `/api/memory/decay`
- セキュリティ: `/api/security/*`, `/api/credentials/*`, `/api/backup/*`
- Agent Skills: `/api/agent-skills`
- MCP: `/api/mcp/*`

### WebSocket の概要

送信例:

```json
{
  "message": "ユーザー入力",
  "mode": "chat",
  "sessionId": "optional-session-id",
  "attachments": [],
  "agentId": "optional-agent-id"
}
```

受信イベントには `chunk`, `status`, `activity`, `history`, `tool_confirmation_request`, `download_progress`, `done`, `error` などがあります。

### フロントエンド改修時の見どころ

- 現行 UI の起点は `src/app/`
- active frontend 実装は `src/features/` と `src/shared/`
- `src/legacy/` は archive 専用
- settings は editor model / model-management hooks / layout subview に分割済み
- chat は screen state / lifecycle / composer actions に分割済み
- sidecar 起動制御は `src/utils/sidecar.ts`
- 通信・認証系ヘルパーは `src/utils/` 配下
