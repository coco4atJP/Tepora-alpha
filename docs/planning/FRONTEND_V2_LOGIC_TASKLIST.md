# Frontend v2 ロジック担当タスクリスト

- 作成日: 2026-03-17
- 対象計画: `FRONTEND_V2_IMPLEMENTATION_PLAN.md`
- 主担当: ロジック担当
- 目的: v2 に必要な状態管理、契約同期、transport 接続、screen container 実装を段階的に進める
- 実装更新日: 2026-03-17
- 現在ステータス: 完了

## 実施結果サマリ

- `L-001` `L-002` `L-003`: 完了
- `L-101`: 完了
  - 方針文書: `FRONTEND_V2_CONTRACT_SYNC_STRATEGY.md`
- `L-102` `L-103` `L-104`: 完了
- `L-201` `L-202` `L-203` `L-204`: 完了
- `L-301` `L-302` `L-303` `L-304`: 完了
  - `L-304` は「直近履歴 window の bounded refetch」で達成
- `L-401` `L-402` `L-403`: 完了
- `L-501`: 完了
  - validator / adapter / machine / query hook / integration test を追加済み
- `L-502`: 完了
  - 比較チェック: `FRONTEND_V2_PARITY_CHECKLIST.md`
- `L-503`: 完了
  - 縮退計画: `FRONTEND_V2_V1_RETIREMENT_PLAN.md`

---

## 1. 担当責務

ロジック担当は以下に責任を持つ。

- backend 契約と frontend 型の同期
- runtime validation
- transport adapter
- React Query / Zustand / XState の責務整理
- route loader / action
- screen container と view model
- feature flag / v1-v2 切替
- desktop integration の再利用導線

ロジック担当が責任を持たないもの:

- 見た目の最終レイアウト
- アニメーションの最終調整
- デザイントークン定義
- typography / spacing / hover 演出

---

## 2. 完了条件

ロジック側の完了条件は以下。

1. v2 画面が既存 backend と安全に通信できる
2. state の責務が `Query / Zustand / XState` に分離されている
3. view は backend 生 payload を直接扱わない
4. desktop / web 差分が adapter 層で吸収されている
5. v1 と v2 の切替が feature flag または route で可能

---

## 3. 優先順位

優先度は `P0 > P1 > P2` とする。

- `P0`: v2 の成立に必須
- `P1`: 主要フローに必須
- `P2`: 安定化・退役準備

---

## 4. タスクリスト

## Phase 0: v2 レール作成

### L-001 `P0` v2 エントリポイント作成

- 内容: `src/v2/app/entry.tsx`, `router.tsx`, `providers.tsx` を作成
- 成果物:
  - v2 専用 router
  - v2 専用 provider 合成
  - v1 から独立した描画入口
- 完了条件: 空の v2 shell を表示できる

### L-002 `P0` v2 切替導線作成

- 内容: feature flag または `/v2` route の作成
- 成果物:
  - v1/v2 切替ロジック
  - 開発用切替手順
- 完了条件: 本番コードを壊さず v2 を起動できる

### L-003 `P0` v2 ディレクトリ責務定義

- 内容: `screen/`, `model/`, `shared/contracts/`, `shared/lib/` のスケルトン作成
- 成果物:
  - 物理的な責務境界
  - 最低限の lint / import ルール案
- 完了条件: デザイン担当が触るファイルと明確に分かれる

---

## Phase 1: 契約・validation・adapter 基盤

### L-101 `P0` 契約同期導線の実装方針確定

- 内容: Rust 真実源から frontend 契約を得る生成導線を決める
- 成果物:
  - schema 生成方針
  - frontend 生成先ディレクトリ
  - 更新手順メモ
- 完了条件: 手書き二重管理を避ける運用が決まる

### L-102 `P0` Zod validation レイヤー作成

- 内容: API / WS 境界に Zod schema を配置する
- 成果物:
  - `src/v2/shared/contracts/*`
  - parse / safeParse helper
  - transport 境界 validator
- 完了条件: 生 payload が screen/view に流れない

### L-103 `P0` transport adapter 作成

- 内容: 既存 transport / socketCommands / ipc-websocket 差分を v2 から使える adapter に包む
- 成果物:
  - send / stop / subscribe / reconnect API
  - desktop/web transport 差分吸収
- 完了条件: v2 model 層が既存 `socketCommands.ts` を直接知らない

### L-104 `P1` session token / reconnect 更新ロジック統合

- 内容: token refresh と再接続時の stream 失効ルールを v2 adapter に反映
- 完了条件: refresh 後の再接続動作が v2 でも統一される

