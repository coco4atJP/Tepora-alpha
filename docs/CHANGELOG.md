# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added proposal catalog document: `docs/planning/PROJECT_IMPROVEMENT_CATALOG_2026-03-05.md` (60 improvement items with rationale and expected impact).
- Added `dev_sync` pseudo E2E test (`npm run test:dev-sync`) and made it a required CI quality gate.
- Added `clean-wasm-fixtures` task to remove Wasm fixture build artifacts.

### Changed
- Consolidated task definitions into `Tepora-app/Taskfile.yml`; root `Taskfile.yml` now delegates as a compatibility wrapper.
- Enforced feature boundary lint in frontend (`chat/navigation/session/settings` cannot import each other directly).

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