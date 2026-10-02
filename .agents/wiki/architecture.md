# Tepora V3 beta.11 architecture

Use the [current architecture](../../Tepora-v3/docs/ARCHITECTURE.md) as the source of truth.

- `Tepora-v3/core/`: Node control plane, SQLite, dialogue, provider routing and job execution.
- `Tepora-v3/web/`: JavaScript/CSS conversation and artifact UI.
- `Tepora-v3/workers/`: optional Python capability and computer workers.
- `Tepora-v3/desktop/`: thin Tauri host and bundled Node runtime.
- Root npm/Task commands and `.github/workflows/`: V3 startup, validation and native packaging.

Protected container execution, trusted built-in operations and explicitly acknowledged legacy-host operations have different trust boundaries. See [BETA11](../../Tepora-v3/docs/BETA11.md).
