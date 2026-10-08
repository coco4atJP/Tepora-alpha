# Native avatar asset library (beta.11)

The ordinary avatar asset routes R103–R107 run in both Rust development modes. Normal Node/Tauri launch and the JavaScript/CSS UI remain unchanged.

## Contract and ownership

- `GET /api/avatar/assets`: ordered public metadata and original library limits
- `PUT /api/avatar/assets`: inspect raw images, VRM 0.x/1.0, image-set packs and mesh-avatar-studio packs; preserve original bytes and metadata
- `GET` / `HEAD /api/avatar/assets/{id}/files/{logical-path}`: recheck stored SHA-256, serve exact bytes and MIME/length with private caching and restrictive CSP
- `DELETE /api/avatar/assets/{id}`: remove the asset directory and metadata, emit `avatar.assets`, then reset a currently worn asset with revision/history and `avatar.updated`

The compatibility limits remain 24 assets, 1 GiB total, 96 MiB upload/pack and 80 MiB VRM. Per-picture, per-pack-file, dimension, layer and mesh constraints are preserved by the inspection module. Files are indexed locally within each asset directory; pack logical names are only public metadata. Public snapshots omit storage indexes and hashes. Import names retain platform basename handling, ECMAScript trimming/control-character replacement, 80 UTF-16-unit clipping and extension removal. Duplicate detection is SHA-256 plus kind, after inspection, and emits no new event. Files are never decoded into pixels, rendered, generated externally or sent to another service. Inspected file bytes borrow slices of the admitted upload buffer, avoiding an extra whole-file/pack byte copy; pointer-origin assertions verify that property. Ordinary JSON inspection also avoids a redundant normalized-text allocation when no overflowing number needs representation. Neither change is an application-speed benchmark.

The existing HTTP authentication, Host/Origin and CSRF admission applies. A dedicated asset mutex serializes library operations without holding SQLite during file I/O. One Workspace continues to own metadata and event persistence. Graceful shutdown first withdraws admission, then waits for the asset mutex before closing SQLite, allowing already-admitted metadata/event commits to finish. The current avatar is checked under the state lock after deletion, so resetting the worn asset and recording history uses the latest revision. Existing metadata and directory layouts remain readable without a data conversion.

Imports write exclusive indexed files into a new temporary directory and rename it into place. Failed writes/renames clean up the temporary directory on a best-effort basis. As in the source host, the filesystem and SQLite are separate resources: a crash or metadata failure after rename/deletion can leave orphan files or stale metadata. No crash-time reconciliation or repair is claimed.

Exceptionally deep JSON inherits the shared Rust JSON codec’s serde parser nesting limit. Such inputs can return the format-read error earlier than Node’s `JSON.parse` (including an otherwise unused deeply nested VRM field); this is a known parity boundary, not covered by the ordinary asset acceptance claim. The shared general JSON parser is not expanded in this slice.

## Verification scope

Only synthetic bytes, generated avatar fixtures and isolated temporary stores are used. Ordinary inspection, metadata, byte-serving, deduplication, quota, deletion, history, events and restart behavior are compared against `core/avatar.mjs` and `core/avatar-inspect.mjs`. Native tests also exercise concurrent duplicate imports, aggregate/count limits, ordinary filesystem failures and deterministic shutdown draining.

Local Linux evidence (2026-10-08): 19 focused avatar Rust tests pass (14 inspection matrices and 5 storage/lifecycle tests), plus 8 existing photo regressions after sharing the bounded HTTP body reader. Five direct Node-versus-native avatar HTTP tests and two photo HTTP regressions pass under both Node 22.16.0 and 24.19.0, with no skips. Core/native builds, 235-module JavaScript syntax checking, route-inventory counts and diff checks pass. Independent read-only review cleared the ordinary storage, lifecycle, HTTP and inspection implementation after its findings were addressed. Combined integration passes 91 selected ordinary native-service tests and, on both Node 22.16.0 and 24.19.0, 18 HTTP tests, 1 source scheduler regression and 9 root checks. This includes retained positive photo dispatch checks and updated positive avatar availability checks in existing tests. These are focused checks rather than the aggregate quality gate.

This scope does not exercise real user images, real VRM/mesh exports, GPU/browser rendering, external models, desktop packaging or a default cutover. Approval-policy and broader security suites are excluded. Aggregate quality is not claimed.

Commands (build the core first, as for other Node tests):

```sh
npm run build:core
cargo test --locked --manifest-path Tepora-v3/native-service/Cargo.toml avatar_assets --lib
cargo build --locked --manifest-path Tepora-v3/native-service/Cargo.toml
TEPORA_NATIVE_SERVICE_BINARY=/absolute/path/to/tepora-native-service node --test Tepora-v3/tests/native-avatar-assets.test.mjs
```
