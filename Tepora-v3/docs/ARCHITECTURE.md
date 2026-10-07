# Tepora V3 — 3.0.0-beta.11 architecture

The current application has a shared Rust core and two service hosts. Normal `npm start` and Tauri use the Node ESM compatibility host with the existing feature set. The opt-in `native-service --dev-native --agent` path runs supported conversation and worker effects in Rust; `--dev-native` alone remains the local-workspace-only mode. This is not a default or desktop cutover, and the web UI remains JavaScript/CSS.

This document describes the rebuilt session harness and incremental native host. [AGENT-HARNESS](AGENT-HARNESS.md) describes the current session model; [Rust migration](RUST-MIGRATION.md) records staged validation. Older protected/legacy-host capsule descriptions in [BETA11](BETA11.md) are historical and do not define the current `sandbox.mode` default or native capabilities.

```mermaid
flowchart TD
    UI[JavaScript and CSS web UI] --> Node[Node compatibility service]
    UI --> Native[Opt-in native HTTP host]
    Desktop[Tauri with packaged Node sidecar] --> Node
    Node --> Core[Shared Rust state and reducers]
    Native --> Workspace[Single Workspace SQLite owner and projections]
    Workspace --> Core
    Native --> Actor[FIFO agent coordinator]
    Actor --> Runtime[RuntimeEngine: admission and lifecycle]
    Actor --> Execution[ExecutionEngine: model and tool phases]
    Actor --> Host[Scoped native effects and owned snapshots]
    Host --> Provider[ProviderRuntime and native network transport]
    Host --> Tools[17 native built-ins and immutable approvals]
    Host --> Harness[Pure prompts, context, compaction and metacognition]
    Host --> Workspace
    Node --> Compatibility[Remaining tools, hooks, capabilities and schedulers]
```

## HTTP, state and event ownership

`core/server.mjs` is the ordinary loopback service. `native-service/src/http.rs` independently implements the authenticated listener, launch token/cookie flow, CSRF and Host/Origin checks, body bounds, static allowlist/CSP and SSE. It is not a reverse proxy to Node. Both hosts retain the service-owner lease and reject another live owner of the same data directory.

`native-core` owns SQLite documents/settings, FTS persistence, events, session transcripts/evidence/inboxes, and atomic artifact revisions. `store_domain.rs` shares workspace validation, indexing and import/export normalization; `projection.rs` shares UI snapshots and derived events. The Node `Store` and `SessionStore` facades retain their public callback and JavaScript compatibility behavior. The native `WorkspaceAccess` facade exposes narrow state operations and commit batches using the same single connection; provider caches, approvals and tools do not create another database owner.

State batches commit before their events are published. UI-derived projections precede their source event. SSE replay/snapshot choice and live subscription registration share the state lock, with bounded subscriber queues and write deadlines. No SQLite lock is held across provider/file I/O or an approval wait.

Context import assigns fresh IDs, remaps references and cannot restore execution authority: memories are private/unconfirmed, imported skills/routines remain disabled, jobs remain interrupted/resume-blocked and dialogue archives remain read-only. Existing databases and unknown document fields are preserved rather than converted or deleted. SQLite is not encrypted; the source-service and desktop data directories may differ.

## Sessions and native coordination

The resident main session and independent worker sessions have append-only logs, ordered inboxes, personas, working folders, toolsets, state and usage. Worker progress is a passive parent notification; a final report is an ordinary follow-up message. Visibility follows the existing main/parent/descendant rules. Input headers identify provenance and use the process-local timezone. Model output, persona text and received reports are data, not new authority.

`native-core/src/runtime.rs` owns admission, capacity, epochs, timers, retries, auxiliary leases, completion checks and stop/resume. `execution.rs` owns prompt/budget/context phases, model failure handling, tool grouping, approvals and ordered receipts. `native-service/src/agent/coordinator.rs` drives both reducers on one FIFO actor. A service ID, session ID, runtime epoch, execution generation and operation ID identify continuations; effect workers return owned values or scoped state requests instead of recursively entering the reducers.

