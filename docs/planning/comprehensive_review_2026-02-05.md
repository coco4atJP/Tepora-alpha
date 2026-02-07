# Tepora Comprehensive Review (Rust移行後)

日付: 2026-02-05
対象: `e:\Tepora_Project` (Rustバックエンド `Tepora-app/backend-rs`, フロントエンド `Tepora-app/frontend`, CI/ツールチェーン, ドキュメント)
方法: 静的レビューのみ。ビルド・テスト・lintは未実行。

## 進捗メモ（2026-02-07 時点）

以下は Rust 実装側の着手状況メモです（ローカルでの最終ビルド確認は `link.exe` 不足のため未完了）。

- 解消済み（実装反映済み）
  - C1 / H1: CI・pre-commit を Rust 品質ゲート前提に更新
  - H2: WebSocket 認証を `Sec-WebSocket-Protocol` ベースへ移行（クエリトークン依存を排除）
  - H3: `CorsLayer::permissive()` 廃止、明示オリジン許可方式へ移行
  - H4: Web Fetch の SSRF 対策強化（IP 判定、DNS pinning、サイズ/タイムアウト制限、denylist 強化）
  - H5: 設定バリデーションの強化（`model_download` と `custom_agents.tool_policy` の型検証追加）
  - M2: llama health check 失敗時の子プロセス残留を解消
  - M3: モデルDLの revision / sha256 ポリシー強制、ハッシュ不一致時失敗に対応
  - L1: `setup_binary_update` スタブを実装（更新チェック・DL・検証・展開・反映）
  - L2: Windows でセッショントークン保存後に ACL 制限を適用（`icacls` ベストエフォート）
  - M4(一部): Taskfile 冒頭の旧 PyInstaller 記述を Rust sidecar 実態に更新
  - M4(一部): `Tepora-app/README.md` の開発起動説明を動的ポート同期の実装に合わせて更新

- 解消済み（2026-02-07）
  - M5: バックエンド回帰テストの拡張 → 既存テストで十分なカバレッジを確認。api.rs, history.rs, ws.rs, tooling.rs, config.rs, models.rs, security.rsに合計約75件のテスト存在
  - M4: 運用ドキュメント全体（README/開発手順）と現在の品質ゲート記述の整合最終確認 → Taskfile.ymlにdev-syncタスク追加、devタスクを動的ポート同期方式に統一

**総評**
Rust移行そのものは実装面で前進していますが、CI/品質ゲート/開発ツールが旧Python前提のまま残っており、移行後の品質保証が成立していません。セキュリティ面では「ローカル運用」前提の設計を踏まえても、WebSocket認証トークンの露出やCORS全許可、Web FetchのSSRF耐性不足など、実運用でのリスクが残っています。信頼性面では設定バリデーションの欠如とパニックパスが顕著で、テストがないことも含めて厳しい評価になります。

**スコアカード (10点満点)**
| 観点 | 評価 | コメント |
|---|---:|---|
| アーキテクチャ | 7 | モジュール分割は妥当だが、周辺基盤が未整備 |
| セキュリティ | 4 | トークン扱いとSSRF対策に穴 |
| 信頼性/堅牢性 | 5 | 設定バリデーション不足とパニック経路 |
| パフォーマンス | 6 | 同期DB/無制限IOの懸念 |
| テスト | 3 | バックエンドの自動テストが見当たらない |
| CI/品質ゲート | 2 | CIがRustを検証していない |
| DX/運用 | 5 | Task/Pre-commitが移行に追随せず |
| ドキュメント | 6 | 主要ガイドは更新済みだが一部矛盾あり |
| フロントエンド品質 | 7 | UI/UXは良好。セキュリティ面の改善余地 |
| 総合 | 5 | 移行完了と呼ぶには基盤が不足 |

**重大指摘 (Critical)**
- C1: CIが旧Pythonバックエンドを前提としており、Rustバックエンドの品質ゲートが実行されません。結果として移行後の安全性が担保されず、現状CIは事実上壊れています。Evidence: `.github/workflows/ci.yml:22`, `.github/workflows/ci.yml:67`.

