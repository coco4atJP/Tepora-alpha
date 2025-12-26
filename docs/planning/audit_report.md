# Tepora プロジェクトへの「全力」批判

※かなり辛口寄りでいきますが、人格ではなくプロジェクトへの批判です。

---

## 🛡️ 監査対応状況 (2025-12-15 更新)

本レポートでの指摘を受け、以下の改善を実施しました。

- **[Server Refactor]**: `server.py` の肥大化を解消し、`src.tepora_server` パッケージ（`app_factory`, `api`）へ責務を委譲・分割しました。
- **[Dependencies]**: `backend/requirements.txt` のバージョンを固定化し、再現性を向上させました。
- **[Configuration]**: パス解決ロジックを `loader.py` に集約し、PyInstaller/Dev環境の差異吸収を強化しました。
- **[Documentation]**: 開発者向けガイド (`docs/guides/development.md`) を新規作成し、開発フローを標準化しました。

---

## 全体アーキテクチャ

- **やりたいことが多すぎて、プロダクトの芯がぼやけている**
  - EM-LLM、LangGraph、A2A、AG-UI、マルチモーダル、Tauri…とにかく要素盛りすぎ。
  - 「ローカルでちゃんと動くパーソナルエージェント」という一番大事なゴールに対して、周辺の”かっこいい概念”が先行している印象が強い。
  - 実装と運用コストに対して、ユーザーが本当に得る価値がどこまで増えているかが曖昧。

