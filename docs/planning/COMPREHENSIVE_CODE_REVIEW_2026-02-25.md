# Tepora Project 総合コードレビュー（検証済み・改訂版）

**レビュー日付**: 2026-02-25  
**改訂日**: 2026-02-25  
**レビュアー**: AIエージェント  
**アプリケーションバージョン**: v0.4.5 (BETA)
**対象**: Rustバックエンド + Reactフロントエンド + セキュリティ + インフラ構成

---

## 1. 本改訂の方針

本ドキュメントは、当初レビュー内容を実コード・設定・CI定義に照合し、以下の観点で再編集した。

- 事実として確認できる主張のみを「確定」とする
- 根拠が不足する主張は重大度を下げるか、保留にする
- 優先度は「実害リスク」と「再現性」で再評価する

---

## 2. 主張別の妥当性判定（要約）

| 主張 | 判定 | コメント |
| ---- | ---- | -------- |
| `console.*` が多い | 妥当 | フロントで100件を確認 |
| APIキー認証 + WS検証あり | 妥当 | `x-api-key` と WS token/origin 検証あり |
| トークンに有効期限がない | 妥当 | `SessionToken` にTTL/expiry実装なし |
| レート制限未実装 | 妥当 | サーバー側に該当レイヤー未検出 |
| `RUSTSEC-2023-0071` をignore | 妥当 | `audit.toml` と CI 両方で確認 |
| `--legacy-peer-deps` 使用 | 妥当 | CIで複数箇所確認 |
| Graphの `Box<dyn Node>` が重大競合 | 根拠不足 | `Node: Send + Sync` かつ `run(&self, ...)`。重大確定は不適切 |
| AppState全体に重大Race | 根拠不足 | `Arc<Mutex/RwLock>` による同期が広く使われる |
| `router.rs` に包括的ユニットテスト | 不正確 | `runtime.rs` / `tools/manager.rs` はあるが `router.rs` は未確認 |
| ポート番号ハードコード | 部分的に妥当 | モデルportは`config.yml`固定値あり、ただしサーバportはENV上書き可能 |

---

## 3. フロントエンドレビュー（検証済み）

### 3.1 技術スタック

- React 19.2.1
- TypeScript 5.9.3
- Tauri API 2.9.1
- TanStack Query 5.90.x
- React Router 7.12.x
- Tailwind 4.1.18
- Vite 7.3.0
- Zustand
- i18next

### 3.2 良い点

#### 状態管理の責務分離

- `chatStore` と `websocketStore` と `sessionStore` の責務は概ね分離されている。
- `sessionStore` は `partialize` で `currentSessionId` のみ永続化している。

#### ストリーミング実装

- `chatStore` にて、チャンクバッファとフラッシュ制御を実装。
- ネットワークヒント（`effectiveType`, `rtt`, `saveData`）を使う間隔調整を確認。

#### WebSocket運用

- `websocketStore` で指数バックオフ + ジッター再接続。
- ツール確認フロー（request/response）とセッション管理を実装。

#### i18n

- `i18next` + `LanguageDetector` を適切に初期化。
- `en`, `ja`, `es`, `zh` の4言語リソースを確認。

### 3.3 問題点

#### 課題 1: ログ出力過多
**深刻度**: 中

- `frontend/src` 内で `console.log/error/warn/info/debug` を100件確認。
- 本番で不要ログが残るとノイズ・運用コスト・情報露出リスクが上がる。

#### 課題 2: エラーハンドリング不整合
**深刻度**: 高

- 例: `useSessions` は失敗時 `console.error` + `null/false` を返し、UI文脈に依存。
- 例: `SetupWizard` でも箇所により握り潰し/再throw/ユーザー表示が混在。

#### 課題 3: WebSocket接続ロジックの重複
**深刻度**: 低

- `hooks/chat/useSocketConnection.ts` と `stores/websocketStore.ts` に類似実装（URL解決、token、再接続）が存在。
- 機能分散により将来的な差分バグを誘発しやすい。

### 3.4 フロントエンド推奨アクション

| 優先度 | アクション | 期待効果 |
| ------ | ---------- | -------- |
| 高 | 統一エラーモデル導入（型 + UI変換 + ログ方針） | UX安定化と保守性向上 |
| 中 | `console.*` の整理（開発限定/構造化ログ） | 運用性・セキュリティ向上 |
| 低 | WebSocket接続実装の一本化 | 重複削減・修正漏れ防止 |

---

## 4. バックエンドレビュー（検証済み）

### 4.1 良い点

#### アーキテクチャ

- `petgraph` ベースの `GraphRuntime` + ノード実行モデルを実装。
- `Node` trait に `Send + Sync` 制約あり。
- `AppState` は共有コンポーネントを `Arc` で保持し、主要モジュールは同期プリミティブを利用。

