リファクタリングの「コードダイエット（不要コード削減・責務整理）」と「拡張しやすい堅牢なモジュール構造」を両立するために、現状分析→目標アーキテクチャ定義→段階的移行→品質ゲート整備、の順で進める計画にします。まずは全体の流れが見えるようにマイルストーン型のTODOを作ります。
## ゴール（コードダイエット + 拡張性の高いモジュール構造）
- **コードダイエット**
  - 未使用コード/重複コード/不要依存の削除
  - 「共通util化のしすぎ」を解消して、責務ごとに置き場所を固定
  - “動いているけど誰も使ってない” を可視化して削る
- **拡張性**
  - 機能追加が「既存コードの改造」ではなく「差し込み（プラグイン/プロバイダ追加）」で済む構造
  - 循環依存を禁止し、依存方向が一方向（レイヤー化）になるようにする
  - 公開API（importしてよい入口）を明確化して破壊的変更を減らす

※過去の状況メモ（参考）として、`ToolManager` のネイティブ/MCPヘルパを `agent_core.tools` に移し始めている点を前提に、以降も「順序立てて」移行できる計画にします。

---

## マイルストーン計画（段階的に安全に進める）
### 1) 現状把握と可視化（最初に必ずやる）
- **成果物**
  - エントリポイント一覧（CLI/アプリ起動/主要コマンド）
  - 依存関係マップ（パッケージ間の依存、循環参照の有無）
  - 削除候補リスト
    - 未使用モジュール/未参照関数
    - 重複ユーティリティ
    - 死んだ設定項目・フラグ
    - 使われていない外部依存
- **判断基準（ダイエットの基準）**
  - “参照されていない” だけで消さず、実行経路（CLI/起動時/プラグインロード）も含めて確認
  - 削除は「削除PR」として分離（構造変更PRと混ぜない）

### 2) 目標アーキテクチャ定義（ここで勝負が決まる）
- **成果物（`ARCHITECTURE.md` に確定）**
  - レイヤー定義と依存方向（例：`app` → `agent_core` → `infra` のみ、逆は禁止）
  - モジュール境界（何がどこに置かれるべきか）
  - 公開APIの定義（外から import していいのはどこか）
  - 拡張点（プラグイン・プロバイダ・ツール追加手順）
- **おすすめの形（例）**
  - `agent_core/`：ドメイン・ユースケース・抽象（Interface）
  - `adapters/`：外部I/O（CLI、HTTP、MCP、LLMベンダ、DB等）の実装
  - `app/`：アプリ組み立て（DI/設定読込/起動）
  - `shared/`：本当に横断的なものだけ（例外、ログ、型、定数）
  - `tests/`：レイヤー別に配置

### 3) 段階的モジュール再編（Strangler Fig方式で移行）
- **基本方針**
  - いきなり全部移さない  
    - “新しい入口” を作って少しずつ呼び替える
  - 移行中は互換レイヤーを用意（古い import を新しい場所へ転送）
- **優先順（効果が大きい順）**
  - 設定/DI/起動周り（構造の土台）
  - ツール管理（`ToolManager` など）を “インターフェース + 実装” に分離
  - メモリ/検索/ログ/履歴など横断関心事の整理
  - UI/CLI 表示（Rich）とコア処理の分離（コアは純粋ロジックに寄せる）

### 4) コードダイエット（削除・統合・標準化）
- **削る**
  - 未使用ファイル、未使用設定キー、死んだコマンド、古い試作コード
- **統合する**
  - “似た関数が複数箇所にある” を1箇所へ（ただし `shared` に寄せすぎない）
- **標準化する**
  - 例外階層、ログの取り方、設定の読み方、型定義（必要なら）

### 5) 品質ゲート（回帰防止・長期運用のため）
- **最低限のゲート**
  - ユニットテスト（コアから優先）
  - importルール/循環依存の検出
  - フォーマット/静的解析（導入済みなら設定統一）
- **完了条件**
  - 循環依存がゼロ
  - 公開API境界が明文化され、内部モジュールへ直接依存しない
  - 主要フロー（起動・主要コマンド・ツール実行）がテスト or スモークで保証される

---

## 進め方（PR/コミット運用ルール）
- **PRを分ける**
  - **構造変更PR**（移設/リネーム/依存整理）
  - **削除PR**（未使用コード削除）
  - **振る舞い変更PR**（機能追加・仕様変更）
- **毎PRで守ること**
  - “動作確認手順” を短く書ける粒度にする
  - 大規模移動は互換importで段階移行（いきなり全置換しない）

