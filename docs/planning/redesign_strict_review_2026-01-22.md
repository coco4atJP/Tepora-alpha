# Tepora 再設計（V2系統） 厳格レビュー報告書

**作成日**: 2026-01-22  
**対象リポジトリ**: `e:\Tepora_Project`  
**対象範囲（主要）**:
- 旧版: `格納/core_v1_archive/core/`（Core V1 アーカイブ）
- 新版: `Tepora-app/backend/src/core/` + `Tepora-app/backend/src/tepora_server/`
- 設計資料: `docs/architecture/ARCHITECTURE.md`（ver 2.8 / 最終更新 2026-01-11）、`docs/architecture/refactoring_plan_v2.md`（Draft / 2026-01-21）

---

## 0. 結論（要約）

再設計の狙い（Local-first / モジュラー化 / セッション並列 / MCP拡張 / UI統合）は妥当で、方向性自体は良いです。  
一方で現状は「**設計・命名・境界の整合**」が崩れている箇所が複数あり、V2を本番スイッチする前に **P0（停止級）** を潰さないと、運用時に **起動直後クラッシュ** / **検索品質の破綻** / **監視・UI表示の虚偽** が発生する可能性が高いです。

特に重要な停止級は以下です（詳細は後述）:
- **P0-1**: ToolProvider 契約破綻（`ToolManager` が `provider.name` を前提にしているのに、Provider側が満たしていない）✅ 解決済み
- **P0-2**: Searchノードのプロンプト不整合（`rag_context` 等がテンプレに入っておらず、RAGが事実上無効化）✅ 解決済み
- **P0-3**: V2切替（`TEPORA_USE_V2`）が REST API 側に反映されない（`active_core` と `state.core` の混在）✅ 解決済み

---

## 1. 前提・観測した構造

### 1.1 旧版（アーカイブ）の構造
旧版は `格納/core_v1_archive/core/` 配下に、以下のような構造でまとまっています（例）:
- `chat_history_manager.py`, `llm_manager.py`, `tool_manager.py`, `state.py`
- `graph/`（ルーティング/実行）
- `em_llm/`（記憶）
- `tools/`（ツール群）
- `mcp/`（MCP連携）

### 1.2 新版（V2系統の実装が混在している状態）
新版は `Tepora-app/backend/src/core/` 配下に、以下の"V2相当"のモジュール群が追加・改変されています:
- `system/`（logging, session）
- `context/`（history, window）
- `rag/`（engine, context_builder, manager）
- `agent/`（base, registry）
- `llm/service.py`（stateless を名乗る新サービス）
- `graph/runtime.py` + `graph/nodes/{chat,search,...}.py`
- `app_v2.py`（V2ファサード）

設計資料 `docs/architecture/refactoring_plan_v2.md` は「`src/core_v2` を新設する」と明記していますが、実装は `src/core/` に存在します。命名のズレがテスト・モック・参照箇所に波及しています（後述）。

### 1.3 V1/V2切替の現在地
`Tepora-app/backend/src/tepora_server/state.py` で `TEPORA_USE_V2=true` により V2 を有効化する設計になっています。
- `AppState.active_core` が V1/V2の実体を返す
- WebSocket のハンドラは `active_core` を使用している（良い）
- REST の一部が `state.core` を参照している（悪い: V2が反映されない）

---

## 2. 評価軸（レビュー観点）

本レビューでは、以下の観点で"厳格"に評価します。

1. **境界の厳密性**: 依存方向（下位→上位禁止）と責務分離が守られているか
2. **起動・運用可能性**: 最小構成でクラッシュせず起動し、診断情報が正しく出るか
3. **並列/セッション安全性**: 複数セッション同時実行に耐える設計・実装か
4. **品質・一貫性**: 命名・参照・テスト・ドキュメントが整合しているか
5. **安全性（ローカル運用含む）**: 誤設定・入力による機密露出・危険動作の経路があるか

---

## 3. 重大度別の指摘（P0/P1/P2）

### P0（停止級 / 直ちに修正が必要）

#### P0-1: ToolProvider の契約破綻で、V2の初期化が落ちる可能性が高い ✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-22  
> `ToolProvider` に `name` プロパティを追加し、すべてのProvider実装で実装。

**症状**:
- `ToolManager.initialize()` が `provider.name` を参照しますが、`ToolProvider` 抽象クラスに `name` が定義されていません。
- そのため、Provider実装（例: テスト用Mockや、実運用Provider）が `name` を持たない場合に初期化中に例外が発生します。

**関係ファイル**:
- `Tepora-app/backend/src/core/tools/base.py`（`ToolProvider` に `name` が無い）
- `Tepora-app/backend/src/core/tools/manager.py`（`provider.name` 前提）
- `Tepora-app/backend/src/core/tools/native.py` / `.../mcp.py`（Providerとして動くが `name` 未定義）

