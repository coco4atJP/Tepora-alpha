---
name: doc-updater
description: A comprehensive documentation management skill that ensures project documentation stays synchronized with code changes.
---

# Doc Updater Skill

## Description
A comprehensive documentation management skill that ensures project documentation (README, CHANGELOG, API docs) stays synchronized with code changes in the Tepora Project.

## Usage
Activate this skill when:
- The user asks to "update docs" or "add this to the changelog".
- A significant feature has been implemented or a bug fixed, and documentation needs to reflect it.
- Directory structure or dependencies have changed.

## Dependencies
- Existing documentation files (`README.md`, `CHANGELOG.md`, `docs/*.md`)
- Knowledge of recent code changes (via user input or context)

## Instructions

When this skill is activated, follow these steps:

1.  **Analyze Context**:
    Determine what kind of update is needed based on recent changes or user request.
    - **Feature/Fix:** Update `CHANGELOG.md` and potentially feature-specific docs in `docs/`.
    - **New Command/API:** Update API documentation (create if missing).
    - **Setup/Config:** Update `README.md` (Installation/Usage sections).

2.  **CHANGELOG Update**:
    If updating `CHANGELOG.md`:
    - Read `E:\Tepora_Project\CHANGELOG.md`.
    - Identify the current "Unreleased" section or create a new entry for today's date.
    - Categorize the change (Added, Changed, Deprecated, Removed, Fixed, Security).
    - **Format:** ` - [Category] Description of the change.`

3.  **README Update**:
    If updating `README.md`:
    - Read the file first.
    - Locate the relevant section (e.g., "Getting Started", "Features").
    - Appending or modifying text to reflect the current state of the project.
    - **Critical:** Ensure installation commands and requirement versions are accurate.

4.  **Architecture/API Docs**:
    If deeper documentation is needed:
    - Check `docs/` directory.
    - If a relevant file exists, update it.
    - If not, ask the user if a new documentation file should be created (e.g., `docs/api-reference.md`).

5.  **Review & Write**:
    - Present the planned changes to the user (diff format is helpful).
    - Upon confirmation, write the changes to the files.

## Example Interaction
**User:** "新しい検索機能を追加したので、ドキュメントを更新して"
**Agent:**
"承知しました。以下の更新を行います。

**1. CHANGELOG.md**
```markdown
## [Unreleased] - 2026-02-11
### Added
- フロントエンドに全文検索機能を追加
- Rustバックエンドに検索用API `search_items` を追加
```

**2. docs/features.md (新規作成)**
検索機能の仕様と使い方を記載します。

よろしいでしょうか？"
