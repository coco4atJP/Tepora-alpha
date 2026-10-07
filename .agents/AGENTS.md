# AGENTS.md — Tepora V3 project context

## Current application

- **Release**: Tepora V3 **3.0.0-beta.11**.
- **Goal**: A local-first character conversation with independent asynchronous worker jobs and verifiable artifacts.
- **Core**: Node.js 22.16.0+ ESM, HTTP loopback service and SQLite under `Tepora-v3/core/`.
- **UI**: JavaScript modules and CSS under `Tepora-v3/web/`.
- **Desktop**: Thin Tauri host under `Tepora-v3/desktop/`; optional Python workers under `Tepora-v3/workers/`.
- **Language**: ユーザーとの対話は原則日本語。

Root `npm start`, `task dev`, `npm run quality`, `task quality`, `npm run build` and `task build` target V3. This checkout contains only V3. Earlier application sources, V2-specific skills, launchers and archived documents were removed at the user's request; use Git history for earlier revisions. Do not reintroduce old React/Axum conventions.

## Architecture and changes

Read `Tepora-v3/docs/ARCHITECTURE.md`, `BETA11.md` and `QA.md` for current contracts. Preserve cookie/CSRF/Host/Origin checks, pinned routes, source hashes, revisions, exact operation approvals and result uncertainty. Persona instructions and model output do not grant permissions.

New installations default to protected mode. Untrusted code runs only through the approved restricted executor; no automatic image pull, package installation or host fallback. Host CLI/Codex/MCP/Computer Use/model launchers need explicit legacy-host acknowledgement. Do not erase this distinction in documentation or tests.

Keep current documentation at beta.11. Earlier records are in Git history, not archived copies in this checkout. For documentation and architecture changes, use `.agents/skills/doc-updater/SKILL.md` and `.agents/skills/update-architecture-docs/SKILL.md`. Inspect current V3 code before making feature changes.

Run checks appropriate to the change. `npm run quality` covers V3 syntax, Node/Python regressions, specification traceability, preview build, local capability fixtures and root entry-point tests. Optional real models, paid APIs, host actions, browser checks and container execution are separate explicit choices.

## User data and communication

Do not delete or overwrite V2/V3 user configuration, databases or backups without explicit authorization. V2 persona/profile migration is unfinished; source cutover does not authorize data conversion. Do not transmit user data to external services without permission. Keep generated validation output, databases, secrets and native binaries out of source control.
