# Tepora プロジェクト 包括的・批判的レビュー v5.0

**レビュー日**: 2026-01-08  
**対象**: `e:\Tepora_Project`（Git: `c592643`）  
**レビュー方針**: 批判的・厳格（リリース可否を現実基準で判定）  
**主対象**: `Tepora-app/backend`（FastAPI + LangGraph + llama.cpp sidecar） / `Tepora-app/frontend`（React + Vite + Tauri）

---

## 0. 結論（先に要点）

### 判定: **現状のままの一般配布は「不可（Release Blocked）」**

理由は「細かいバグ」ではなく、**権限境界と供給網（Supply Chain）**に直結する設計上の欠陥が複数残っているためです。  
特に **(1) 認証なしで設定・MCP（外部コマンド実行経路）を操作できる点**、**(2) Setup API のルーティング衝突**、**(3) フロント/バックの契約不整合（search result）**、**(4) Tauri同梱バイナリの検証欠如**は、支持を得る以前に「事故が起きる設計」です。

一方で、**テスト資産（105 backend tests + 72 frontend tests）**、**モジュール分割**、**セットアップウィザード導線**など、伸びる土台もあります。P0を潰せば「条件付きリリース」まで戻せます。

---

## 1. スコア（0–10, 厳格）

| 軸 | スコア | 根拠（要約） |
|---|---:|---|
| アーキテクチャ | 7.5 | コア/サーバ/ツール/ダウンロードが分割されている。だが権限境界が未定義で崩れている。 |
| コード品質 | 6.5 | テストは多いが、API重複・契約不整合・ブロッキング処理など「本番で刺さる」欠陥が残る。 |
| セキュリティ | 3.5 | ローカル前提でも守るべき境界が未実装。MCPが実質RCE経路。バイナリ検証なし。 |
| テスト/CI | 6.5 | テスト自体は通るが、CIが重要領域を除外しており信頼度が下がる。 |
| UX/出来栄え | 7.0 | 見た目/導線は良い。一方で細部のバグ（自動承認、検索結果クラッシュ等）が信頼を損ねる。 |
| リリース準備 | 4.0 | 署名/更新/設定保護/供給網対策/版数整合が不足。 |

---

## 2. 実行した検証（検索・コマンド結果に基づく事実）

### Backend
- `uv run pytest tests -q` → **105 passed**（警告 26）  
- `uv run ruff check src/` → **All checks passed**  
- `uv run mypy src/` → **失敗**（モジュール名の二重解決）

### Frontend
- `npm test` → **72 passed**（テストは通るが act 警告などのノイズあり）  
- `npx tsc --noEmit` → **OK**  
- `npm run lint` → **失敗**（`any`禁止違反 + Hook deps 警告）

---

## 3. P0（リリースブロッカー）

### P0-1. 「認証が存在しない」＝設定・MCP操作が無防備（重大）
**根拠**:
- `Tepora-app/backend/src/tepora_server/api/security.py` の `get_api_key()` が常に `return None`（認証を実装していない）
- `Tepora-app/backend/src/tepora_server/api/routes.py` の `/api/config` は `dependencies=[Depends(get_api_key)]` だが実質ノーガード
- `Tepora-app/backend/src/tepora_server/api/mcp_routes.py` の `/api/mcp/config`・`/api/mcp/install` 等も同様

**影響**:
- ローカルの別プロセスが **設定を書き換え**できる（プライバシー/動作/ツールポリシー含む）
- MCP機能の存在により、**「設定書き換え」＝「任意コマンド実行経路の準備」**になり得る（後述 P0-2）
- 将来 `0.0.0.0` バインドやLAN公開を許した瞬間に即死する設計

**推奨修正（最低ライン）**:
- **機密API（config/mcp/setup/shutdown/ログ閲覧）をセッショントークン必須**にする
- トークンはバックエンド起動時に生成し、Tauri側へ安全に受け渡す（例: `TEPORA_TOKEN=` をstdoutへ出す/OSの安全領域へ保存）
- WebSocketも **token必須**（後方互換の「token無し許可」は廃止）

---

### P0-2. MCPストア/インストールが実質「供給網RCE」になっている
**根拠**:
- `Tepora-app/backend/src/core/mcp/installer.py` が `npx -y <pkg>` / `uvx <pkg>` / `docker run ...` を生成
- `Tepora-app/frontend/src/hooks/useMcp.ts` が `/api/mcp/install` を叩けるUIを提供

**影響**:
- UI操作で **外部パッケージ取得→実行**が可能（ユーザーが理解しないと危険）
- しかも P0-1 により、認証なしで実行経路が露出している

**推奨修正**:
- **初期設定ではMCPインストールを無効化**（明示的に「危険機能を有効化」したユーザーのみ）
- インストール実行前に、生成コマンドを固定表示し、同意を強制
- 可能なら「許可リスト（ベンダー/署名/ハッシュ）」を導入（最低でも信頼境界を文書化）

