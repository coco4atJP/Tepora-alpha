# Tepora Frontend

The desktop interface for Tepora, built with Tauri, React, and Tailwind CSS v4.

## Setup

**Important:** You must use `npm ci --legacy-peer-deps` due to specific peer dependency conflicts in the current stack.

```bash
cd frontend
npm ci --legacy-peer-deps
```

## Development

To run the frontend in development mode (which also starts the backend sidecar):

```bash
npm run tauri dev
```

## Build

To build the distributable application:

```bash
npm run tauri build
```

---

# Tepora フロントエンド

Tepora のデスクトップインターフェースです。Tauri, React, Tailwind CSS v4 で構築されています。

## セットアップ (Setup)

**重要:** 依存関係の競合を回避するため、`npm ci --legacy-peer-deps` を使用してください。

```bash
cd frontend
npm ci --legacy-peer-deps
```

## 開発 (Development)

開発モードで起動するには以下のコマンドを実行します（バックエンドのサイドカーも同時に起動します）：

```bash
npm run tauri dev
```

## ビルド (Build)

配布用アプリケーションをビルドするには：

```bash
npm run tauri build
```
