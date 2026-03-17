# Tailwind / Token 運用ルール (v2)

本ドキュメントは `v2` 開発における Tailwind CSS とデザイントークンの運用ルールを定めます。

## 1. 原則 (Rule of Thumb)
- **色指定はすべてセマンティックトークンを使う**: `text-primary`, `bg-surface`, `border-border` など。`bg-red-500` や `text-[#333]` といった直接指定は禁止。
- **フォント指定もトークンを使う**: 本文・UIは `font-sans`、見出しやアクセントは `font-serif`。
- **Feature側でのスタイル上書きを最小限に**: 画面コンポーネント (screen) から `shared/ui` のコンポーネントを呼び出す際、`className` で余白 (margin) 以外のスタイル (color, padding 等) を上書きしないこと。

## 2. Token マッピング
`variables.css` で定義された CSS 変数を、Tailwind のテーマとしてマッピングしています。

- **Colors**:
  - `bg-bg`: アプリ全体の背景 (`--color-bg`)
  - `bg-surface`: カード・入力欄背景 (`--color-surface`)
  - `text-primary`, `bg-primary`, `border-primary`: 主要要素 (`--color-primary`)
  - `text-secondary`, `bg-secondary`, `border-secondary`: アクセント (`--color-secondary`)
  - `text-main`: 本文テキスト (`--color-text-main`)
  - `text-muted`: 補足テキスト (`--color-text-muted`)
  - `border-border`: 区切り線 (`--color-border`)

- **Typography**:
  - `font-sans`: `--font-sans`
  - `font-serif`: `--font-serif`

- **Radius**:
  - `rounded-md`: 6px
  - `rounded-xl`: 12px
  - `rounded-2xl`: 16px
  - `rounded-[24px]`: 24px

## 3. UIコンポーネントの実装方針
- 状態 (hover, focus, disabled) のスタイルは `shared/ui` 内部で完結させること。
- `hover:bg-primary/90` や `focus:ring-1 focus:ring-primary` などの状態表現は、控えめで上品なトランジション (`duration-200 ease-out`) を伴うこと。
