# Native ordinary custom-skill CRUD (beta.11)

The explicit `--dev-native --agent` host implements R092 `PATCH /api/skills/{id}`, R093 `DELETE /api/skills/{id}` and R094 `POST /api/skills`. Normal Node/Tauri launch, `main`, and the JavaScript/CSS GUI remain unchanged. The local-workspace-only `--dev-native` mode returns 503 before reading a mutation body: CRUD is not acknowledged without the real session prompt refresh owner.

## Contract and ownership

- `workspace/skills.rs` uses only the existing Workspace SQLite owner. A skill-specific mutex serializes each document mutation, durable event publication and synchronous actor refresh; the SQLite/state lock is released before waiting for the actor
- Create validates name, description and content in source order, against the original string's 100/1024/32000 UTF-16-unit limits, then applies ECMAScript trimming. Lossless isolated-surrogate and private-use-marker handling uses the shared JSON codec. Only exact `enabled: false` disables creation; extra request fields are ignored. Field order, UUID v4 and millisecond UTC timestamp match the source contract
- Patch requires an existing stored skill and an exact boolean `enabled`. Unknown document fields, creation time, object property order and SQLite list order are preserved. The route captures the raw ID without URL-decoding it
- Delete succeeds and emits `skill.deleted` even when the document is already absent. It does not parse a request body. It removes only that SQLite document; it does not read or delete a skill file
- `skill.updated` / `skill.deleted` is durable and published before `RefreshPrompts`, as in `server.mjs`. A refresh error returns failure while retaining the already-written document and event; the response never silently reports refresh success
- The existing actor refreshes eligible sessions with cached prompts, skipping done, stopped and unprompted sessions. Changed instructions append a notice and mark `promptStale`; cached `system` and `tools` remain unchanged until their existing refresh boundary. Identical updates do not duplicate notices. Restart retains documents/events without replaying CRUD

These routes save inert text. They do not discover shared/local assets, inspect paths or hashes, load skill content, execute instructions, add tools, or change permissions. R091 shared scanning remains absent. Native prompt snapshots already collect enabled stored skill metadata, but new native toolsets still omit the unavailable `skill` tool. The renderer's existing tool gate therefore omits the skill index for ordinary new native sessions. An isolated Rust actor fixture injects a synthetic declared `skill` after admission to verify metadata snapshot refresh without dispatching or adding that tool. Real CLI startup continues to reject saved unavailable tool declarations; the real HTTP fixture uses valid empty declared toolsets and verifies that no skill index is fabricated. Saved CRUD is not end-to-end native skill usability. R003 bootstrap remains partial for its existing independent capability gaps.

## Focused verification

The focused gate contains nine Rust tests and five direct Node/native HTTP tests. Rust coverage includes UTF-16/trim validation, source short-circuit errors, field/list order, event-before-refresh, failed-refresh persistence, restart, workspace-mode rejection, deterministic held-refresh/closing-state unit barriers (not a real-actor HTTP race), raw route captures, and refresh through the real actor. HTTP fixtures compare source/native status and JSON contracts, enabled defaults, exact validation errors, SSE event order, active cached prompt metadata, no-op updates, missing deletion, and repeated cross-host restart through the same SQLite database. All text is synthetic and inert; no skill content is loaded or executed.

Run from the repository root, with an isolated Cargo target directory if other workers are building:

```sh
npm run build:core
npm run build:native
cargo test --locked --manifest-path Tepora-v3/native-service/Cargo.toml skills_
TEPORA_NATIVE_SERVICE_BINARY=/absolute/path/to/tepora-native-service node --test Tepora-v3/tests/native-skills.test.mjs
```

Focused Linux evidence on 2026-10-08: all nine selected Rust tests passed. Node 22.16.0 and 24.19.0 each passed all five real HTTP tests, with no skips, against native binary SHA-256 `52885e4326f57b8f0d4497256d3d3c8aa9b233ec2c5699a4a90fbd1bf0e4f7c5`. Core/native builds, the Node 22 core digest/load check, 239 JavaScript syntax checks, changed-document links and route totals passed. The existing native-core dead-code warning remains.

These are focused ordinary-behavior checks, not a full quality or cross-platform/package gate. No shared scan/filesystem discovery, external model/provider/account, MCP, approval-policy, regex or broad security probes are part of this slice. Native route totals are 90 implemented / 12 partial / 24 unavailable (126 application variants, plus 22 separately counted static variants); they are not feature-completion percentages.
