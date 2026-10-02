# Start here — Tepora 3.0.0-beta.11

1. Install Node.js 22.16.0 or later. From the repository root, run `npm start`; no core dependency install is required. Windows/macOS launchers are `start.cmd` / `start.command`.
2. For a model-free screen preview, run `npm run preview:build` and open `Tepora-v3/tepora-v3-preview.html`. It does not perform AI inference, login, MCP startup or PC operations.
3. In **接続と使い始め**, connect an already running local model or explicitly configure a provider and its permitted destination. Verify the tool round trip before relying on work execution.
4. Talk to the persistent character and ask for a small deliverable. Inspect the worker report, artifact versions and requested approvals. Opening task details does not redirect the conversation.
5. Keep **protected** mode for built-in work. Restricted code execution additionally needs an approved preinstalled digest-pinned Docker image. Host CLI/Codex/MCP/PC/model-launch operations need explicit **legacy-host** acknowledgement.
6. Review exact staged executor candidates before promotion. Result promotion and accepting a task are separate actions.

Model/runtime auto-installation and automatic V2 persona/profile migration are unfinished. Optional speech, image/video/embedding endpoints need their own configuration. Native development uses `npm ci --prefix Tepora-v3 --ignore-scripts`, then `npm run desktop` or `npm run build`, with Rust and the platform build prerequisites.

See [README](../README.md), [execution boundaries](BETA11.md), [QA](QA.md) and [status](STATUS.md). Earlier milestones are preserved in [history](history/README.md).