Stop cancels inference and approval waits, rejects work not yet dispatched and drains actual dispatched tool outcomes in model order. Resume waits for the old lease to drain. HTTP Stop All stops active work and rearms the main session; tray/sidecar Stop cancels active workers and native HTTP probes while preserving the resident main inference. Close withdraws approvals, drains commands/receipts and closes network/provider resources before releasing Workspace/SQLite ownership. Restart writes an unknown-outcome receipt for interrupted tool calls rather than replaying their side effects.

The Node host still supplies callbacks, timers and effects through `core/agent/loop.mjs` and `runtime-host.mjs`. It uses the same Rust decision engines; its remaining JavaScript effects have not been removed by adding the native path.

## Providers, network and budgets

`native-core/src/protocols.rs` handles canonical request/response state machines and provider-native replay tied to exact identities. Native `provider.rs` and `network.rs` implement registry profiles/routes, destination admission, DNS/TLS, UTF-8/SSE/NDJSON framing, cancellation, resource/slot leases, limit discovery, retries, compatibility learning and safe errors. Chat Completions, Responses, Anthropic and Gemini are supported, plus discovered native Ollama transport. The Node compatibility path retains its existing provider/network adapters.

The network policy distinguishes online, trusted-LAN and offline destinations. It is not an OS firewall and cannot constrain a separately forwarding inference server. Provider configuration changes invalidate affected active operations. Protocol support and deterministic fixtures do not certify every remote account, model, hardware configuration or real-model quality.

`context.rs` and `tokens.rs` build stable model context, clear/supersede old results, repair call/result sequences and account for tool definitions, images and calibration. Unicode16/17 token estimates are explicit inputs; the native host uses Unicode17 consistently. Role selection, reserve calculation and overflow retries remain compatible with the original harness.

Separate capability endpoints handle typed decisions, embeddings, speech and generated media in the compatibility service. Native capability configuration, identity-bound memory-only keys and typed transport components are implemented. Agent decision/semantic/media consumers remain pending in this checkpoint; a saved `capabilities.routes.decision` route rejects native-agent preflight rather than silently changing delegation or completion behavior to an unavailable decision model.

## Prompts, compaction and self-checks

`native-core/src/harness/` ports result shaping, the actual lightweight schema subset and JSON repair, persona/voice prompts, all harness notices, ledger folding, summary validation, chapters, identifier recovery and metacognition. It has no store, filesystem, network or clock effects. JSON boundaries preserve property ordering, JavaScript number semantics and isolated UTF-16 surrogates. Frozen JavaScript lives only in differential test fixtures.

`agent/context.rs` handles cached prompts, append-only instruction updates, budgets and real asynchronous compaction. It attempts an in-context summary, then rolling compaction-route summaries, then the existing deterministic fallback if model summarization fails. Previous facts, exact ledgers and permanent chapter provenance survive; a cancelled operation cannot return a checkpoint for commit. The actor commits the checkpoint/notice, increments statistics and refreshes the prompt only for the current operation.

`agent/metacognition.rs` applies repetition/error notices and real escalation/deescalation before rereading the session for a measured self-check. Stuck-parent reports use ordinary passive send semantics and per-reason deduplication. `reflect` records model-stated beliefs separately from measured facts. Memory updates are published only after their corresponding effects succeed.

## Native preferences and visual configuration

The explicit native host now implements persona/voice and application preference changes, plus the display/avatar recipe state APIs. `workspace/preferences.rs` validates the existing field subset, serializes persona changes, checks revisions and asks the actor to refresh prompts without replacing a cached prefix. Persona/voice text never grants execution authority. Network-related preference changes retain the existing policy revocation boundary.

