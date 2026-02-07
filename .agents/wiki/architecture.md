# architecture.md - System Architecture

システムの全体構成やコンポーネント間の関係を記述します。

## 全体構成図 (Mermaid)

```mermaid
graph TD
    User[User] --> Frontend[React Frontend (Tauri)]
    Frontend -- HTTP/WS --> Backend[Rust Backend]
    Backend --> LLM[LLM Service (Ollama/OpenAI)]
    Backend --> Tools[Native Tools (Search, FS)]
    Backend --> DB[(SQLite DB)]
```

## ディレクトリ構造
- `backend-rs/`: Rustバックエンド
- `frontend/`: Reactフロントエンド
- `src-tauri/`: Tauri設定とデスクトップ統合層
