---
name: update-architecture-docs
description: Update Tepora V3 architecture descriptions and diagrams after structural changes.
---

# Tepora V3 architecture updates

The canonical architecture is `Tepora-v3/docs/ARCHITECTURE.md`; `docs/architecture/ARCHITECTURE.md` links to it. Agent context is maintained in `.agents/AGENTS.md`, `.agents/spec/` and `.agents/wiki/`.

1. Inspect changed components and their actual data flow.
2. Update descriptions, source paths and Mermaid diagrams to match the Node/SQLite control plane, web UI, asynchronous jobs and optional Tauri/Python integrations.
3. Preserve trust boundaries: foreground conversation, sourced handoffs, protected execution, staged promotion and explicit legacy-host integrations.
4. Keep current wording at beta.11 and link to `BETA11.md`, `QA.md` and `STATUS.md` for limits and validation.
5. Verify local links and affected checks. Do not reintroduce earlier application source trees or archive copies.
