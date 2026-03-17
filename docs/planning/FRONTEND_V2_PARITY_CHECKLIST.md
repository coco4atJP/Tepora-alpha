# Frontend v2 v1-v2 比較チェック

- 作成日: 2026-03-17
- 対象: `FRONTEND_V2_LOGIC_TASKLIST.md` `L-502`
- ステータス: Active

---

## 1. 目的

v2 を既定導線へ切り替える前に、v1 と比較して主要フローの欠落がないことを確認するためのチェックリスト。

---

## 2. 主要フロー

### Chat

- [ ] 既存 session を開くと履歴が表示される
- [ ] 空 session から初回送信で session が自動作成される
- [ ] streaming chunk が順序通りに結合される
- [ ] `stop` で生成が停止する
- [ ] `regenerate` が直前応答に対して動作する
- [ ] `interaction_complete` 後に再取得履歴と表示内容が一致する

### Session

- [ ] session list が表示される
- [ ] 新規 session 作成が動作する
- [ ] session 切替で active session が更新される
- [ ] 履歴は全件常駐せず、直近 window のみ再取得される

### Input

- [ ] mode 切替が `chat/search/agent` で動作する
- [ ] thinking budget が送信 payload に反映される
- [ ] attachment 追加と削除が動作する
- [ ] PII 検知時に送信をブロックする

### Settings

- [ ] `/api/config` の初期値が表示される
- [ ] field 編集が local reducer に反映される
- [ ] save で partial patch が送信される
- [ ] language 変更が i18n に反映される

### Agent / Tool Confirmation

- [ ] 右パネルに mode / connection / activity が反映される
- [ ] tool confirmation request が表示される
- [ ] `deny` / `once` / `always_until_expiry` が送信される

---

## 3. 現時点の自動検証

自動検証済みの項目:

- [V2Integration.test.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/__tests__/V2Integration.test.tsx)
  - workspace 初期化
  - session 読み込み
  - chat 送信
  - stream 完了
  - settings save
  - tool confirmation
- [messagePipeline.test.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/chat/model/messagePipeline.test.ts)
  - seq 順序制御
  - eventId 重複排除
- [chatMachine.test.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/chat/model/chatMachine.test.ts)
  - send / stream / tool confirmation / reconnect invalidation
- [transportAdapter.test.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/lib/transportAdapter.test.ts)
  - IPC 経路の正規化
- [queries.test.tsx](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/session/model/queries.test.tsx)
  - session query / create mutation
- [state.test.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/features/settings/model/state.test.ts)
  - dirty field / patch 生成
- [validation.test.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/lib/validation.test.ts)
  - schema parse / failure

---

## 4. 切替判断

v2 を既定にできる条件:

1. 上記主要フローで P0/P1 欠落がない
2. `npm run typecheck` と v2 test suite が green
3. design 側の presenter 差し替えでロジック変更を要求しない
4. v1 fallback に依存するユーザー操作が残っていない

このドキュメントをもって `L-502` 完了とする。
