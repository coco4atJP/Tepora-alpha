# Tepora native host (development, beta.11)

A real Rust HTTP process, not a proxy to the Node server. It owns the loopback listener, authentication, CSRF/Host/Origin checks, static allowlist/CSP, one SQLite connection, local workspace operations and bounded SSE subscriptions.

This is an **explicit development entry point**, not the complete application cutover. Normal `npm start` and Tauri packaging still use the Node compatibility service backed by the shared Rust core. The JavaScript/CSS UI and optional Python workers have not been rewritten.

## Build and run

From the repository root:

```sh
npm run build:native

# Local history, memory, artifacts and workspace APIs only
Tepora-v3/native-service/target/debug/tepora-native-service \
  --dev-native --data-dir /path/to/isolated-test-data \
  --web-dir Tepora-v3/web --bundle Tepora-v3/dist/native/app.bundle.js

# Also enable native conversation and supported worker tools
Tepora-v3/native-service/target/debug/tepora-native-service \
  --dev-native --agent --data-dir /path/to/isolated-test-data \
  --web-dir Tepora-v3/web --bundle Tepora-v3/dist/native/app.bundle.js
```

On Windows the binary has `.exe`. `--agent` still requires `--dev-native`. Prefer separate test data during development. The schema and filename are unchanged, but this service takes the same exclusive ownership lease as the existing app and refuses a directory owned by a live Node or Rust service.

Node prepares the frontend bundle at **build time only**. The built binary requires no Node executable or JavaScript server. A missing prebuilt bundle fails startup. `--open`, `--port`, `--sidecar`, `TEPORA_DATA_DIR`, `TEPORA_WEB_DIR`, `TEPORA_BUNDLE_PATH` and `TEPORA_PORT` are supported. Readiness JSON reports `native-workspace-development` or `native-agent-development`. Sidecar `stop`, `shutdown`, EOF and signals use the native stop/drain lifecycle; SQLite ownership remains held until outstanding work and receipts settle.

## Workspace mode

Both modes implement:

- Health, authenticated launch, fixed assets and prebuilt GUI bundle
- Bootstrap, agent/dialogue projections, session lists and transcript reads
- Memory create/update/delete, privacy cleanup and search indexing
- Artifacts, optimistic revisions, history and rendering
- Context export/import with remapped IDs, disabled authority, private/unconfirmed memories and read-only dialogue archives
- Presence, diagnostics, durable event replay and SSE snapshots

Shared Rust projections preserve message/continuation and job/approval shapes. The workspace domain owns validation, ID remapping, indexing, transactions and event creation. SSE subscription and replay/snapshot selection are atomic relative to writes; slow clients have bounded queues and write deadlines. `--dev-native` without `--agent` retains its explicit unavailable-effect responses.

## Process/capability checkpoint

Native process execution supports foreground/background commands, bounded UTF-16 output, process polling/logging/input/kill, exact approvals and custom receipts. Stop owns the original process resources; Resume waits for their cleanup before the next model request. Escaped descendant pipes are reported as uncertain cleanup, never a successful drain.

Capability registry/key routes use one shared owner and atomic revision checks. Explicit capability keys are memory-only and identity-bound. Typed capability transports are tested components; decision routing and embeddings in memory search remain unconnected. Web search/fetch is connected through the checked native transport and actor approval/receipt path. A new live decision route is rejected as well as a saved route at startup.

Attachment staging/removal validates bounded text and PNG/JPEG payloads on the existing database. Agent mode also supports session acceptance, file lists and downloads. Download paths are confined after symlink resolution, tightening the prior lexical-only guard. Attachment delivery to a model is still unavailable; staging alone does not claim that feature is complete.

SSE reconnect/retention-gap snapshots now include live provider health, detected limits, resource queues and capability key hints without reentering the database owner.

## Native agent mode

`--dev-native --agent` adds real text conversation, asynchronous worker sessions, tool receipts, stop/resume, parent reports, provider configuration/probes, settings and approvals. It uses the saved provider registry; it does not substitute canned model replies. Chat Completions, Responses, Anthropic and Gemini transports are implemented, including the native Ollama path discovered behind a Chat Completions profile. Protocol fixtures do not certify every model or hosted provider account.

The native tool catalog contains these 21 built-ins, with the existing main/worker/lean ordering intersected with implemented tools:

