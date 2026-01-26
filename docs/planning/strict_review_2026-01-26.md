# 厳格コードレビュー レポート（2026-01-26）

対象: `e:\Tepora_Project`（Tepora v3系 / Tauri + FastAPI + LangGraph + llama.cpp / Ollama）

## 0. レビュー方針（前提）

- 目的: **「壊れる前に止める」**（起動不能・セキュリティ・運用不能を最優先で潰す）
- 方法: 静的レビュー + 最小限の実行確認（import確認など）
- 優先度定義:
  - **P0**: このままでは動かない / 重大なセキュリティ・プライバシー事故の可能性が高い（Stop-Ship）
  - **P1**: 近いうちに高確率で事故る / 保守不能化に直結（次スプリントで対応）
  - **P2**: 品質・体験を押し上げる改善（余力で）

---

## 1. エグゼクティブサマリー

アーキテクチャ（`core` の Facade/Service/Graph 分離、MCPのHub化、WS起点のセッション処理分離、テスト群の整備）は方向性が良く、**「ローカルファーストAIエージェント」**としての基礎体力はあります。

一方で、**モデル管理（`core/models`）の移行が未完了のまま参照が混線しており、現状はバックエンドのimportが破綻して起動不能**です。また、ローカルファーストを掲げる以上、外部ネットワークに触れるツール（WebFetch）のガードが甘く、**プライバシー設定の意図を破る挙動**が見られます。

まずは **P0 を潰して「起動できる・約束したセキュリティ境界を守れる」状態に戻す**のが最優先です。

---

## 2. P0（Stop-Ship）

### P0-1: `core/models` 周りが壊れており、バックエンドがimport時点で落ちる

- 症状:
  - `python -c "from src.core.models import ModelManager"` が ImportError で失敗（= 起動以前に崩壊）
- 主要因（混線）:
  - `Tepora-app/backend/src/core/models/manager.py` が `ProgressCallback` 等を `src/core/models/types.py` からimportしているが、定義が存在しない
  - `Tepora-app/backend/src/core/models/__init__.py` が `ModelPool` / `ModelRole` をexportしているが、`src/core/models/types.py` 側に存在しない
  - さらに `src/core/download/types.py` 側にも **別物の** `ModelInfo/ModelRegistry/ModelPool` が存在し、移行途中の二重定義になっている
- 影響:
  - `LLMService` も `core.models` を参照するため巻き添えでimport不能
  - 既存の `DownloadManager` が `from ..models import ModelManager` を行うため、セットアップフロー/起動フローも停止
- 最低限の修正方針（いずれかを即断）:
  1) **移行を一旦止める**: 既存の `core/download/types.py` を単一の真実にして `core/models` を薄い互換レイヤに戻す  
  2) **移行を完遂する**: `core/models/types.py` に必要型（`ProgressCallback` 等）と互換エイリアス（`ModelPool/ModelRole`）を揃え、`core/download` 側の型を段階的に撤去  
  3) **混在を許さない**: `ModelInfo/ModelRegistry` の型を二重に持たず、片方へ統合。移行期間は `deprecated import path` を用意して警告ログで炙り出す
- 推奨（現実的）: **2) 移行を完遂**（このレポート時点で `core/models/manager.py` はV3志向の実装が入っているため）

### P0-2: プライバシー設定とネットワークアクセスの境界が破れている

- 該当: `Tepora-app/backend/src/core/tools/native.py`
- 症状:
  - `settings.privacy.allow_web_search` が `false` でも **`WebFetchTool` が常に登録される**
  - 「検索」だけでなく「任意URLフェッチ」も外部通信であり、ローカルファースト/プライバシーの期待値と衝突
- 追加のセキュリティ懸念（SSRF）:
  - `WebFetchTool._validate_url()` はホスト文字列のdenylistと **“ホストがIP literalの場合”** のみをチェックしている  
    → **DNS解決後にプライベートIPへ到達するケース**（例: `example.com -> 10.x`）を防げない
- 最低限の修正方針:
  - `allow_web_search`（または別名の `allow_external_network`）を導入し、WebFetch/検索/MCPのHTTP系を一括で抑制
  - URL検証は **「DNS解決→IPレンジ判定」** まで行う（IPv6含む）
  - denylistは `AgentToolPolicyConfig()` のデフォルト生成ではなく **`settings` から読んで反映**（設定変更が効く形）

---

## 3. P1（高優先）

### P1-1: WebSocketの進捗コールバックが解除されず、リークする

- 該当: `Tepora-app/backend/src/tepora_server/api/ws.py`
- 症状:
  - `dm.on_progress(send_progress)` で登録したコールバックを、切断時に `remove_progress_callback` していない
  - 接続が増えるほどコールバックが蓄積し、切断済みソケットへ `create_task()` を投げ続ける可能性
- 改善:
  - `try/finally` で必ず解除（成功・例外・切断の全経路）
  - `send_progress_callback` は閉じたWSに送れないので、送信失敗を契機に自動解除する設計も有効

### P1-2: MCP設定/ポリシーの保存先が `PROJECT_ROOT` 前提で、配布形態とズレる

