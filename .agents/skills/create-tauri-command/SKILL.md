---
name: create-tauri-command
description: 新しいTauriコマンドを追加し、フロントエンドから呼び出せるようにするための手順です。
---

# `create-tauri-command` Skill

このスキルは、Rustバックエンドに新しいTauriコマンドを追加し、それをTypeScriptフロントエンドから呼び出せるようにする一連の作業をガイドします。

## 手順

1.  **バックエンド: コマンド関数の実装**
    - `Tepora-app/backend-rs/src/api.rs` (または適切なモジュール) に関数を作成します。
    - 関数には `#[tauri::command]` 属性を付与します。
    - 引数と戻り値は `serde::Serialize`, `serde::Deserialize` を実装している必要があります。

    ```rust
    #[tauri::command]
    pub fn my_new_command(arg: String) -> Result<String, String> {
        // 実装
        Ok(format!("Hello, {}", arg))
    }
    ```

2.  **バックエンド: ハンドラの登録**
    - `Tepora-app/backend-rs/src/main.rs` (または `lib.rs`) の `tauri::Builder` チェーンにある `.invoke_handler(tauri::generate_handler![...])` を探します。
    - 新しいコマンド名をリストに追加します。

    ```rust
    .invoke_handler(tauri::generate_handler![
        existing_command,
        my_new_command, // 追加
    ])
    ```

3.  **フロントエンド: API定義の追加**
    - `Tepora-app/frontend/src/lib/api/` 内の適切なファイル（例: `index.ts`）に、Tauriの `invoke` をラップする関数を追加します。

    ```typescript
    import { invoke } from '@tauri-apps/api/tauri';

    export async function myNewCommand(arg: string): Promise<string> {
        return await invoke('my_new_command', { arg });
    }
    ```

## 注意点
- コマンド名はスネークケース（`my_new_command`）がRustの慣習です。
- フロントエンドからの呼び出し時は、引数オブジェクトのキー名がRust側の引数名と一致している必要があります。
