# Frontend v2 デザイン担当タスクリスト

- 作成日: 2026-03-17
- 対象計画: `FRONTEND_V2_IMPLEMENTATION_PLAN.md`
- 主担当: デザイン担当
- 目的: v2 の app shell、design system、screen view を既存 v1 から独立して構築する

---

## 1. 担当責務

デザイン担当は以下に責任を持つ。

- design token
- theme
- primitive UI
- app shell
- screen の見た目実装
- アニメーション、余白、タイポグラフィ、hover / focus 体験
- `FRONTEND_DESIGN_GUIDELINES.md` と `UI_PROTOTYPE_REFERENCE.html` の React 移植

デザイン担当が責任を持たないもの:

- API 呼び出し
- React Query / Zustand / XState の責務設計
- backend payload 解釈
- token refresh / reconnect / sidecar 制御

---

## 2. 完了条件

デザイン側の完了条件は以下。

1. v2 shell がデザインガイドラインに沿って一貫している
2. `shared/ui` と `shared/theme` が screen 横断で再利用できる
3. view は props だけで成立する pure component になっている
4. v1 の modal / layout / settings UI に依存しない
5. desktop 基準の見た目が成立し、狭幅時の振る舞いも整理されている

---

## 3. 優先順位

- `P0`: shell と主要画面の成立に必須
- `P1`: 完成度と一貫性に必須
- `P2`: 洗練・微調整

---

## 4. タスクリスト

## Phase 0: v2 デザイン土台

### D-001 `P0` v2 テーマ基盤作成

- 内容:
  - CSS variables
  - semantic color token
  - typography token
  - spacing / radius token
- 成果物:
  - `src/v2/shared/theme/*`
  - theme entry
- 完了条件: Light / Dark / Tepora のテーマ土台が揃う

### D-002 `P0` Tailwind / token 運用ルール整理

- 内容: v2 で使う token ベース class 運用を明文化
- 完了条件: screen 側で無秩序な class 上書きを避けられる

### D-003 `P0` primitive UI の最小セット作成

- 対象:
  - Button
  - IconButton
  - TextField
  - Panel
  - Chip
  - Toggle
  - Select
  - ScrollArea
- 完了条件: 主要 screen を primitives だけで組める

---

## Phase 1: App Shell

### D-101 `P0` desktop 基準の app shell 実装

- 内容:
  - 左右 hidden sidebar
  - main content
  - floating command area の配置骨格
- 参照:
  - `FRONTEND_DESIGN_GUIDELINES.md`
  - `UI_PROTOTYPE_REFERENCE.html`
- 完了条件: static data で shell 全体が視覚的に成立

### D-102 `P0` 狭幅時 overlay / drawer 実装

- 内容:
  - narrow width での sidebar 退避
  - overlay panel の見た目
- 完了条件: 600px 前後でも破綻しない

### D-103 `P1` 背景・質感・glass 表現の統一

- 内容:
  - shadow
  - backdrop blur
  - glow
  - background gradient
- 完了条件: 画面ごとの質感がばらつかない

---

## Phase 2: Chat View

### D-201 `P0` ChatScreenView 作成

- 内容:
  - shell 上の chat main area
  - empty state
  - message region
  - header chrome
- 完了条件: ロジック未接続でも view props で成立する

### D-202 `P0` floating input / command area 実装

- 内容:
  - 浮遊入力ボックス
  - focus glow
  - footer tools の視覚構造
- 完了条件: `InputArea` 相当の v2 view が成立

### D-203 `P0` radial menu view 実装

- 内容:
  - collapsed dial
  - hover-expand radial menu
  - active mode 表示
- 完了条件: static props で mode 切替UIを表現できる

### D-204 `P1` message bubble と hover actions 実装

- 内容:
  - user bubble
  - assistant bubble
  - thought block
  - copy / regenerate / delete action visibility
- 完了条件: ガイドライン準拠の bubble 表現になる

### D-205 `P1` search / agent mode 差分UI

- 内容:
  - mode badge
  - contextual affordance
  - right panel 連動時の見え方
- 完了条件: mode ごとの体験差が視覚的に明確

---

## Phase 3: Settings View

### D-301 `P0` fullscreen settings shell 実装

- 内容:
  - full-page transition
  - left navigation
  - right content flow
  - close / return 導線
- 完了条件: 旧 modal 型 settings と明確に分離されている

### D-302 `P1` quiet controls の v2 化

- 内容:
  - minimalist select
  - text-first option layout
  - subtle indicator
  - ultra-minimal slider
- 完了条件: ガイドラインの quiet controls を満たす

### D-303 `P1` settings section primitives 作成

- 対象:
  - section heading
  - form group
  - inline helper
  - warning / status display
- 完了条件: sections 間の余白と階層が統一される

---

## Phase 4: Session / Agent / Context Panels

### D-401 `P1` session sidebar view 実装

- 内容:
  - hidden trigger
  - session list
  - active item
  - create button
- 完了条件: 左サイドバーだけで独立した情報導線になる

### D-402 `P1` context / RAG panel view 実装

- 内容:
  - chips
  - toggles
  - active context list
  - panel heading
- 完了条件: Search/Agent 時のみ違和感なく現れる

### D-403 `P1` agent execution panel view 実装

- 内容:
  - target agent selection
  - execution mode selector
  - tool access UI
- 完了条件: 複雑な情報でも過密に見えない

---

## Phase 5: polish / a11y / consistency

### D-501 `P1` keyboard focus と accessibility state の見た目整理

- 内容:
  - focus ring
  - reduced motion 配慮
  - contrast 見直し
- 完了条件: desktop アプリとして違和感のないフォーカス体験

### D-502 `P1` token 外スタイルの削減

- 内容: screen 内の ad-hoc class を減らし token 経由に寄せる
- 完了条件: 見た目の一貫性が保てる

### D-503 `P2` transition / micro motion 微調整

- 内容:
  - shell 遷移
  - settings 切替
  - sidebar hover
  - dial 展開
- 完了条件: 露骨すぎず、上品な動きに統一される

---

## 5. ロジック担当から受け取るもの

デザイン担当が必要とする引き渡し物:

- `screen` から `view` に渡す props 型
- callback interface
- loading / empty / error / success の状態定義
- ダミーではなく実際の screen composition 例

依存する契約:

- `features/chat/view/props.ts`
- `features/settings/view/props.ts`
- `features/session/view/props.ts`
- `features/agent/view/props.ts`

props が未確定な場合、view 側で backend payload を仮置きしない。

---

## 6. マージ前チェック

- API 呼び出しや query/store/machine の責務を view に持ち込んでいない
- token / color / spacing / radius が直書きで乱れていない
- v1 コンポーネント依存を持ち込んでいない
- narrow width の崩れがない
- desktop 基準の操作感を損なっていない

---

## 7. 最初の着手順

1. `D-001`, `D-002`, `D-003`
2. `D-101`, `D-102`
3. `D-201`, `D-202`, `D-203`
4. `D-301`

この順序で進めると、ロジック担当は shell と chat screen の接続を早期に始められる。
