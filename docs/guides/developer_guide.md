# Developer Guide / エクステンション実装ガイド

[English](#english) | [日本語](#japanese)

> **Note:** For general environment setup and development workflow, please see [development.md](./development.md).
> 基本的な環境構築や開発手順については [development.md](./development.md) をご参照ください。

<div id="english"></div>

# Implementation & Extension Guide (English)

This guide provides information on how to extend Tepora's functionality, including adding new tools and modifying agent behavior.

## Adding New Features

### Adding a New Tool

Tepora's tool system is modular. To add a new tool:

1. **Native Tools**: Implement the logic in `Tepora-app/backend-rs/src/tooling.rs`.
2. **MCP Tools**: Configure external MCP servers in `config/mcp_tools_config.json`.
   - See `Tepora-app/backend-rs/src/mcp.rs` for the MCP manager implementation.
3. Register the tool in `Tepora-app/backend-rs/src/tooling.rs`.
4. If necessary, update the `agent_profiles` in `config.yml` to allow the new tool.

**Tool directory structure:**
```
backend-rs/src/
├── tooling.rs      # Native tools + tool router
├── mcp.rs          # MCP manager
└── search.rs       # Search provider implementations
```

### Modifying Agent Behavior
- **Prompt Engineering**: Edit system prompts in `Tepora-app/backend-rs/src/config.rs` or relevant `.yaml` profiles.
- **Graph Logic**: Modify the execution flow and state management in `Tepora-app/backend-rs/src/ws.rs`.

---

<div id="japanese"></div>

# エクステンション実装ガイド (日本語)

このガイドでは、Teporaの新機能追加（新しいツールやAPIの追加）およびエージェントの挙動変更に関する実装手順を解説します。

## 新機能の追加

### 新しいツールの追加

Teporaのツールシステムはモジュラー設計になっています。新しいエージェントツールを追加するには、以下の手順を実施します。

1. **ネイティブツール**: `Tepora-app/backend-rs/src/tooling.rs` にツールの実体となる関数を実装します。
2. **MCPツール**: 外部プロセスやAPIをそのままツール化する場合は、`config/mcp_tools_config.json` に外部MCPサーバーを設定します。
   - MCPの管理・実行エンジンは `Tepora-app/backend-rs/src/mcp.rs` を参照してください。
3. 実装したツールを `Tepora-app/backend-rs/src/tooling.rs` 内のツールルーターに登録します。
4. 必要であれば、設定ファイル内の `agent_profiles` を更新して、エージェントが新しいツールを使用できるように許可します。

**関連するディレクトリとファイル:**
```
backend-rs/src/
├── tooling.rs      # ネイティブツールの実装とルーティング
├── mcp.rs          # MCPサーバープロセス管理・クライアント
└── search.rs       # Web検索用プロバイダの実装
```

### エージェントの挙動の変更
- **プロンプトエンジニアリング**: エージェントの性格やベースとなる指示は `Tepora-app/backend-rs/src/config.rs` や専用のプロファイルファイルで定義されています。
- **フロー制御・グラフロジック**: エージェントの思考プロセスや状態遷移のフローを変更する場合は、`Tepora-app/backend-rs/src/ws.rs` を中心としたワークフローロジックを修正します。
