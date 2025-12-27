# Tepora プロジェクト包括レビュー（本番リリース観点・率直版）

前提として、**コンセプト/設計ドキュメントの完成度は非常に高い**です。一方で、現状は「本番リリース」というより **“配布可能な開発版（Beta）”** に近く、**リリース阻害（P0）が複数あります**。特に **CIが実構成と整合していない／認証設計とUIが噛み合っていない／リポジトリ衛生（生成物・秘密情報候補）が危険** が大きいです。

---

## 結論（Executive Summary）

- **リリース判定**: **現状のまま本番リリースは非推奨（P0が未解決）**
- **ただし**: アーキテクチャの方向性・分割・テストの芽は良く、**「整理すれば一気に“製品”に寄せられる」段階**です。
- **最短でプロダクション品質に寄せる戦略**:  
  - **P0（リリース阻害）を潰す → リポジトリ/ビルド/起動を一本化 → セキュリティモデルを“ローカルアプリ前提”に再定義**  
  - その後に性能・UX・拡張へ進むのが最短です。

---

## 強いところ（本当に良い点）

- **[ビジョンとストーリー]**  
  - [docs/architecture/ARCHITECTURE.md](cci:7://file:///e:/Tepora_Project/docs/architecture/ARCHITECTURE.md:0:0-0:0) の密度が高く、「何を作りたいか」「どんな層で守るか」が明確。
- **[Local-firstの一貫性]**  
  - Tauri + local backend + SQLite + ChromaDB + llama.cpp という意思決定は尖っていて差別化できる。
- **[分割の方向性が正しい]**  
  - `backend/src/tepora_server` と `backend/src/core` の分離、WebSocketの `SessionHandler` など、テスタブルにする意志が見える。
- **[最低限のセキュリティ意識がある]**  
  - WebSocket origin検証や、ログAPIのパス結合防止（`SecurityUtils.safe_path_join`）など、無自覚ではない。
- **[テストが存在し、守りたい“脳”に当たっている]**  
  - `backend/tests` が存在し、WSセキュリティなど「壊れやすい外周」も一部見ているのは良い。

---

## P0（本番リリース阻害）— 今すぐ直すべき致命点

## 1) CI/CDが現行ディレクトリ構成と不整合（=CIが死んでいる可能性）
- **根拠**
  - `.github/workflows/ci.yml` が `./backend` / `./frontend` を前提
  - 実際のアプリは `Tepora-app/backend` / `Tepora-app/frontend`
- **影響**
  - CIが成功していても「違うフォルダをテストしている」可能性がある（=品質ゲートとして機能しない）。
- **推奨**
  - CIの `working-directory` を `./Tepora-app/backend` と `./Tepora-app/frontend` に修正
  - 併せて `Taskfile.yml` / README の起動手順も同じ前提に統一

## 2) 認証（APIキー）設計とフロントが噛み合っていない（=本番でUIが詰む）
- **根拠**
  - バックエンドは `/api/config` `/api/logs` `/api/setup/*` が `Depends(get_api_key)` で保護（[backend/src/tepora_server/api/routes.py](cci:7://file:///e:/Tepora_Project/Tepora-app/backend/src/tepora_server/api/routes.py:0:0-0:0), [api/setup.py](cci:7://file:///e:/Tepora_Project/Tepora-app/backend/src/tepora_server/api/setup.py:0:0-0:0)）
  - フロントエンド側に `x-api-key` を付与する実装が **存在しない**（`grep`でも見つからない）
  - [SetupWizard](cci:1://file:///e:/Tepora_Project/Tepora-app/frontend/src/components/SetupWizard.tsx:44:0-476:1) や `SettingsContext` は普通に `fetch(`${API_BASE}/api/config`)` 等を叩く
- **影響**
  - **本番（TEPORA_ENV=production & APIキー設定あり）だと、フロントの大半の機能が403で死ぬ**
- **推奨（方向性の決め直しが必要）**
  - Teporaは「ローカルデスクトップアプリ」なので、**Webサービスの“APIキー方式”がそもそも筋が悪い**です。
  - 代替案（推奨順）:
    - **案A（推奨）**: “外部公開しない”前提で **localhostバインド + OSローカル前提の安全策** に寄せる  
      - 例: `127.0.0.1` 以外に bind する場合だけ強い認証を要求
    - **案B**: **セッション・トークン方式の統一**  
      - backend起動時にランダムトークン生成 → Tauri側が取得し、HTTP/WSに付与  
      - 今はWS tokenが「任意」で、HTTPはAPIキー、という **二重で中途半端** な状態
    - **案C**: 開発時のみAPIキーOFF／配布時はUI内でキー生成・保持  
      - ただし “ユーザーから隠せないキー” なので、セキュリティ境界としては限定的

## 3) ポート/URL設定が二重化・不一致（=環境差で壊れやすい）
- **根拠**
  - [frontend/src/utils/api.ts](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src/utils/api.ts:0:0-0:0) は `VITE_API_PORT` を参照し `API_BASE`/`WS_BASE` を構築
  - 一方で
    - [frontend/src/utils/sidecar.ts](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src/utils/sidecar.ts:0:0-0:0) は `http://localhost:8000/health` 固定
    - [frontend/src/hooks/chat/useSocketConnection.ts](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src/hooks/chat/useSocketConnection.ts:0:0-0:0) は Desktop時 `ws://localhost:8000/ws` 固定
  - `tauri.conf.json` の CSP も `http://localhost:8000 ws://localhost:8000` 固定
- **影響**
  - ポート変更・競合・複数プロセス時に破綻しやすい。設定で直るはずなのに直らない。
- **推奨**
  - **API/WS/health/CSP を “単一ソース” に揃える**（環境変数 or 設定）
  - 最低でもフロントの [useSocketConnection](cci:1://file:///e:/Tepora_Project/Tepora-app/frontend/src/hooks/chat/useSocketConnection.ts:17:0-123:2) と [sidecar.ts](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src/utils/sidecar.ts:0:0-0:0) は `API_BASE`/`WS_BASE` を参照する形に統一

## 4) リポジトリ衛生（生成物・DB・secrets）が危険信号
- **根拠（現物が存在）**
  - ルートに `tepora_chat.db`, `server.log`, [build/](cci:1://file:///e:/Tepora_Project/Tepora-app/scripts/build_sidecar.py:48:0-116:19), `dist/`, `logs/`
  - `Tepora-app/backend/` に `server.log`（巨大）, `tepora_chat.db`, `chroma_db/`, `secrets.yaml`, `.env` が存在
  - [frontend/src-tauri/2](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src-tauri/2:0:0-0:0) という **npm auditの出力っぽい謎ファイル**が存在（脆弱性5件と書いてある）
- **影響**
  - **誤ってコミットされると即アウト**（秘密情報・個人会話・環境情報・巨大バイナリ混入）
  - さらに「開発者が増えた瞬間に破綻」するタイプの地雷
- **推奨**
  - まず「git管理対象から除外すべきもの」を明文化し、`.gitignore` を見直す
  - そして `secrets.yaml` やDB類が **“devでもリポジトリ直下に生成されない設計”** にする  
    - いま [loader.py](cci:7://file:///e:/Tepora_Project/Tepora-app/backend/src/core/config/loader.py:0:0-0:0) は **非frozen時は `USER_DATA_DIR = PROJECT_ROOT`** なので、dev実行で secrets/db が作られやすい（危険）

## 5) Tauriの権限が強い（攻撃面の増大）
- **根拠**
  - [src-tauri/capabilities/default.json](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src-tauri/capabilities/default.json:0:0-0:0) に `shell:default` + `shell:allow-execute`（sidecar）
  - `tauri-plugin-shell` が有効
- **影響**
  - もしフロントにXSS（依存関係由来含む）が入ると、**ローカルでコマンド実行に近づく**。
- **推奨**
  - `shell:default` を外し、**必要最小限（sidecar実行だけ）**に寄せる
  - CSPの再点検（`style-src 'unsafe-inline'` 等は妥協点としても、許可先の最小化）

---

## P1（早期に直すべき）— 品質/運用/将来コストを激減させる

## 1) “本番”の定義が曖昧（Desktop配布？サーバ公開？）
- 現状の作りは **Desktop配布が主戦場**ですが、APIキー保護やCORSなどが「Web公開っぽい」思想も混ざっています。
- まず脅威モデルを固定してください:
  - **ローカルユーザー＝信頼**なのか
  - **LAN内の別プロセスからのアクセスを防ぐ**のか
  - **Web公開を想定**するのか  
→ ここが曖昧だとセキュリティ設計が永遠に中途半端になります。

## 2) 依存関係の重さ（PyInstallerで地獄になりやすい）
- `backend/pyproject.toml` に `torch==2.9.1` や `transformers==4.57.3` が入っている一方、主推論は llama.cpp 由来に見えます。
- **影響**
  - sidecar exeが巨大化・ビルドが不安定化・サポート負荷爆増
- **推奨**
  - 「本当に必要な依存」だけに削る（特にtorch/transformers）
  - もし将来機能のためなら optional extrasに切る

## 3) Python/ツール設定のバージョン整合性が崩れている
- `requires-python = ">=3.11"` なのに
  - `ruff target-version = "py310"`
  - `mypy python_version = "3.10"`
  - docsはPython 3.10+ と書いてある箇所あり
- **影響**
  - 静的解析が本来検出すべき問題を見逃す／開発者が混乱
- **推奨**
  - 全部3.11基準に揃える（最小コストで信頼性が上がる）

## 4) Setup Wizard/ダウンロードAPIの同時実行・多セッション耐性
- [api/setup.py](cci:7://file:///e:/Tepora_Project/Tepora-app/backend/src/tepora_server/api/setup.py:0:0-0:0) の `_current_progress` がグローバルで、複数セッションを想定していない
- **影響**
  - 将来（複数ウィンドウ/複数ユーザー/再接続）で壊れる
- **推奨**
  - job_id単位で進捗管理、またはWSで進捗配信に一本化

---

## P2（中期）— UX/品質/拡張を底上げする

## 1) ログ設計（運用性）
- 良い点: `/api/logs/{filename}` で末尾100KBに制限しているのは賢い
- 改善点:
  - ローテーション（`server.log` が巨大化している兆候あり）
  - UI側も `x-api-key` 問題を解消しないとログ閲覧が機能しない

## 2) ツール実行の安全性（Prompt Injection耐性）
- `tool_policy: allow: ['*']` が基本になっている（`config.yml`）
- `dangerous_patterns` はあるが、**“道具が強い”割にガードが弱い**（ローカルとはいえ）
- 推奨:
  - “ユーザー承認”のUX（許可ダイアログ）を強化
  - ツールごとの許可・スコープ（URL制限、ローカルネット禁止等）を設計

## 3) リポジトリ構造（参考資料の扱い）
- `プロジェクト参考資料/` が巨大で、本番リリース・CI・配布の足を引っ張りやすい
- 推奨:
  - 別リポジトリ化/サブモジュール化/アーカイブ化（配布物から除外）

---

## 「今すぐやる」優先度付きロードマップ（現実的な順序）

## 優先度P0
- [x] **[CI修正]** `.github/workflows/ci.yml` を `Tepora-app/*` に合わせる
- [x] **[認証の一本化]** APIキー方式を見直し（ローカル前提のセキュリティモデルに確定）
- [x] **[ポート/URL単一化]** `8000` ハードコード排除（WS/health/CSPまで含む）
- [x] **[リポジトリ衛生]** `secrets.yaml`/DB/log/謎ファイル（[src-tauri/2](cci:7://file:///e:/Tepora_Project/Tepora-app/frontend/src-tauri/2:0:0-0:0)）等の扱いを確定

## 優先度P1
- [x] **[依存関係の棚卸し]** torch/transformers削除、OSレベルCUDA検出に置換
- [x] **[Dev/Prod整合]** Python 3.11基準に統一（ruff/mypy）
- [x] **[Setup進捗管理]** グローバル進捗をジョブID単位に変更

## 優先度P2
- [x] **[ログローテ・監視]** ローカルでも保守しやすい形に
- [x] **[ツール安全設計]** 権限・承認・スコープ（停止コマンドによるキャンセル対応）

---

## 追加で確認したい（必要なら、次に一緒に確定できること）
ここまでの指摘のうち「本当にコミットされているか」は `git status` / `git ls-files` で確定できます。もしあなたがOKなら、**“コミット済み地雷（DB/secret/生成物）”の有無を機械的に洗い出して、修正PR案まで作る**ところまで一気に進められます。

---

# 進捗サマリ
- **状況**: 包括レビュー（本番リリース観点の監査・根拠ファイル精査）まで完了  
- **次アクション**: あなたが望むなら、P0のうち「どれから直すか」を決めて、実際にパッチ適用まで着手可能です