- Sessions: `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history`, `sessions_stop`
- Processes: `exec`, `process`
- Files: `read`, `write`, `edit`
- Web: `web_search`, `web_fetch`
- Task state/results: `todo`, `reflect`, `artifact`
- Retrieval/memory: `recall`, `history_search`, `memory_search`, `memory_write`
- Discovery/indirection: `tools_search`, `tools_call`

`memory_search` uses the existing lexical fallback. `tools_call` resolves implemented built-ins; it does not enable MCP. File reads support text and directory handling, but image ingestion/vision bridging remains unavailable. Unported tools are omitted from new toolsets, and native availability instructions state the limitations explicitly.

### Ownership and execution

- `native-core` remains the authority for runtime admission, epochs, retries, inner execution phases, grouping, stop/resume and completion decisions. A FIFO coordinator runs effects; there is no second handwritten agent loop
- `WorkspaceAccess` and its scoped state operations use the existing single SQLite owner. Provider caches, approvals, transcript/evidence entries and accounting do not open another connection
- Native provider/network code owns destination checks, DNS/TLS, response framing, resource/slot leases, cancellation, parameter compatibility and retries. Network policy is not an OS firewall and does not constrain a separately forwarding model server
- `native-core/src/harness/` supplies pure UTF-16/JSON formatting, schema/argument repair, prompts, ledger/compaction planning, reflection and measured self-checks. Host context/compaction code performs real in-context summary attempts, rolling summaries and the existing deterministic fallback; cancellation cannot commit a checkpoint
- Post-tool checks apply repetition/error notices, real escalation/deescalation and deduplicated passive parent reports before measuring the refreshed session. Cached prompts change through append-only notices and checkpoint refreshes
- Approvals bind immutable tool names and arguments. Policy rules are validated before use. Actor-owned decisions, withdrawal and restart recovery prevent late or altered approvals from authorizing an operation
- Stop cancels pending inference/approvals but drains dispatched tool work and ordered receipts. A missing receipt after restart is recorded as an unknown outcome; uncertain writes are not automatically replayed

### File and permission boundary

The current application defaults to **sandbox mode `off`**, and this migration preserves it. When configured, file tools enforce the existing writable-root policy and freshness/read-before-overwrite guards. This is not a new protected/legacy-host capsule system, and native process execution now uses the source sandbox selection without an unconfined fallback. Optional TTY compatibility can require an installed Python or script utility; ordinary exec requires no Node.

Per-file locks use the existing **lexically resolved path**, not inode or canonical identity. Symlink/hardlink aliases can therefore race read-modify-write operations. With confinement enabled, the implementation rejects final symlinks and canonical parents outside the permitted roots, but does not claim full protection against concurrent ancestor renames. These limitations must not be described as a complete filesystem sandbox. Persona instructions, model text and tool output do not grant permission.

## Native first-use setup and catalog

In `--dev-native --agent`, `setup/manager.rs`, `runtime_discovery.rs` and `model_catalog.rs` own the setup, discovery and catalog routes. Workspace-only mode remains effect-free. Construction and GET snapshots never start scanning, model calls, downloads or a browser; interrupted persisted transfers are marked interrupted without auto-resume.

- Explicit scan/discovery queries fixed loopback runtimes through `NativeNetwork`, with bounded responses and expiring candidates. Ollama remote/forwarded models are excluded from first-use candidates
- Selection requires exact `consentTest: true`, a fresh candidate, an idle actor and no existing named provider registry. A safe tool-roundtrip probe and Ollama digest recheck precede activation. The actor rechecks cancellation, busy state, settings identity and registry revision; settings, registry, receipt and ordered events commit together through the single SQLite owner, with rollback on failure. The receipt does not certify model quality or vision/decision capabilities
- Install requires online mode before HTTP body parsing and again at admission, exact `consentDownload: true`, a fresh local engine and one of the fixed catalog choices. It requests a bounded, cancellable Ollama pull with progress/idle/total limits. Stop and network restriction cancel the active probe/download; shutdown also cancels scans and drains setup work. Retry can reuse Ollama-managed partial data. It neither installs a runtime package nor automatically activates the downloaded model
- Install-help only opens the fixed official Ollama download page with the platform opener after the explicit authenticated request. It is not arbitrary shell execution or unattended package installation
- Catalog import/search handles bounded unverified metadata with provenance/hash; explicit refresh uses the fixed `https://models.dev/api.json` endpoint through checked web network policy with a 24 MiB limit and cancellation. Catalog entries grant no execution or network authority

