# Tepora トラブルシューティングガイド

このガイドは、Tepora の開発・運用中に遭遇しやすい問題と、その対処法をまとめたものです。

---

## 目次

1. [バックエンド起動エラー](#バックエンド起動エラー)
2. [フロントエンド接続エラー](#フロントエンド接続エラー)
3. [LLM・モデル関連](#llmモデル関連)
4. [MCP設定エラー](#mcp設定エラー)
5. [WebSocket接続問題](#websocket接続問題)
6. [データベース関連](#データベース関連)
7. [ログの読み方](#ログの読み方)
8. [デバッグ手順まとめ](#デバッグ手順まとめ)

---

## バックエンド起動エラー

### `address already in use` エラー

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

## フロントエンド接続エラー

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

## LLM・モデル関連

### モデルが応答しない / タイムアウト

**症状**: チャット送信後に応答がなく、タイムアウトエラーが発生する。

**原因**: モデルfile が見つからない、またはリソース不足。

**対処法**:
1. `/health` エンドポイントの `components.llm.status` を確認:
   ```json
   { "components": { "llm": { "status": "ok", "model": "..." } } }
   ```
2. `status` が `no_model` の場合、設定画面でモデルを再設定する
3. モデルファイルのパスをバックエンドのログで確認:
   ```
   RUST_LOG=debug cargo run
   ```

### `Model not found` エラー

**症状**: セットアップ後にモデルが見つからないエラーが発生する。

**対処法**:
1. `~/.tepora/models.json` を確認して、モデルパスが正しいか確認
2. モデルファイルが実際に存在するかを確認
3. アプリを再起動し、設定画面でモデルを再登録する

---

## MCP設定エラー

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

## WebSocket接続問題

### WebSocket が切断を繰り返す

**症状**: チャット中に接続が度々切れて再接続が発生する。

**原因**: ネットワーク不安定、またはバックエンドの処理タイムアウト。

**対処法**:
1. ブラウザの開発者ツールでネットワークタブを確認
2. バックエンドのログで WebSocket の切断理由を確認:
   ```
   RUST_LOG=tepora_backend::server::ws=debug
   ```
3. 長い応答を生成する際は、フロントエンドのタイムアウト設定を確認する

### `401 Unauthorized` on WebSocket

**症状**: WebSocket 接続が `401` で拒否される。

**原因**: セッショントークンが無効または期限切れ。

**対処法**:
1. アプリを再起動する（セッショントークンが更新される）
2. `~/.tepora/.session_token` を削除して再起動することでトークンをリセットできる

---

## データベース関連

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

## ログの読み方

### バックエンドログ

バックエンドログは構造化 JSON 形式（tracing + tower_http TraceLayer）で出力されます。

```
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

ブラウザの開発者ツール（F12）でコンソールを確認する。

Zustand DevTools を使用して状態変化を追跡できます（開発モード時）。

---

## デバッグ手順まとめ

1. **`/health` エンドポイントを確認**: `http://localhost:8000/health` でシステム状態をチェック
2. **バックエンドログを確認**: `RUST_LOG=debug` で詳細ログを有効化
3. **MCP設定を確認**: `line/column` 情報を含むエラーログでファイルの問題箇所を特定
4. **データベースを確認**: 接続エラーの場合はパーミッションと空きディスク容量を確認
5. **ブラウザコンソール**: フロントエンドのエラーはここで確認
6. **再現手順を記録**: バグ報告の際は、RUST_LOG=debug のログを添付してください

---

## 問題が解決しない場合

1. `cargo clippy` と `npm run typecheck` を実行して未検出のエラーを確認
2. `cargo test` と `npm test` を実行してテストが通るか確認
3. 問題のある設定ファイル（`~/.tepora/` 内）を削除してリセット
4. issue に再現手順と関連ログを記録して報告
