# design.md - Technical Design & API Specs

技術的な設計方針やAPI仕様を記述します。

## API設計指針
- REST APIは `Axum` を使用して実装する。
- WebSocketはリアルタイム通信（チャット、ツール実行通知）に使用する。
- エンドポイントは `/api/v1/` プレフィックスを持つ。

## データモデル
- **Agent**:
    - `id`: UUID
    - `name`: String
    - `system_prompt`: String
    - `tools`: List<String>