`workspace/display_avatar.rs` owns validated recipe changes, revision histories, undo/reset and portable preset import/export under the same Workspace/SQLite owner. The date parser preserves the frozen V8 input behavior and carries its source/license notice into native distributions. These state APIs do not implement custom avatar asset uploads, asset byte serving, photo-frame storage, audio or media effects. Normal Node/Tauri startup and all JavaScript/CSS remain unchanged.

## Tools, approvals and current execution boundary

The native catalog implements `sessions_spawn`, `sessions_send`, `sessions_list`, `sessions_history`, `sessions_stop`, `read`, `write`, `edit`, `todo`, `reflect`, `artifact`, `recall`, `history_search`, `memory_search`, `memory_write`, `tools_search` and `tools_call`. Fixed main/worker/lean sets preserve order and include only implemented/enabled definitions. Native memory search uses the existing lexical fallback. Image reads/vision bridging and MCP indirection remain unavailable.

Policy matching preserves first-rule ordering, wildcard/prefix/exact names and validated ECMAScript-compatible UTF-16 regex matching. `agent/approvals.rs` persists immutable approved arguments, coordinates actor-owned decisions and withdraws stale requests. Approval wait futures do not write state. Late decisions, altered approval documents and stopped runs cannot authorize dispatch. Actual results and evidence are recorded once, in model order, with truncation/recall references, error/not-executed/interrupted distinctions, read references and usage statistics.

The current `core/sandbox.mjs` default is **`off`**, with optional `workspace`, `readonly` and `container` configurations. This migration preserves those settings and existing file guards; it does not revive the former protected/legacy-host capsule architecture. Native `exec`/`process` uses the same sandbox selection and never silently falls back to an unconfined command. Process ownership, bounded output and cleanup uncertainty are separate from model/tool scheduling. Resume awaits the previous stopped-process barrier before making a new model request.

File tools preserve path resolution, freshness checks and read-before-overwrite behavior. Their serialization key is a lexically resolved path, not inode/canonical identity: symlink/hardlink aliases can race. Configured confinement rejects final symlinks and canonical parents outside writable roots, but does not establish complete safety against concurrent ancestor renames. Neither writable-root checks nor network policy should be described as a complete OS sandbox.

## Native admission and remaining effects

Native mode fails preflight for configured global `.mjs` plugins, a capability decision route, enabled heartbeat or saved schedule documents. Cached unsupported toolsets are diagnosed before model use, including resumed sessions. Absent hooks can use identity behavior; configured hooks cannot silently become no-ops. New native prompts explicitly describe unavailable capabilities, and known unimplemented APIs fail clearly.

Process execution, web tools, `find`/`grep`, MCP, skills execution, image ingestion, media/speech, Computer Use, capability services, schedules/heartbeat/dream optimization, JavaScript plugins and remaining setup/avatar/photo/peripheral mutations still use the compatibility service. Their saved data are retained. [Native host setup and limits](../native-service/README.md) lists the supported mode and routes. Neither the default launcher nor Tauri has been switched to the native service.

## Companion monitor UI

The page is plain ES modules joined by `core/frontend.mjs` into one classic script; top-level names must be unique across modules and the bundler rejects duplicates. `web/app.mjs` owns state, rendering and actions; `ambient.mjs` (cards, deck, idle watcher), `inbox.mjs` (あなたの番), `markdown.mjs` (escaped Markdown subset, links as text), `status.mjs` (one status vocabulary) and `approval-format.mjs` (plain-language approvals) are pure helpers. The avatar is `web/avatar/`: `pose.mjs` (mood → pose vector), `model.mjs` (the spec, bodies and colours, shared by the service), `kit.mjs`, `geometry.mjs`, `body-*.mjs` and `svg.mjs` (the drawn and picture bodies), `stage.mjs` (`createAvatar`: one handle for every body, with fallback to しろ・改) and `settings.mjs` (the studio); `voice-lines.mjs` holds the persona's tones. `vrm-stage.mjs`, `mesh-avatar.mjs` and `three-body.mjs`, with the pinned three.js, three-vrm and mesh-avatar-studio engine in `web/vendor/`, are loaded by dynamic import only when a VRM, a mesh project or the solid body is chosen, and are served from an explicit allowlist. On the service side `core/avatar.mjs` stores the spec (revision, undo) and the asset library, `core/avatar-inspect.mjs` judges what a person brings by content, and `core/persona.mjs` keeps the persona's voice apart from the avatar. See [AVATAR](AVATAR.md).