---

### P0-3. Setup API が同一パスで二重定義されている（動作が不定）
**根拠**:
- `Tepora-app/backend/src/tepora_server/api/setup.py` に `@router.post("/run")` が **2回**存在（例: 261行付近 / 609行付近）

**影響**:
- フロント（SetupWizard）が期待するスキーマと違うハンドラが選ばれると、セットアップが壊れる
- OpenAPI/ルーティングの挙動が不明瞭になり、保守不能

**推奨修正**:
- 片方を削除 or パス変更（例: `POST /api/setup/run` と `POST /api/setup/run-legacy` を分離）
- フロント/バックで契約（JSON schema）を固定し、テストで検知する

---

### P0-4. 検索結果の「link/url」不整合でフロントがクラッシュし得る
**根拠**:
- backend: `Tepora-app/backend/src/core/tools/native.py` の検索結果が `{"title","link","snippet"}`  
- backend: `Tepora-app/backend/src/core/graph/nodes/conversation.py` も `result.get("link")` を参照  
- frontend: `Tepora-app/frontend/src/types/index.ts` は `SearchResult.url` を定義し、`SearchResults.tsx` は `new URL(result.url)` を実行

**影響**:
- Web検索を有効化した瞬間に、UI側で `result.url === undefined` となり **例外→画面崩壊**の可能性が高い

**推奨修正**:
- どちらかに統一（`url`推奨）し、WS送信直前に変換する  
  - 例: backendが `link -> url` へ正規化して送る  
  - 併せて frontend は `new URL()` を try/catch で防御する

---

### P0-5. ツール確認「自動許可」が成立していない（機能不全）
**根拠**:
- backend: `Tepora-app/backend/src/tepora_server/api/session_handler.py` は「危険ツール実行時、WSで approval を要求し `Future` を待つ」
- frontend: `Tepora-app/frontend/src/hooks/chat/useWebSocketMessageHandlers.ts` は「既に許可済みならダイアログ非表示」だが、**自動で approval 応答を返していない**

**影響**:
- 「このセッション中は自動許可」をONにした後、次回以降の危険ツール実行が **無反応→タイムアウト拒否**になり得る  
  （ユーザー体験が最悪で、原因追跡も困難）

**推奨修正**:
- フロントで auto-approved の場合は即 `tool_confirmation_response` を送る  
  もしくは、バックエンド側で「セッション内承認キャッシュ」を持ち、そもそも要求しない

---

### P0-6. llama.cpp バイナリのダウンロードに整合性検証がない（供給網リスク）
**根拠**:
- `Tepora-app/backend/src/core/download/binary.py` は GitHub Release から取得→展開するが、**SHA256/署名検証が存在しない**

**影響**:
- ローカルアプリ同梱の「推論エンジン」更新が、供給網攻撃/改ざんに弱い

**推奨修正**:
- バージョンをピン留めし、**既知SHA256の検証**を必須化
- 可能なら署名検証（少なくとも「ハッシュ一致しない場合は実行しない」）

---

## 4. P1（早期修正推奨）

### P1-1. 静的ファイル配信でパストラバーサルになり得る
**根拠**:
- `Tepora-app/backend/src/tepora_server/app_factory.py` の SPA fallback が `frontend_dist / full_path` をそのまま参照している

**影響**:
- `..` を含むパスで dist 外のファイルを参照できる可能性（将来の外部公開時に致命傷）

**推奨修正**:
- `resolve()` + `relative_to(frontend_dist.resolve())` で dist 配下のみ許可（ZipSlip対策と同じ発想）

---

### P1-2. `SecurityUtils.safe_path_join()` が文字列 `startswith` 依存で境界を誤判定し得る
**根拠**:
- `Tepora-app/backend/src/core/common/security.py` が `str(final_path).startswith(str(base))` で判定

**影響**:
- Windows等で `C:\\logs` と `C:\\logs_backup` のような **prefix一致**で迂回し得る

**推奨修正**:
- `Path.is_relative_to()`（3.9+）または `os.path.commonpath` を使用

---

### P1-3. イベントループをブロックする処理が残る（体感品質を落とす）
例:
- `Tepora-app/backend/src/core/llm/health.py` が `requests + time.sleep` でヘルスチェック（async呼び出し経路でブロックし得る）
- `Tepora-app/backend/src/core/graph/nodes/conversation.py` の検索実行が同期ノードでブリッジ実行（設計としては成立するが遅延が見えにくい）

**推奨修正**:
- ブロッキング箇所は `asyncio.to_thread()` / executor に隔離し、WS応答性を維持

---

