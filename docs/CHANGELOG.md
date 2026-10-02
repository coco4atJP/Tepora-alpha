# Tepora V3 changelog

## [3.0.0-beta.11] — 2026-10-02

### Removed

- Remove the earlier application source tree, V2-specific skills and localization helpers, old launchers, obsolete architecture image, archived V2 workflows/documents and earlier V3 milestone copies. This checkout now contains the current V3 application and beta.11 guides; Git history retains earlier revisions.

### Changed

- Switch the branch's root npm commands, Taskfile, launchers, development guidance and native builds to `Tepora-v3/`.
- Run V3 regression and native workflows for `main`, V3 beta branches and relevant pull requests.
- Target V3 npm and desktop Rust dependencies and retire the previous V2 workflows and documentation.
- Consolidate current startup, architecture, QA and status documentation around beta.11. Earlier milestones remain available through Git history.

### Fixed

- Retain build-time macro debug information to avoid the locally reproduced macOS LINKEDIT loader failure with affected Rust/LLVM toolchains. App release optimization remains unchanged.

### Added

- Persistent character dialogue with independent asynchronous worker jobs, sourced questions/results and separate persona snapshots.
- Protected execution by default, explicitly approved digest-pinned container execution, bounded context capsules, operation journals and staged artifact promotion.
- Repository launch checks and locked native CLI/Rust dependency installations.

These entries describe the imported beta.11 implementation and this branch's cutover. They do not claim automatic V2 data migration, real-model acceptance or completed native release validation.

Earlier changes and milestones are available through Git history.