---

## 確認したいこと（計画をプロジェクトに最適化するため）
- **[質問1]** このプロジェクトの主言語/実行形態は Python（CLI中心）で合っていますか？
- **[質問2]** テスト/型チェック（pytest/mypy等）は既に導入済みですか？
- **[質問3]** 最優先で拡張したい機能領域はどれですか？（例：ツール追加、MCP連携、検索/メモリ、UI/CLI機能 など）

---

## ステータス
- **完了**: リファクタリング計画（マイルストーン + 進め方 + 完了条件）を提示
- **次にやると良いこと**: 上の質問に答えてもらえれば、`Tepora_Project` の実構造に合わせて「ディレクトリ案」と「移行順（どのファイルから移すか）」まで具体化します


===


いただいた回答を前提に、計画を「GUI移行後の現実（backend/frontend分離・起動経路・テスト配置）」に合わせて具体化します。まずコードベースを軽くスキャンして、エントリポイント（GUI/バックエンド起動）、現行モジュール境界、依存の絡み（特にCLI残骸とGUI層の混在）を特定します。その結果をもとに、推奨ディレクトリ構成案と“どのファイルからどう移すか”の移行順を提示します。次にリポジトリを検索します。
`code_search` が失敗したので、同等の調査を `list_dir` / `find_by_name` / `grep_search` / `read_file` の組み合わせで進めます。まずリポジトリの全体構造（`backend`/`frontend`、起動エントリ、依存管理ファイル、GUIフレームワーク）を特定し、次にモジュール境界とCLI残骸の混在箇所を洗い出します。あわせて、あなたの回答（Python+GUI移行、tests配置）をメモリに保存しておきます。

