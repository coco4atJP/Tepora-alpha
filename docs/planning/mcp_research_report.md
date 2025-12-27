# MCP実装調査報告書

## 概要
提供されたMCP関連プロジェクト（Cline, Gemini CLI, Jan, LMS）のソースコードを分析し、MCP（Model Context Protocol）の動作原理とアーキテクチャを調査しました。
目的は、これらのプロジェクトから我々のプロジェクトに取り入れ可能な概念や実装パターンを特定することです。

## 調査対象
1.  **Cline** (`cline-main`): VSCode拡張機能としてのMCPクライアント実装
2.  **Gemini CLI** (`gemini-cli-main`): コマンドラインツールとしてのMCP実装
3.  **Jan** (`jan-dev`): デスクトップ/Web両対応のAIアシスタント
4.  **LMS** (`lms-main`): LM Studio CLI (詳細実装はSDK内または非公開の可能性あり)

---

## 1. Cline (`cline-main`)
**主な実装場所**: `src/services/mcp/McpHub.ts`

### アーキテクチャと動作
*   **McpHub**: MCPサーバーのライフサイクル管理を行う中心的なクラスです。
*   **接続管理**:
    *   ローカルサーバーには `StdioClientTransport` を使用。
    *   リモートサーバーには `SSEClientTransport` または `StreamableHTTPClientTransport` を使用。
*   **設定監視**: `chokidar` を使用して設定ファイル（`mcpSettings.json`）を監視し、変更があった場合に自動的にサーバーの再接続や設定更新を行います。
*   **OAuth認証**: `McpOAuthManager` により、認証が必要なMCPサーバー（Google Driveなど）のOAuthフローを処理します。

### 注目すべき実装パターン
*   **Hot Reloading**: 設定ファイルが書き換わると即座に反映される仕組み。
*   **Auto-approve**: 特定のツールの実行を自動許可するフィルタリング機能。
*   **Cline-specific Settings**: タイムアウトや自動許可などの設定変更では、サーバー再起動を行わずにインメモリの状態のみを更新する最適化が行われています。

---

## 2. Gemini CLI (`gemini-cli-main`)
**主な実装場所**: `packages/core/src/tools/mcp-client.ts`

### アーキテクチャと動作
*   **McpClient**: サーバーごとにインスタンス化されるクライアントクラス。
*   **発見プロセス (Discovery)**:
    *   `discoverTools`, `discoverPrompts`, `discoverResources` と明確にフェーズが分かれています。
    *   `ToolRegistry`, `PromptRegistry` といったレジストリクラスに発見した機能を登録します。
*   **イベント駆動**: `EventBus` (`coreEvents`) を通じてエラーやフィードバックを通知します。

### 注目すべき実装パターン
*   **Coalescing Pattern (更新の集約)**:
    *   サーバーからの `notifications/list_changed` 通知が短期間に大量に来た場合、それらをまとめて一度だけ更新処理を行う仕組み（Debounceに近い動き）が実装されています。これによりパフォーマンス低下を防いでいます。
*   **Lenient Validation (寛容なバリデーション)**:
    *   一部のMCPサーバーが複雑すぎるJSONスキーマを返す場合に対処するため、AJVバリデーションが失敗してもツール自体は登録する（バリデーションをスキップする）フォールバック機構があります。

---

## 3. Jan (`jan-dev`)
**主な実装場所**: `web-app/src/services/mcp/` (Web/Tauri Bridge)

### アーキテクチャと動作
*   **抽象化レイヤー**: `MCPService` インターフェースを定義し、プラットフォームに応じた実装を切り替えています。
    *   `TauriMCPService`: Tauriバックエンド（Rust実装）へのブリッジ。
    *   `WebMCPService`: ブラウザ拡張機能などを通じたWeb実装。
*   **Rustバックエンド**: 実際のMCP通信処理の多くはRust側（`src-tauri`）で行われているようです（今回はJS側インターフェースを中心に確認）。

### 注目すべき実装パターン
*   **Platform Agnostic**: フロントエンドコードが実行環境（デスクトップアプリかWebアプリか）を意識せずにMCPを利用できる設計になっています。将来的にWeb版を展開する場合に極めて有用です。

---

## 4. LMS (`lms-main`)
**調査結果**:
*   提供されたリポジトリはCLIのエントリーポイントであり、MCPのコアロジックはこのリポジトリ内の通常のソースコードには見当たりませんでした。
*   `package.json` に `@lmstudio/sdk` への依存が含まれているため、MCP関連の機能はSDK内部にカプセル化されているか、独自のプロトコルを使用している可能性があります。

---

## 我々のプロジェクトへ輸入できそうな概念・実装

### 1. Central Hub Pattern (`McpHub`)
**推奨度: 高**
すべてのMCP接続を一元管理するクラス（Hub）を作成し、アプリケーション全体の状態管理を簡素化します。現在は `McpClientService` が近い役割ですが、設定ファイルの監視や再接続ロジックをここに集約すると堅牢になります。

### 2. Config Watcher & Hot Reloading
**推奨度: 高**
ユーザーが設定ファイルを編集した際に、アプリを再起動することなくMCPサーバー構成を更新できる機能はUX向上に直結します。Clineの `chokidar` を使った実装が参考になります。

### 3. Coalescing / Debouncing Updates
**推奨度: 中〜高**
MCPサーバーが増えると通知イベントが増加します。Gemini CLIのような「更新の集約」ロジックを入れることで、不要な再レンダリングやフェッチを防げます。

### 4. Service Abstraction (`MCPService`)
**推奨度: 中**
現状はElectronのみであれば不要かもしれませんが、将来的にWebブラウザ版や別のランタイムに対応する場合、Janのようなインターフェース抽象化をしておくと有利です。

### 5. Robust Schema Validation
**推奨度: 低〜中**
自作MCPサーバーのみなら不要ですが、サードパーティのMCPサーバーを接続させる場合、Gemini CLIのような「厳密すぎないバリデーション」が必要になる場合があります。
