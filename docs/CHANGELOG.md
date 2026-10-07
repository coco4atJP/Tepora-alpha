# Tepora V3 changelog

## [Unreleased]

### Added

- Companion monitor home: the character (drawn, or a local VRM 1.0/0.x model rendered with pinned three.js 0.186.1 and @pixiv/three-vrm 3.5.5) with its latest reply as a caption, a clock and one rotating card at a time (RSS news, music files from this PC, generated images, and Open-Meteo weather when it changes what you would do), plus an idle screen that drifts against burn-in.
- あなたの番: one stack for approvals, worker questions, results to review, stopped jobs and routine/plan proposals, with batch review of approvals.
- Stacked approvals: while the person is away, stackable operations wait as exact pending requests, the worker continues independent work and the job parks without holding a slot; a later decision replays exactly the approved request. Parked jobs survive restarts.
- `GET/POST /api/approvals`, `POST /api/presence` and artifact revision reads.
- One lamp: colour is kept for what calls you. Running work is a small light beside the character and what waits in あなたの番 is one amber lamp (the wordmark dot on other pages); the home room follows the hour and the weather (a patch of window light that moves, softens under cloud and disappears in rain, and the lamp's glow at dusk); the date carries its 七十二候 and the weather is one line; on return the character says what finished and what waits.
- Approval seals: an approval is a slip allowed by stamping a seal — a tap for low-risk requests, a 0.7 s hold for operations on this PC or that may cost money, and an arm-then-confirm pair of activations for keyboard and assistive technology — after which the existing approve action runs once.
- Idle screen as a screensaver: it starts from any quiet view and returns to it, ends on input or a deliberate sweep of the pointer, can keep the display awake (Screen Wake Lock, where available), offers the wallpapers 部屋・無地・ゆらぎ・星空・写真, and uses a dark lamp palette at night instead of dimming the day.
- Digital photo frame: photos chosen on this PC (shrunk in the browser, stored under `<data>/frame/`, never sent anywhere) are shown full screen with a cross-fade, shuffle, interval, cover/contain/mat fit, an optional clock and the images made in つくったもの; 「写真立てにする」 starts it full screen. `GET /api/frame`, `PUT /api/frame/photos`, `GET|HEAD|DELETE /api/frame/photos/:id` and the `frame.updated` event.
- Avatar foundation: what the character looks like (the avatar) is now separate from how it answers (the persona). The avatar is a validated recipe (body, material, lamp colour and shape, face, ears, small items, per-body options, flat or solid, size, motion) with revisions, undo, reset and presets, edited in 設定 → キャラクター → 姿を作る with a live preview. The default is しろ・改; 灯守, 円相, 小箱, 狐火, 蛍 and 苔玉 are included, and every body reads the same mood and pose vector. しろ・改 can also be drawn as a solid 3D figure (three.js, no model file) lit by its own lamp.
- Bring an existing character: a VRM 1.0/0.x model, one picture, a set of mood pictures (with an optional mouth-open picture) or a mesh-avatar-studio project (rendered by the engine at one pinned commit, MIT). Files are inspected by content, kept under the data directory, served with `nosniff` and a sandboxed CSP and never sent anywhere. `GET|PATCH /api/avatar`, `POST /api/avatar/undo|reset|import`, `GET /api/avatar/export`, `GET|PUT /api/avatar/assets`, `GET|DELETE /api/avatar/assets/:id[/files/<path>]` and the `avatar.updated` and `avatar.assets` events. See `Tepora-v3/docs/AVATAR.md`.
- Persona voice: a tone (ていねい, やわらか, くだけた, ひとこと, しっとり, 静か), a call name, how often to speak up and the person's own wording for the fixed lines the screen speaks. The model receives the tone as a style hint; lines written for the screen never reach it.
- Tests for the avatar spec (`avatar-model.test.mjs`), the library, its API and the lazily loaded renderers' files (`avatar-assets.test.mjs`), the voice (`voice-lines.test.mjs`) and the real-service browser behaviour of all of it (`browser-avatar.py`, run by `improve-loop --browser`, with fixtures made by `tests/fixtures/avatar-fixtures.mjs`).
- Tests for the lamp, lights, seals, daylight, seasons and wallpapers (`one-lamp.test.mjs`), the photo frame store and API (`photo-frame.test.mjs`) and the browser behaviour of all of it (`browser-lamp.py`, run by `improve-loop --browser`).

### Changed

- The character settings are split in two: 姿 (how it looks) and 人格と口調 (how it answers). The earlier single-model VRM setting, `display.companion` and the `/api/character*` routes are replaced by the avatar; there is nothing to migrate.
- Rebuild the screen around one fact per place: the message box sits under the character on ホーム and the conversation opens on demand; the top bar shows only what needs attention; idle screen, shared view and full screen share one menu; settings live in one page and apply immediately; plain status text replaces most badges.
- Update the Playwright UI checks to the current screen and let them find Chrome or Chromium through `CHROMIUM_PATH` or PATH.
- Remove the teal accent, move work and weather out of the card deck (lights and one line) and replace the speech balloon with a caption.

### Fixed

- Status words that differed between screens, raw `waiting_approval` in the conversation, duplicated worker labels, Markdown shown as raw text, approvals shown as raw JSON, lost focus and scroll on every update, repeated screen-reader announcements, IME Enter/Escape in WebKit, duplicated error messages, the artifact frame reloading when a version was pinned, and an expanded artifact staying expanded after navigation.
- The message box kept its old height after the window was resized, and a notice could float over the idle screen.

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
