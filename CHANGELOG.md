# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
