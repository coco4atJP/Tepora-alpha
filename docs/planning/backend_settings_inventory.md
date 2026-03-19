# バックエンド設定項目インベントリ

> [!NOTE]
> フロントエンドV2の設定UIに乗せるべき項目を洗い出す目的で、バックエンド (`backend-rs`) のコードから設定可能な項目を網羅的に調査した結果です。

---

## 設定の仕組み

- 設定は [config.yml](file:///e:/Tepora_Project/Tepora-app/backend-rs/config.yml) (YAML) に保存、`secrets.yml` にセンシティブ値を分離
- API: `GET /config`（読取）/ `PUT /config`（全置換）/ `PATCH /config`（マージ更新）
- バリデーション: [validation.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/core/config/validation.rs)
- 機密キー (`api_key`, `password`, `token` 等) はOSキーリングに自動保存・リダクト

---

## 1. [app](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/mcp/config_store.rs#37-42) — アプリケーション全般

| キー | 型 | 範囲 / 選択肢 | 用途 |
|---|---|---|---|
| `app.language` | string | — | UI言語（セットアップ時に設定） |
| `app.setup_completed` | bool | — | 初期セットアップ完了フラグ |
| `app.em_memory_enabled` | bool | — | エピソード記憶機能の有効/無効 |
| `app.max_input_length` | u64 | 1 〜 10,000,000 | ユーザー入力の最大文字数 |
| `app.graph_recursion_limit` | u64 | 1 〜 10,000 | グラフ実行の再帰上限 |
| `app.graph_execution_timeout` | u64 | 1,000 〜 3,600,000 (ms) | グラフ実行のタイムアウト |
| `app.tool_execution_timeout` | u64 | 1 〜 86,400 (秒) | ツール実行のタイムアウト |
| `app.tool_approval_timeout` | u64 | 1 〜 86,400 (秒) | ツール承認待ちのタイムアウト |
| `app.web_fetch_max_chars` | u64 | 1 〜 5,000,000 | Web取得の最大文字数 |
| `app.web_fetch_timeout_secs` | u64 | 1 〜 86,400 (秒) | Web取得のタイムアウト |
| `app.web_fetch_max_bytes` | u64 | 1 〜 100,000,000 | Web取得の最大バイト数 |
| `app.mcp_config_path` | string | — | MCPツール設定ファイルのパス |
| `app.history_limit` | u64 | 1 〜 1,000 | コンテキストに含める直近の会話履歴ペア数 |
| `app.entity_extraction_limit` | u64 | 1 〜 100 | セッションエンティティ抽出の上限数 |

---

## 2. `active_agent_profile` — アクティブキャラクター

| キー | 型 | 用途 |
|---|---|---|
| `active_agent_profile` | string | 現在アクティブなキャラクターID |

---

## 3. [characters](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/core/config/service.rs#151-167) — キャラクター定義

各キャラクターは `characters.<id>` で定義。

| キー | 型 | 用途 |
|---|---|---|
| `characters.<id>.name` | string | 表示名 |
| `characters.<id>.description` | string | 説明文 |
| `characters.<id>.system_prompt` | string | システムプロンプト |
| `characters.<id>.icon` | string | アイコン（絵文字等） |
| `characters.<id>.avatar_path` | string | アバター画像パス |
| `characters.<id>.model_config_name` | string | キャラクター固有のモデル設定名 |

> [!TIP]
> デフォルトキャラクター（マリナ、彩月、時雨、悠、蓮、琥珀）は [characters](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/core/config/service.rs#151-167) が空の場合に自動生成されます。

---

## 4. `custom_agents` — カスタムエージェント

各エージェントは `custom_agents.<id>` で定義。

| キー | 型 | 用途 |
|---|---|---|
| `custom_agents.<id>.name` | string | 表示名 |
| `custom_agents.<id>.description` | string | 説明文 |
| `custom_agents.<id>.enabled` | bool | 有効/無効 |
| `custom_agents.<id>.icon` | string? | アイコン |
| `custom_agents.<id>.model_config_name` | string? | 使用モデル設定名 |
| `custom_agents.<id>.priority` | number | 優先度 |
| `custom_agents.<id>.system_prompt` | string | システムプロンプト |
| `custom_agents.<id>.tags` | string[] | マッチングタグ |
| `custom_agents.<id>.tool_policy.allow_all` | bool? | 全ツール許可 |
| `custom_agents.<id>.tool_policy.allowed_tools` | string[] | 許可ツールリスト |
| `custom_agents.<id>.tool_policy.denied_tools` | string[] | 拒否ツールリスト |
| `custom_agents.<id>.tool_policy.require_confirmation` | string[] | 確認必要ツールリスト |

---

## 5. `llm_manager` — LLMマネージャー

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `llm_manager.loader` | string | — | 使用するローダー（[ollama](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/server/handlers/setup.rs#811-817) 等） |
| `llm_manager.process_terminate_timeout` | u64 | 1 〜 3,600,000 (ms) | プロセス終了タイムアウト |
| `llm_manager.external_request_timeout_ms` | u64 | 1 〜 3,600,000 (ms) | 外部リクエストタイムアウト |
| `llm_manager.stream_idle_timeout_ms` | u64 | 1 〜 3,600,000 (ms) | ストリームアイドルタイムアウト |
| `llm_manager.health_check_timeout` | u64 | 1 〜 3,600,000 (ms) | ヘルスチェックタイムアウト |
| `llm_manager.health_check_interval` | u64 | 1 〜 3,600,000 | ヘルスチェック間隔 |
| `llm_manager.health_check_interval_ms` | u64 | 1 〜 3,600,000 (ms) | ヘルスチェック間隔（ms） |
| `llm_manager.stream_channel_buffer` | u64 | 1 〜 65,536 | ストリーミングチャネルバッファサイズ |
| `llm_manager.stream_internal_buffer` | u64 | 1 〜 65,536 | ストリーミング内部バッファサイズ |

---

## 6. `models_gguf` — GGUFモデル設定

各モデルは `models_gguf.<name>` で定義。

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `models_gguf.<name>.path` | string | **必須** | モデルファイルパス（`ollama://` プレフィックス可） |
| `models_gguf.<name>.port` | u64 | 1 〜 65,535 | 推論サーバーのポート |
| `models_gguf.<name>.n_ctx` | u64 | 1 〜 10,000,000 | コンテキストウィンドウサイズ |
| `models_gguf.<name>.n_gpu_layers` | i64 | -1 〜 1,000,000 | GPU使用レイヤー数（-1=全部） |
| `models_gguf.<name>.temperature` | number | — | 生成温度 |
| `models_gguf.<name>.top_k` | i64 | 0 〜 1,000,000 | Top-Kサンプリング |
| `models_gguf.<name>.top_p` | number | — | Top-Pサンプリング |
| `models_gguf.<name>.repeat_penalty` | number | — | 繰り返しペナルティ |
| `models_gguf.<name>.max_tokens` | i64 | 1 〜 1,000,000 | 最大生成トークン数 |
| `models_gguf.<name>.predict_len` | i64 | 1 〜 1,000,000 | 予測長（`max_tokens` の別名） |
| `models_gguf.<name>.stop` | string[] | — | 停止シーケンスリスト |
| `models_gguf.<name>.seed` | i64 | — | 乱数シード |
| `models_gguf.<name>.frequency_penalty` | number | — | 頻度ペナルティ |
| `models_gguf.<name>.presence_penalty` | number | — | 存在ペナルティ |
| `models_gguf.<name>.min_p` | number | — | Min-Pサンプリング |
| `models_gguf.<name>.tfs_z` | number | — | Tail Free Sampling |
| `models_gguf.<name>.typical_p` | number | — | Typical-Pサンプリング |
| `models_gguf.<name>.mirostat` | i64 | 0 〜 100 | Mirostatモード |
| `models_gguf.<name>.mirostat_tau` | number | — | Mirostat τパラメータ |
| `models_gguf.<name>.mirostat_eta` | number | — | Mirostat ηパラメータ |
| `models_gguf.<name>.repeat_last_n` | i64 | -1 〜 1,000,000 | ペナルティ適用する直近Nトークン |
| `models_gguf.<name>.penalize_nl` | bool | — | 改行をペナルティ対象にするか |
| `models_gguf.<name>.n_keep` | i64 | -1 〜 1,000,000 | 保持するプロンプトトークン数 |
| `models_gguf.<name>.cache_prompt` | bool | — | プロンプトキャッシュの有効/無効 |
| `models_gguf.<name>.num_ctx` | i64 | 1 〜 10,000,000 | コンテキストサイズ（Ollama互換） |
| `models_gguf.<name>.tokenizer_path` | string? | — | カスタムトークナイザーのパス |
| `models_gguf.<name>.tokenizer_format` | string? | — | トークナイザーのフォーマット |
| `models_gguf.<name>.loader_specific_settings` | string? | — | ローダー固有の設定JSON |

> [!IMPORTANT]
> `text_model` と `embedding_model` は特別な予約名で、デフォルトロールに使用されます。

---

## 7. `loaders` — 外部ローダー設定

| キー | 型 | 用途 |
|---|---|---|
| `loaders.<name>.base_url` | string | ローダーの接続先URL |

---

## 8. [tools](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/mcp/config_store.rs#79-108) — ツール設定

| キー | 型 | 選択肢 | 用途 |
|---|---|---|---|
| `tools.search_provider` | string | `google`, `duckduckgo`, `brave`, `bing` | Web検索プロバイダー |
| `tools.brave_search_api_key` | string (機密) | — | Brave Search APIキー |
| `tools.bing_search_api_key` | string (機密) | — | Bing Search APIキー |
| `tools.google_search_api_key` | string (機密) | — | Google Search APIキー |
| `tools.google_search_engine_id` | string (機密) | — | Google検索エンジンID |

---

## 9. `privacy` — プライバシー設定

| キー | 型 | 選択肢 | 用途 |
|---|---|---|---|
| `privacy.allow_web_search` | bool | — | Web検索の許可/禁止 |
| `privacy.isolation_mode` | bool | — | 隔離モード（有効時は `allow_web_search` を強制 false にしWeb完全遮断） |
| `privacy.url_denylist` | string[] | — | アクセス禁止URLリスト |
| `privacy.url_policy_preset` | string | `strict`, `balanced`, `permissive` | URLポリシープリセット |
| `privacy.lockdown.enabled` | bool | — | ロックダウンモード |
| `privacy.lockdown.updated_at` | string? | — | 最終更新日時 |
| `privacy.lockdown.reason` | string? | — | ロックダウン理由 |

---

## 10. `search` — 検索設定

| キー | 型 | 用途 |
|---|---|---|
| `search.embedding_rerank` | bool | 埋め込みリランキングの有効/無効 |

---

## 11. `permissions` — 権限設定

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `permissions.default_ttl_seconds` | u64 | 60 〜 31,536,000 | 許可のデフォルトTTL（秒） |
| `permissions.native_tools.<tool>.decision` | string | `deny`, `once`, `always_until_expiry` | ネイティブツール許否 |
| `permissions.native_tools.<tool>.expires_at` | string? | — | 有効期限 |
| `permissions.mcp_servers.<server>.decision` | string | `deny`, `once`, `always_until_expiry` | MCPサーバー許否 |
| `permissions.mcp_servers.<server>.expires_at` | string? | — | 有効期限 |

---

## 12. `model_download` — モデルダウンロードポリシー

| キー | 型 | 用途 |
|---|---|---|
| `model_download.require_allowlist` | bool | 許可リスト必須 |
| `model_download.warn_on_unlisted` | bool | 未リスト時に警告 |
| `model_download.require_revision` | bool | リビジョン指定を必須に |
| `model_download.require_sha256` | bool | SHA256チェック必須 |
| `model_download.allow_repo_owners` | string[] | 許可するリポジトリオーナー |

---

## 13. `credentials` — 資格情報

各プロバイダー `credentials.<provider>` で管理。

| キー | 型 | 用途 |
|---|---|---|
| `credentials.<provider>.api_key` | string (機密) | APIキー |
| `credentials.<provider>.expires_at` | string? | 有効期限 |
| `credentials.<provider>.last_rotated_at` | string? | 最終ローテーション日時 |
| `credentials.<provider>.status` | string? | ステータス |

---

## 14. `backup` — バックアップ設定

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `backup.enable_restore` | bool | — | リストア許可 |
| `backup.startup_auto_backup_limit` | u64 | 1 〜 1,000 | 起動時自動バックアップの最大数 |
| `backup.include_chat_history` | bool | — | チャット履歴を含める |
| `backup.include_settings` | bool | — | 設定を含める |
| `backup.include_characters` | bool | — | キャラクターを含める |
| `backup.include_executors` | bool | — | エグゼキューターを含める |
| `backup.encryption.enabled` | bool | — | 暗号化有効 |
| `backup.encryption.algorithm` | string? | — | 暗号化アルゴリズム |

---

## 15. `quarantine` — MCP検疫設定

| キー | 型 | 用途 |
|---|---|---|
| `quarantine.enabled` | bool | 検疫機能の有効/無効 |
| `quarantine.required` | bool | 検疫の必須化 |
| `quarantine.required_transports` | string[] | 検疫必須のトランスポート |

---

## 16. `agent_skills` — エージェントスキルルート

| キー | 型 | 用途 |
|---|---|---|
| `agent_skills.roots[].path` | string (必須) | スキルルートディレクトリパス |
| `agent_skills.roots[].enabled` | bool | 有効/無効 |
| `agent_skills.roots[].label` | string? | 表示ラベル |

---

## 17. `features` — フィーチャーフラグ

| キー | 型 | 選択肢 | 用途 |
|---|---|---|---|
| `features.redesign.<key>` | bool | — | 各リデザイン機能のON/OFF |
| `features.redesign.transport_mode` | string | `ipc`, `websocket` | V2フロントのトランスポートモード |

---

## 18. `em_llm` — エピソード記憶パラメータ

### 18a. `em_llm.decay` — 減衰エンジン設定

| キー | 型 | デフォルト | 範囲 | 用途 |
|---|---|---|---|---|
| `em_llm.decay.lambda_base` | f64 | (defaults) | 0.000001 〜 10.0 | 基本減衰率 |
| `em_llm.decay.importance_modulation` | f64 | (defaults) | 0.0 〜 10.0 | 重要度変調 |
| `em_llm.decay.beta_lml` | f64 | (defaults) | 0.1 〜 5.0 | LML層のβ減衰係数 |
| `em_llm.decay.beta_sml` | f64 | (defaults) | 0.1 〜 5.0 | SML層のβ減衰係数 |
| `em_llm.decay.promote_threshold` | f64 | (defaults) | 0.0 〜 1.0 | LMLへの昇格閾値 |
| `em_llm.decay.demote_threshold` | f64 | (defaults) | 0.0 〜 1.0 | SMLへの降格閾値 |
| `em_llm.decay.prune_threshold` | f64 | (defaults) | 0.0 〜 1.0 | 削除閾値 |
| `em_llm.decay.reinforcement_delta` | f64 | (defaults) | 0.0 〜 1.0 | 強化デルタ |
| `em_llm.decay.alpha` | f64 | (defaults) | 0.0 〜 1.0 | αパラメータ |
| `em_llm.decay.beta` | f64 | (defaults) | 0.0 〜 1.0 | βパラメータ |
| `em_llm.decay.gamma` | f64 | (defaults) | 0.0 〜 1.0 | γパラメータ |
| `em_llm.decay.frequency_growth_rate` | f64 | (defaults) | 0.01 〜 2.0 | 頻度成長率 |
| `em_llm.decay.recency_time_constant` | f64 | (defaults) | 0.1 〜 365.0 | 近時性時定数 |
| `em_llm.decay.time_unit` | string | [days](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/infrastructure/episodic_store/em_llm/service.rs#1134-1141) | `hours`, [days](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/infrastructure/episodic_store/em_llm/service.rs#1134-1141) | 時間単位 |
| `em_llm.decay.transition_hysteresis` | f64 | (defaults) | 0.0 〜 1.0 | 遷移ヒステリシス |

### 18b. `em_llm.retrieval` — 検索設定

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `em_llm.retrieval.similarity_ratio` | f64 | 0.0 〜 1.0 | 類似度比率 |

---

## 19. `llm_defaults` — グローバルLLMデフォルト設定

`validate_sampling_config` を共有しており、`models_gguf.<name>` と同じサンプリングパラメータすべてをグローバルデフォルト値として設定可能です。個別モデル設定（`models_gguf.<name>`）に値がない場合、こちらの値がフォールバックとして使用されます。

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `llm_defaults.temperature` | number | — | デフォルト生成温度 |
| `llm_defaults.top_p` | number | — | デフォルト Top-P |
| `llm_defaults.top_k` | i64 | 0 〜 1,000,000 | デフォルト Top-K |
| `llm_defaults.repeat_penalty` | number | — | デフォルト繰り返しペナルティ |
| `llm_defaults.max_tokens` | i64 | 1 〜 1,000,000 | デフォルト最大生成トークン数 |
| `llm_defaults.predict_len` | i64 | 1 〜 1,000,000 | デフォルト予測長 |
| `llm_defaults.stop` | string[] | — | デフォルト停止シーケンス |
| `llm_defaults.seed` | i64 | — | デフォルト乱数シード |
| `llm_defaults.frequency_penalty` | number | — | デフォルト頻度ペナルティ |
| `llm_defaults.presence_penalty` | number | — | デフォルト存在ペナルティ |
| `llm_defaults.min_p` | number | — | デフォルト Min-P |
| `llm_defaults.tfs_z` | number | — | デフォルト TFS |
| `llm_defaults.typical_p` | number | — | デフォルト Typical-P |
| `llm_defaults.mirostat` | i64 | 0 〜 100 | デフォルト Mirostatモード |
| `llm_defaults.mirostat_tau` | number | — | デフォルト Mirostat τ |
| `llm_defaults.mirostat_eta` | number | — | デフォルト Mirostat η |
| `llm_defaults.repeat_last_n` | i64 | -1 〜 1,000,000 | デフォルトペナルティ対象トークン数 |
| `llm_defaults.penalize_nl` | bool | — | デフォルト改行ペナルティ |
| `llm_defaults.n_keep` | i64 | -1 〜 1,000,000 | デフォルト保持トークン数 |
| `llm_defaults.cache_prompt` | bool | — | デフォルトプロンプトキャッシュ |
| `llm_defaults.num_ctx` | i64 | 1 〜 10,000,000 | デフォルトコンテキストサイズ |

---

## 20. `rag` — RAG検索設定

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `rag.search_default_limit` | u64 | 1 〜 20 | ベクトル検索のデフォルト結果件数 |
| `rag.text_search_default_limit` | u64 | 1 〜 50 | テキスト検索のデフォルト結果件数 |
| `rag.embedding_timeout_ms` | u64 | 1 〜 3,600,000 (ms) | 埋め込み生成タイムアウト |
| `rag.chunk_window_default_chars` | u64 | 128 〜 20,000 | チャンク展開のデフォルトウィンドウサイズ（文字数） |

---

## 21. `agent` — エージェント実行設定

| キー | 型 | 範囲 | 用途 |
|---|---|---|---|
| `agent.max_attachments` | u64 | 1 〜 100 | ツール実行時の添付ファイル上限数 |
| `agent.attachment_preview_chars` | u64 | 1 〜 1,000,000 | 添付コンテンツのプレビュー文字数 |

---

## 22. `context_window` — コンテキストウィンドウ設定

モード/ステージごとのコンテキストウィンドウキャップ比率と制御パラメータを上書きします。構造は `context_window.<mode>.<stage>.<param>` または `context_window.<mode>.<param>`（ステージ省略時はモード全体に適用）。

**利用可能なモード**: `chat`, `search_fast`, `search_agentic`, `agent_high`, `agent_low`, `agent_direct`

**利用可能なステージ**: `main`, `search_query_generate`, `search_chunk_select`, `search_report_build`, `search_final_synthesis`, `agent_planner`, `agent_executor`, `agent_synthesizer`, `default`

| パラメータ | 型 | 範囲 | 用途 |
|---|---|---|---|
| `system_cap` | u64 | 0 〜 100 (%) | システムプロンプトの最大比率 |
| `memory_cap` | u64 | 0 〜 100 (%) | エピソード記憶の最大比率 |
| `local_context_cap` | u64 | 0 〜 100 (%) | ローカルコンテキストの最大比率 |
| `interaction_tail_cap` | u64 | 0 〜 100 (%) | 会話履歴の最大比率 |
| `evidence_cap` | u64 | 0 〜 100 (%) | 検索エビデンスの最大比率 |
| `artifact_summary_cap` | u64 | 0 〜 100 (%) | アーティファクト要約の最大比率 |
| `app_thinking_digest_cap` | u64 | 0 〜 100 (%) | アプリ思考ダイジェストの最大比率 |
| `model_thinking_digest_cap` | u64 | 0 〜 100 (%) | モデル思考ダイジェストの最大比率 |
| `user_input_cap` | u64 | 0 〜 100 (%) | ユーザー入力の最大比率 |
| `evidence_limit` | u64 | 0 〜 100 | 検索結果の最大件数 |
| `artifact_limit` | u64 | 0 〜 100 | アーティファクトの最大件数 |

> [!TIP]
> 例: `context_window.chat.system_cap: 25` で Chat モードのシステムプロンプト比率を 25% に変更。`context_window.agent_high.agent_executor.evidence_limit: 3` でエージェントの Executor ステージの検索結果上限を 3 件に変更。

---

## 23. [server](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/server/handlers/setup.rs#1514-1542) — サーバー設定

| キー | 型 | 用途 |
|---|---|---|
| `server.host` | string | バインドホスト |
| `server.allowed_origins` | string[] | 許可オリジン |
| `server.cors_allowed_origins` | string[] | CORS許可オリジン |
| `server.ws_allowed_origins` | string[] | WebSocket許可オリジン |

---

## 24. [default_models](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/server/handlers/setup.rs#311-338) — デフォルトモデル定義

| キー | 型 | 用途 |
|---|---|---|
| `default_models.text_models` | array | テキスト用デフォルトモデル群 |
| `default_models.embedding` | object | 埋め込み用デフォルトモデル |
| `default_models.character` | object | キャラクター用デフォルト |
| `default_models.executor` | object | エグゼキューター用デフォルト |
| `default_models.text` | object | テキスト用デフォルト |

---

## 設定UIへの推奨カテゴリ分類

| UIカテゴリ | 対応セクション | 優先度 |
|---|---|---|
| **一般設定** | `app.language`, `active_agent_profile` | 🔴 必須 |
| **キャラクター管理** | `characters.*`, `custom_agents.*` | 🔴 必須 |
| **モデル管理** | `models_gguf.*`, `llm_manager.*`, `llm_defaults.*`, `loaders.*`, `default_models.*` | 🔴 必須 |
| **プライバシー & セキュリティ** | `privacy.*`（`isolation_mode` 含む）, `quarantine.*`, `permissions.*` | 🔴 必須 |
| **ツール設定** | `tools.*`（検索APIキー含む）, `agent_skills.*` | 🟡 推奨 |
| **記憶 (EM) 設定** | `app.em_memory_enabled`, `em_llm.decay.*`, `em_llm.retrieval.*` | 🟡 推奨 |
| **会話・コンテキスト** | `app.history_limit`, `app.entity_extraction_limit`, `context_window.*` | 🟡 推奨 |
| **RAG設定** | `rag.*` | 🟡 推奨 |
| **エージェント実行** | `agent.*` | 🟡 推奨 |
| **バックアップ** | `backup.*` | 🟡 推奨 |
| **認証情報** | `credentials.*` | 🟡 推奨 |
| **モデルDLポリシー** | `model_download.*` | 🟢 上級者向け |
| **フィーチャーフラグ** | `features.*` | 🟢 上級者向け |
| **サーバー設定** | `server.*` | 🟢 上級者向け |
| **実行パラメータ** | `app.max_input_length`, `app.*_timeout`, `app.graph_*` | 🟢 上級者向け |
