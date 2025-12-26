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