#### セキュリティ実装

- APIキー認証（`x-api-key`）とWS token検証あり。
- Originチェックあり（設定値 + デフォルトローカル起点）。
- Web fetch のSSRF対策（private/loopback/link-local/documentation帯域ブロック）あり。

#### メモリ暗号化

- `memory_v2` で AES-256-GCM 暗号化実装を確認。
- `em_llm/service` で keyring 連携し鍵を生成/保存する実装を確認。

#### テスト

- `graph/runtime.rs` と `tools/manager.rs` はテストが比較的厚い。

### 4.2 見直しが必要な評価点（当初レビューの修正）

#### 修正 1: Graphノード所有権問題を「重大」とする評価
**修正後評価**: 根拠不足（重大確定不可）

- `Box<dyn Node>` 自体は `Node: Send + Sync` 制約下で直ちに競合を意味しない。
- `GraphRuntime::run(&self, ...)` で実行され、当該主張だけでは実害再現に至らない。

#### 修正 2: AppState並行性を「重大」とする評価
**修正後評価**: 根拠不足（要個別再現）

- 複数モジュールで `Mutex/RwLock` による保護を確認。
- 重大判定には、具体的なデッドロック経路/整合性破壊シナリオが必要。

### 4.3 実際に残る課題

#### 課題 1: Graph実行経路のテストギャップ
**深刻度**: 中

- `runtime.rs` テスト注釈で、`run()` 本体の実行経路を直接検証しない方針が記載されている。
- 実運用近い `NodeContext` を使う統合テストが不足。

#### 課題 2: llama-serverライフサイクル管理
**深刻度**: 中

- `stop_internal` はモデル切替時には `kill()` するが、公開 `stop` や `Drop` 実装は未確認。
- 異常終了・アプリ終了時の確実な終了戦略を明文化/実装した方がよい。

#### 課題 3: メモリ実装の併存
**深刻度**: 低〜中

- `memory/`, `em_llm/`, `memory_v2/` が共存し、移行期の複雑性が残る。
- 運用上の現行/廃止境界をドキュメント化すべき。

### 4.4 バックエンド推奨アクション

| 優先度 | アクション | 期待効果 |
| ------ | ---------- | -------- |
| 高 | Graph `run()` 実経路の統合テスト追加 | 回帰検知能力向上 |
| 中 | llama-server 明示停止フック導入 | リソースリーク防止 |
| 中 | エラーログ整流（層別の責務統一） | 調査容易性向上 |
| 低 | メモリ系ディレクトリ統合計画の明文化 | 技術負債削減 |

---

## 5. セキュリティレビュー（検証済み）

### 5.1 良い点

- APIキー認証ミドルウェアがAPIルートに適用されている。
- WebSocketで Origin と token（protocol header）を検証。
- Session tokenファイル保護（Unix `0600` / Windows `icacls`）がある。
- MCPポリシーが `LOCAL_ONLY` 既定で、危険コマンドパターンをブロック。
- Web fetch にURL denylist + IP帯域制限がある。

### 5.2 改善点

#### 課題 1: トークンに有効期限・ローテーション概念がない
**深刻度**: 中

- `SessionToken` は値比較のみ。期限/発行時刻/失効戦略を持たない。

#### 課題 2: レート制限の未実装
**深刻度**: 高

- 認証失敗試行や特定エンドポイント保護のレート制御が見当たらない。

#### 課題 3: 開発時Origin検証の緩和
**深刻度**: 低

- `Origin` ヘッダ欠落時、`TEPORA_ENV != production` で許可する分岐がある。
- 開発利便性としては妥当だが、本番混入防止の運用ガードは必要。

### 5.3 セキュリティ推奨アクション

| 優先度 | アクション | 期待効果 |
| ------ | ---------- | -------- |
| 高 | 認証周辺にレート制限導入 | 総当たり耐性向上 |
| 中 | トークン期限/ローテーション導入 | 漏洩時影響の限定 |
| 低 | `TEPORA_ENV` 運用ガード追加 | 設定ミス防止 |

---

## 6. インフラ・設定レビュー（検証済み）

### 6.1 良い点

- `Taskfile.yml` による開発/品質タスク整理あり。
- pre-commit で Rust/TS の品質ゲートを導入。
- CIで backend/frontend の品質・セキュリティジョブを分離。

### 6.2 問題点

#### 課題 1: モデルポートの固定値運用
**深刻度**: 中

- `config.yml` の `models_gguf.*.port` が 8081/8088 固定値。
- ただしサーバー本体ポートは `TEPORA_PORT` / `PORT` で上書き可能。

#### 課題 2: `secrets.yaml` が空
**深刻度**: 低

