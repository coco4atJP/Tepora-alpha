# 依存関係健全化レポート

**作成日**: 2026-02-26  
**対象**: `Tepora-app/frontend`

---

## 現行の peer dependency 競合

| パッケージ | 現行バージョン | peer dependency 要求 | 競合先 |
|-----------|-------------|---------------------|--------|
| `eslint-plugin-react-hooks` | v7.0.1 (latest) | `eslint@^3 \|\| ^4 \|\| ^5 \|\| ^6 \|\| ^7 \|\| ^8 \|\| ^9` | `eslint@10.0.1` |

## 対応方針

ライブラリ側（`eslint-plugin-react-hooks`）が ESLint 10 の peer dependency に未対応のため、即座の解消は不可。

### 実施済み対応

1. `.npmrc` に `legacy-peer-deps=true` を設定し、競合理由をコメントで記録
2. CI（`ci.yml`, `security-scan.yml`）から `--legacy-peer-deps` フラグを除去（`.npmrc` で自動適用されるため）

### 解消条件

`eslint-plugin-react-hooks` が `eslint@^10` を peer dependency に含むバージョンをリリースした時点で：

1. `.npmrc` から `legacy-peer-deps=true` を削除
2. `npm install` が `--legacy-peer-deps` なしで成功することを確認
3. 本レポートを更新

---

*本レポートは中期的改善項目 #9（依存関係健全化）として作成された。*