### P1-4. フロントのUX細部で「信頼を落とすバグ」が点在
例（根拠は各ファイル）:
- `Tepora-app/frontend/src/components/InputArea.tsx` の textarea 自動リサイズが `message` 変更で動かない（effect依存が空）
- `Tepora-app/frontend/src/pages/Memory.tsx` が `useWebSocket()` を直接呼び、Providerと別のWS接続を張る（無駄/競合）
- `Tepora-app/frontend/src/components/SearchResults.tsx` が `new URL()` を例外処理していない（データ不正でクラッシュ）
- `Tepora-app/frontend/src/components/PersonaSwitcher.tsx` が `alert/confirm` を使用（世界観とUI一貫性が崩れる）

---

### P1-5. CI が backend `tests/core` を除外している（品質ゲートが弱い）
**根拠**:
- `.github/workflows/ci.yml` が `pytest tests/ -v --ignore=tests/core`
- 本レビュー環境では `uv run pytest tests -q` が通っているため、除外理由が薄い

**推奨修正**:
- CIも原則 `tests/` 全実行に戻す（重い/OS依存ならタグ分けして戦略的に除外）

---

## 5. P2（中期改善で化けるポイント）

### P2-1. 設定/秘密情報/同意のUXを「事故らない設計」に寄せる
- Web検索・MCP・外部取得（モデル/バイナリ）の各機能に、**明確な同意導線と既定OFF**を徹底
- 「何が外部に送られるか（クエリ/添付/会話）」をUIで説明し、ユーザーに選ばせる

### P2-2. 版数・命名・ドキュメント整合
- `Tepora-app/backend/pyproject.toml` は `1.0.0`、`frontend/src-tauri/tauri.conf.json` は `0.1.0`、READMEは「Beta v2.0」など不整合
- 期待値のズレが「サポート地獄」を生むため、SemVer運用とCHANGELOGが必要

### P2-3. MCPは“拡張機構”として強力だが、プロダクト品質は「隔離」で決まる
- 既定は無効、または「公式署名済み/検証済み」だけを許可
- 実行時権限（ファイル/ネット/プロセス）を段階的に許可する設計が望ましい

---

## 6. 良い点（伸ばすべき資産）

- **テストが動く**（backend 105 / frontend 72）＝改善を高速に回せる
- backend は **DownloadManager / ModelManager / BinaryManager** など、責務分割が進んでいる
- フロントは **Tauri + Sidecar の起動同期**や、WSストリーミングのバッファリングなど、体験を意識した実装がある
- `react-markdown` に `rehype-sanitize` を入れており、Tauri文脈のXSSを意識している（ただしスキーマ/HTML方針は明文化推奨）

---

## 7. リリースに向けた「最短ロードマップ」（現実的）

### Phase 0（P0を潰して“配れる”状態へ）
1. **認証境界を実装**（API/WS/Setup/MCP/Shutdown/Logs をトークン必須に）
2. **Setup API の二重定義を解消**（契約を固定し、フロントと同時に修正）
3. **search result 契約を統一**（`url`/`link`、例外防御）
4. **ツール自動許可を成立させる**（フロント即応答 or バックエンドキャッシュ）
5. **バイナリ更新の整合性検証**（SHA256必須）
6. **静的配信のパス検証**（dist外参照禁止）

### Phase 1（支持される品質へ）
- CIを全テストに戻し、lint/typecheckも必須ゲート化
- エラー表示/翻訳の穴埋め（“？”の残留などをゼロへ）
- プライバシーと同意の説明をUIに統合

---

## 8. 「支持されるか？」への厳しい見立て

現状の機能セットは魅力的ですが、ユーザーがアプリを支持する前に **“怖くて使えない/壊れて見える”体験**が先に来ます。  
特にローカル常駐系AIは「安全・透明・壊れない」が最低条件です。ここを満たせば、Teporaの“相棒”路線（EM-LLM含む）は十分に武器になります。

---

## 9. 付録: 重大指摘の参照一覧（ファイル）

- 認証スキップ: `Tepora-app/backend/src/tepora_server/api/security.py`
- Config API: `Tepora-app/backend/src/tepora_server/api/routes.py`
- MCP API/Installer: `Tepora-app/backend/src/tepora_server/api/mcp_routes.py`, `Tepora-app/backend/src/core/mcp/installer.py`
- Setup 二重定義: `Tepora-app/backend/src/tepora_server/api/setup.py`
- 静的配信: `Tepora-app/backend/src/tepora_server/app_factory.py`
- バイナリDL検証欠如: `Tepora-app/backend/src/core/download/binary.py`
- 検索結果 link: `Tepora-app/backend/src/core/tools/native.py`, `Tepora-app/backend/src/core/graph/nodes/conversation.py`
- フロント SearchResults url: `Tepora-app/frontend/src/components/SearchResults.tsx`, `Tepora-app/frontend/src/types/index.ts`
- ツール自動許可不成立: `Tepora-app/frontend/src/hooks/chat/useWebSocketMessageHandlers.ts`, `Tepora-app/backend/src/tepora_server/api/session_handler.py`