リポジトリ構造が把握できたので（[backend/](cci:7://file:///e:/Tepora_Project/backend:0:0-0:0) + [frontend/](cci:7://file:///e:/Tepora_Project/frontend:0:0-0:0)、さらに [frontend/src-tauri](cci:7://file:///e:/Tepora_Project/frontend/src-tauri:0:0-0:0) がある＝Tauri GUI構成）、次は **起動経路（GUI→backend）、CLI残骸の有無、モジュール境界が崩れている箇所** をファイル内容ベースで特定します。[server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0)、[backend/src](cci:7://file:///e:/Tepora_Project/backend/src:0:0-0:0)、[frontend/src-tauri](cci:7://file:///e:/Tepora_Project/frontend/src-tauri:0:0-0:0)、既存の[ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0)/[REFACTORING_SUMMARY.md](cci:7://file:///e:/Tepora_Project/backend/REFACTORING_SUMMARY.md:0:0-0:0)を読み、そこから「新しい推奨構造」と「移行順（どこから直すか）」を計画として落とし込みます。すぐ関連ファイルを読みます。

把握できた内容から、このリポジトリは **Tauri（[frontend/src-tauri](cci:7://file:///e:/Tepora_Project/frontend/src-tauri:0:0-0:0)）+ React（[frontend/src](cci:7://file:///e:/Tepora_Project/frontend/src:0:0-0:0)） + FastAPI（[backend/server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0)）** の三層構成だと分かりました。次に「GUI（Tauri）がどうやってPythonバックエンドを起動/接続しているか」と「backend/src/core のモジュール境界がどこで崩れているか（CLI残骸・互換レイヤーの有無）」を確認して、計画を“このコードベース専用”に落とし込みます。関連ファイルを追加で読みます。

GUI移行後の実態に合わせて、計画を「backend(FastAPI)」「frontend(React)」「tauri(配布/sidecar)」の3つの境界で整理し直します。今のコードを見る限り、起動方式（devは[start_app.bat](cci:7://file:///e:/Tepora_Project/start_app.bat:0:0-0:0)、prodはTauri sidecar想定）と、backend側のモジュール命名/責務（[server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0)が多機能、`agent_core`表記の残骸など）に“構造の歪み”があるので、そこを中心に段階的に直す手順にします。まずフロント側がバックエンド接続/起動をどう扱っているかを検索して確定します。




## いま分かった“GUI移行後の実態”（計画に反映済み）
- **[構成]** [frontend/](cci:7://file:///e:/Tepora_Project/frontend:0:0-0:0) は **React + Vite**、[frontend/src-tauri/](cci:7://file:///e:/Tepora_Project/frontend/src-tauri:0:0-0:0) は **Tauri**。[backend/](cci:7://file:///e:/Tepora_Project/backend:0:0-0:0) は **FastAPI + WebSocket**。
- **[起動経路が2系統]**
  - **開発（Web）**: [start_app.bat](cci:7://file:///e:/Tepora_Project/start_app.bat:0:0-0:0) → [scripts/start_backend.bat](cci:7://file:///e:/Tepora_Project/scripts/start_backend.bat:0:0-0:0)（python server.py）+ [scripts/start_frontend.bat](cci:7://file:///e:/Tepora_Project/scripts/start_frontend.bat:0:0-0:0)（vite dev）
  - **デスクトップ（Tauri）**: [frontend/src/utils/sidecar.ts](cci:7://file:///e:/Tepora_Project/frontend/src/utils/sidecar.ts:0:0-0:0) が `Command.sidecar('tepora-backend')` で **PyInstaller製バックエンド**を起動（[scripts/build_sidecar.py](cci:7://file:///e:/Tepora_Project/scripts/build_sidecar.py:0:0-0:0) / [tepora-backend.spec](cci:7://file:///e:/Tepora_Project/tepora-backend.spec:0:0-0:0)）。
- **[構造の歪み候補]**
  - [backend/server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) が **WebSocket/REST/静的配信/ログ/設定更新**まで抱えていて肥大化（責務過多）。
  - [backend/src/core/config/](cci:7://file:///e:/Tepora_Project/backend/src/core/config:0:0-0:0) に **パス解決ロジックが複数**（[paths.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/paths.py:0:0-0:0) と [loader.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/loader.py:0:0-0:0) で思想が別）。
  - [config/loader.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/loader.py:0:0-0:0) が **import時に [load_config()](cci:1://file:///e:/Tepora_Project/backend/src/core/config/loader.py:29:0-40:60) 実行**しており、テスト・起動形態（PyInstaller/Tauri）で事故りやすい。
- **[テスト]** [backend/tests](cci:7://file:///e:/Tepora_Project/backend/tests:0:0-0:0) は実在。フロントは [frontend/src/test](cci:7://file:///e:/Tepora_Project/frontend/src/test:0:0-0:0)（[tests](cci:7://file:///e:/Tepora_Project/backend/tests:0:0-0:0) ではなく [test](cci:7://file:///e:/Tepora_Project/frontend/src/test:0:0-0:0)）なので、ドキュメントとズレています。

---

## リファクタリング計画（“コードダイエット”＋“拡張性”に直結する順）
### 1) ランタイム境界の確定（最優先：迷子を止める）
- **[成果物]**
  - 「Web開発」(vite) と「Desktop配布」(Tauri sidecar) を **公式に両対応**するのか、または **どちらを主**にするのかを [ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0) に明記
  - 起動手順を **2ページに分離**（Web用 / Desktop用）
- **[狙い]** 起動経路が2つある状態でも、責務と手順が混ざらないようにする

### 2) backendのモジュール境界を作り直す（[server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) を分割）
- **[方針]** FastAPI層（I/O）とコアロジック（[TeporaCoreApp](cci:2://file:///e:/Tepora_Project/backend/src/core/app/core.py:31:0-406:39)）を明確分離
- **[具体]**
  - [backend/server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) → **アプリ生成だけ**に寄せる（`create_app()` 方式）
  - WebSocket処理・REST処理・静的配信を **別モジュールへ分離**
- **[成果物]** “どこに機能を足すべきか” が1秒で分かる構造

### 3) 設定・パス解決の一本化（GUI移行で壊れやすい最頻出原因）
- **[やること]**
  - `PROJECT_ROOT` / `MODEL_BASE_PATH` / [config.yml](cci:7://file:///e:/Tepora_Project/backend/config.yml:0:0-0:0) の解決を **1箇所に集約**
  - `import時ロード` をやめ、**起動時に明示ロード**（テスト容易性・sidecar安定化）
- **[成果物]** dev/prod（PyInstaller）/Tauri sidecar で同じ規約で動く

### 4) “拡張点”の設計（将来の機能追加が楽になる部分）
- **[対象]** Tool/MCP/Provider 系
- **[やること]**
  - [ToolManager](cci:2://file:///e:/Tepora_Project/backend/src/core/tool_manager.py:35:0-236:30) に「ツール追加の入口（interface）」を固定
  - “ツール増やす＝既存改造”にならないよう、登録方式を整理
- **[成果物]** 新機能追加が **新規ファイル追加中心**になる

### 5) コードダイエット（削除・統合・標準化）
- **[削る優先]**
  - CLI残骸（もし存在するなら）/未使用ユーティリティ/重複設定キー
  - ドキュメントの古い手順（GUI移行前の説明）
- **[統合]**
  - パス解決・ログ設定・例外整形などの“似た実装”を一本化

### 6) 品質ゲート（回帰防止）
- **[最低限]**
  - backend: [backend/tests](cci:7://file:///e:/Tepora_Project/backend/tests:0:0-0:0) が安定して回る状態
  - frontend: `vitest`（[frontend/src/test](cci:7://file:///e:/Tepora_Project/frontend/src/test:0:0-0:0)）が回る状態
  - **契約テスト**: WebSocketのメッセージschema（`chunk/done/stats/activity/search_results`）の破壊を検知

---

## 次にあなたに確認したい“1点だけ”
**Web(UI)モード（vite + browser）も今後残しますか？**  
- **[YES]** → Web用の静的配信/プロキシ設計を正式化（backendがSPAを配るか、別ホストにするか）
- **[NO（Desktop主）]** → [start_app.bat](cci:7://file:///e:/Tepora_Project/start_app.bat:0:0-0:0) 系は開発補助に格下げし、Tauri/sidecar中心に整理（ドキュメントも一本化）

---

## ステータス
- **完了**: GUI移行後の現状（Tauri sidecar起動・FastAPI構成・テスト配置）を踏まえた、実行順つき計画に更新しました  
- **次**: 上の質問（Webモードを残すか）だけ答えてください。答えに合わせて「推奨ディレクトリ構造（backend側の具体案）」と「移行PR順（どのファイルから動かすか）」を最短版で出します


===


## Desktop-first（Tauri）前提に計画を確定します
あなたの方針「**Desktopを主**・**Webモードはリリースしない**」を前提に、計画を **Tauri + sidecar（PyInstaller製FastAPI）** を“唯一の正式ルート”として組み直します。  
（この方針はさきほど更新したメモリにも反映済みで、それに沿って以下の構成案を出します。）

---

## 目標モジュール構造（推奨）
### 1) 境界（責務）を3つに固定
- **[tauri]** デスクトップアプリ殻・sidecar起動・OS権限（Rust/Tauri）
- **[frontend]** UI/状態管理/表示（React/TS）
- **[backend]** API（FastAPI/WebSocket）とコアロジック（Python）

### 2) backendの推奨ディレクトリ（“server.py肥大化”を止める）
現状 [backend/server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) が多責務なので、**FastAPI層**と**core層**を物理的に分離します。

- **案（例）**
  - `backend/src/tepora_server/`
    - `app_factory.py`（`create_app()`）
    - `api/`（websocket・config・logs・health等のrouter）
    - `middleware/`（request logging等）
    - `security/`（API key等。Desktop-onlyなら縮小も検討）
  - `backend/src/tepora_core/`（現状の [backend/src/core/](cci:7://file:///e:/Tepora_Project/backend/src/core:0:0-0:0) を段階移行 or リネーム）
    - [app/](cci:7://file:///e:/Tepora_Project/backend/src/core/app:0:0-0:0)（[TeporaCoreApp](cci:2://file:///e:/Tepora_Project/backend/src/core/app/core.py:31:0-406:39)）
    - [graph/](cci:7://file:///e:/Tepora_Project/backend/src/core/graph:0:0-0:0) [llm/](cci:7://file:///e:/Tepora_Project/backend/src/core/llm:0:0-0:0) [tools/](cci:7://file:///e:/Tepora_Project/backend/src/core/tools:0:0-0:0) [memory/](cci:7://file:///e:/Tepora_Project/backend/src/core/memory:0:0-0:0) [config/](cci:7://file:///e:/Tepora_Project/backend/config:0:0-0:0) …

※リネーム（[core](cci:7://file:///e:/Tepora_Project/backend/src/core:0:0-0:0)→`tepora_core`）は破壊が大きいので、最初は **物理分割だけ**して import は互換層で吸収、が安全です。

---

## Desktop-first で「今すぐ直すべき」設計の歪み（指摘）
コーディングエージェント由来っぽい “壊れやすい典型” がいくつか見えています。遠慮なく挙げます。

- **[frontend]** [main.tsx](cci:7://file:///e:/Tepora_Project/frontend/src/main.tsx:0:0-0:0) が [startSidecar()](cci:1://file:///e:/Tepora_Project/frontend/src/utils/sidecar.ts:2:0-32:1) を無条件実行  
  - ブラウザで `vite dev` を開くと Tauri API が無く落ちやすい（= Webをリリースしないなら、なおさら **Tauri環境でのみ起動**にガードすべき）
- **[backend]** 設定/パス解決が複線化  
  - [config/paths.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/paths.py:0:0-0:0) と [config/loader.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/loader.py:0:0-0:0) が別思想で、PyInstallerやCWD差異で事故が起きやすい
  - [config/loader.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/loader.py:0:0-0:0) が **import時に [load_config()](cci:1://file:///e:/Tepora_Project/backend/src/core/config/loader.py:29:0-40:60) 実行**（テスト・ツール実行・sidecar起動で副作用が出やすい）
- **[backend]** [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) が静的配信（SPA）まで担当  
  - Desktop-firstなら **FastAPIがフロントを配る必要は基本なし**（TauriがUIを持つため）

---

## 移行PR順（“壊さず・痩せさせる”ための実行計画）
大きく5本に分けるのが安全です（各PRが回帰の原因を限定できる）。

### PR1: Desktop-first 方針のドキュメント固定（先に迷いを消す）
- **内容**
  - [README_WEB.md](cci:7://file:///e:/Tepora_Project/docs/guides/web_development.md:0:0-0:0) を「リリース対象外（開発用途のみ/廃止予定）」にするか、Desktop手順に統合
  - [ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0) の起動経路を **Tauri中心**に再記述
  - テスト配置の表記ゆれ修正（`frontend/src/tests`ではなく現状[frontend/src/test](cci:7://file:///e:/Tepora_Project/frontend/src/test:0:0-0:0)）
- **完了条件**
  - 新規参加者が「何を起動すればいいか」迷わない

### PR2: frontendのsidecar起動を“Desktop限定”にし、接続設定を単一化
- **内容**
  - [startSidecar()](cci:1://file:///e:/Tepora_Project/frontend/src/utils/sidecar.ts:2:0-32:1) を「Tauri実行時のみ」にする（環境判定を入れる）
  - `WS_URL` / `API Base URL` を `VITE_*` か単一設定に寄せる（今後の拡張のため）
- **完了条件**
  - `tauri dev` で必ず backend が起動・再起動しても破綻しない  
  - UI単体開発（必要なら）でブラウザ起動しても即死しない

### PR3: backendを「FastAPI層」と「core層」に分割（server.pyダイエット）
- **内容**
  - [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) → `create_app()`化して router 分割
  - 静的配信（[frontend/dist](cci:7://file:///e:/Tepora_Project/frontend/dist:0:0-0:0)配信）は Desktop-firstなら原則撤去（必要なら dev専用に隔離）
  - CORSも dev専用に寄せる（Tauri本番では不要寄り）
- **完了条件**
  - API仕様（WS message type等）を変えずに整理だけ完了  
  - [backend/tests](cci:7://file:///e:/Tepora_Project/backend/tests:0:0-0:0) が通る

### PR4: 設定・パス解決の一本化（sidecar/テスト安定化の要）
- **内容**
  - [config.yml](cci:7://file:///e:/Tepora_Project/backend/config.yml:0:0-0:0) の探索規約を1本にする（PyInstallerでも同様）
  - import副作用（import時ロード）をやめ、起動時に明示ロードへ
  - [ToolManager(config_file)](cci:2://file:///e:/Tepora_Project/backend/src/core/tool_manager.py:35:0-236:30) のパス扱い（絶対/相対混在）を整理
- **完了条件**
  - `tauri build`（sidecar同梱）でも設定が読める  
  - テスト実行時に環境差異で落ちない

### PR5: Desktop配布の一本化（ビルドパイプライン整理）
- **内容**
  - [scripts/build_sidecar.py](cci:7://file:///e:/Tepora_Project/scripts/build_sidecar.py:0:0-0:0) の位置づけを明確化し、`tauri build` と整合する手順に統合
  - `start_*.bat` は「開発補助」に格下げ（公式手順は `npm run tauri dev/build` へ）
- **完了条件**
  - “配布物を作る手順” が1つだけになる

---

## この計画での「コードダイエット」の定義（削る基準）
- **削除候補（優先度高）**
  - Desktopで不要な “Webリリース前提コード”（例：SPA配信、ブラウザ前提の説明）
  - パス解決・設定読み込みの重複（複線を一本化）
  - import重複、責務重複（[server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0)の機能過密など）
- **削除の進め方**
  - 「構造変更PR」と「削除PR」を分離（混ぜるとレビュー不能になりがち）

---