The outer cookie/authentication, CSRF, Host/Origin and body-size checks remain in force. Setup does not change the existing sandbox selection or grant tool permissions. Checked application networking is not an OS firewall and cannot constrain a separately forwarding local runtime. Existing decision-route, heartbeat/schedule, plugin and cached unsupported-tool admission failures remain.

## Admission and remaining limits

A configured `capabilities.routes.decision` endpoint, enabled heartbeat, saved schedule documents, or global `.mjs` plugin files reject native-agent startup with a compatibility-host diagnostic. JavaScript hooks are not silently replaced with no-ops. Cached sessions containing unavailable tools are diagnosed at startup or before model use, including resumed sessions; their prompts/history are not silently rewritten.

Still unported: `find`/`grep`, browser rendering, MCP, image ingestion and vision bridging, media/speech, Computer Use, capability decision/embedding services, skills execution, scheduling/heartbeat/dream optimization, JavaScript plugins and the remaining avatar/photo/other peripheral mutations. Saved configuration and documents remain intact. Known unavailable APIs return **503**; unknown paths/methods retain their 404/405 distinctions. Bootstrap reports the selected development scope.

Do not change default launch or remove the Node sidecar until the remaining effects, route inventory and desktop packaging/installation/startup have their own acceptance evidence. A future JavaScript plugin compatibility host must preserve live callback/context behavior, not just copy it into JSON.

## Verification

The setup source gate (including the retained PTY EOF repair) passed 364 native library + 2 CLI tests, 24 Node HTTP tests, 18 catalog fixtures and 20/20 race-fixture repetitions. Tests use local scripted servers; no real model or runtime package was installed. Earlier full Node validation was 544/549 with five established browser/DNS/bubblewrap environment failures, not an aggregate green gate. The web + setup candidate is local and unpublished; published head22941be covers preferences + PTY repair only, with new actual macOS CI still running. Desktop packaging and installation remain unverified.

From the repository root:

```sh
npm run build:core
npm run build:native
npm run test:rust
npm run test:native
node --test --test-concurrency=1 \
  Tepora-v3/tests/rust-harness.test.mjs \
  Tepora-v3/tests/rust-harness-metacog.test.mjs \
  Tepora-v3/tests/rust-http.test.mjs
# New agent-mode process fixture (separate from workspace mode)
node --test --test-concurrency=1 Tepora-v3/tests/rust-native-agent.test.mjs
```

The stage-6 Linux checkpoint passed **153 service tests and 2 CLI tests**, including **9 real-host fixtures**: streamed conversation/accounting/restart, silent replies, worker file/artifact work and parent reports, stop/rearm, exact approval/withdrawal, draining receipts before releasing SQLite, and explicit native admission checks. These fixtures use the real reducers, provider pipeline and files with controlled local responses; no external model or paid API is called. This gate includes the Unicode17 receipt alignment. The separate direct `--agent` TCP process suite passed **8/8**, and the existing workspace process suite passed **22/22**. Both use isolated data and an empty executable PATH for the Rust child. Agent process fixtures cover authenticated configuration, SSE/input deduplication, actual worker file/artifact work and parent reports, exact approval/withdrawal and late-decision rejection, stop/rearm/restart, and cancelling active/queued probes through HTTP Stop, sidecar Stop and shutdown. Probe work uses four dedicated threads; cancelled queued probes do not dispatch later, fresh probes remain usable, tray Stop preserves the resident main inference and already-completed workers, and shutdown releases the ownership lease without replay on restart. These are recorded Linux checkpoints, not a claim that all application quality or cross-platform gates pass.

Pure harness comparison tests freeze the original JavaScript as a test-only oracle, including malformed arguments, Unicode/UTF-16 boundaries, token thresholds, prompts, compaction and metacognition. Node22/Unicode16 and Node24/Unicode17 are explicit core inputs; the native agent host selects Unicode17 consistently with its receipt calculations.

`defaults.json` and catalog/profile fixtures are frozen build-time compatibility data. Their generation scripts are development tools, never executed by the Rust service. See [Rust migration](../docs/RUST-MIGRATION.md) for staged evidence and the [architecture](../docs/ARCHITECTURE.md) for ownership boundaries.
