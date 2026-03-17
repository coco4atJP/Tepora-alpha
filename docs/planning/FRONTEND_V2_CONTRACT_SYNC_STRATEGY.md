# Frontend v2 契約同期方針

- 作成日: 2026-03-17
- 対象: `FRONTEND_V2_LOGIC_TASKLIST.md` `L-101`
- ステータス: Accepted

---

## 1. 結論

Frontend v2 の契約は **Rust 側を単一の真実源** とし、frontend では `src/v2/shared/contracts/` を runtime validation の受け口として維持する。

最終運用は次の 2 段構成とする。

1. Rust から JSON Schema を生成する
2. frontend は生成物を `src/v2/shared/contracts/generated/` に同期し、Zod schema はその生成物を基準に更新する

現在の実装は移行期として `rest.ts` と `ws.ts` を手書きで運用しているが、更新責務と同期手順は本ドキュメントで固定する。

---

## 2. 真実源

- 真実源: Rust の REST / WS 契約構造体
- frontend 側の直接編集対象:
  - [rest.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/contracts/rest.ts)
  - [ws.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/contracts/ws.ts)
- frontend 側の validation entry:
  - [validation.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/lib/validation.ts)

禁止事項:

- Rust 契約変更と frontend schema 更新を別 PR に分離しない
- view / screen 層で backend payload を直接解釈しない

---

## 3. 生成先と運用

生成先は以下で固定する。

```text
frontend/src/v2/shared/contracts/generated/
  rest.schema.json
  ws.schema.json
```

frontend runtime では次を維持する。

- `generated/*.json`: Rust 契約のスナップショット
- `rest.ts` / `ws.ts`: Zod schema と frontend 向け narrow type

移行完了条件:

- Rust 変更時に JSON Schema が更新される
- frontend 側で `generated/*.json` と `rest.ts` / `ws.ts` の差分確認ができる
- v2 test に契約破壊が反映される

---

## 4. 更新手順

契約変更時は次の順で更新する。

1. Rust 側の REST / WS 契約を更新する
2. JSON Schema を再生成し `generated/` に同期する
3. `rest.ts` / `ws.ts` を更新する
4. validator / adapter / integration test を更新する
5. UI 側で必要な mapper / view model を更新する

レビューチェック:

- 破壊的変更か
- event envelope `eventId / streamId / seq / emittedAt` に影響があるか
- `tool_confirmation_request` や `history` の shape に影響があるか
- REST patch payload が後方互換を保つか

---

## 5. 現時点の実装反映

現時点で v2 に入っている境界実装は以下。

- REST schema:
  - [rest.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/contracts/rest.ts)
- WS schema:
  - [ws.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/contracts/ws.ts)
- API validation:
  - [api-client.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/lib/api-client.ts)
- Transport validation:
  - [transportAdapter.ts](/E:/Tepora_Project/Tepora-app/frontend/src/v2/shared/lib/transportAdapter.ts)

このため `L-101` は「生成導線の方針確定」として完了扱いにする。
