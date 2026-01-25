# Tepora Backend

Local-first personal AI agent with episodic memory.

## Installation

```bash
# Install uv (if not installed)
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Non-Windows
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
cd backend
uv sync
```

## Usage

```bash
# Start the server
uv run server.py
```

## Testing

```bash
uv run pytest tests/ -v
```

---

# Tepora バックエンド

エピソード記憶を持つローカルファーストのパーソナルAIエージェントのバックエンドです。

## インストール

```bash
# uv のインストール (未インストールの場合)
# Windows (PowerShell)
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"

# Non-Windows
curl -LsSf https://astral.sh/uv/install.sh | sh

# 依存関係のインストール
cd backend
uv sync
```

## 使い方 (Usage)

```bash
# サーバーの起動
uv run server.py
```

## テスト (Testing)

```bash
uv run pytest tests/ -v
```
