
# Tepora_Project 包括的レビュー（率直・本番リリース前提）

前提として、`.env` は [.gitignore](cci:7://file:///e:/Tepora_Project/frontend/src-tauri/.gitignore:0:0-0:0) 対象で中身を閲覧できないため、**実際の秘密情報（APIキー等）が置かれているか**は確認できていません（ただし設計上の漏洩リスクはコードから判断できます）。

---

## 0. エグゼクティブサマリ（結論）

このプロジェクトは「ローカルファーストAIエージェント」を **Tauri + FastAPI + LangGraph + llama.cpp + Chroma/SQLite** で成立させており、**方向性・機能の核は既に揃っています**。ドキュメント（[docs/architecture/ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0)）も整備され、モジュール分割も進んでいて、AI生成コードとしては上位の部類です。

一方で、本番リリース（一般層・セキュリティ重視）に対しては **“今のまま出すのは危険”** です。理由は大きく3つです。

- **Stop-Ship級のセキュリティ問題が複数ある**
- **データ格納先・実行環境（開発/sidecar/凍結）で整合が取れていない**
- **サプライチェーン（npx/uvx・GitHub/HFダウンロード・zip展開）周りが未防御**

この3点は「時間をかければ直る」タイプであり、致命的というより **“出荷要件を満たしていない”** という意味です。ここを越えると、かなり強い製品になります。

---

## 1. プロジェクト構想（ビジョン）レビュー

### 良い点
- **Local-first** をコアコンセプトに据えたのは強い。一般層に刺さる「安心」へ直結します。
- UI/UX（Tauri）と、推論/メモリ（バックエンド）を分ける設計は正しい。
- “3モード（Chat/Search/Agent）” はユーザー理解しやすい。
- EM-LLM を「差別化要素」にしているのも良い（ただし後述の品質・検証が必要）。

### 辛口ポイント（プロダクト設計）
- 「一般層・セキュリティ重視」を狙うなら、**“勝手に外へ出ない”** と **“ローカルでも安全”** を両方満たす必要があります。現状は **ローカルなのにネットワーク越しに触れる** 形になり得ます（後述：`uvicorn host=0.0.0.0`）。
- “無料/安価で遊びたい層” を狙うなら、初回セットアップ（巨大モデルDL、llama.cppバイナリDL）が最大の離脱点です。現状は仕組みはあるが、**安全性・再開性・エラー時UX** がまだ製品水準ではありません。

---

## 2. アーキテクチャ（全体設計）レビュー

### 現状アーキテクチャ（概略）
- **Frontend**: React + Vite + Tauri（`frontend/`）
- **Backend**: FastAPI + WebSocket（`backend/server.py` → `src/tepora_server/app_factory.py`）
- **Core**: LangGraph, ToolManager, LLMManager, EM-LLM, MemorySystem, History（`backend/src/core/`）
- **推論**: llama.cpp serverを別プロセス起動しHTTPで叩く（[LLMManager](cci:2://file:///e:/Tepora_Project/backend/src/core/llm_manager.py:25:0-297:27)）
- **永続化**: SQLite（チャット履歴） + ChromaDB（エピソード記憶）

これは方向として良いです。特に `src/core/app/core.py` が「UIから独立した中枢」になっているのは健全。

### 大きな設計課題
#### **(A) “デスクトップアプリ”なのにバックエンドがネットワークサービスとして開きすぎ**
- `backend/server.py` の `uvicorn.run(app, host="0.0.0.0", port=port)` が **最優先で直すべき**です。
  - 0.0.0.0 はLAN全体に公開し得ます。
  - `/ws` も `/api/config` も `/api/setup/*` も、現状は実質ノーガードです。
  - 「ローカルで安全」という価値を壊します。

**本番の基本方針**は以下が現実的です。
- **バックエンドは `127.0.0.1` にのみbind**（LANから不可）
- 可能なら **起動時にランダムポート** + **Tauri側だけが知るトークン** で接続
- WebSocketは **Originチェック + セッショントークン必須** にする（CORSでは守れません）

#### **(B) “設定/データ保存場所”が環境でブレる（開発と凍結で破綻しやすい）**
例：
- [ChatHistoryManager(db_path="tepora_chat.db")](cci:2://file:///e:/Tepora_Project/backend/src/core/chat_history_manager.py:12:0-193:76) が **カレントディレクトリ依存**
- `MemorySystem` の `db_path` が `PROJECT_ROOT / "chroma_db_em_llm"` など **プロジェクト直下依存**
- 一方で [DownloadManager](cci:2://file:///e:/Tepora_Project/backend/src/core/download/manager.py:47:0-305:23) は `%LOCALAPPDATA%/Tepora` を基準にしている

この状態だと、製品版で
- 書き込み権限がない場所にDBを作ろうとして失敗
- アップデートでデータが消える/場所が変わる
が起きがちです。

**解決策（強推奨）**
- 「ユーザーデータのroot」を **単一の関数/設定**に統一（例：`USER_DATA_DIR`）
- SQLite/Chroma/ログ/ダウンロード/設定 を **全てそこへ集約**
- `PROJECT_ROOT` は「アプリのリソース参照（読み取り）」に限定

---

## 3. マイクロアーキテクチャ（実装設計）レビュー

### 3.1 FastAPI / WebSocket 層
- `app_factory.py` の `lifespan` で **起動時検証→初期化** をしているのは良い（fail-fastの方向性は正しい）。
- [SessionHandler](cci:2://file:///e:/Tepora_Project/backend/src/tepora_server/api/session_handler.py:19:0-208:14) に処理を寄せたのも良い（分離が進んでいる）。

ただし問題が多いです。

#### **重大：設定更新APIが無防備**
`backend/src/tepora_server/api/routes.py`
- `POST /api/config` が **認証なし**
- `GET /api/config` も **認証なし**

これが 0.0.0.0 bind と組み合わさると、同一LANの第三者が設定を書き換えたり、内部情報を抜けます。  
また設定内に将来 `security.api_key` 等を入れたら、そのまま漏れます。

**最低限の対策**
- `GET/POST /api/config` は **常に保護**（APIキー、もしくはローカル限定 + トークン）
- 返す設定は **redact（秘密情報は伏字）**
- そもそも「設定更新」をHTTPで開くなら、**入力をPydanticで厳格に検証**（今は `dict` をそのまま `yaml.dump`）

#### WebSocket入力（添付）とDoS耐性
[WSIncomingMessage](cci:2://file:///e:/Tepora_Project/backend/src/tepora_server/api/ws.py:22:0-32:5) に `attachments: List[Dict[str, Any]] = []` があり、`core.py` で base64 decode を試みますが、
- サイズ上限（`SEARCH_ATTACHMENT_SIZE_LIMIT`）が**適用されていない**
- でかいbase64を投げられるとメモリ爆発が起き得ます

---

### 3.2 ToolManager / MCP
- Provider方式（`NativeToolProvider`, `McpToolProvider`）は拡張性が高く、方向性は良いです。
- MCPは「壊れても動く」ように `load_mcp_tools_robust` で堅牢化している点も良い。

ただし、製品としては危険が大きいです。

#### **サプライチェーン + 実行の危険**
[backend/config/mcp_tools_config.json](cci:7://file:///e:/Tepora_Project/backend/config/mcp_tools_config.json:0:0-0:0)
- `npx -y @modelcontextprotocol/server-*`
- `uvx mcp-server-time`

これは「ユーザーPC上で、外部取得した実行コードを動かす」行為です。一般層に配布するなら **ほぼ確実に炎上ポイント**になります（セキュリティ製品に弾かれる確率も高い）。

**本番方針（推奨）**
- MCPサーバーは **バンドル（同梱）**、または **バージョン固定 + 署名/ハッシュ検証**
- 少なくとも `npx -y` のような “最新を都度取る” 運用はやめる
- filesystem MCPのルートが `E:/Sandbox` に固定なのもプロダクトとして不自然。ユーザーが選べる/安全に制限できる必要があります。

---

### 3.3 LLMManager（llama.cppプロセス管理）
設計は現実的です（ローカル推論をHTTP化するのは手堅い）。  
ただ、運用品質にまだ穴があります。

- ヘルスチェックはあるが、障害時の復旧（プロセス死亡→再起動）設計が薄い
- ポートを動的割当していますが、フロント側は `localhost:8000` 固定で、**バックエンドが別ポートに移る未来と整合**が必要になります
- 依存バージョン（`torch==2.9.1`, `transformers==4.57.3` 等）がかなり攻めていて、配布再現性・入手性が不安（実在/互換性の問題が出ると地獄）

---

### 3.4 Memory / Storage
- [VectorStore](cci:2://file:///e:/Tepora_Project/backend/src/core/memory/vector_store.py:3:0-35:12) 抽象化は良いです（将来Chroma以外に逃げられる）。
- ただし [ChromaVectorStore.get_oldest_ids()](cci:1://file:///e:/Tepora_Project/backend/src/core/memory/chroma_store.py:46:4-77:50) は、コメントにある通り **全件get → Pythonでソート** でスケールしません（メモリ死します）。
  - 製品で長期運用するなら、ここは設計から変える必要があります（タイムスタンプで効率的に削除できるストア or 別テーブル管理）。

#### 履歴DB（SQLite）の平文保存
[ChatHistoryManager](cci:2://file:///e:/Tepora_Project/backend/src/core/chat_history_manager.py:12:0-193:76) は平文で履歴を保存します。ローカルアプリとしては一般的ですが、ターゲットが「セキュリティ重視」なら次が欲しいです。
- OSのユーザーディレクトリ配下固定
- 暗号化（最低でもオプションで）
- “削除/エクスポート” のユーザー機能

---

## 4. コード品質レビュー（AI生成コードとしての評価も含む）

### 良いところ
- モジュール分割が進んでおり、[core](cci:7://file:///e:/Tepora_Project/backend/tests/core:0:0-0:0) / `tepora_server` の境界は概ね合理的。
- テストが存在し、CIも最低限回っています（[backend/tests](cci:7://file:///e:/Tepora_Project/backend/tests:0:0-0:0) がちゃんとある）。
- 設定が Pydantic Settings へ寄せられている（方向性が良い）。

### 率直に良くないところ（保守性・事故率が上がる）
- **重複・取りこぼし**が散見（例：[agents.py](cci:7://file:///e:/Tepora_Project/backend/src/core/config/agents.py:0:0-0:0) が二重にimport/定義されている箇所がある）
- “互換レイヤー”や“移行途中”の痕跡が多く、読む人間の認知負荷が上がる
- ログ・例外が「ユーザー向け」と「開発者向け」で整理されていない（例：WSで内部例外をdevelopment時は返す等）

---

## 5. セキュリティレビュー（最重要）

ここは容赦なく書きます。あなたのターゲット層だと「1個の事故で終わる」領域です。

### Stop-Ship（出荷停止レベル）
- **(1) バックエンドが `0.0.0.0` bind**
  - LAN上の他者が `/ws` に接続可能
  - `/api/setup/*` を叩いて勝手に巨大DL（ディスク枯渇DoS）
  - `/api/config` 書き換え可能（現状無認証）
- **(2) [tauri.conf.json](cci:7://file:///e:/Tepora_Project/frontend/src-tauri/tauri.conf.json:0:0-0:0) の `csp: null`**
  - CSP無効は、XSSが起きた時に即死します（TauriはXSSが“ローカルRCE”に繋がり得る）
- **(3) zip展開のZip Slip対策がない**
  - [BinaryManager](cci:2://file:///e:/Tepora_Project/backend/src/core/download/binary.py:40:0-483:53) が GitHub からzipを落として `zipfile.extractall()` しています
  - 悪意あるzip（あるいは中間者/改ざん）で `../` パスを含まれると、任意ファイル上書きが起こり得ます  
  → **これはクラシックで危険度が高い**です

### High（早期に潰すべき）
- **`/api/config` が無認証**（既述）
- **WebSocketに認証・Originチェックがない**
- **MCPが `npx -y` で都度取得実行**（サプライチェーン）
- **秘密情報の取り扱い**
  - `GET /api/config` が将来、APIキー等を返しうる
  - ログファイルに個人情報が混ざる可能性（会話内容、モデルパス等）
- **[SecurityUtils.safe_path_join](cci:1://file:///e:/Tepora_Project/backend/src/core/common/security.py:7:4-29:25) の判定が `startswith`**
  - Windowsの大小文字・パス正規化等で事故る可能性があります（厳密な `Path.is_relative_to` 等に寄せたい）

---

## 6. ファイル構造レビュー

### 良い
- `backend/src` に寄せ、エントリは `backend/server.py` に寄せているのはわかりやすい
- `docs/` があり、アーキテクチャ仕様書が読めるのは強い

### 課題
- ルートに `プロジェクト参考資料/` が **4k items** 規模で存在しており、配布・クローン・CIの全てを重くします。
  - 製品リポジトリから切り離す（別repo / release assets / git submodule / .gitignore）を強く推奨します。
- `backend/pyproject.toml` と `backend/requirements.txt` が二重管理  
  - どちらが正か明確にしないと、将来必ず壊れます（CIはrequirements.txtでinstall）。

---

## 7. 本番リリース準備（CI/CD、署名、更新、運用）

### CI
[.github/workflows/ci.yml](cci:7://file:///e:/Tepora_Project/.github/workflows/ci.yml:0:0-0:0)
- backendは一部テストしか回していません（[test_api.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_api.py:0:0-0:0), [test_contract_ws.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_contract_ws.py:0:0-0:0) のみ）。  
  本番を狙うなら最低限：
  - `pytest` 全実行
  - `ruff`
  - `mypy`
  - frontendも `npm run build` / `tsc --noEmit` / eslint を入れる

### 配布・アップデート
- 現在は sidecar（PyInstaller）+ resources 同梱の方向ですが、ここが製品として一番難所です。
- 更新機能（llama.cpp更新、モデル更新）を入れるなら、
  - **ダウンロード物の署名/ハッシュ検証**
  - **ロールバック**
  - **失敗時の復旧**
  が必要です（今はハッシュ検証が無い）。

---

## 8. 優先度付きロードマップ（提案）

### フェーズ0（Stop-Ship解消：最優先）
- [x] **バックエンドbindを `127.0.0.1` 限定**（+ WebSocket Originチェック）
- [x] **`/api/config` と `/api/setup/*` を保護**（少なくともローカル限定 + トークン）
- [x] **Zip Slip対策**（zip展開前に各エントリの展開先が `version_dir` 配下か検証）
- [x] **Tauri CSPを有効化**（`csp:null` を撤廃、必要な許可だけ付与）
- [x] **添付サイズ上限の実装**（base64 decode前にサイズ判定）

### フェーズ1（製品品質の基礎）
- [x] データ/ログ/設定の格納先を `USER_DATA_DIR` に統一
- [x] secretsの扱いを整理（configに載せない、返さない、ログに出さない）
- [ ](スキップ 対応の必要なし) MCP実行方式の見直し（同梱 or 固定/検証）
- [x] 依存関係管理の一本化（pyprojectに寄せる等）

### フェーズ2（一般層向け完成度）
- [ ] 初回セットアップUX（中断/再開/失敗時ガイド）
- [ ] メモリ・履歴の“ユーザー操作”（消去、エクスポート、暗号化オプション）
- [ ] 観測性（ログローテ、診断パッケージ、クラッシュレポートは任意で）

---

## 9. 「褒め」と「批判」を同時にまとめる

- **褒め（事実）**
  - アーキテクチャの骨格は既に成立していて、モジュール分割も進んでいる
  - ローカル推論、メモリ、ツール、UIを統合できている時点で強い
  - 仕様書があるのは、AI生成プロジェクトとしては明確に上位

- **批判（率直）**
  - セキュリティの“基本の基本”（bind、認証、zip、CSP）が未完で、現状は本番に出せない
  - 「ローカルだから大丈夫」が成立していない（ローカルでもネットワークで触れる）
  - サプライチェーン（npx/ダウンロード/展開）の危険を正面から扱っていない

---

# 完了ステータス
- **完了**: コード・設定・ドキュメントを根拠に、構想/アーキ/マイクロアーキ/品質/セキュリティ/構造/リリース観点で包括レビューを提示しました。  

  2025年12月20日時点 作成者: GPT-5.2-thinking-high