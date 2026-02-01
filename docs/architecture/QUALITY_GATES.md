# Tepora Quality Gates

このドキュメントでは、Tepora プロジェクトの品質ゲートシステムについて説明します。

## 概要

品質ゲートは、コードの品質と信頼性を保証するための自動チェックシステムです。

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Gate 1         │    │  Gate 2         │    │  Gate 3         │
│  Pre-commit     │ -> │  CI Pipeline    │ -> │  Release        │
│  (ローカル)      │    │  (PR)           │    │  (リリース前)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 品質チェック項目

### Backend (Python)

| チェック | ツール | コマンド |
|----------|--------|----------|
| Lint | Ruff | `uv run ruff check src/` |
| Format | Ruff | `uv run ruff format --check src/` |
| Type Check | Mypy | `uv run mypy src/` |
| Tests | pytest | `uv run pytest tests/ -v` |
| Security | pip-audit | `uv run pip-audit` |

### Frontend (TypeScript/React)

| チェック | ツール | コマンド |
|----------|--------|----------|
| Type Check | TypeScript | `npm run typecheck` |
| Lint | Biome/ESLint | `npx biome check src/` |
| Tests | Vitest | `npm test` |
| Security | npm audit | `npm audit` |

## 使用方法

### 統合品質ゲート実行

```bash
# 全チェック実行
task quality

# 厳格モード（警告も失敗扱い）
task quality:strict

# 自動修正モード
task quality:fix

# バックエンドのみ
task quality:backend

# フロントエンドのみ
task quality:frontend
```

### セキュリティスキャン

```bash
# 全セキュリティスキャン
task security

# 個別実行
task security-backend
task security-frontend
```

### カバレッジレポート

```bash
# 全カバレッジ
task coverage
```

## Pre-commit フック

### インストール

```bash
task pre-commit:install
```

### 手動実行

```bash
task pre-commit
# または
pre-commit run --all-files
```

### 設定ファイル

Pre-commit の設定は `.pre-commit-config.yaml` にあります。

## CI/CD パイプライン

GitHub Actions で自動実行されます。

### トリガー

- `main` / `develop` ブランチへのプッシュ
- これらのブランチへのプルリクエスト

### ジョブ構成

```mermaid
graph TD
    A[Push/PR] --> B[Backend Quality]
    A --> C[Frontend Quality]
    A --> D[Backend Security]
    A --> E[Frontend Security]
    B --> F[Summary]
    C --> F
    D --> F
    E --> F
    F --> G{All Passed?}
    G -->|Yes| H[✅ Merge Allowed]
    G -->|No| I[❌ Merge Blocked]
```

## トラブルシューティング

### よくあるエラー

#### Ruff エラー

```bash
# 自動修正
uv run ruff check src/ --fix
uv run ruff format src/
```

#### Mypy エラー

型エラーの場合、適切な型アノテーションを追加してください。

#### Biome エラー

```bash
# 自動修正
npx biome check --write src/
```

### チェックのスキップ

緊急時のみ、以下のように特定チェックをスキップできます：

```python
# noqa: E501  # Ruff: 特定の行を無視
# type: ignore  # Mypy: 型チェック無視
```

> [!CAUTION]
> チェックのスキップは最小限に抑え、必ずコメントで理由を記載してください。

## 設定ファイル一覧

| ファイル | 用途 |
|----------|------|
| `pyproject.toml` | Ruff, Mypy, pytest 設定 |
| `biome.json` | Biome lint/format 設定 |
| `.pre-commit-config.yaml` | Pre-commit フック設定 |
| `.github/workflows/ci.yml` | CI パイプライン設定 |
| `Taskfile.yml` | タスクランナー設定 |
