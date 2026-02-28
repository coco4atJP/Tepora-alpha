# Tepora 設定運用ガイド

**最終更新**: 2026-02-26  
**対象バージョン**: v0.4.0

---

## 1. 設定ファイル全体像

```
backend-rs/
├── config.yml          # メイン設定ファイル
├── secrets.yaml        # 将来的なシークレット管理用（現在は空）
└── config/
    ├── agents.yaml           # エージェントプロファイル定義
    ├── mcp_policy.json       # MCPツール実行ポリシー
    └── mcp_tools_config.json # MCPサーバー接続設定
```

---

## 2. config.yml

アプリケーションのメイン設定ファイル。起動時に自動読み込みされる。

### セクション一覧

| セクション | 説明 |
|-----------|------|
| `active_agent_profile` | 現在使用中のエージェントプロファイル名（`string`） |
| `app` | アプリケーション基本設定 |
| `characters` | ペルソナ（キャラクター）定義 |
| `custom_agents` | ユーザー定義エージェント |
| `llm_manager` | LLMバックエンド選択 |
| `models_gguf` | ローカルモデル設定 |
| `tools` | ツール設定 |

### 2.1 `app`

| キー | 型 | デフォルト | 説明 |
|-----|-----|----------|------|
| `language` | `string` | `ja` | UIの表示言語（`en`, `ja`, `es`, `zh`） |
| `setup_completed` | `bool` | `false` | セットアップウィザード完了フラグ |

### 2.2 `characters`

キャラクター（ペルソナ）の定義。キー名がキャラクターIDとなる。

```yaml
characters:
  <character_id>:
    name: "表示名"
    description: "キャラクターの説明"
    system_prompt: |
      <persona_definition>
      ...
      </persona_definition>
```

### 2.3 `custom_agents`

ユーザーが定義するエージェントプロファイル。タスク分類に応じて自動選択される。

```yaml
custom_agents:
  <agent_id>:
    name: "表示名"
    description: "説明"
    enabled: true
    system_prompt: "追加プロンプト"
    priority: 0          # 数値が大きいほど優先
    tags: ["tag1"]       # マッチングに使用
    model_config_name: null  # null = デフォルトモデル使用
    icon: null
    tool_policy:
      allow_all: true        # true = 全ツール許可
      allowed_tools: []      # allow_all が null/false の場合に有効
      denied_tools: []
      require_confirmation: []
```

### 2.4 `llm_manager`

| キー | 型 | 値 | 説明 |
|-----|-----|---|------|
| `loader` | `string` | `ollama` / `llama-server` | LLMバックエンドの種類 |

### 2.5 `models_gguf`

ローカルモデルの接続設定。

| パス | 型 | 説明 |
|-----|-----|------|
| `text_model.path` | `string` | テキストモデルのパス（例: `ollama://model`, `lmstudio://model`） |
| `text_model.port` | `u16` | テキストモデルの待受ポート |
| `text_model.n_ctx` | `u32` | コンテキスト長 |
| `text_model.n_gpu_layers` | `i32` | GPU利用レイヤー数（`-1` = 全GPU） |
| `embedding_model.*` | — | 埋め込みモデル（同構造） |

> **注意**: `port` は `llama-server` ローダー使用時のみ有効。`ollama` 使用時は Ollama 側のデフォルトポートが使われる。

### 2.6 `tools`

| キー | 型 | 値 | 説明 |
|-----|-----|---|------|
| `search_provider` | `string` | `google` / `duckduckgo` | Web検索プロバイダー |

---

## 3. secrets.yaml

将来的に外部 API キー等のシークレット情報を格納するために設計されたファイル。

**現状**: 空オブジェクト `{}` であり、アプリケーション内で読み込まれていない。

**設計意図**: ユーザーが利用する外部サービス（検索API等）のキーを `config.yml` から分離して管理する予定地。本番展開時には `.gitignore` への追加とファイルパーミッション制御を推奨。

---

## 4. config/ ディレクトリ

### 4.1 `agents.yaml`

`config.yml` の `custom_agents` セクションとは別に、プリセットのエージェント定義を保持する。
構造は `custom_agents` と同等だが、アプリケーション同梱の初期定義として使用される。

### 4.2 `mcp_policy.json`

MCPツールの実行ポリシーを定義する。

| キー | 型 | 説明 |
|-----|-----|------|
| `policy` | `string` | `LOCAL_ONLY` = ローカルプロセスのみ許可 |
| `blocked_commands` | `string[]` | ブロック対象のコマンドパターン |
| `require_tool_confirmation` | `bool` | ツール実行前にユーザー確認を求めるか |
| `first_use_confirmation` | `bool` | 初回使用時の確認を求めるか |

### 4.3 `mcp_tools_config.json`

外部MCPサーバーの接続定義。初期値は空 `{"mcpServers": {}}`。
ユーザーがMCPサーバーを追加すると、ここにサーバー定義が保存される。

---

## 5. 環境変数による上書き

| 環境変数 | デフォルト | 説明 |
|---------|----------|------|
| `TEPORA_PORT` | `3001` | サーバー待受ポート（最優先） |
| `PORT` | `3001` | サーバー待受ポート（フォールバック） |
| `TEPORA_HOST` | `127.0.0.1` | サーバーバインドアドレス |
| `TEPORA_ENV` | (未設定) | `production` 設定時にセキュリティ検証を強化 |
| `RUST_LOG` | `info,backend_rs=debug` | トレーシングフィルタ |

---

*本ドキュメントは中期的改善項目 #8（設定運用ガイド整備）として作成された。*
