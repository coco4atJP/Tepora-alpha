# Tepora native workspace host (development)

A real Rust HTTP process, not a proxy to the Node server. It owns the loopback listener, authentication, CSRF/Host/Origin checks, static allowlist/CSP, one SQLite connection, local workspace operations and bounded SSE subscriptions.

This is an **explicit development entry point**, not the complete application cutover. Normal `npm start` and Tauri packaging still use the feature-complete Node compatibility service backed by the Rust domain/runtime library.

## Build and run

From the repository root:

```sh
npm run build:native
Tepora-v3/native-service/target/debug/tepora-native-service \
  --dev-native --data-dir /path/to/isolated-test-data \
  --web-dir Tepora-v3/web --bundle Tepora-v3/dist/native/app.bundle.js
```

On Windows the binary has `.exe`. Prefer separate test data during development. The schema and filename are unchanged, but this service takes the same exclusive ownership lease as the existing app and refuses a directory owned by a live Node or Rust service.

Node prepares the frontend bundle at **build time only**. The built binary uses no Node runtime or JS server. A missing prebuilt bundle fails startup. `--open`, `--port`, `--sidecar`, `TEPORA_DATA_DIR`, `TEPORA_WEB_DIR`, `TEPORA_BUNDLE_PATH` and `TEPORA_PORT` are supported. Sidecar stdin handles `stop`, `shutdown` and EOF; signals drain domain work. The single readiness JSON line reports mode `native-workspace-development`.

## Implemented routes

- Health, authenticated launch, fixed assets and prebuilt GUI bundle
- Bootstrap, agent/dialogue projections, session lists and transcript reads
- Memory create/update/delete, privacy cleanup and search indexing
- Artifacts, optimistic revisions, history and sandboxed rendering
- Context export/import with remapped IDs, disabled authority, private/unconfirmed memories and read-only dialogue archives
- Presence, diagnostics, durable event replay and SSE snapshots

Shared Rust projections preserve message/continuation and job/approval shapes. The workspace domain owns validation, ID remapping, indexing, transactions and event creation. SSE subscription and replay/snapshot selection are atomic relative to writes; slow clients have bounded queues and write deadlines.

## Deliberately unfinished

Conversation execution, provider transport/configuration, scheduling, live tools/plugins, setup, media, speech, computer/MCP, avatar/photo manipulation and other remaining effects are not activated here yet. Known unported operations return **503**; unknown paths/methods retain 404/405 distinctions. Bootstrap identifies this boundary. Saved configuration/history is not evidence that those effects can run.

Do not switch default launch, remove the Node sidecar or call this a complete port until built-in effects and the full route inventory pass end-to-end and desktop checks. Existing arbitrary `.mjs` plugins need a tested optional compatibility host, not just a JSON copy of their live runtime/store context.

## Verification

```sh
npm run test:native
node --test --test-concurrency=1 Tepora-v3/tests/rust-http.test.mjs
```

Process tests launch the direct binary with empty executable PATH and isolated data. They cover auth, CSRF/origin/duplicate headers, exact body bounds, JSON/UTF-16, static paths, import restrictions, artifact conflicts, SSE replay/concurrent subscription, stale approvals, shutdown and cross-host leases. Unit tests additionally cover short header/body/write deadlines, heartbeat and broadcast framing. No real model or paid provider is used.

`defaults.json` is frozen build-time compatibility data from current constants. `scripts/generate-defaults.mjs` regenerates it deliberately; the Rust service never executes it. Frontend assets remain JavaScript/CSS.