- **「モジュラー設計」と書いてあるが、依然としてモノリシックな部分が目立つ**
  - [backend/server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) が 500 行近くあり、WebSocket、REST、静的配信、設定 I/O、ログ閲覧まで全部抱え込んでいる。
  - [AppState](cci:2://file:///e:/Tepora_Project/backend/server.py:60:0-63:69) に `TeporaCoreApp` をグローバルで持たせる設計は、「Core が全部知ってる神オブジェクト」を作っていて、結局境界線が曖昧。

- **アーキテクチャ図と「実際の責務の切り方」のギャップ**
  - 図では層がきれいに分かれている（プレゼンテーション層 / アプリケーション層 / ビジネスロジック層 / データ層…）。
  - しかし実コードを見ると、FastAPI 層がかなりビジネスロジック寄りのこと（状態の持ち方、activity の意味付けなど）まで握っていて、本当に「層」が守られているとは言い難い。

---

## バックエンド実装・責務分離

- **[server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) が「なんでも屋」化している**
  - WebSocket のストリーミング処理、ノード状態のマッピング、検索結果の flatten、メモリ統計の集計、設定ファイルの読み書き、ログ閲覧、SPA 配信まで一枚岩。
  - これは「FastAPI アプリケーション」ではなく「ミニフレームワーク」を [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) に押し込めている状態で、可読性・テスト性ともに悪い。

- **状態管理が安直でテストしづらい**
  - [AppState](cci:2://file:///e:/Tepora_Project/backend/server.py:60:0-63:69) のグローバルインスタンスに `TeporaCoreApp` をぶら下げる設計は、DI（依存性注入）を完全に諦めている。
  - テストや将来のマルチテナント化／マルチセッション拡張を考えると、ここは一番やってはいけない手抜きポイント。

- **WebSocket ハンドラ内のロジックが過密**
  - [websocket_endpoint](cci:1://file:///e:/Tepora_Project/backend/server.py:154:0-333:44) 内で、Pydantic バリデーション、停止コマンド、ステータス取得、非同期タスク管理、エラーハンドリングと大量の分岐が詰め込まれている。
  - これだけ詰め込むなら、専用の「セッションハンドラ」クラスや状態マシンに切り出すべきで、現状は”大きな async 関数”にすべて流し込んでいるだけ。

---

## 設定・運用・環境依存

- **設定の扱いが場当たり的**
  - [config.yml](cci:7://file:///e:/Tepora_Project/backend/config.yml:0:0-0:0) を「カレントディレクトリ」「親ディレクトリ」「PyInstaller の `sys._MEIPASS`」と手探りで探すコードはかなり脆い。
  - これは「とりあえず動かす」ためのハックであって、ちゃんとした設定ロード戦略（XDG, APPDATA, CLI 引数, 環境変数優先順位など）が設計されていない。

- **セキュリティ設定が「とりあえずチェックしてます」レベル**
  - API キーは `TEPORA_API_KEY env > config.yml` と書いてあるが、未設定かつ `TEPORA_ENV != development` の場合は 500 を投げるだけで、実運用上の運用手当てがない。
  - CORS 設定は `http://localhost:5173` と `http://localhost:3000` にベタ書きで、将来の配布形態やホスト変更を考えると柔軟性がない。

- **ローカルファイル前提の設計が強すぎて、少しでもパスがずれると壊れやすい**
  - [logs](cci:7://file:///e:/Tepora_Project/logs:0:0-0:0) ディレクトリや [config.yml](cci:7://file:///e:/Tepora_Project/backend/config.yml:0:0-0:0) を `../` 探索に頼っていて、「どこから起動しても安定する」設計になっていない。
  - Tauri + PyInstaller + 素の Python 起動を同時にサポートしようとして、その場しのぎの `if getattr(sys, 'frozen', False)` がそこら中に散りそうな設計。

---

## 依存関係・パフォーマンス

- **requirements が「>=」ばかりで、再現性を本気で考えていない**
  - `torch>=2.5.1`, `transformers>=4.45.0`, `langgraph>=0.2.42` など、大型かつ破壊的変更が入りやすいライブラリを全部「最低バージョンのみ指定」。
  - これで「Production Ready」と名乗るのは厳しい。数ヶ月後に `pip install` したら普通に壊れる未来が濃厚。

- **ローカルファーストと言いながら、ユーザー環境への負荷をあまりに軽視**
  - CPU/ライトユーザーも対象にすると言いつつ、`torch + transformers + LangChain + chromadb` フルセットはかなり重い。
  - llama.cpp をメイン推論に据えるなら、PyTorch 依存や大げさな NLP スタックをどこまで本当に必要としているのか、もっと削ぎ落とすべき。

---

## テスト戦略

- **テストは「ある」けど、肝心な部分が抜けている**
  - [tests/](cci:7://file:///e:/Tepora_Project/backend/tests:0:0-0:0) に [test_llm_manager.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_llm_manager.py:0:0-0:0), [test_memory_nodes.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_memory_nodes.py:0:0-0:0), [test_tool_manager.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_tool_manager.py:0:0-0:0) などがあるのは良い。
  - しかし [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) の WebSocket フロー、REST API (`/api/config`, `/api/status`, `/api/logs`) の挙動、安全性エッジケースはテストされている気配がない。
  - 「ユーザーが一番触る I/O の部分」が手動テスト頼みになっている疑いが強い。

- **「大規模リファクタリング後のリグレッションを守るテスト」がどこまでカバーしているか不透明**
  - [REFACTORING_SUMMARY.md](cci:7://file:///e:/Tepora_Project/backend/REFACTORING_SUMMARY.md:0:0-0:0) ではファイル行数削減などを誇っているが、リファクタ前後の動作互換性を担保するテスト戦略が見えない。
  - 行数やモジュール数ではなく、「振る舞いをどこまで守れているか」の指標が欲しいが、それがドキュメント化されていない。

---

## セキュリティ

- **ログ閲覧 API の設計が「便利だけど雑」**
  - `glob` でログファイル一覧を返し、中身も `/api/logs/{filename}` で丸出しにする設計は、ローカルとはいえ情報露出が大きい。
  - ディレクトリトラバーサル対策はしているが、認可モデル（誰が何を読めるか）は「API キー 1 個で全部保護」の一本足打法。

- **WebSocket エラーハンドリングがユーザー視点で不親切**
  - 例外時に `"Internal server error"` しか返さない部分があり、ユーザーにとっては「たまに動かない不安定なアプリ」と映る危険。
  - ローカルアプリであれば、多少内部事情を出してもよく、開発者向け情報とユーザー向け情報をうまく切り分ける設計が欲しい。

---

## ドキュメントと実装の乖離

- **ARCHITECTURE.md が「理想図／セールス資料」と「実在するコード仕様」が混ざっている**
  - 未来の Phase 3（AG-UI, A2A, Canvas, Artifact など）が、現在の実装と同じレベルの粒度で書かれており、「今できること」と「これからやりたいこと」が混ざっている。
  - 開発者からすると、「どこまで終わっていて、どこからが構想だけなのか」が一読では分かりづらい。

- **CLI から Tauri への移行過程がドキュメント側にうまく反映されていない**
  - 開発経緯セクションで「CLI ベースのプロトタイプ」など触れられているが、現在のコードベースでは CLI エントリが見当たらない。
  - 「アプリの起動方法」もほぼバッチと npm スクリプト前提で、Python パッケージとしての利用やライブラリとしての再利用は想定されていないように見える。

---

## DX / 開発体験

- **Windows + バッチ前提の起動 UX**
  - [start_app.bat](cci:7://file:///e:/Tepora_Project/start_app.bat:0:0-0:0), `scripts/start_backend.bat`, `scripts/start_frontend.bat` は Windows 想定一本槍。
  - クロスプラットフォーム志向のわりに、開発・実行フローはかなり手作り感が強く、VSCode や devcontainer, Makefile/Taskfile 的な「共通の儀式」が整備されていない。

- **バックエンドが Python パッケージとして整っていない**
  - プロジェクトルートに [pyproject.toml](cci:7://file:///e:/Tepora_Project/%E3%83%97%E3%83%AD%E3%82%B8%E3%82%A7%E3%82%AF%E3%83%88%E5%8F%82%E8%80%83%E8%B3%87%E6%96%99/llama.cpp-master/pyproject.toml:0:0-0:0) / `setup.cfg` 等がなく、[backend](cci:7://file:///e:/Tepora_Project/backend:0:0-0:0) をライブラリや CLI としてインストールすることを想定していない。
  - すべて「このリポジトリを丸ごとクローンして、特定ディレクトリでスクリプトを直叩きする」前提で、再利用性が低い。

---

## まとめ

- **一言でいうと、「発想とビジョンはかなり高水準だが、実装と運用設計がまだ“個人研究プロジェクト寄り”で、プロダクションクオリティとは言い難い」状態**です。
- アーキテクチャドキュメントの完成度と比較すると、  
  実コードはまだ「理想の設計図を追いかけている途中」で、責務分離・設定戦略・依存管理・テストカバレッジに粗さが目立ちます。

もし次に進めるなら、  
「褒め要素＋どこから潰すと効果が一番大きいか（優先度付き改善ロードマップ）」の形で整理してお渡しすることもできますが、今回はリクエストどおり批判に徹しました。

===
===

# 褒めポイント（本当に強いところ）

- **アーキテクチャドキュメントが異常に充実している**
  - [ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0) のレベルは、個人プロジェクトとしては明らかにオーバースペック級。
  - 機能一覧・データフロー・将来構想まで一貫した物語になっていて、「何を作りたいのか」がブレていない。
  - 実装が多少いびつでも、この設計書があるだけで後から人が入れるし、将来の自分も迷子になりづらい。

- **バックエンドのドメイン分割の方向性はかなり良い**
  - `src/core/graph`, `em_llm`, `llm`, `tools`, `memory`, [config](cci:7://file:///e:/Tepora_Project/backend/config:0:0-0:0) みたいな分割は、ちゃんと責務単位で切ろうとしている。
  - 特に EM-LLM を `segmenter.py`, `retrieval.py`, `integrator.py` などに分けているのは、「論文実装をそのまま泥団子にしない」という意思が見える。

- **「Local First」を本気でやろうとしている**
  - llama.cpp + GGUF モデル、ChromaDB、SQLite、Tauri+sidecar という構成は、クラウド前提のエージェント群とは一線を画している。
  - 単なる ChatGPT クライアントではなく、「ローカルに閉じたプロダクト」を狙っているのが明確で、コンセプトが尖っている。

- **WebSocket ストリーミングと UI 連携がよく考えられている**
  - `STREAM_EVENT_CHAT_MODEL` を流しながら `activity` イベントでノード状態を UI に出す設計は、LangGraph の内部状態を“ちゃんとユーザー体験に落とそう”としている。
  - 単に「トークンを流すだけ」ではなく、検索結果やメモリ統計まで返しているのは、エージェント観察性の点で良い。

- **テストを書いている範囲が的を外していない**
  - [test_llm_manager.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_llm_manager.py:0:0-0:0), [test_memory_nodes.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_memory_nodes.py:0:0-0:0), [test_segmenter.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_segmenter.py:0:0-0:0), [test_retrieval.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_retrieval.py:0:0-0:0), [test_tool_manager.py](cci:7://file:///e:/Tepora_Project/backend/tests/test_tool_manager.py:0:0-0:0) など、ミドル層のロジックにテストが当たっている。
  - “賢さ”の中枢に近い部分をテストしているのは正しくて、「頭脳を守る」意識は高い。

- **Tauri との統合をちゃんと設計している**
  - `src-tauri` 以下の構成、`externalBin` で `tepora-backend` をバンドル、Glassmorphism UI など、単なる技術デモではなく「ユーザーに配るアプリ」として見据えている。

---

# どこから潰すと効果が一番大きいか（優先度付き）

「短期で効く」「バグと不安定さが減る」「将来の変更コストが下がる」という観点で、優先度順に並べます。

---

## 優先度 S：安定性・再現性

- **① 依存関係と実行環境の“固定”**
  - **やること**
    - [backend/requirements.txt](cci:7://file:///e:/Tepora_Project/backend/requirements.txt:0:0-0:0) を「最低バージョン」ではなく、**開発中に実際に動作確認したバージョンでピン留め**する。
    - 可能なら [pyproject.toml](cci:7://file:///e:/Tepora_Project/%E3%83%97%E3%83%AD%E3%82%B8%E3%82%A7%E3%82%AF%E3%83%88%E5%8F%82%E8%80%83%E8%B3%87%E6%96%99/llama.cpp-master/pyproject.toml:0:0-0:0) + `requirements-lock.txt` or `uv.lock` 的なロックファイルを用意。
  - **理由**
    - 今の `torch>=2.5.1`, `transformers>=4.45.0`, `langgraph>=0.2.42` などは、半年後に `pip install` したとき普通に壊れる。
    - ここを固めるだけで「昨日は動いたのに今日は動かない」というストレスがかなり減り、他のリファクタリングも安心して進められる。

- **② モデルパス・EM-LLM 設定の起動時バリデーション**
  - **やること**
    - `TeporaCoreApp.initialize()` の中で、  
      - GGUF モデルファイルの存在チェック  
      - [config.yml](cci:7://file:///e:/Tepora_Project/backend/config.yml:0:0-0:0) の `models_gguf` / `em_llm` セクションの型・値検証  
      - ChromaDB パスの整合性  
      を行い、失敗したら起動時に明示的にエラーを出す。
  - **理由**
    - 「起動はするが、いざ EM-LLM を使うとどこかで None が飛んで死ぬ」みたいな遅延クラッシュは、ユーザー体験最悪。
    - 起動時に一気にチェックして「何が足りないか」をはっきり表示する方が、デバッグコストも UX も爆減する。

---

## 優先度 A：設計の“歪み”を取る

- **③ [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) の分割と責務整理**
  - **やること**
    - [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) を概ね次のレイヤに分割：
      - `api/ws.py`：WebSocket エンドポイントとセッション管理
      - `api/config.py`：設定の GET/POST
      - `api/logs.py`：ログ閲覧 API
      - `api/status.py`：ヘルス・ステータス
      - `app_factory.py`：`FastAPI` app の組み立て（CORS, middleware, lifespan）。
    - [AppState](cci:2://file:///e:/Tepora_Project/backend/server.py:60:0-63:69) / `TeporaCoreApp` を FastAPI の `dependency` 経由で注入する形に近づける。
  - **理由**
    - ここを綺麗にするだけで、
      - テストが書きやすい
      - バグ調査のスコープが小さくなる
      - フロントエンドから見た API の仕様が明瞭になる  
      ので、開発スピードに直結する。
    - また、WebSocket のロジックも「セッションハンドラ」としてテストしやすくなる。

- **④ 設定ロード戦略の一本化（ConfigManager）**
  - **やること**
    - `get_env_or_config` などを発展させて、  
      `Settings` / `ConfigManager` 的なクラス or Pydantic の `BaseSettings` で
      - 環境変数
      - [config.yml](cci:7://file:///e:/Tepora_Project/backend/config.yml:0:0-0:0)
      - 実行モード（開発 / 本番 / PyInstaller / Tauri sidecar）  
      を統一的に扱うレイヤを作る。
    - [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) 側の `if getattr(sys, 'frozen', False)` や `../config.yml` 探索ロジックをそこへ集約。
  - **理由**
    - 今のままだと、「新しい起動パターンを増やすたびに if 文が増えていく」構造。
    - 一度 “起動コンテキスト” の概念をまとめておけば、  
      将来的な CLI 再追加や Docker 化、Tauri 側の変更にも耐えやすい。

---

## 優先度 B：品質保証と UX

- **⑤ WebSocket / REST I/O の自動テスト追加**
  - **やること**
    - FastAPI の `TestClient` を使って：
      - `/health`, `/api/status`, `/api/config`, `/api/logs/*` の happy path / error path をテスト。
      - WebSocket で想定どおり `chunk` / `activity` / `search_results` / `stats` / `done` が飛んでくるシナリオを一つ書く。
  - **理由**
    - これは「ユーザーが一番最初に壊れを感じる場所」なので、ここにテストがあると致命的バグを早期に捕まえられる。
    - コアロジックにはすでにテストがある程度あるので、“外周の I/O” を守るのが次の一手として効率がいい。

- **⑥ ログ閲覧 API・エラーメッセージの“人間向けチューニング”**
  - **やること**
    - `/api/logs` 系は、少なくとも「何のログか（種別）」や「最終更新時刻」を返すようにして UX を上げる。
    - WebSocket の `"Internal server error"` を、開発モードではもう少し情報豊富に（エラーコードやヒントを含める）。
  - **理由**
    - ローカルアプリなので、ユーザー＝開発者 のケースも多く、内部情報を多少出しても問題になりにくい。
    - デバッグ時に「何が起きているか」が分かりやすくなり、バグ修正サイクルが短くなる。

---

## 優先度 C：DX・将来の拡張

- **⑦ 起動フローと開発フローの標準化**
  - **やること**
    - `Makefile` 相当（Windows なら `invoke` や `taskfile.yml` でも良い）で：
      - `dev-backend`, `dev-frontend`, `dev-all`, `test`, `lint` などを1コマンド化。
    - VSCode の `.vscode/launch.json` や tasks で、**Tauri + backend 同時起動**をワンクリックにする。
  - **理由**
    - 今はバッチ主体で「このリポジトリでしか通用しない儀式」が分散している。
    - コマンド体系を整えると、開発者が増えても“儀式説明コスト”が激減する。

- **⑧ ドキュメントの「現状」と「構想」の分離**
  - **やること**
    - [ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0) を
      - `Current Architecture`
      - `Planned / Roadmap`  
      に明確分離して、「ここまではコードが実在する」「ここから先は構想」と線を引く。
  - **理由**
    - 自分で読み返したときにも「どこまで終わったのか」が把握しやすく、  
      Issue や Milestone に落とすときの粒度決めが楽になる。

---

## 総括

- 強みとしては、**ビジョンの明確さ・アーキテクチャ文書の質・ドメイン分割の方向性・Local First の徹底**が光っていて、「研究プロトタイプの域は明確に超えつつあるプロジェクト」です。
- 一方で、**環境の再現性・[server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) の肥大化・設定/起動戦略の場当たり感・I/O 周りのテスト不足**が、現在の一番のボトルネックになっています。

もし次のステップとして進めるなら、  
ここで挙げた①〜④あたりを実際にコードに落とすリファクタリング（特に [server.py](cci:7://file:///e:/Tepora_Project/backend/server.py:0:0-0:0) の分割と ConfigManager の導入）を、一緒に具体設計からやっていくこともできます。  

**現状のタスク状況まとめ**  
- 批判と現状分析 → 完了  
- 強みの洗い出し → 完了  
- 優先度付き改善ポイントの提示 → 完了