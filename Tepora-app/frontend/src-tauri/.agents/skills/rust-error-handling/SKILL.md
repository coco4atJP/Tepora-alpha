---
name: rust-error-handling
description: Rustバックエンドにおけるエラーハンドリングの統一ルールと実装パターンです。
---

# `rust-error-handling` Skill

TeporaプロジェクトでのRustエラーハンドリングのベストプラクティスです。

## ルール

1.  **`unwrap()` / `expect()` の禁止**
    - 本番コードでは原則としてパニックを引き起こすメソッドを使用しないでください。
    - 代わりに `?` 演算子を使用し、エラーを呼び出し元に伝播させます。

2.  **`ApiError` の使用**
    - Web APIのエンドポイントでは、エラー型として `crate::errors::ApiError` を使用します。
    - 外部クレートのエラーは `.map_err(ApiError::internal)` などを通じて変換します。

    ```rust
    // 良い例
    let content = fs::read_to_string(path).map_err(ApiError::internal)?;

    // 悪い例
    let content = fs::read_to_string(path).unwrap();
    ```

3.  **エラーログ**
    - エラーを返す前に、必要に応じて `tracing::error!` や `tracing::warn!` でログ出力を行ってください。

## パターン

### anyhow の利用（内部ロジック）
API層以外（ビジネスロジックやユーティリティ）では、柔軟なエラーハンドリングのために `anyhow::Result` を使用することが推奨される場合があります（プロジェクトの依存関係による）。

### 独自エラー定義
新しいモジュールを作成する場合、必要であれば `thiserror` を使用して専用のエラー型を定義することを検討してください。