- 該当: `Tepora-app/backend/src/tepora_server/state.py`, `Tepora-app/backend/src/core/app_v2.py`
- 症状:
  - `PROJECT_ROOT / "config" / ...` を参照しており、PyInstaller/Tauri配布時の `PROJECT_ROOT` が読み取り専用/一時展開ディレクトリになるケースと衝突しやすい
  - trustファイル（`.mcp_trusted_hashes`）も同ディレクトリへ出るため、**「アプリの設定がリポジトリ/バンドル側へ混入」**しうる
- 改善:
  - 設定は `USER_DATA_DIR`（既に `config/loader.py` が持つ）配下へ統一
  - `settings.app.mcp_config_path` を “相対パス” として解決し、起点を `USER_DATA_DIR` にする

### P1-3: フロントのWebSocketが「importしただけで自動接続」していて制御不能

- 該当: `Tepora-app/frontend/src/stores/websocketStore.ts`
- 症状:
  - モジュール末尾の `setTimeout(() => connect(), 0)` により、**import＝副作用**になる
  - テストの不安定化、画面遷移/多重マウント時の接続競合、切断タイミングの不明瞭化を招く
- 改善:
  - 接続開始/終了は `App.tsx`（またはセッション管理コンポーネント）で `useEffect` 管理
  - `connect()` を「冪等」化（既接続なら何もしない、token refresh中は待つ等）

### P1-4: Sidecar起動フラグが戻らず、再実行/例外時の状態が壊れる

- 該当: `Tepora-app/frontend/src/utils/sidecar.ts`
- 症状:
  - `sidecarStarting = true` にした後、成功/失敗/非Desktop経路で `false` に戻らない経路がある
- 改善:
  - `try/finally` で確実に `sidecarStarting = false`
  - 「起動中」「起動済み」を別stateに分離（`starting` と `child != null` の意味が混ざっている）

### P1-5: リリース設定として危険なデフォルトが混入

- 該当: `Tepora-app/frontend/src-tauri/tauri.conf.json`
- 症状:
  - `devtools: true` が常時有効
  - `connect-src` が `http://localhost:*` / `ws://localhost:*` 等で広い
- 改善:
  - `TAURI_DEBUG` 等で dev/prod を分岐し、本番は devtools 無効
  - connect-src を必要最小限へ（固定ポート or 127.0.0.1 のみ など）

### P1-6: CIが「テストのみ」で、lint/typecheckがゲートになっていない

- 該当: `.github/workflows/ci.yml`
- 症状:
  - `ruff`/`mypy` が落ちてもPRを止められない（壊れたコードが混入しやすい）
- 改善:
  - `backend-lint` / `backend-typecheck` / `frontend-lint` を追加し、**失敗で落とす**
  - OS依存が強いプロジェクトなので、可能ならWindows job も追加（少なくともPyInstaller/パス周りの事故を検知）

---

## 4. P2（改善提案）

### P2-1: ビルドスクリプトの `tarfile.extractall()` は安全対策を入れる

- 該当: `Tepora-app/scripts/build_sidecar.py`, `Tepora-app/scripts/prepare_fallback.py`
- 理由:
  - アーカイブに `../` が混入すると任意パスへ展開され得る（供給元が「常に信頼できる」前提でも事故る）
- 改善:
  - 展開前にメンバーの `Path` を検査し、目的ディレクトリ外への書き込みを拒否

### P2-2: バージョン表記が散らばっていて不整合が出やすい

- 該当: `Tepora-app/backend/pyproject.toml`（0.3.0-beta） vs `Tepora-app/backend/src/tepora_server/app_factory.py`（0.2.0-beta）等
- 改善:
  - バージョンを単一ソースへ（pyproject→importlib.metadata で参照、フロントは同一値をビルド時注入）

### P2-3: “会話ログ的なコメント” がコードに残っている

- 該当: `Tepora-app/backend/src/core/tools/native.py`, `Tepora-app/backend/src/core/llm/ollama_runner.py` 等
- 理由:
  - 将来の保守者にとってノイズで、仕様の根拠にもならない
- 改善:
  - コメントは「なぜそうするか」だけに絞る（AIの思考ログは残さない）

---

## 5. 良い点（継続すべき）

- `docs/architecture/ARCHITECTURE.md` の整備が進んでおり、意図が共有されている
- WebSocketのOrigin/Token検証、静的ファイル配信でのパストラバーサル対策など、セキュリティの基本が入っている
- MCP Hub / ConfigService に “trust” の概念を入れているのは良い（ただし保存先は要修正）
- テストが一定量存在し、回帰を止める土台がある（CIにlint/typecheckも載せると強くなる）

---

## 6. 推奨アクション（最短で立て直す）

1) **（即日）P0-1**: `core/models` のimport破綻を解消（テスト以前に起動できる状態へ）
2) **（即日）P0-2**: WebFetchをプライバシー設定で確実に無効化できるようにし、DNS解決ベースのSSRF対策を入れる
3) **（〜2日）P1-1**: WSのprogressコールバック解除を保証
4) **（〜1週間）P1-2/P1-3/P1-5/P1-6**: 設定保存先統一・自動接続撤廃・本番設定見直し・CIゲート強化
5) **（余力）P2**: ビルドスクリプト安全化、バージョン単一化、コメント清掃

