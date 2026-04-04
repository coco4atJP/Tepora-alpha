# Frontend v2 v1 縮退計画

- 作成日: 2026-03-17
- 対象: `FRONTEND_V2_LOGIC_TASKLIST.md` `L-503`
- ステータス: Drafted

---

## 1. 目的

v2 を既定ルートへ切り替えた後、v1 の UI 依存を安全に縮退させるための削除順序を固定する。

---

## 2. 置き換え済み領域

v2 で独立実装済みの領域:

- app entry / providers / router
  - [entry.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/app/entry.tsx)
  - [providers.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/app/providers.tsx)
  - [router.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/app/router.tsx)
- chat screen
  - [ChatScreen.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/chat/screen/ChatScreen.tsx)
- settings screen
  - [SettingsScreen.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/settings/screen/SettingsScreen.tsx)
- session sidebar
  - [SessionSidebar.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/session/screen/SessionSidebar.tsx)
- agent panel
  - [AgentPanel.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/agent/screen/AgentPanel.tsx)

---

## 3. 削除順序

### Step 1

`/v2` を既定導線にし、`/` からのフォールバックを feature flag で維持する。

対象:

- [main.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/main.tsx)

### Step 2

v1 の shell / chat / settings UI を read-only fallback へ縮退する。

対象候補:

- [Layout.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/features/navigation/Layout.tsx)
- [ChatInterface.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/features/chat/ChatInterface.tsx)
- [SettingsDialog.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/features/settings/components/SettingsDialog.tsx)

### Step 3

v1 presenter 依存が消えたら、v1 専用 store 参照と route 配線を削除する。

対象候補:

- `src/features/chat/*`
- `src/features/navigation/*`
- `src/features/settings/components/*`

### Step 4

最終的に v1 route と fallback 判定を除去する。

---

## 4. fallback 終了条件

fallback を終了して v1 を削除してよい条件:

1. [FRONTEND_V2_PARITY_CHECKLIST.md](/E:/Tepora_Project/docs/planning/FRONTEND_V2_PARITY_CHECKLIST.md) の P0/P1 項目が充足
2. v2 integration test suite が green
3. `/v2/settings` を含む主要 route が production 同等データで動作
4. デスクトップ環境で token / reconnect / sidecar が v2 経路で安定

---

## 5. 注意点

- backend / sidecar / token 認証は v1 と共有しているため、UI 削除前に transport 層の共有責務を壊さない
- v1 由来の utility を v2 が参照している場合は先に `src/v2/shared/lib/*` へ移す
- destructive deletion は v2 既定化後の別 PR に分離する

このドキュメントをもって `L-503` の計画作成は完了とする。
