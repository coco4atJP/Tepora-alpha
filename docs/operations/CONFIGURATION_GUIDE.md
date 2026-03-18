# Tepora 設定運用ガイド

**最終更新**: 2026-03-18
**対象バージョン**: v0.4.5

この文書は、現行の Rust バックエンド実装に合わせて設定の読み書き場所、秘密情報の扱い、主要キーを整理したものです。

## 1. 設定の読み込みと保存先

### 1.1 パス解決ルール

`ConfigService` は次の順序で設定ファイルを解決します。

1. `TEPORA_CONFIG_PATH` があればそのパスを使用
2. `USER_DATA_DIR/config.yml` があればそれを使用
3. なければ `project_root/config.yml` を初期値として読む

保存先は常に次です。

- 公開設定: `USER_DATA_DIR/config.yml`
- 機密設定: `USER_DATA_DIR/secrets.yaml`

読み込み時は `config.yml` と `secrets.yaml` をマージします。

### 1.2 USER_DATA_DIR

- Windows: `%LOCALAPPDATA%\Tepora`
- macOS: `~/Library/Application Support/Tepora`
- Linux: `~/.local/share/tepora`

> デバッグビルドでは `USER_DATA_DIR` は `backend-rs/` 直下になります。`TEPORA_DATA_DIR` を設定すると明示的に上書きできます。

## 2. 実際に使われる設定関連ファイル

```text
USER_DATA_DIR/
├── config.yml
├── secrets.yaml
├── setup_state.json
├── models.json
├── tepora_core.db
├── em_memory.db
├── rag.db
├── logs/
├── bin/llama.cpp/current/
└── config/
    ├── mcp_policy.json
    └── mcp_tools_config.json
```

### 補足

- `setup_state.json`: セットアップウィザードの進捗と選択ローダーを保持
- `models.json`: モデルレジストリ
- `mcp_policy.json`: MCP 実行ポリシー
- `mcp_tools_config.json`: MCP サーバー定義

## 3. 秘密情報の扱い

- API キーやトークン系の値は `secrets.yaml` に分離保存されます。
- 一部の機密値は OS の Secret Store / Keyring 参照へ正規化されることがあります。
- `GET /api/config` のレスポンスでは機密値が `****` にマスクされます。
- `POST /api/config` / `PATCH /api/config` で `****` を送ると、既存値を保持したまま更新できます。

## 4. 主要設定セクション

| セクション | 用途 |
|---|---|
| `app` | 言語、セットアップ完了フラグ、入力上限などの基本設定 |
| `server` | CORS 許可 origin などのサーバー設定 |
| `privacy` | Web 検索許可、lockdown、URL ポリシー |
| `permissions` | 権限 TTL の既定値 |
| `tools` | 検索プロバイダーなどのツール設定 |
| `llm_manager` | 現在のローダー選択 (`llama_cpp` / `ollama` / `lmstudio`) |
| `models_gguf` | テキストモデル / 埋め込みモデル / 個別モデル定義 |
| `model_download` | ダウンロードの SHA256 検証や同意要件 |
| `default_models` | セットアップウィザードに出す推奨モデル |
| `characters` | キャラクタープロファイル |
| `custom_agents` | 汎用 / researcher / coder などの追加エージェント定義 |

## 5. 実運用でよく見るキー

### `app`

```yaml
app:
  language: ja
  setup_completed: true
  em_memory_enabled: true
```

### `privacy`

```yaml
privacy:
  allow_web_search: true
  isolation_mode: false
  url_policy_preset: balanced
  lockdown:
    enabled: false
    reason: null
```

### `llm_manager`

```yaml
llm_manager:
  loader: ollama
  process_terminate_timeout: 5000
  external_request_timeout_ms: 120000
  stream_idle_timeout_ms: 60000
  health_check_timeout: 15000
  health_check_interval_ms: 500
  stream_channel_buffer: 128
  stream_internal_buffer: 100
```

### `models_gguf`

```yaml
models_gguf:
  text_model:
    path: ollama://gemma3n:latest
    port: 8088
    n_ctx: 8192
    n_gpu_layers: -1
    max_tokens: 1024
    repeat_penalty: 1.1
    stop:
      - "User:"
      - "System:"
  embedding_model:
    path: ollama://embeddinggemma:latest
    port: 8081
    n_ctx: 2048
    n_gpu_layers: -1
    num_ctx: 2048
```

> `port` は主に `llama_cpp` 実行時に意味を持ちます。`ollama://...` や `lmstudio://...` を使う場合は、対応ローダーの接続先解決が優先されます。

### `llm_defaults`

```yaml
llm_defaults:
  n_predict: 1024
  temperature: 0.7
  top_p: 0.9
  top_k: 40
  repeat_penalty: 1.1
```

### `rag`

```yaml
rag:
  search_default_limit: 5
  text_search_default_limit: 10
  embedding_timeout_ms: 5000
  chunk_window_default_chars: 1200
```

### `agent`

```yaml
agent:
  max_attachments: 5
  attachment_preview_chars: 500
```

### `context_window`

```yaml
context_window:
  chat:
    system_cap: 20
    memory_cap: 45
    local_context_cap: 20
    interaction_tail_cap: 5
  search_agentic:
    search_report_build:
      evidence_cap: 35
      artifact_summary_cap: 15
      evidence_limit: 5
      artifact_limit: 3
```

- `*_cap: 0` はその block kind の非必須コンテキストを無効化します。
- `*_cap` を省略した場合は mode / stage の既定 recipe を使います。

### `model_download`

```yaml
model_download:
  require_sha256: true
```

## 6. MCP 関連設定

### `config/mcp_policy.json`

- `policy`: 既定は `LOCAL_ONLY`
- `blocked_commands`
- `require_tool_confirmation`
- `first_use_confirmation`

### `config/mcp_tools_config.json`

- `mcpServers` 配下にサーバー定義を保存
- UI / API 経由の追加・削除・有効化・無効化に追従

## 7. 環境変数

| 環境変数 | 説明 |
|---|---|
| `TEPORA_ROOT` | project root を明示 |
| `TEPORA_DATA_DIR` | USER_DATA_DIR を明示 |
| `TEPORA_CONFIG_PATH` | 読み書きする config.yml を明示 |
| `TEPORA_PORT` | サーバー待受ポート |
| `PORT` | `TEPORA_PORT` 未設定時のフォールバック |
| `TEPORA_HOST` | サーバーバインドアドレス |
| `TEPORA_ENV` | `production` 時の一部セキュリティ挙動に影響 |
| `RUST_LOG` | Rust tracing のログレベル |

## 8. 運用メモ

- 起動時に `tepora_core.db`、`em_memory.db`、`rag.db` の自動バックアップが作成されます。
- `backup.startup_auto_backup_limit` で保持数を調整できます。
- `privacy.lockdown.enabled` が有効な場合、一部の危険操作や外部アクセスは API 側で拒否されます。