- 現状 `{}`。設計意図が明文化されていない場合、運用者が迷う可能性がある。

#### 課題 3: `RUSTSEC-2023-0071` の継続ignore
**深刻度**: 中（運用管理課題）

- `audit.toml` とCIでignoreされる。
- ただし `audit.toml` に理由コメントは記載済み。

#### 課題 4: CIで `--legacy-peer-deps` を使用
**深刻度**: 低〜中

- 依存競合を潜在化しうるため、段階的に解消が望ましい。

### 6.3 インフラ推奨アクション

| 優先度 | アクション | 期待効果 |
| ------ | ---------- | -------- |
| 中 | モデルport設定の上書き戦略を文書化 | 運用柔軟性向上 |
| 中 | RustSec ignoreの定期見直しルール化 | セキュリティ維持 |
| 低 | `legacy-peer-deps` 解消計画 | 依存健全性向上 |

---

## 7. 優先度高の改善項目（改訂版）

### 7.1 緊急（次期リリースで対応推奨）

| # | 項目 | 領域 | 説明 |
|---|------|------|------|
| 1 | レート制限実装 | セキュリティ | 認証系・高頻度APIの保護 |
| 2 | エラー処理統一 | フロントエンド | 失敗時のUI/ログ/型を統一 |
| 3 | トークン期限/ローテーション | セキュリティ | 長期固定トークン運用の改善 |

### 7.2 高優先度（次期スプリント）

| # | 項目 | 領域 | 説明 |
|---|------|------|------|
| 4 | Graph実行経路の統合テスト | バックエンド | `run()` の実経路検証を追加 |
| 5 | console出力整理 | フロントエンド | 本番不要ログを削減/統制 |
| 6 | llama-server停止戦略明確化 | バックエンド | 終了処理と障害時動作を明確化 |

---

## 8. 中期的改善項目（3〜6ヶ月）

| # | 項目 | 領域 | 説明 |
|---|------|------|------|
| 7 | メモリ実装の統合整理 | バックエンド | `memory` 系の責務明確化 |
| 8 | 設定運用ガイド整備 | インフラ | `config/secrets` 運用の明文化 |
| 9 | 依存関係健全化 | インフラ | `legacy-peer-deps` 依存脱却 |
| 10 | セキュリティ例外管理 | セキュリティ | RustSec ignoreの棚卸し運用 |

---

## 9. 低優先度の改善項目

| # | 項目 | 領域 | 説明 |
|---|------|------|------|
| 11 | WS接続ロジック一本化 | フロントエンド | Store/Hook重複の段階解消 |
| 12 | 開発時Origin緩和の明示 | セキュリティ | 運用事故防止のための文書化 |

---

## 10. まとめ

Teporaは、Local-Firstかつプライバシー重視の設計として、バックエンド/フロントエンドともに完成度が高い。特に、WS認証、MCPポリシー、メモリ暗号化、状態管理の分離は強みである。

一方で、次の品質向上のボトルネックは「セキュリティ運用（レート制限・トークン寿命）」「フロントのエラー処理統一」「統合テストの厚み」である。本改訂では、根拠の薄い重大指摘（Graph所有権起因の重大競合など）を除外し、実装証跡に基づく優先度へ再構成した。

---

## 11. 主要根拠ファイル（抜粋）

- `Tepora-app/frontend/package.json`
- `Tepora-app/frontend/src/stores/chatStore.ts`
- `Tepora-app/frontend/src/stores/websocketStore.ts`
- `Tepora-app/frontend/src/stores/sessionStore.ts`
- `Tepora-app/frontend/src/i18n.ts`
- `Tepora-app/frontend/src/hooks/useSessions.ts`
- `Tepora-app/frontend/src/features/settings/components/SetupWizard/SetupWizard.tsx`
- `Tepora-app/backend-rs/src/graph/runtime.rs`
- `Tepora-app/backend-rs/src/graph/node.rs`
- `Tepora-app/backend-rs/src/state/mod.rs`
- `Tepora-app/backend-rs/src/core/security.rs`
- `Tepora-app/backend-rs/src/server/router.rs`
- `Tepora-app/backend-rs/src/server/ws/handler.rs`
- `Tepora-app/backend-rs/src/tools/manager.rs`
- `Tepora-app/backend-rs/src/memory_v2/sqlite_repository.rs`
- `Tepora-app/backend-rs/src/em_llm/service.rs`
- `Tepora-app/backend-rs/config.yml`
- `Tepora-app/backend-rs/secrets.yaml`
- `Tepora-app/backend-rs/audit.toml`
- `.github/workflows/ci.yml`
- `.github/workflows/security-scan.yml`

---

*本レビューは、実コード照合にもとづいて再編集された検証済み版です。*
