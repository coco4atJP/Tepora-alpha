# Tepora Frontend v2 実装計画

- 作成日: 2026-03-17
- ステータス: Draft
- 前提: `FRONTEND_TECHNICAL_REQUIREMENTS.md` と `FRONTEND_DESIGN_GUIDELINES.md` を確定仕様として扱う
- 目的: 既存フロントエンドを直接大改修するのではなく、同一コードベース内で `v2` を並行実装し、段階的に v1 を退役させる

---

## 1. 結論

Tepora のフロントエンド改修は、**既存コードベース上で Frontend v2 を並行実装し、段階移行する方式**を採用する。

採用理由:

1. UI要件が既存画面の延長ではなく、アプリシェル・入力導線・設定画面・サイドバー構造まで再設計を要求しているため
2. transport / sidecar / 認証 / Tauri統合などの既存資産は再利用価値が高く、全面新規実装はリスクが高いため
3. ロジック担当とデザイン担当を分離しやすく、並行開発と比較検証がしやすいため

---

## 2. 基本方針

### 2.1 実装モデル

- `v1` を維持したまま、同一アプリ内に `v2` の app shell と主要画面を新設する
- `v2` は当初 `feature flag` または専用 route で切り替え可能にする
- backend 契約、transport、sidecar、session token、desktop capability などは既存資産を再利用する
- 新規UIは `v1` コンポーネントを直接流用せず、`v2` 用の layout / primitives / screen を新設する

### 2.2 やらないこと

- 既存の `Layout.tsx`, `SettingsDialog.tsx`, `ChatInterface.tsx` を大規模に書き換えながら最終形へ持っていくこと
- `v2` を別アプリ・別パッケージとして新設し、desktop integration を作り直すこと
- design と logic が同一ファイルを同時編集し続けること

---

## 3. v2 の配置方針

### 3.1 推奨ディレクトリ構成

```text
Tepora-app/frontend/src/
  v2/
    app/
      entry.tsx
      router.tsx
      providers.tsx
      shell/
    shared/
      ui/
      theme/
      assets/
      contracts/
      lib/
    features/
      chat/
        model/
        view/
        screen/
      session/
        model/
        view/
        screen/
      settings/
        model/
        view/
        screen/
      agent/
        model/
        view/
        screen/
```

### 3.2 既存コードの再利用対象

以下は **再利用前提** とする。

- `src/transport/*`
- `src/utils/sessionToken.ts`
- `src/utils/sidecar.ts`
- `src/utils/api-client.ts`
- `src/utils/wsAuth.ts`
- `src/stores/socketConnectionStore.ts` のうち transport 接続責務
- backend と同期する generated types / schema 導線

以下は **v2 で置き換え前提** とする。

- `src/features/navigation/Layout.tsx`
- `src/features/chat/*` の画面構成コンポーネント
- `src/features/settings/components/*` の画面UI
- `src/context/SettingsContext.tsx` の肥大化した画面向け責務

---

## 4. ロジック担当 / デザイン担当の境界

この計画では、担当境界を **ファイル単位** で固定する。

### 4.1 ロジック担当の責務

ロジック担当は、`見た目` ではなく `状態・契約・データフロー` に責任を持つ。

担当範囲:

- `src/v2/shared/contracts/*`
- `src/v2/shared/lib/*` のうち validation / adapters / mappers
- `src/v2/features/*/model/*`
- `src/v2/features/*/screen/*` の container 層
- router loader/action
- React Query hooks
- XState machine
- Zustand store
- transport adapter
- backend schema 同期
- feature flag / route 切替

ロジック担当が返すもの:

- screen container
- view model
- presenter に渡す props 型
- callback interface
- loading / error / empty / success 状態定義

### 4.2 デザイン担当の責務

デザイン担当は、`データ取得` ではなく `UI構造・見た目・操作感` に責任を持つ。

担当範囲:

