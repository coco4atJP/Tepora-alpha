---
name: add-backend-tool
description: バックエンドに新しいネイティブツール（Function Calling用）を追加する手順です。
---

# `add-backend-tool` Skill

Teporaのバックエンドに新しいツール（エージェントが使用する機能）を追加するためのガイドです。

## 手順

1.  **ツール定義の作成**
    - `Tepora-app/backend-rs/src/tooling.rs` を編集します。
    - 新しいツールの構造体や、ツールロジックを実装する関数を追加します。

2.  **ツールレジストリへの登録**
    - `tooling.rs` 内の `execute_tool` 関数（またはツールをディスパッチしている箇所）に、新しいツールの `case` を追加します。

    ```rust
    match tool_name {
        "existing_tool" => { ... },
        "new_tool_name" => {
            // ツールロジックの呼び出し
        },
        _ => Err(...)
    }
    ```

3.  **ツール定義（JSON Schema）の追加**
    - エージェントにツールの存在を知らせるため、`api.rs` の `list_tools` エンドポイント（または設定ファイル）にツールのメタデータ（名前、説明、引数スキーマ）を追加します。

## 注意点
- ツール名は一意である必要があります。
- エージェントがツールを正しく使えるよう、`description` (説明) は明確に記述してください。
