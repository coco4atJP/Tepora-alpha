# i18n Auto Key Skill

## Description
Streamlines the internationalization workflow by automating the addition of new translation keys and values across multiple language files (Japanese, English, Spanish, Chinese) in the Tepora Project.

## Usage
Activate this skill when adding new text to the UI. The user provides the Japanese text (and optionally a key name), and the skill handles updating all `translation.json` files.

## Dependencies
- `i18next` configuration in `frontend/src/i18n.ts`
- Translation files located in `frontend/public/locales/{lang}/translation.json`
- Supported languages: `ja`, `en`, `es`, `zh`

## Instructions

When this skill is activated, follow these steps:

1.  **Input Analysis**:
    Ask the user for the **Japanese text** they want to add.
    Optionally, ask for a preferred **Key Name** (e.g., `BUTTON_SAVE`). If not provided, generate a semantic UPPER_SNAKE_CASE key based on the English translation of the text (e.g., "保存" -> `SAVE`).

2.  **Translation Generation**:
    Using your internal knowledge, generate translations for the provided text in:
    - **English (en)**
    - **Spanish (es)**
    - **Chinese (zh)**

3.  **File Update Plan**:
    Identify the target files:
    - `frontend/public/locales/ja/translation.json`
    - `frontend/public/locales/en/translation.json`
    - `frontend/public/locales/es/translation.json`
    - `frontend/public/locales/zh/translation.json`

    *Note: Always use `read_file` to check existing keys to avoid duplicates.*

4.  **Execution**:
    - Read the current content of all 4 JSON files.
    - Insert the new key-value pair into each JSON object, maintaining alphabetical order of keys if possible (or just appending).
    - Write the updated content back to the files.

5.  **Code Snippet**:
    After updating the JSON files, provide the user with the React code snippet to use the new key:
    ```tsx
    import { useTranslation } from 'react-i18next';
    // ...
    const { t } = useTranslation();
    // ...
    <p>{t('YOUR_NEW_KEY')}</p>
    ```

## Example Interaction
**User:** "「設定を保存しました」というメッセージを追加したい"
**Agent:**
"承知しました。キーは `SETTINGS_SAVED` でいかがでしょうか？
以下の内容で各言語ファイルに追加します：
- ja: 設定を保存しました
- en: Settings saved
- es: Configuración guardada
- zh: 设置已保存

よろしければ実行します。"
