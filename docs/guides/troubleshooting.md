# Tepora Troubleshooting Guide / Tepora トラブルシューティングガイド

[English](#english) | [日本語](#japanese)

<div id="english"></div>

# Troubleshooting Guide (English)

This guide deals with common issues you might encounter during the development and operation of Tepora, along with their solutions.

---

## 1. Backend Startup Errors

### `address already in use`
**Symptoms**: When attempting to start the backend, an "address already in use" error occurs.
**Cause**: The previous process is still running, or another process is using the same port.
**Solution**:
```pwsh
# Windows: Find the process using the port (Default 8000)
netstat -ano | findstr :8000
# Identify the PID and terminate the process
taskkill /PID <PID> /F
```

### `Failed to connect to history db`
**Symptoms**: An SQLite connection error occurs upon startup.
**Cause**: Permissions issue with the `~/.tepora/` directory, or insufficient disk space.
**Solution**:
```pwsh
# Verify the user data directory on Windows
ls $env:USERPROFILE\.tepora\
# Manually create if it does not exist
mkdir $env:USERPROFILE\.tepora\
```

---

## 2. Frontend Connection Errors

### `ECONNREFUSED` or `ERR_CONNECTION_REFUSED`
**Symptoms**: The frontend cannot connect to the API.
**Cause**: The backend is not running, or the port configuration differs.
**Solution**:
1. Verify the backend is running: `http://localhost:8000/health`
2. Ensure the `VITE_API_PORT` environment variable matches the backend port.
3. Check or create the `frontend/.env` file:
   ```
   VITE_API_PORT=8000
   ```

---

## 3. LLM and Model Related Errors

### Model Not Responding / Timeout
**Symptoms**: No response after sending a chat, resulting in a timeout error.
**Cause**: The model file cannot be found, or resources are insufficient.
**Solution**:
1. Check `components.llm.status` at the `/health` endpoint:
   ```json
   { "components": { "llm": { "status": "ok", "model": "..." } } }
   ```
2. If `status` is `no_model`, reconfigure the model via the settings screen.
3. Check the model file paths in the backend logs:
   `RUST_LOG=debug cargo run`

### `Model not found` Error
**Symptoms**: "Model not found" error occurs after setup.
**Solution**:
1. Check `~/.tepora/models.json` to ensure the model paths are correct.
2. Verify that the model files actually exist.
3. Restart the app and re-register the model on the settings screen.

---

## 4. MCP Configuration Errors

### `Failed to parse MCP config` Log
**Symptoms**: The following warning appears in the backend logs:
```
WARN Failed to parse MCP config; using current in-memory config. line=15, column=5, error=...
```
**Cause**: Syntax error in `mcp_tools_config.json`. The log includes the `line` and `column`, check that line.
**Solution**:
1. Note the `line` and `column` from the log.
2. Open `~/.tepora/config/mcp_tools_config.json` in a text editor.
3. Fix the JSON syntax error on that line (e.g. missing commas, unclosed quotes).
4. Verify valid JSON: `cat mcp_tools_config.json | python -m json.tool`

### `Blocked command pattern detected` Error
**Symptoms**: An MCP tool fails to execute with a "Blocked command pattern" error.
**Cause**: Matches a command in `blocked_commands` inside `mcp_policy.json`.
**Solution**:
1. Check `blocked_commands` in `~/.tepora/config/mcp_policy.json`.
2. Review the policy to ensure untrusted commands are not permitted.
3. Alternatively, exclude it using the MCP Policy settings screen if needed.

---

## 5. WebSocket Connection Issues

### WebSocket Repeatedly Disconnects
**Symptoms**: Connection drops frequently during chats and reconnects happen.
**Cause**: Unstable network, or backend processing timeout.
**Solution**:
1. Check the Network tab in browser developer tools.
2. Verify the reason for WebSocket disconnection in the backend logs:
   `RUST_LOG=tepora_backend::server::ws=debug`
3. When generating long responses, verify the frontend timeout settings.

### `401 Unauthorized` on WebSocket
**Symptoms**: WebSocket connection is rejected with `401`.
**Cause**: Invalid or expired session token.
**Solution**:
1. Restart the app (refreshes the session token).
2. Reset the token by deleting `~/.tepora/.session_token` and restarting.

---

## 6. Database Errors

### `Failed to init sessions table` Error
**Symptoms**: Fails to initialize the sessions table at startup.
**Cause**: Corrupted database file or permission issues.
**Solution**:
1. Delete `~/.tepora/history.db` and restart (**Chat history will be lost**).
2. Create a backup first:
   ```pwsh
   Copy-Item $env:USERPROFILE\.tepora\history.db $env:USERPROFILE\.tepora\history.db.bak
   ```

---

## 7. Reading Logs

### Backend Logs
Backend logs use a structured JSON format (tracing + tower_http TraceLayer).
```pwsh
# Enable detailed logs
$env:RUST_LOG = "tepora_backend=debug,tower_http=debug"
cd Tepora-app/backend-rs && cargo run
```

**Key Log Fields**:
- `node_id`: The graph node where the error occurred
- `trace`: Execution path until the error (e.g. `router(2ms) -> chat(150ms)`)
- `config_path`, `line`, `column`: Location of error in MCP config files

**Log Levels**:
| Level | Description |
|-------|-------------|
| `ERROR` | Error requiring immediate attention |
| `WARN`  | Issue that needs attention but can proceed |
| `INFO`  | Normal operational log |
| `DEBUG` | Debugging info (detailed execution flow) |

### Frontend Logs
Check the console using your browser's Developer Tools (F12). Zustand DevTools can be used to track state changes (when in development mode).

---

## 8. Debugging Procedure Summary
1. **Check `/health` Endpoint**: Verify system status at `http://localhost:8000/health`
2. **Check Backend Logs**: Enable detailed logs with `RUST_LOG=debug`
3. **Verify MCP Config**: Pinpoint issue locations using `line/column` info
4. **Verify Database**: Check permissions and free space for connection errors
5. **Browser Console**: Check here for frontend errors
6. **Record Repro Steps**: When reporting a bug, attach the logs from `RUST_LOG=debug`

If the issue persists, execute `cargo clippy` and `npm run typecheck` to catch undetected errors, and attempt resetting config files (in `~/.tepora/`).

---

<div id="japanese"></div>

# トラブルシューティングガイド (日本語)

このガイドは、Tepora の開発・運用中に遭遇しやすい問題と、その対処法をまとめたものです。

---

## 1. バックエンド起動エラー

### `address already in use`
**症状**: バックエンドを起動しようとすると「address already in use」エラーが発生する。
**原因**: 前回のプロセスが残っている、または別のプロセスが同じポートを使用している。
**対処法**:
```pwsh
# Windows: ポートを使用しているプロセスを探す (デフォルト 8000)
netstat -ano | findstr :8000
# PIDを特定してプロセスを終了する
taskkill /PID <PID> /F
```

### `Failed to connect to history db`
**症状**: 起動時に SQLite の接続エラーが発生する。
**原因**: `~/.tepora/` ディレクトリの権限問題、またはディスク容量不足。
**対処法**:
```pwsh
# Windows でユーザーデータディレクトリを確認
ls $env:USERPROFILE\.tepora\
# 存在しない場合は手動作成
mkdir $env:USERPROFILE\.tepora\
```

---

## 2. フロントエンド接続エラー

### `ECONNREFUSED` or `ERR_CONNECTION_REFUSED`
**症状**: フロントエンドが API に接続できない。
**原因**: バックエンドが起動していない、またはポート設定が異なる。
**対処法**:
1. バックエンドが起動しているか確認: `http://localhost:8000/health`
2. `VITE_API_PORT` 環境変数がバックエンドのポートと一致しているか確認
3. `frontend/.env` ファイルを確認・作成:
   ```
   VITE_API_PORT=8000
   ```

---

## 3. LLM・モデル関連エラー

### モデルが応答しない / タイムアウト
**症状**: チャット送信後に応答がなく、タイムアウトエラーが発生する。
**原因**: モデルファイルが見つからない、またはリソース不足。
**対処法**:
1. `/health` エンドポイントの `components.llm.status` を確認:
   ```json
   { "components": { "llm": { "status": "ok", "model": "..." } } }
   ```
2. `status` が `no_model` の場合、設定画面でモデルを再設定する
3. モデルファイルのパスをバックエンドのログで確認:
   `RUST_LOG=debug cargo run`

### `Model not found` エラー
**症状**: セットアップ後にモデルが見つからないエラーが発生する。
**対処法**:
1. `~/.tepora/models.json` を確認して、モデルパスが正しいか確認
2. モデルファイルが実際に存在するかを確認
3. アプリを再起動し、設定画面でモデルを再登録する

---

## 4. MCP設定関連エラー

### `Failed to parse MCP config` ログ
**症状**: バックエンドのログに以下のような警告が表示される:
```
WARN Failed to parse MCP config; using current in-memory config. line=15, column=5, error=...
```
**原因**: `mcp_tools_config.json` の構文エラー。ログに `line` と `column` が含まれるので、その行を確認する。
**対処法**:
1. ログで `line` と `column` を確認する
2. `~/.tepora/config/mcp_tools_config.json` をテキストエディタで開く
3. 該当行の JSON 構文エラーを修正する (カンマの過不足、クォートなど)
4. 有効な JSON の確認: `cat mcp_tools_config.json | python -m json.tool`

### `Blocked command pattern detected` エラー
**症状**: MCP ツールが「ブロックされたコマンドパターン」エラーで実行できない。
**原因**: `mcp_policy.json` の `blocked_commands` がコマンドに一致している。
**対処法**:
1. `~/.tepora/config/mcp_policy.json` の `blocked_commands` を確認
2. 信頼できないコマンドが許可されないよう、ポリシーを見直す
3. 必要に応じて MCP Policy 設定画面から除外する

---

## 5. WebSocket接続問題

### WebSocket が切断を繰り返す
**症状**: チャット中に接続が度々切れて再接続が発生する。
**原因**: ネットワーク不安定、またはバックエンドの処理タイムアウト。
**対処法**:
1. ブラウザの開発者ツールでネットワークタブを確認
2. バックエンドのログで WebSocket の切断理由を確認:
   `RUST_LOG=tepora_backend::server::ws=debug`
3. 長い応答を生成する際は、フロントエンドのタイムアウト設定を確認する

### `401 Unauthorized` on WebSocket
**症状**: WebSocket 接続が `401` で拒否される。
**原因**: セッショントークンが無効または期限切れ。
**対処法**:
1. アプリを再起動する（セッショントークンが更新される）
2. `~/.tepora/.session_token` を削除して再起動することでトークンをリセットできる

---

## 6. データベース関連エラー

### `Failed to init sessions table` エラー
**症状**: 起動時に sessions テーブルの初期化に失敗する。
**原因**: データベースファイルが破損しているか権限問題。
**対処法**:
1. `~/.tepora/history.db` を削除して再起動する（**チャット履歴が失われます**）
2. バックアップを先に作成する:
   ```pwsh
   Copy-Item $env:USERPROFILE\.tepora\history.db $env:USERPROFILE\.tepora\history.db.bak
   ```

---

## 7. ログの読み方

### バックエンドログ
バックエンドログは構造化 JSON 形式（tracing + tower_http TraceLayer）で出力されます。
```pwsh
# 詳細ログを有効化する
$env:RUST_LOG = "tepora_backend=debug,tower_http=debug"
cd Tepora-app/backend-rs && cargo run
```

**重要なログフィールド**:
- `node_id`: エラーが発生したグラフノード
- `trace`: エラーまでの実行経路（`router(2ms) -> chat(150ms)` など）
- `config_path`, `line`, `column`: MCP 設定ファイルのエラー位置

**ログレベル**:
| レベル | 説明 |
|-------|------|
| `ERROR` | 即時対応が必要なエラー |
| `WARN` | 注意が必要だが続行可能な問題 |
| `INFO` | 通常の動作ログ |
| `DEBUG` | デバッグ情報（詳細な実行フロー） |

### フロントエンドログ
ブラウザの開発者ツール（F12）でコンソールを確認する。Zustand DevTools を使用して状態変化を追跡できます（開発モード時）。

---

## 8. デバッグ手順まとめ
1. **`/health` エンドポイントを確認**: `http://localhost:8000/health` でシステム状態をチェック
2. **バックエンドログを確認**: `RUST_LOG=debug` で詳細ログを有効化
3. **MCP設定を確認**: `line/column` 情報を含むエラーログでファイルの問題箇所を特定
4. **データベースを確認**: 接続エラーの場合はパーミッションと空きディスク容量を確認
5. **ブラウザコンソール**: フロントエンドのエラーはここで確認
6. **再現手順を記録**: バグ報告の際は、RUST_LOG=debug のログを添付してください

問題が解決しない場合は、`cargo clippy` と `npm run typecheck` を実行して未検出のエラーを確認し、設定ファイル（`~/.tepora/` 内）のリセットを試みてください。