**影響**:
- `TeporaApp.initialize()`（V2）がツールロードで落ちる
- さらに、V2を `TEPORA_USE_V2=true` で有効化すると起動直後のバックグラウンド初期化が失敗し続ける

**推奨修正（最短）**:
- `ToolProvider` に `name: str` を契約として追加する（`@property` でも良い）
- 既存Providerに `name` を実装する
- `ToolManager` 側は `getattr(provider, "name", provider.__class__.__name__)` のようなフォールバックを持つ（防御的）

---

#### P0-2: SearchノードがRAG/検索結果をプロンプトへ渡していない（検索品質が破綻）✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-22  
> Searchノードのプロンプトテンプレートに `rag_context` を統合。

**症状**:
- `summarize_search_result_node()` で `rag_context`, `search_result`, `attachments` 等を入力として渡しているが、テンプレートがそれらを参照していないため、実質的にRAGが出力に反映されません。
- `stream_search_summary()` 側は `rag_context` を human message に埋めていますが、非ストリーム系と挙動が不一致で「ルート/実行経路により結果が変わる」状態です。

**関係ファイル**:
- `Tepora-app/backend/src/core/graph/nodes/search.py`

**影響**:
- Searchモードの回答が、コンテキスト不足/根拠不足になりやすい
- "引用（Source）" を求める設計意図（RAG）と現実の出力が乖離する
- デバッグが難しい（変数は渡しているのにプロンプトに入っていない）

**推奨修正**:
- system/human テンプレに `rag_context` / `search_result` / `attachments` を統一的に埋める
- ストリーミング・非ストリーミングで同等のプロンプト構造に揃える
- "引用必須（Sourceを含める）" の要件があるなら、テンプレに明示する（例: `[Source: ...]` を出力制約に含める）

---

#### P0-3: V2切替がREST APIに反映されず、状態表示が虚偽になる ✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-23  
> REST API全体で `active_core` を参照するよう統一。

**症状**:
- `AppState` は `active_core` を持つのに、REST API の一部が `state.core`（V1固定）を参照しています。
- WebSocket ハンドラは `active_core` を使っており、RESTとWSで「参照しているCoreが違う」状態が発生します。

**関係ファイル（例）**:
- `Tepora-app/backend/src/tepora_server/api/routes.py`（`state.core...` を参照）
- `Tepora-app/backend/src/tepora_server/api/sessions.py`（同様にV1固定の可能性）
- `Tepora-app/backend/src/tepora_server/api/session_handler.py`（`active_core` を参照しており良い）

**影響**:
- `/health` や `/api/status` 等がV2稼働時に誤情報を返す
- UIがRESTを参照している場合、画面の初期化状態・統計が崩れる

**推奨修正**:
- RESTも `active_core` を参照するよう統一する
- 併せて「V1/V2どちらを返しているか」をレスポンスに含める（`core_version: v1|v2` 等）

---

### P1（高優先 / 設計意図と実装のズレ）

#### P1-1: "core_v2" という命名がドキュメント/テスト/コードで混在している ✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-23  
> ドキュメントを更新し、`src/core/` に統一されていることを明記。

**観測**:
- 設計資料では `src/core_v2` 新設
- 実装は `src/core/` に存在（`app_v2.py` など）
- テストが `src.core_v2...` を patch して失敗するケースがある

**影響**:
- 参照のズレでモックが効かない/テストが壊れる
- "どれがV2なのか" がチーム内で曖昧になり保守性が落ちる

**推奨修正**:
- 方針を決めて統一する（推奨: 設計資料に合わせ `src/core_v2/` を新設し、`src/core/` はV1として凍結）
- 移行期は `src/core/__init__.py` で互換エクスポートする（ただし依存方向のルールを守る）

---

#### P1-2: Session/History が"プロトコル上は async"だが、実装は sync で噛み合っていない ✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-23  
> `SessionHistoryProtocol` を同期インターフェースに統一。

**観測**:
- `SessionHistoryProtocol` は `async def get_messages/add_message` を想定
- `context/history.py` の `SessionHistory` は sync メソッドを提供
- V2の `SessionManager` は現状 "保持するだけ" で、Graph/Nodeに履歴が自然に流れていない

**影響**:
- 以後、RAG/Agentの実装が進むほど「履歴の受け渡し」が複雑化し、修正コストが上がる
- "セッション並列" を目指す場合、I/O（SQLite等）部分のasync化/スレッド化戦略が必要

**推奨修正**:
- どちらかに寄せる（例: Protocolもsyncにする / 実装をasyncにする）
- `TeporaApp.process_message()` の入り口で「履歴取得→stateへ注入→完了後に保存」まで責務を明確化する

---

#### P1-3: LLMService の並列性（stateless主張）に対して排他・競合対策が不足 ✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-23  
> `LLMService` にスレッドセーフな `threading.Lock` を導入。

**観測**:
- "stateless" を名乗りつつ、実体は `model_key -> client` をキャッシュし、プロセスを起動する
- `get_client()` 同時実行時に二重起動/キャッシュ競合し得る（`model_key` 単位のロックが無い）
- `_CACHE_SIZE = 1` で常に追い出す挙動があり、複数ロールや複数セッションではスラッシングし得る