- `src/v2/shared/ui/*`
- `src/v2/shared/theme/*`
- `src/v2/app/shell/*`
- `src/v2/features/*/view/*`
- animation / spacing / token / layout / typography
- `FRONTEND_DESIGN_GUIDELINES.md` と `UI_PROTOTYPE_REFERENCE.html` の React 移植

デザイン担当が返すもの:

- pure presentational component
- tokenized class / style definition
- interaction spec に沿った hover / focus / transition
- responsive layout
- accessibility を満たす見た目実装

### 4.3 明確な禁止事項

ロジック担当は以下を行わない。

- `view/` 配下でレイアウトの最終責任を持つこと
- 独自デザイントークンや見た目調整を `screen/` 側へ直書きすること

デザイン担当は以下を行わない。

- API呼び出し
- React Query / Zustand / XState の新規導入や責務変更
- transport / token / sidecar の制御
- backend payload を UI コンポーネント内で直接解釈すること

---

## 5. 合流点のルール

### 5.1 コンテナ / プレゼンター分離

各 major screen は次の形を基本とする。

```text
screen/  : logic owner
view/    : design owner
model/   : logic owner
```

例:

```text
features/chat/
  model/useChatScreenModel.ts
  view/ChatScreenView.tsx
  screen/ChatScreen.tsx
```

- `screen/ChatScreen.tsx`: model からデータを取り、`view/ChatScreenView.tsx` に props を渡す
- `view/ChatScreenView.tsx`: 見た目だけを担当し、props 経由でイベントを返す
- `model/*`: query/store/machine/mapper を扱う

### 5.2 Props 契約

- presenter に渡す props は `view/props.ts` または `screen/types.ts` に明示定義する
- props は backend 生 payload を直接含まない
- view は `Attachment`, `ToolConfirmationRequest` などの domain object をそのまま知らず、UI向けに整形済みの view model を受け取る

### 5.3 共有コンポーネントの扱い

- `shared/ui` は design owner
- ただし stateful primitive が必要な場合でも、状態の起点は logic owner が持つ
- 共有コンポーネントへ backend 固有知識を持ち込まない

---

## 6. 実装フェーズ

### Phase 0: 基盤レール作成

目的:

- v2 用ディレクトリの新設
- v2 entry / router / providers の作成
- feature flag または `/v2` route の作成
- design / logic の所有境界をファイル構成に固定

完了条件:

- v1 に影響を与えず v2 の空 shell が表示できる
- `main.tsx` から v1 / v2 を切り替えられる

### Phase 1: Design System と App Shell

目的:

- token, theme, primitive UI, shell layout を実装
- 左右 hidden sidebar、floating command area、settings full-page の骨格を作る

担当:

- 主担当: デザイン
- 支援: ロジックは shell 用 minimal state のみ提供

完了条件:

- プロトタイプ準拠の shell が static data で動作
- ウィンドウ幅縮小時の drawer / overlay 動作が成立

### Phase 2: Transport / 契約 / State 基盤の v2 接続

目的:

- 既存 transport を v2 model 層から使えるよう adapter 化
- contract / validation / query defaults / machine の v2 版基盤を確立

担当:

- 主担当: ロジック

完了条件:

- v2 画面から session 取得、message 送信、stream 受信、stop が可能
- `eventId/streamId/seq` 前提の message pipeline が v2 に接続される

### Phase 3: Chat Surface v2

目的:

- chat screen, message list, input area, radial menu, tool confirmation UI を v2 化

担当:

- view: デザイン
- screen/model: ロジック

完了条件:

- 新規セッション作成
- メッセージ送信
- stream 表示
- stop / regenerate
- search / agent mode 切替
- attachment / thinking / tool confirmation の基本フロー

### Phase 4: Settings v2

目的:

- fullscreen settings view と sections の再構築
- 既存 `SettingsContext` 依存を縮小し、query/mutation ベースへ寄せる

担当:

- view: デザイン
- config fetch/save, mutation, validation: ロジック

完了条件:

- 主要設定の表示・保存
- desktop 固有設定と web fallback の分離表示

