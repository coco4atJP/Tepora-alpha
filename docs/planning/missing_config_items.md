# バックエンド未設定項目レポート

> [!IMPORTANT]
> 現在バックエンドでハードコードされているが、設定UIで変更可能にすべき（または設定スキーマに登録すべき）項目のリストです。

---

## A. コード内で参照されているが、バリデーションスキーマに未登録の設定キー

これらはコード内で `config.get()` 経由で読み取られ、設定ファイルに書けば効くが、[validation.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/core/config/validation.rs) に正式なスキーマがなくUIにも出ていない項目です。

### A1. `privacy.isolation_mode` 🔴 重要

| 項目 | 内容 |
|---|---|
| 参照箇所 | [web_security.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/web_security.rs#L93-L99) |
| 型 | [bool](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/core/config/validation.rs#304-317) (デフォルト: [false](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/runtime.rs#600-611)) |
| 効果 | [true](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/web_security.rs#269-278) にすると [allow_web_search](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/web_security.rs#82-92) が強制 [false](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/graph/runtime.rs#600-611) に（Web完全遮断） |
| 現状 | `privacy.*` バリデーションに含まれない。設定UIが無い |

### A2. `llm_manager` タイムアウト群 🟡 推奨

| キー | デフォルト | 参照箇所 |
|---|---|---|
| `llm_manager.process_terminate_timeout` | 5,000 ms | [external_loader_common.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/external_loader_common.rs#L16-L27) |
| `llm_manager.external_request_timeout_ms` | 120,000 ms | [同上](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/external_loader_common.rs#L29-L43) |
| `llm_manager.stream_idle_timeout_ms` | 60,000 ms | [同上](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/external_loader_common.rs#L45-L56) |

### A3. [tools](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/mcp/config_store.rs#79-108) 内の検索APIキー群 🟡 推奨

| キー | 参照箇所 |
|---|---|
| `tools.brave_search_api_key` | [search.rs:24](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#L22-L26) |
| `tools.bing_search_api_key` | [search.rs:34](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#L33-L36) |
| `tools.google_search_api_key` | [search.rs:43](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#L42-L46) |
| `tools.google_search_engine_id` | [search.rs:48](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#L47-L50) |

> [!TIP]
> これらは機密情報なので `secrets.yml`（キーリング）経由の管理が適切です。`credentials` セクションに統合検討を推奨。

---

## B. ハードコードされているが、設定可能にすべき定数

### B1. コンテキストウィンドウ制御 🟡 推奨

[controller.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/controller.rs#L519-L743) にて、モード/ステージごとのキャップ比率がすべてハードコードされています：

| パラメータ | 現在の値 (Chat例) | 意味 |
|---|---|---|
| `System キャップ` | 20% | システムプロンプトの最大比率 |
| `Memory キャップ` | 45% | エピソード記憶の最大比率 |
| `LocalContext キャップ` | 20% | ローカルコンテキストの最大比率 |
| `InteractionTail キャップ` | 5% | 会話履歴の最大比率 |
| `evidence_limit` | 0〜5 (モード依存) | 検索結果の最大件数 |
| `artifact_limit` | 0〜5 (モード依存) | アーティファクトの最大件数 |

> [!NOTE]
> これは上級者向け設定として提供可能。まとめて `context_window` セクションに。

### B2. 会話履歴取得数 🟡 推奨

| パラメータ | ハードコード値 | 参照箇所 |
|---|---|---|
| `MemoryWorker.history_limit` | **6** | [memory_worker.rs:29](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/memory_worker.rs#L28-L31) |

コンテキストに含める直近の会話履歴ペア数を制御。モデルのコンテキスト長やユーザーの好みで調整可能にすべき。

### B3. LLMデフォルト生成パラメータ 🟡 推奨

[llama_service.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/llama_service.rs#L316-L324) でのデフォルト値：

| パラメータ | ハードコード | 意味 |
|---|---|---|
| `n_predict` | 1024 | 最大生成トークン数 |
| `temperature` | 0.7 | 生成温度 |
| `top_p` | 0.9 | Top-P |
| `top_k` | 40 | Top-K |
| `repeat_penalty` | 1.1 | 繰り返しペナルティ |

> [!WARNING]
> これらは `models_gguf.<name>` 内の個別モデル設定で上書き可能だが、**グローバルデフォルト**として設定する手段がありません。設定UIの「モデル設定 → デフォルトサンプリング」セクションとして追加すべき。

### B4. `models_gguf` の拡張サンプリングパラメータ 🟢 上級者向け

`ChatRequest::with_config` ([types.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/types.rs#L96-L188)) は以下を `models_gguf.<name>` から読み取るが、[validation.rs](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/core/config/validation.rs) のスキーマにほとんど登録されていません：

| パラメータ | 型 | 現在の設定スキーマ |
|---|---|---|
| `repeat_penalty` | f64 | ❌ 未登録 |
| `max_tokens` | i32 | ❌ 未登録 |
| [stop](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/llama_service.rs#105-109) | string[] | ❌ 未登録 |
| `seed` | i64 | ❌ 未登録 |
| `frequency_penalty` | f64 | ❌ 未登録 |
| `presence_penalty` | f64 | ❌ 未登録 |
| `min_p` | f64 | ❌ 未登録 |
| `tfs_z` | f64 | ❌ 未登録 |
| `typical_p` | f64 | ❌ 未登録 |
| `mirostat` | i32 | ❌ 未登録 |
| `mirostat_tau` | f64 | ❌ 未登録 |
| `mirostat_eta` | f64 | ❌ 未登録 |
| `repeat_last_n` | i32 | ❌ 未登録 |
| `penalize_nl` | bool | ❌ 未登録 |
| `n_keep` | i32 | ❌ 未登録 |
| `cache_prompt` | bool | ❌ 未登録 |
| `num_ctx` | i32 | ❌ 未登録 |

### B5. RAG関連定数 🟢 上級者向け

| パラメータ | ハードコード値 | 参照箇所 | 意味 |
|---|---|---|---|
| RAG検索デフォルトlimit | 5 (clamp 1〜20) | [rag.rs:35](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/rag.rs#L32-L36) | ベクトル検索結果数 |
| RAGテキスト検索limit | 10 (clamp 1〜50) | [rag.rs:155](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/rag.rs#L152-L156) | テキスト検索結果数 |
| 埋め込み用タイムアウト | 5秒 | [rag.rs:42](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/rag.rs#L42), [reranker.rs:36](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/reranker.rs#L36) | 埋め込み生成タイムアウト |
| チャンクウィンドウデフォルト | 1200文字 (128〜20000) | [rag.rs:244](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/rag.rs#L239-L245) | チャンク展開サイズ |

### B6. その他のハードコード定数 🟢 上級者向け

| パラメータ | 値 | 参照箇所 | 意味 |
|---|---|---|---|
| 添付ファイル最大数 | 5 | [execution.rs:274](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/agent/execution.rs#L274) | ツール実行時の添付上限 |
| 添付プレビュー文字数 | 500 | [execution.rs:285](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/agent/execution.rs#L285) | 添付コンテンツのプレビュー長 |
| llama-serverヘルスチェックリトライ | 30回 (各500ms) | [llama_service.rs:19,206](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/llama_service.rs#L19) | サーバー起動待ちリトライ |
| ストリーミングチャンネルバッファ | 128/100 | [service.rs:133](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/service.rs#L133), [llama_service.rs:475](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/llm/llama_service.rs#L475) | 内部バッファサイズ |
| エンティティ抽出最大数 | 6個 | [memory_worker.rs:291](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/context/workers/memory_worker.rs#L291) | セッションエンティティ数上限 |

---

## まとめ: 設定UIへの推奨追加

| 優先度 | カテゴリ | 追加すべき設定項目 |
|---|---|---|
| 🔴 **必須** | プライバシー | `privacy.isolation_mode` |
| 🟡 **推奨** | ツール認証 | 検索APIキー群 ([brave](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#196-245), [bing](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#246-291), [google](file:///e:/Tepora_Project/Tepora-app/backend-rs/src/tools/search.rs#68-128)) |
| 🟡 **推奨** | 会話制御 | `app.history_limit` (現ハードコード: 6) |
| 🟡 **推奨** | LLMデフォルト | グローバルサンプリングパラメータ (`n_predict`, `temperature` 等) |
| 🟡 **推奨** | LLM接続 | `llm_manager.*` タイムアウト群 |
| 🟢 **上級者** | モデル詳細 | 拡張サンプリングパラメータ16項目 |
| 🟢 **上級者** | コンテキスト | ウィンドウキャップ比率・検索結果/アーティファクト上限 |
| 🟢 **上級者** | RAG | デフォルト検索件数・タイムアウト |