**影響**:
- 複数セッションの同時要求で不安定化（想定: 二重起動、ヘルスチェック競合、ポート競合）
- "Session parallel execution" の要件に対してボトルネックになる

**推奨修正**:
- `model_key` 単位の `asyncio.Lock`（またはスレッドロック）を導入し、起動を単一化する
- キャッシュ戦略（LRU/役割別常駐）を設計に落とす

---

### P2（中長期 / 事故予防・運用品質）

#### P2-1: カスタムエージェントのスキル読み込みが任意パス read で危険 ✅ 解決済み
> [!NOTE]
> **解決日**: 2026-01-23  
> `registry.py` の `load_skills()` にセキュリティ機能を追加：
> - 許可ディレクトリ制限（`PROJECT_ROOT/skills/`, `USER_DATA_DIR/skills/` 等）
> - `Path.resolve()` によるパストラバーサル防止
> - ファイルサイズ上限（1MB）
> - 拡張子制限（.md, .txt, .skill のみ）

**観測**:
- `CustomAgentRegistry.load_skills()` が設定にあるパスをそのまま `open()` して読み込む

**影響**:
- 誤設定/悪意ある設定により、ローカル機密ファイルをプロンプトに流し込みうる（Local-firstでも"漏えい"は起きる）

**推奨修正**:
- 読み込み許可ディレクトリを固定（例: `PROJECT_ROOT/skills/` 以下のみ）
- `Path.resolve()` してルート外参照をブロック
- 最大サイズ上限を設ける（巨大ファイル対策）

---

#### P2-2: 開発/検証環境でファイル書込み権限の問題が発生している ✅ 対応済み
> [!NOTE]
> **対応日**: 2026-01-23  
> `pytest.ini` と `pyproject.toml` にキャッシュディレクトリ設定を追加。

**観測**:
- `__pycache__` / `.pytest_cache` 作成で `WinError 5`（アクセス拒否）が出るケースがある

**影響**:
- CI/ローカルの検証が不安定化
- "検証できない設計" になりやすい（レビュー不能、回帰検知不能）

**推奨**:
- `backend/` 配下の書込み権限・属性（読み取り専用）を確認
- 生成物は `%LOCALAPPDATA%` 等に寄せるポリシーを統一

---

## 4. ドキュメントと実装の整合（ギャップ分析）

### 4.1 `ARCHITECTURE.md` との整合
`docs/architecture/ARCHITECTURE.md` は "V2の全体像" が十分に記述されており、方向性も明確です。  
ただしコード側は、以下の点で仕様に追随し切れていません。
- 「V2は `core_v2` に分離する」という約束（refactoring_plan）と現実の相違
- セッション並列のコア要件（LLMの排他/状態管理）に未到達
- RAGの出力要件（引用/根拠）をプロンプトに反映できていない

### 4.2 `refactoring_plan_v2.md` との整合
計画書（Draft）は "依存方向のルール" を明示しており良いです。  
ただし現行実装は、移行期の都合で `src.core.*` 参照が多数残っており、「今は許容」「いつ消すか」「互換レイヤの責務」を明文化しないと、長期的に "Big ball of mud" に戻るリスクがあります。

---

## 5. 推奨アクションプラン（最短で安定化させる）

### 5.1 48時間以内（P0解消）✅ 完了
1. ✅ ToolProvider契約修正（`name` 必須化＋既存Provider/Mock対応）
2. ✅ Searchノードのプロンプト統一（`rag_context` 等を必ず注入、stream/invokeで一致）
3. ✅ REST APIの `active_core` 統一（`/health` `/api/status` `/api/tools` `/api/sessions` 等）

### 5.2 1週間以内（P1の設計ギャップを縮める）✅ 完了
4. ✅ `core_v2` 命名/配置の統一（方針決定→リネーム→互換層→テスト修正）
5. ✅ Session/History の責務を入口に集約（`TeporaApp.process_message()` が履歴I/Oを担う）
6. ✅ LLMService に排他・キャッシュ戦略を導入（セッション並列の実要件に合わせる）

### 5.3 以後（P2の事故経路を潰す）✅ 完了
7. ✅ スキル読み込みのパス制限・上限設定
8. ✅ 生成物（キャッシュ/ログ/pycache）の配置ポリシー統一

---

## 6. 付録: 参考（レビュー時に確認したキー点）

- V2切替: `Tepora-app/backend/src/tepora_server/state.py`（`TEPORA_USE_V2`）
- V2ファサード: `Tepora-app/backend/src/core/app_v2.py`
- ツール: `Tepora-app/backend/src/core/tools/manager.py`, `.../tools/base.py`
- Graph: `Tepora-app/backend/src/core/graph/runtime.py`, `.../graph/nodes/search.py`
- 旧Core: `格納/core_v1_archive/core/`

