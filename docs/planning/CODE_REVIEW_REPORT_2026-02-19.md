# Code Review Report - 2026-02-19

## Summary
- **Reviewed by**: Antigravity (AI Agent)
- **Scope**: 直近5コミット + 全体的な品質チェック
- **Overall Status**: ✅ 概ね良好 / ⚠️ 軽微な対応推奨

---

## 📊 静的解析メトリクス

| チェック | 結果 | 詳細 |
|---|---|---|
| `cargo clippy` | ✅ 警告ゼロ | `finished dev profile in 44.00s` |
| `cargo fmt --check` | ✅ 差分なし | フォーマット遵守 |
| `biome check ./src` | ✅ エラーなし | TS/TSXコード問題なし |
| `cargo audit` | ⚠️ 1件 (ignore済) | RUSTSEC-2023-0071 (詳細は下記) |
| `npm audit --audit-level=high` | ⚠️ 11件 | minimatch関連 (devDeps) |

---

## 🎯 強み (Strengths)

1. **型安全性が高い** — `SettingsContext.tsx` は generics を活用した型安全な update 関数群を実装
2. **セキュリティ設計が堅牢** — `security.rs` でセッショントークン管理、WindowsでACL (`icacls`) による権限制限、non-UTF8ヘッダーのreject等のエッジケースもテスト済み
3. **WS起動同期の改善** — `dev_sync.mjs` が stdout の `TEPORA_PORT=...` シグナルを検出してフロントエンドを起動する設計は、tracing が stderr を使うという制約を正しく回避している
4. **エラー型が明確** — `state/error.rs` の `InitializationError` バリアントが初期化失敗の原因を細分化しており診断しやすい
5. **MCP セキュリティポリシー** — `mcp_policy.json` で `require_tool_confirmation: true` および危険コマンドのブロックリストを適切に設定
6. **audit.toml の適切な管理** — `RUSTSEC-2023-0071` の ignore に理由コメントを付記しており、意図的な除外であることが明確

---

## ⚠️ 指摘事項

### Minor (Nice to Have)

#### 1. `main.rs` — CORSの `allow_origin(Any)` 設定
- **場所**: `backend-rs/src/main.rs:56`
- **説明**: 開発環境では問題ないが、本番ビルドでは Tauri の webview origin のみに制限することを検討
- **推奨**: `TAURI_ENV` や `TEPORA_ENV` 環境変数で開発/本番を切り替え、本番では `allow_origin` を `localhost` 等に制限する

```rust
// 現状 (開発中は許容範囲)
CorsLayer::new().allow_origin(Any)

// 本番向け改善案
let origin = if is_production {
    AllowOrigin::predicate(/* tauri scheme */)
} else {
    AllowOrigin::any()
};
```

#### 2. `dev_sync.mjs` — フロントエンドプロセスの exit ハンドリング
- **場所**: `Tepora-app/scripts/dev_sync.mjs:127-130`
- **説明**: バックエンドプロセスの exit は `shutdown()` を呼ぶが、フロントエンドプロセスの exit（クラッシュ等）は検出・通知されない
- **推奨**: フロントエンドにも `on('exit')` ハンドラを追加

```js
frontendProcess.on('exit', (code) => {
  if (!shuttingDown) {
    log('dev-sync', `Frontend exited unexpectedly (code: ${code})`);
    shutdown();
  }
});
```

#### 3. `SettingsContext.tsx` — `normalizeConfig` の冗長コード
- **場所**: `frontend/src/context/SettingsContext.tsx:130-133`
- **説明**: `if (!data.models_gguf)` ブロック内が空コメントのみであり、意図が不明確
- **推奨**: コメントを削除するか、`data.models_gguf || {}` へのフォールバックをそのブロック内で行う

#### 4. `agents.yaml` — `general` エージェントの `allow_all: true`
- **場所**: `backend-rs/config/agents.yaml:13-14`
- **説明**: デフォルトエージェントにすべてのツール使用を許可しており、攻撃面が大きい
- **推奨**: `coder` や `researcher` エージェントと同様に使用ツールを限定することを検討

---

## 🔒 セキュリティレビュー

### cargo audit
```
RUSTSEC-2023-0071 (rsa crate v0.9.10 — Marvin Attack)
```
- **評価**: ⚠️ 低リスク — SQLiteのみ使用しており、MySQLドライバ経由の `rsa` クレートは実行されない
- **対応**: `audit.toml` でコメント付きの ignore を設定済み ✅
- **将来的な対応**: `sqlx` を次のメジャーアップデートで更新し、脆弱性のある推移的依存を解消することを推奨

### npm audit
```
11 vulnerabilities (1 moderate, 10 high) — minimatch (ReDoS)
```
- **対象**: `@eslint/config-array`, `@typescript-eslint/typescript-estree`, `eslint`
- **評価**: ⚠️ **devDependenciesのみ** — ビルド成果物には含まれず、本番リスクはない
- **対応**: `npm audit fix` で一部修正可能。`--force` は ESLint 10 へのメジャーアップグレードを伴うため、互換性確認後に実施

### ハードコード認証情報
- **チェック結果**: ✅ なし
- `password` 等のキーワードはテストデータのマスキング処理内にのみ存在 (`"****"`)

---

## 💡 その他の提案

1. **CORSの本番ハードニング** — Tauri ベースのアプリのため、最終的には webview origin のみ許可
2. **フロントエンドの exit 監視** — `dev_sync.mjs` の堅牢性向上
3. **ESLint 依存関係の更新** — `npm audit fix` または手動での `minimatch` ピン留め
4. **`agents.yaml` のツールポリシー見直し** — デフォルトエージェントの `allow_all` は最小権限原則に反する

---

## ✅ 総評

最新コミット (`b480df1`) の実装品質は高く、WS ハートビート・動的ポート検出・セッショントークン注入の設計は適切です。Clippy・Biome ともに警告ゼロを達成しており、コードの一貫性が保たれています。指摘事項はすべて Minor 以下であり、ブロッカーはありません。

---

*Reviewed by Antigravity AI Agent on 2026-02-19*
