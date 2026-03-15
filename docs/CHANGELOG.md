# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Refactored backend `models` into a thin `ModelManager` facade plus dedicated `registry`, `discovery`, `download`, `metadata`, and `selection` modules.
- Added entry-returning model lookup APIs (`resolve_character_model`, `resolve_embedding_model`, `find_first_model_by_role`) and reduced direct `get_registry()` traversal outside setup handlers.
- Refactored backend `llm/service.rs` into a thin orchestration layer and extracted model resolution, external-loader shared utilities, and provider-specific clients for OpenAI-compatible, Ollama native, and LM Studio native flows.
- Split backend tool execution into dispatcher, RAG, web fetch, and SSRF/security modules; split frontend settings into granular provider hooks; and replaced the monolithic websocket store with dedicated connection, tool-confirmation, command, and message-router modules.

## [0.4.5] - 2026-03-14

### Added
- Added proposal catalog document: `docs/planning/PROJECT_IMPROVEMENT_CATALOG_2026-03-05.md` (60 improvement items with rationale and expected impact).
- Added `dev_sync` pseudo E2E test (`npm run test:dev-sync`) and made it a required CI quality gate.
- Added `clean-wasm-fixtures` task to remove Wasm fixture build artifacts.
- Added `task doctor` environment diagnostics for Node.js, npm, Rust, Task, frontend dependencies, local Tauri CLI, and `legacy-peer-deps` warnings.
- Added two-tier pre-commit operations with `task pre-commit` / `task pre-commit:fast` for quick checks and `task pre-commit:full` for full pre-push validation.
- Added `task test:changed` to run only the backend/frontend/Node test suites affected by the current diff.
- Added conventional commit validation plus automated release-notes generation tasks/workflows (`task commitlint`, `task release-notes`, `.github/workflows/release-notes.yml`).
- Added MCP tool schema contract coverage for `/api/tools`, including optional `inputSchema` passthrough for MCP-discovered tools.
- Added flaky-test quarantine tooling (`task test:flaky`, `npm run test:flaky`) plus a non-blocking CI lane for repeated dev-sync checks.
- Added workflow JSON golden tests for declarative graph fixtures, including canonical snapshots for the default workflow and a ToolNode workflow.
- Added backend layer-conformance tests plus `task test:arch` to detect forbidden imports across the `domain`, `application`, and `infrastructure` modules.
- Added deterministic WebSocket session replay coverage plus `task test:ws-replay`, including stable transcript assertions for `set_session` and `perf_probe` flows.
- Added model behavior A/B evaluation tooling (`task test:behavior`, `npm run eval:behavior`) with rubric-based scoring, pairwise regression checks, and Markdown/JSON report generation.

### Changed
- Replaced the legacy ExecutionAgent package system with an Agent Skills-compatible registry based on standard `SKILL.md` packages, including Supervisor skill discovery, Execution skill loading, configurable skill roots, and settings UI/API support for editing full skill packages.
- Consolidated task definitions into `Tepora-app/Taskfile.yml`; root `Taskfile.yml` now delegates as a compatibility wrapper.
- Enforced feature boundary lint in frontend (`chat/navigation/session/settings` cannot import each other directly).
- Updated developer setup docs to use `task install-*` and `task doctor` instead of the old `npm ci --legacy-peer-deps` flow.
- Split pre-commit hooks into fast commit-time checks and heavier pre-push checks to reduce per-commit latency.
- Added diff-aware test selection so routine edits do not always trigger the full local test matrix.
- Added CI enforcement for conventional commit ranges so generated release notes stay structured and predictable.

## [0.4.0] - 2026-02-15

### Added
- **Multi-Backend LLM Support**: Added native support for local LLM providers including Ollama and LMStudio alongside llama.cpp.
- **Agent Mode**: Introduced a modular agent system with High, Low, and Direct sub-modes for flexible execution.
- **RAG Integration**: Built-in Retrieval-Augmented Generation using SQLite + ndarray (in-process) for long-term memory and context retrieval.
- **Pipeline Context**: Migrated to an ephemeral context pipeline architecture (PipelineContext) for robust state management.
- **ExclusiveAgentManager**: New component for managing custom user-defined Execution Agents via `agents.yaml`.
- **Search Mode**: Enhanced search capabilities with RAG integration and artifact accumulation.

### Changed
- Refactored graph engine to support configurable worker pipelines.
- Replaced `LlamaService` with a generalized `ModelManager` for multi-backend abstraction.
- Updated frontend to reflect V4 architecture changes (RAG tab, Agent settings).
- Improved backend documentation coverage for public APIs and core components (Router, AppState, McpManager).

## [0.3.0] - 2026-01-23

### Added
- Comprehensive unit tests for core graph engine components.
- Initial groundwork for configurable worker pipeline architecture.

### Changed
- Stabilized core graph engine functionality.
- Improved error handling and logging in backend services.

## [0.2.0-beta] - 2026-01-09

### Added
- Initial beta release with core functionalities.
- Dual-agent system (Character & Professional).
- EM-LLM (Episodic Memory) integration.
- LangGraph-based orchestration.
- Modern React+Tauri frontend.
- Secure 2-step MCP tool installation flow.
- SHA256 hash verification for binary downloads.

### Changed
- Unified versioning across backend and frontend components.

### Fixed
- Removed WebSocket auth bypass in development mode (token is always validated)
- Required WebSocket Origin header in production (rejects empty Origin)
- Fixed mypy duplicate-source configuration issue (type-checking can run again)
- Pinned `tauri-plugin-shell` minimum version (avoids known vulnerable versions)
- Disabled updater when signing is not configured (removed `pubkey` placeholder)
