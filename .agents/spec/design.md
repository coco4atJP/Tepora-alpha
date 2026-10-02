# Tepora V3 beta.11 technical design

The current design is maintained in [Tepora-v3/docs/ARCHITECTURE.md](../../Tepora-v3/docs/ARCHITECTURE.md) and [BETA11.md](../../Tepora-v3/docs/BETA11.md).

The Node ESM loopback service owns SQLite persistence, authenticated HTTP APIs and event streams. The JavaScript UI and optional Tauri host use the same service. Persistent character dialogue delegates bounded, sourced work to independent asynchronous jobs. Protected execution is the default; host integrations require explicit legacy-host acknowledgement.

Preserve recipient identity, source hashes, task revisions, exact approvals and uncertainty handling. Do not interpret model output, persona settings or navigation as permission.