### Phase 5: Session / Agent / Context Panels v2

目的:

- 左サイドバー session history
- 右サイドバー RAG / Agent execution panel
- metrics / system status / context chip UI

完了条件:

- v2 shell 上で主要情報導線が揃う
- v1 の補助UIに依存しない

### Phase 6: 切替・比較・退役

目的:

- v2 を既定ルートへ切替
- v1 を read-only fallback または feature-flag fallback に縮退
- 問題がなければ v1 画面群を削除

完了条件:

- v2 がデフォルト
- v1 依存の layout / settings / chat UI を削除可能

---

## 7. 担当境界がぶれないための運用ルール

### 7.1 ファイル所有ルール

- `view/`, `shared/ui/`, `shared/theme/`, `app/shell/`: デザイン担当が owner
- `model/`, `contracts/`, `shared/lib/validation/`, `screen/`, `router` loader/action: ロジック担当が owner
- 同一ファイルの共同編集を避ける

### 7.2 PR ルール

- デザインPRは、backend 契約や store/machine を変更しない
- ロジックPRは、presentational component の見た目責務を抱え込まない
- integration PR は thin composition のみを対象とし、大きな見た目変更と大きな state 変更を同時に混ぜない

### 7.3 合流レビュー観点

- props 契約が stable か
- view が backend payload を直接知らないか
- screen が token / class の最終責務を持っていないか
- memory footprint 制約に反して、履歴や markdown 結果を多重保持していないか

---

## 8. 初回の具体的な分担

### ロジック担当の初回着手

1. `src/v2/app/router.tsx`, `providers.tsx`, `entry.tsx`
2. `src/v2/shared/contracts/*`
3. `src/v2/features/chat/model/*`
4. transport adapter と v2 query defaults
5. feature flag / `/v2` route

### デザイン担当の初回着手

1. `src/v2/shared/theme/*`
2. `src/v2/shared/ui/*`
3. `src/v2/app/shell/*`
4. `src/v2/features/chat/view/*`
5. `src/v2/features/settings/view/*`

### 最初の合流点

- `ChatScreen`
- `SettingsScreen`
- `AppShell`

この3箇所だけを最初の統合対象とし、それ以外は並行で進める。

---

## 9. リスクと対策

### R1. v1 と v2 の責務が混ざる

対策:

- `src/v2/` に物理分離する
- v1 既存画面の延命修正は最小限に限定する

### R2. 既存 transport 依存が複雑で v2 から使いづらい

対策:

- adapter 層を 1 枚挟む
- v2 から `stores/socketCommands.ts` を直接叩かず、screen/model で吸収する

### R3. デザインとロジックが props 契約で衝突する

対策:

- screen/view 間の props 型を先に固定する
- view model を logic owner が定義し、design owner はそれを消費する

### R4. メモリ制約を破る

対策:

- Query cache, message history, markdown render cache の保持方針を v2 初期実装から厳格化する
- screen 層で大きな配列を複製しない

---

## 10. この計画での最終形

最終的には以下を目指す。

- v2 shell / chat / settings / session / agent panels が本番既定になる
- v1 は fallback を経て削除される
- backend integration と desktop integration は維持される
- design と logic の責務分離が、ディレクトリと PR 運用の両方で固定される

この計画は、Frontend v2 を「別製品として作る」のではなく、「同一製品の安全な次世代実装として差し替える」ための実行計画である。

---

## 11. 関連ドキュメント

- ロジック担当タスク: `FRONTEND_V2_LOGIC_TASKLIST.md`
- デザイン担当タスク: `FRONTEND_V2_DESIGN_TASKLIST.md`
- 契約同期方針: `FRONTEND_V2_CONTRACT_SYNC_STRATEGY.md`
- v1-v2 比較チェック: `FRONTEND_V2_PARITY_CHECKLIST.md`
- v1 縮退計画: `FRONTEND_V2_V1_RETIREMENT_PLAN.md`