---

## Phase 2: 状態管理の再構築

### L-201 `P0` QueryClient v2 デフォルト設定

- 内容: メモリ優先の `staleTime`, `gcTime`, `retry`, `refetchOnWindowFocus` を v2 側で明示
- 成果物:
  - v2 QueryClient factory
  - query option helper
- 完了条件: inactive query の長時間保持を避ける設定になっている

### L-202 `P0` chat state の責務分離

- 内容:
  - Query: server state
  - Zustand: 軽量 global state
  - XState: 生成フロー
- 成果物:
  - chat v2 model
  - state ownership 表
- 完了条件: v1 の chatStore 的な集中状態を作らない

### L-203 `P0` XState machine v2 作成

- 内容: `idle -> sending -> streaming -> completed / error / stopped` を中心とした machine 作成
- 範囲:
  - send
  - stop
  - regenerate
  - tool confirmation
- 完了条件: machine context に重い本文配列を持たない

### L-204 `P1` settings state の再設計

- 内容: `SettingsContext` に集中している責務を query/mutation + local reducer へ分割
- 成果物:
  - config fetch hook
  - config save mutation
  - settings section view model
- 完了条件: v2 settings は巨大 context 依存なしで成立する

---

## Phase 3: Chat Screen 連携

### L-301 `P0` ChatScreen container 作成

- 内容: `features/chat/screen/ChatScreen.tsx` を作成し、view に props を渡す
- 成果物:
  - `ChatScreen`
  - `useChatScreenModel`
  - view props contract
- 完了条件: デザイン担当は props のみで画面を組める

### L-302 `P0` message pipeline 実装

- 内容:
  - `eventId / streamId / seq` に基づく message routing
  - chunk append
  - done / error / stopped の終端処理
- 完了条件: 順序保証と重複排除の仕様を満たす

### L-303 `P1` attachment / tool confirmation / thinking budget 連携

- 内容:
  - attachment view model
  - tool confirmation model
  - thinking budget state
- 完了条件: Input Area の主要機能が v2 で送受信可能

### L-304 `P1` session create / switch / history paging

- 内容:
  - 新規 session 作成
  - session 切替
  - history 常駐抑制を前提にした再取得
- 完了条件: message 全件常駐なしで動く

---

## Phase 4: Settings / Side Panels 連携

### L-401 `P1` SettingsScreen container 作成

- 内容: fullscreen settings 用 screen/model を作成
- 完了条件: view が sections を props だけで描画できる

### L-402 `P1` Session sidebar model 作成

- 内容: 左サイドバー用の session list / selection model を作成
- 完了条件: session history が shell から独立して使える

### L-403 `P1` Agent / RAG panel model 作成

- 内容:
  - mode 別右パネル状態
  - search / agent 用設定
  - active context chips
- 完了条件: view は panel state を直接解釈するだけで描画できる

---

## Phase 5: 品質・移行・退役準備

### L-501 `P0` model / adapter / machine のテスト整備

- 内容:
  - validator test
  - adapter test
  - machine test
  - query hook test
- 完了条件: critical path のロジックが UI 非依存で検証される

### L-502 `P1` v1-v2 比較チェック導線

- 内容:
  - 切替検証リスト
  - major flow parity 確認項目
- 完了条件: v2 切替判断の材料が揃う

### L-503 `P2` v1 依存の縮退計画作成

- 内容:
  - 置き換え済みファイル一覧
  - 削除順序
  - fallback 終了条件
- 完了条件: v1 退役を安全に始められる

---

## 5. デザイン担当への引き渡し物

ロジック担当は以下をデザイン担当へ渡す。

- `screen` と `model` の最小実装
- `view` に渡す props 型
- loading / empty / error / success の state 列挙
- callback interface
- ダミーデータではなく実際の screen composition 例

最低限必要な契約ファイル:

- `features/chat/view/props.ts`
- `features/settings/view/props.ts`
- `features/session/view/props.ts`
- `features/agent/view/props.ts`

---

## 6. マージ前チェック

- backend payload を view に直接渡していない
- Query cache が重くなりすぎる設計になっていない
- machine context に本文や履歴配列を持っていない
- adapter が desktop/web 差分を吸収している
- v1 依存 import が `src/v2/` に流入していない

---

## 7. 最初の着手順

1. `L-001`, `L-002`, `L-003`
2. `L-101`, `L-102`, `L-103`
3. `L-201`, `L-202`, `L-203`
4. `L-301`, `L-302`

この順序で進めると、デザイン担当は Phase 1 の shell と chat view を先行実装できる。
