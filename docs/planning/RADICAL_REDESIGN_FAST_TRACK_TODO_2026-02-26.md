# Tepora Radical Redesign Fast-Track TODO

- 作成日: 2026-02-26
- ステータス: Ready
- 前提:
  - 個人開発（納期制約なし）
  - 1週間以内に実装
  - タスクは最短10分単位で分割
  - ほぼ0コストで試行可能
- 参照:
  - `docs/planning/COMPREHENSIVE_CODE_REVIEW_2026-02-25.md`
  - Radical Redesign Proposal (2026-02-26)

---

## 1. 実行ルール

- [ ] すべての新規実装を feature flag 化する（`redesign.*`）
- [ ] 既存経路を消さず、切替で比較できる状態を維持する
- [ ] 各タスク完了時に `cargo check` または `npm test -- --run` の最小確認を行う

---

## 2. Day 1: 安全基盤（Security + Observability）

- [ ] Rust `tracing` 初期化（request_id / session_id を span に付与）
- [ ] フロントログを構造化して backend 側に集約する導線を追加
- [ ] 認証系エンドポイントにレート制限ミドルウェアを追加
- [ ] Session token に `expires_at` と再発行処理を追加
- [ ] トークン期限切れ時のフロント再接続フローを追加

---

## 3. Day 2: Backend コア骨格（CQRS + Actor）

- [ ] `Command` / `Query` の型を定義
- [ ] `tokio::mpsc` ベースの command bus を追加
- [ ] `SessionActor` の最小実装（1 session = 1 actor）
- [ ] 既存 chat 実行経路を actor 経由に切替可能にする
- [ ] `TokenGenerated` / `NodeCompleted` イベントを publish する

---

## 4. Day 3: Memory 統合（Hexagonal）

- [ ] `MemoryRepository` trait を定義
- [ ] SQLite 実装（統合リポジトリ）を追加
- [ ] `memory` / `em_llm` / `memory_v2` の read path を adapter 経由に統一
- [ ] write path を統合実装に寄せる
- [ ] 旧経路は `legacy` フラグで残す

---

## 5. Day 4: Graph 宣言化（PoC -> 本適用）

- [ ] workflow JSON schema を定義
- [ ] 1本の既存フローを JSON 定義へ移植
- [ ] runtime で JSON をロードして実行する経路を追加
- [ ] schema バリデーション失敗時の安全なフォールバックを実装
- [ ] GUI編集機能向けの最小メタ情報（node label, edge type）を残す

---

## 6. Day 5: Frontend 状態再設計（XState）

- [ ] chat UI state machine を定義（idle / thinking / streaming / tool_confirm / error）
- [ ] `isGenerating` 等の重要フラグを machine 状態へ置換
- [ ] 「生成中は送信不可」「ツール実行中キャンセル」遷移ガードを実装
- [ ] Zustand は session list と cache のみに責務縮小
- [ ] 主要遷移の単体テストを追加

---

## 7. Day 6: 通信統一（Tauri IPC）

- [ ] `transport` 抽象層を作成（invoke / listen）
- [ ] 主要機能を IPC 経路へ移植（chat send / stream event / tool confirm）
- [ ] WebSocket/REST は fallback として温存
- [ ] 設定で `transport = ipc | websocket` を切替可能にする
- [ ] ローカルポート未使用での動作確認を実施

**証跡 (Day 6)**

- 変更ファイル一覧:
  - `frontend/src/transport/index.ts`
  - `frontend/src/transport/ipcTransport.ts`
  - `frontend/src/transport/websocketTransport.ts`
  - `frontend/src/transport/factory.ts`
  - `frontend/src/stores/websocketStore.ts`
  - `frontend/src/context/SettingsContext.tsx`
  - `frontend/src/hooks/useFeatureFlag.ts`
  - `frontend/src/test/unit/transport/transport.test.ts`
- 主要差分要約:
  - `Transport` interfaceを定義し、IPCとWebSocketの実装を分離。
  - `useFeatureValue`を利用して `transport_mode`を取得し、`SettingsContext`内で `window.__TRANSPORT_MODE__`として展開。
  - `websocketStore`内の `sendMessage`等を `transport_mode === 'ipc'`時に `getTransport('ipc').send(...)`を利用してIPC経由へ切り替え、それ以外は既存WebSocket実装へフォールバックするよう修正。
- 実行コマンド: `npm test -- --run src/test/unit/transport/transport.test.ts`、`npx tsc --noEmit`
- 実行結果: Pass (Transport unit tests x7 pass. Typescript check pass)
- TODO更新可否: 可（[ ] -> [x]）

---

## 8. Day 7: CRDT + MCP Sandbox（PoCゲート）

- [ ] CRDT（Automerge or Yjs）で 1データ構造のみ同期PoC
- [ ] 同時編集コンフリクトが自動解決されることを確認
- [ ] MCPツール1本を Wasmtime sandbox で実行するPoC
- [ ] ファイル/ネットワーク制限ポリシーを最小適用
- [ ] PoC結果を「採択/保留」で記録

---

## 9. 完了条件（Definition of Done）

- [ ] 既存機能を壊さずに `redesign` フラグで新旧切替できる
- [ ] セキュリティ必須項目（レート制限・トークン期限）が有効
- [ ] Event駆動の最小経路（Command -> Actor -> Event -> UI反映）が通る
- [ ] Memoryアクセスの主要経路が `MemoryRepository` 経由
- [ ] XState 化したチャット遷移がテストで担保される
- [ ] IPC経路で主要ユースケースが実行可能
- [ ] CRDT / Sandbox は PoC結果を意思決定メモ化済み

---

## 10. 実装メモ

- 重い判断が必要な項目は「PoC先行、採択後に本実装」で進める
- 破壊的変更は最終日にまとめず、毎日 feature flag 下で段階投入する
- 1タスク10分を超える場合は分割して未完了を明示する
