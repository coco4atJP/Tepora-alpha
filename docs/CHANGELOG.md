# Tepora V3 changelog

## [Unreleased]

### Added

- Companion monitor home: the character (drawn, or a local VRM 1.0/0.x model rendered with pinned three.js 0.186.1 and @pixiv/three-vrm 3.5.5), its latest reply, a clock and one rotating card at a time (work, Open-Meteo weather, RSS news, music files from this PC, generated images), plus an idle screen that dims at night and drifts against burn-in.
- あなたの番: one stack for approvals, worker questions, results to review, stopped jobs and routine/plan proposals, with batch review of approvals.
- Stacked approvals: while the person is away, stackable operations wait as exact pending requests, the worker continues independent work and the job parks without holding a slot; a later decision replays exactly the approved request. Parked jobs survive restarts.
- `GET/POST /api/approvals`, `POST /api/presence`, `GET /api/character`, `GET/PUT/DELETE /api/character/model` and artifact revision reads.

### Changed

- Rebuild the screen around one fact per place: the message box sits under the character on ホーム and the conversation opens on demand; the top bar shows only what needs attention; idle screen, shared view and full screen share one menu; settings live in one page and apply immediately; plain status text replaces most badges.
- Update the Playwright UI checks to the current screen and let them find Chrome or Chromium through `CHROMIUM_PATH` or PATH.

### Fixed

- Status words that differed between screens, raw `waiting_approval` in the conversation, duplicated worker labels, Markdown shown as raw text, approvals shown as raw JSON, lost focus and scroll on every update, repeated screen-reader announcements, IME Enter/Escape in WebKit, duplicated error messages, the artifact frame reloading when a version was pinned, and an expanded artifact staying expanded after navigation.

## [3.0.0-beta.11] — 2026-10-02

### Removed

- Remove the earlier application source tree, V2-specific skills and localization helpers, old launchers, obsolete architecture image, archived V2 workflows/documents and earlier V3 milestone copies. This checkout now contains the current V3 application and beta.11 guides; Git history retains earlier revisions.

### Changed

- Switch the branch's root npm commands, Taskfile, launchers, development guidance and native builds to `Tepora-v3/`.
- Run V3 regression and native workflows for `main`, V3 beta branches and relevant pull requests.
- Target V3 npm and desktop Rust dependencies and retire the previous V2 workflows and documentation.
- Consolidate current startup, architecture, QA and status documentation around beta.11. Earlier milestones remain available through Git history.

### Fixed

- Restrict model-controlled public Web fetching to consented online HTTPS destinations with public addresses, while preserving explicit local inference, HTTP MCP and configured RSS integrations.
- Remap imported routine last-job references, escape stored references in the UI, and require registered live form elements for privileged submissions.
- Retain build-time macro debug information to avoid the locally reproduced macOS LINKEDIT loader failure with affected Rust/LLVM toolchains. App release optimization remains unchanged.

### Added

- Persistent character dialogue with independent asynchronous worker jobs, sourced questions/results and separate persona snapshots.
- Protected execution by default, explicitly approved digest-pinned container execution, bounded context capsules, operation journals and staged artifact promotion.
- Repository launch checks and locked native CLI/Rust dependency installations.

These entries describe the imported beta.11 implementation and this branch's cutover. They do not claim automatic V2 data migration, real-model acceptance or completed native release validation.

Earlier changes and milestones are available through Git history.
