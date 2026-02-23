# 設定

## 一般

- 外観
  - テーマ
  - 言語
  - フォント・表示サイズ
  - コードブロック設定 (シンタックスハイライトテーマ、折り返し、行番号)
- 通知設定
  - バックグラウンドタスク完了通知 (OS通知ON/OFF、通知音)
- ショートカットキー / ホットキー
  - 新規チャット開始など
- 入力制限
  - 最大入力長 (max_input_length)
- 検索エンジン
  - 検索プロバイダ選択 (Google / DuckDuckGo / Brave / Bing)
  - APIキー設定
    - Google Search API Key / Engine ID
    - Brave Search API Key
    - Bing Search API Key
  - Webfetch最大取得文字数
  - Webfetch最大取得サイズ (バイト数)
  - Webfetchタイムアウト (秒)
  - 埋め込みモデルによるリランク
- Thinkingの実行設定
  - Thinking最大トークン数
  - チャット時のデフォルトThinking ON/OFF
  - 検索時のデフォルトThinking ON/OFF
- エージェント設定
  - グラフ再帰上限 (graph_recursion_limit)
  - グラフ実行タイムアウト (graph_execution_timeout)
  - ツール実行タイムアウト (tool_execution_timeout)
  - ツール承認タイムアウト (tool_approval_timeout)

## データ管理・ストレージ

- チャンクサイズ（文字数/トークン数）とオーバーラップサイズ
- インデックス化対象の監視フォルダ指定
- 保存先ディレクトリ指定
  - ベクターストア (Db) の保存先
  - モデルファイルの保存先
- バックアップ・復元
  - チャット履歴、設定データ、キャラクター/Executorのインポート・エクスポート
  - エクスポート形式選択 (JSON / SQLite dump)
- キャッシュ管理
  - Webfetchのキャッシュクリア
  - 古い埋め込みデータ・不要な一時ファイルの削除 / 容量上限設定

## セキュリティ / プライバシー

- ツールセキュリティポリシー
  - 接続モード
  - 許可ツールリスト or 拒否ツールリスト
  - ツール実行確認
  - 初回ツール実行確認
  - ブロックコマンドリスト (dangerous_patterns)
- プライバシー保護
  - Web検索許可 (allow_web_search)
  - 個人情報自動リダクション ON/OFF (redact_pii)
  - URLブロックリスト (url_denylist)

### ネットワーク

- プロキシ設定 (HTTP/HTTPS)
- カスタム証明書
- ダウンロードポリシー
  - 許可リスト必須
    - 許可するリポジトリ
  - 確認警告必須
  - リビジョン
  - 整合性確認

### サーバー設定

- ホスト (host)
- 許可オリジン (allowed_origins)
- CORS許可オリジン (cors_allowed_origins)
- WebSocket許可オリジン (ws_allowed_origins)

## システム統合・パフォーマンス

- 起動設定
  - OS起動時の自動起動
  - ウィンドウを閉じた際のシステムトレイ常駐
- ハードウェア設定
  - ハードウェアアクセラレーション (UIのGPU描画ON/OFF)
- リソース管理
  - GPU VRAM上限設定
  - メモリ使用上限設定

## カスタム

### キャラクター

- キャラクターリスト
  - 名前
  - 説明文 (description)
  - キャラクタープロンプト編集
  - アイコン 画像変更
  - 使用モデル
    - モデル設定オーバーライド
- NSFW許可プロンプトON/OFF
- キャラクターのインポート・エクスポート (個別)

### Executor

- Executorリスト
  - 名前
  - Executorプロンプト編集
  - アイコン変更
  - 使用可能ツール
  - エージェント推奨度
  - 使用モデル
    - モデル設定オーバーライド

## モデル

- モデル追加・更新
  - ダウンロード
    - HuggingFace Hub
    - ローカルファイル
  - Ollama接続更新
  - LM Studio接続更新
- モデルリスト（一覧・管理）
  - モデルパラメータ詳細設定
    - Temperature / Top-P / Top-K
    - Repetition Penalty
    - コンテキスト長 (n_ctx)
    - GPUオフロード層数 (n_gpu_layers)
    - 最大生成トークン数 (max_tokens)
    - 予測長 (predict_len)
    - 対数確率出力 (logprobs ON/OFF)
    - システムプロンプトのプレフィックス / サフィックス追加設定
    - ローダー固有設定
  - モデル削除
  - モデルサイズ確認 ローダー確認 ロール確認
- モデル規定値
  - キャラクター規定モデル
  - Supervisor/Planner規定モデル
  - Executor規定モデル
- 埋め込みモデル
  - パラメータ設定
    - コンテキスト長
    - ローダー固有設定

### LLMマネージャー

- モデルローダー
  - Ollama Base URL
  - LM Studio Base URL
- モデルキャッシュ数
- プロセス終了タイムアウト (process_terminate_timeout)
- ヘルスチェックタイムアウト (health_check_timeout)
- ヘルスチェック間隔 (health_check_interval)
- トークナイザーモデル指定 (tokenizer_model_key)
- キャッシュサイズ (cache_size)

## MCP

- コンフィグパス
- 環境変数 (Environment Variables) 管理
  - サーバーごとに必要なAPIキーやシークレット情報の設定

### MCPストア

- 検索
- サーバーリスト
  - サーバー詳細

### 登録済みサーバーリスト

- 起動停止
- サーバー詳細
  - コンフィグ編集
- オート実行許可
- サーバーヘルスステータス表示
- 接続エラー時のリトライポリシー

## メモリ

- ローカルコンテキストウィンドウ (max_tokens)
- 最大メッセージ数 (default_limit)

### EM-LLM

- パラメータ設定
  - surprise_gamma
  - min_event_size / max_event_size
  - total_retrieved_events
  - repr_topk
  - use_boundary_refinement (ON/OFF)
- 保存イベント一覧 (Memory Explorer)

## その他

- アプリ更新
- Llama.cpp更新
- タイムアウト設定
  - モデルローダー
  - ツール
- ログ
  - ログレベル
  - ログ保存期間
  - ログローテーション
- セットアップウィザード完了フラグ (setup_completed)