The home stage's light and the idle screen are built from small modules that only compute or draw. `seasons.mjs` (七十二候 table) and `daylight.mjs` (hour, weather and sunrise/sunset to CSS custom properties) are pure; `wallpaper.mjs` chooses the backdrop (`body[data-backdrop]`: room, plain, drift, stars, photos) and the dark lamp palette and draws the CSS layers; `lights.mjs` keeps one element per running job around the character and the amber lamp for あなたの番; `seal.mjs` implements the hold, tap and arm-then-confirm seal that fronts the existing `approve` action (seal buttons carry `data-seal` and never `data-action`, so the page's generic click handler cannot approve on a plain click); `frame.mjs` runs the photo slideshow (cross-fade, fit, Ken Burns, decode before show) and `frame-settings.mjs` prepares files in the browser (scaling) and edits the frame's options. `core/photo-frame.mjs` stores the photos under the data directory (signature check, SVG refused, size/count limits, one copy per picture) and serves them only to an authenticated page with a restrictive CSP; the list is part of `/api/bootstrap` and changes arrive as `frame.updated`. The idle screen can start from any quiet view and restores the previous view; photos are never drawn in 共有表示.

On ホーム the conversation column collapses to its message box, placed under the character with CSS grid overlap (a separate row on narrow screens); the column opens on demand elsewhere. The work page updates the job list, bench header and artifact toolbar in place around the artifact iframe, because a detached iframe reloads. Display settings, theme and idle behaviour are display preferences only; they never change permissions or work, and the emergency stop is shown whenever anything runs.

## Desktop, speech and verification

Tauri still bundles a Node runtime, the compiled Rust core addon and V3 sources. It opens only the sidecar loopback origin and retains tray/background behavior. The standalone native-service binary needs no Node executable after its frontend bundle is built, but it is not the packaged desktop sidecar. Optional Python speech/decision workers remain separate services.

Root npm/Task commands and CI target V3. [QA](QA.md) and [STATUS](STATUS.md) contain historical and current evidence; the dated [migration record](RUST-MIGRATION.md) identifies exactly which native slice was exercised. Local deterministic provider fixtures verify mechanics, not real model quality or a paid account. Windows/macOS packaging, installation, native WebView behavior and real hardware/model acceptance remain separate gates. Complete V2 migration and the remaining native effects are unfinished.

## Process and capability checkpoint

`agent/process_host.rs` adapts real processes to the existing FIFO actor and ordered receipts. `agent/processes.rs` owns the bounded process manager; `sandbox.rs` creates the configured host/workspace/readonly/container invocation. Frozen per-step descriptors preserve dynamic alias receipt keys. Approved arguments are consumed once at dispatch.

`capabilities/` uses the same `WorkspaceAccess` and `NativeNetwork`; registry/event CAS is atomic, and explicit keys are memory-only. Workspace retains the agent host for live process projections. Provider/capability snapshot decorators only read runtime-owned caches, so reconnect sequence capture and subscriber registration remain atomic under the one State lock.

`workspace/input_files.rs` stages inert bounded text/image documents transactionally. `workspace/session_files.rs` provides bounded file listing/download with a resolved-root guard. Model attachment delivery, decision routing and web host wiring remain later steps. No default application cutover is implied.

See [complete route inventory and release gates](RUST-ROUTE-PARITY.md).