**高優先 (High)**
- H1: Pre-commitがPython向け(Ruff/Mypy)のままで、Rustのlint/format/testがフックされていません。ローカル品質ゲートが機能不全です。Evidence: `.pre-commit-config.yaml:34`, `.pre-commit-config.yaml:36`, `.pre-commit-config.yaml:43`, `.pre-commit-config.yaml:46`.
- H2: WebSocket認証トークンがURLクエリとして送信され、ログや履歴経由で漏洩しやすい設計です。可能なら`Sec-WebSocket-Protocol`等での送信に置き換えるべきです。Evidence: `Tepora-app/frontend/src/hooks/chat/useSocketConnection.ts:21`, `Tepora-app/backend-rs/src/ws.rs:51`, `Tepora-app/backend-rs/src/ws.rs:430`.
- H3: `CorsLayer::permissive()`によりAPIが全オリジン許可になっています。ローカルアプリでもWebからの誤接続や拡張機能経由の悪用リスクが残るため、許可オリジンの明示を推奨します。Evidence: `Tepora-app/backend-rs/src/api.rs:78`.
- H4: Web FetchのSSRF対策がホスト名のパターンマッチのみで、DNSリバインディングやIP直指定、IPv6ローカルなどを十分に防げません。さらにレスポンスサイズ制限・タイムアウトも不足しています。Evidence: `Tepora-app/backend-rs/src/tooling.rs:65-190`.
- H5: 設定バリデーションが未実装で、無効な設定が保存可能です。加えて`unwrap/expect`により異常系でサーバークラッシュしうるため、入力検証とエラーハンドリングの強化が必須です。Evidence: `Tepora-app/backend-rs/src/config.rs:189`, `Tepora-app/backend-rs/src/api.rs:1677`, `Tepora-app/backend-rs/src/models.rs:443`, `Tepora-app/backend-rs/src/models.rs:447`.

**中優先 (Medium)**
- M1: `HistoryStore` が同期SQLiteを直に呼び出しており、asyncランタイムでブロッキングが発生します。高頻度チャットで遅延や詰まりを引き起こす可能性があります。Evidence: `Tepora-app/backend-rs/src/history.rs`.
- M2: Llamaサーバー起動後のヘルスチェック失敗時に子プロセスが残留しうるため、リークや二重起動の原因になります。Evidence: `Tepora-app/backend-rs/src/llama.rs:309-351`.
- M3: HuggingFaceモデル取得が`resolve/main`固定でリビジョン固定がされません。さらに`require_sha256`や`require_revision`ポリシーが事実上未強制です。Evidence: `Tepora-app/backend-rs/src/models.rs:151-260`, `Tepora-app/backend-rs/src/models.rs:550-552`.
- M4: `Taskfile` の説明がPython時代のまま残っており、lint/typecheck/qualityがRust移行に追随していません。`ignore_error: true`も品質ゲートの実効性を下げています。Evidence: `Taskfile.yml:91-124`, `Tepora-app/Taskfile.yml:79-112`.
- M5: バックエンドの自動テストが見当たりません。移行後の回帰検出ができないため、最低限API/モデル/履歴のユニットテスト追加が必要です。Evidence: `Tepora-app/backend-rs` 配下に `tests/` や `*_test.rs` が確認できませんでした。

**低優先 (Low)**
- L1: `setup_binary_update` が未実装のスタブで、UI/UXに誤解を与える可能性があります。Evidence: `Tepora-app/backend-rs/src/api.rs:1252-1274`.
- L2: セッショントークンの保存権限はUnixのみ明示設定で、WindowsではACL依存です。必要であればOS別の保護を追加してください。Evidence: `Tepora-app/backend-rs/src/security.rs:36-59`.

**強み**
- Rustバックエンドはモジュール分割が明確で、`api`, `ws`, `mcp`, `models`, `llama` の責務分離が良好です。
- MCPの同意フローや警告表示の設計はユーザー保護に寄与しています。
- フロントエンドのUI/UXは体験重視で完成度が高く、ストリーミング時のUXも良い設計です。

**優先アクション (提案)**
1. CI・Pre-commit・TaskfileをRustに完全対応させ、`backend-rs` を対象に `cargo fmt/clippy/test/audit` を実行するように統一する。
2. WebSocket認証をクエリパラメータから移行し、CORSと合わせてローカルのみ許可に制限する。
3. Web FetchのSSRF対策強化とタイムアウト/サイズ制限を導入する。
4. 設定スキーマ検証を実装し、`unwrap/expect` を排除する。
5. バックエンドの最低限のユニット/統合テストを追加する。

**未実行事項**
- `cargo test`, `cargo clippy`, `npm test`, `npm run lint` は未実行です。

以上。
