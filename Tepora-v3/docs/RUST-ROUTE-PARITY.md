# Native backend route parity: ordinary weather/news checkpoint

This source inventory compares the existing application routes with the explicit Rust development host. It is not a default-switch approval. The GUI and normal Node/Tauri launch remain unchanged.

The inventory contains 126 application method/path variants and 22 separately grouped static rows. In this checkpoint, **92 are substantially matched, 12 are partial and 22 are absent**. Thus 104 have handlers, and the 12 partial routes are included in those 104. A route count is not an end-to-end feature completion percentage.

Preceding exact-head acceptance: `f0d6c43e210fe925732643119cb1db4fccb16b4b` passed all five CI jobs: full quality gates on Linux/Windows/macOS, macOS DMG and bundled startup, and Windows NSIS build/installation/startup. Native-service counts were macOS 441 + 2 CLI and Windows 407 + 2 CLI; Node tests were macOS 558 passed, Windows 556 passed / 2 platform skips. Both had 109 core tests. This evidence does not certify the photo-frame candidate.

Current avatar integration: 91 selected ordinary native-service tests passed, including photo, avatar, scheduler, lifecycle and positive HTTP dispatch checks. On both Node 22.16.0 and 24.19.0, 18 selected real HTTP tests, 1 source scheduler regression and 9 root checks passed. Syntax checks cover 235 modules. These are focused gates; exact-head full CI/package acceptance remains pending. Photo repair head `34203d3` passed all three full quality gates and macOS packaging, but its separate Windows native job hit the previously observed completion-fixture deadline; Windows package stages were skipped. The test-only fixture stabilization is tracked separately. No new broad security review, real model or default cutover is claimed.

Scope: native exec/process, web_search/web_fetch, preferences/personas, display/avatar configuration state, first-use setup, model catalog/runtime discovery, scoped semantic memory and typed decisions are connected. Attachment admission/delivery and idle-worker deletion use correlated actor admissions and drain barriers. Saved schedules and change-sensitive heartbeats are connected. Unsupported vision bridges, plugins/MCP/media agent tools/PC and remaining peripheral effects stay unavailable. Session download retains its resolved-root symlink guard. Missing effects are not fabricated and never fall back to Node inside this host.

Photo-frame evidence and exact local scope are recorded in [RUST-PHOTO-FRAME](RUST-PHOTO-FRAME.md). Avatar asset evidence and scope are recorded in [RUST-AVATAR-ASSETS](RUST-AVATAR-ASSETS.md). These independent five-route slices do not establish a full quality pass or cross-platform package acceptance.

Media jobs add seven ordinary routes under `--dev-native --agent`. Focused evidence and limitations are in [RUST-MEDIA-JOBS](RUST-MEDIA-JOBS.md). This does not switch the launcher or certify remote accounts, decoders or billing.

Dictation proposals and uploaded-audio transcription add two ordinary routes. [RUST-VOICE-ROUTES](RUST-VOICE-ROUTES.md) records source parity, deliberate native bounds and cancellation improvements, and focused synthetic evidence.

Ordinary custom-skill CRUD adds R092–R094 under `--agent`, including real actor prompt refresh. [RUST-CUSTOM-SKILLS](RUST-CUSTOM-SKILLS.md) records exact validation, persistence, event and snapshot behavior. Shared scan R091 and the native `skill` content-loading tool remain absent; stored CRUD does not make skills usable end-to-end. R003 bootstrap remains partial.

Ordinary weather/news adds R119–R120 with the unchanged saved-setting and feed-admission boundary, source projection/cache behavior and owned cancellation. [RUST-FEED-CONNECTORS](RUST-FEED-CONNECTORS.md) records the deliberate native bounds and mock-only verification.

## Complete route inventory

YES means a real handler is present in the supported scope, not that every model/platform is certified. PARTIAL identifies a missing behavior or deliberate compatibility boundary. ABSENT means the route has no native implementation (normally503; media-view remains404). All API routes retain the outer authentication, CSRF, Host/Origin and body-size boundary.

| ID | Method/path | Native agent | Successful source status | Boundary |
|---|---|---|---|---|
| R001 | `GET /health` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R002 | `GET /launch?token={token}` | YES | 303 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R003 | `GET /api/bootstrap` | PARTIAL | 200 | Live provider/capability/setup overlays implemented. Display/avatar configuration and persona state are supported; computer behavior and media agent tools are still incomplete. |
| R004 | `GET /api/events?since={seq}` | PARTIAL | 200 | Atomic replay/reconnect includes live provider health/limits/resources, capability key hints and setup state. Events from unported peripheral hosts remain absent. |
| R005 | `GET /api/agent` | PARTIAL | 200 | Projected agent state includes saved schedules and change-sensitive heartbeats; browser rendering/media agent tools/plugin effects remain incomplete. |
| R006 | `GET /api/agent/dialogue` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R007 | `POST /api/agent/input` | PARTIAL | 202 | Server-resolved bounded attachment preparation, request-ID deduplication and supported vision delivery are connected. Non-vision chat keeps local receipts without image bytes or a bridge. Oversized image resize is macOS-only; unavailable/failed resize omits the image. Unsupported vision bridges remain absent. |
| R008 | `GET /api/agent/sessions` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R009 | `POST /api/agent/spawn` | PARTIAL | 202 | Native 22-tool catalog includes exec/process, web_search/web_fetch and schedule. find/grep/skill/MCP/media/computer remain unavailable; unsupported cached tools block admission. |
| R010 | `GET /api/agent/sessions/{id}` | PARTIAL | 200 | Transcript paging and live process projection are implemented. Fractional/NaN paging coercion remains intentionally stricter than the JS endpoint. |
| R011 | `DELETE /api/agent/sessions/{id}` | YES | 200 | Idle worker deletion waits for owned process cleanup and actor revalidation. Main, missing, active/draining and uncertain-cleanup cases fail explicitly; failure preserves session receipts. Working folders and unrelated user files are not recursively deleted. |
| R012 | `POST /api/agent/sessions/{id}/message` | YES | 202 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R013 | `POST /api/agent/sessions/{id}/stop` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R014 | `POST /api/agent/sessions/{id}/resume` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R015 | `POST /api/agent/sessions/{id}/accept` | YES | 200 | Actor-compatible session acceptance; source timestamp and projection retained. |
| R016 | `GET /api/agent/sessions/{id}/files` | YES | 200 | Bounded session-folder listing, hidden/build directories skipped; symlinks not traversed. |
| R017 | `GET /api/agent/sessions/{id}/download?path={relativePath}` | PARTIAL | 200 | Binary download and 50MB bound implemented; deliberately rejects symlink escapes accepted by the old lexical-only check. Ancestor rename races are not claimed eliminated. |
| R018 | `GET /api/agent/settings` | PARTIAL | 200 | Settings and real process sandbox availability are returned. Heartbeat settings drive versioned native timers; optimizer and peripheral settings remain partial. |
| R019 | `PATCH /api/agent/settings` | PARTIAL | 200 | Configuration and prompt refresh work; heartbeat changes replace timers and cancel in-flight old check-ins. Web search configuration invalidates bindings; dream optimizer and broader effects remain unported. |
| R020 | `GET /api/agent/policy` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R021 | `POST /api/agent/policy/revert` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R022 | `POST /api/agent/dream` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R023 | `PUT /api/agent/search-key` | YES | 200 | Selected Brave key validation/storage and atomic config binding; stale requests/cache are revoked before acknowledgement. No key appears in public events. |
| R024 | `POST /api/agent/plugins/reload` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R025 | `GET /api/agent/approvals` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R026 | `POST /api/agent/approvals` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R027 | `POST /api/agent/approvals/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R028 | `POST /api/stop` | PARTIAL | 200 | Correct for integrated actors, provider probes, media jobs, streaming speech and setup cancellation. Tool-discovery/computer hosts remain unported. |
| R029 | `GET /api/dialogue/personas` | YES | 200 | Revisioned persona/voice configuration; saving refreshes the live actor prompt without replacing its cached prefix. Persona data cannot grant tool/network authority. |
| R030 | `PUT /api/dialogue/personas` | YES | 200 | Revisioned persona/voice configuration; saving refreshes the live actor prompt without replacing its cached prefix. Persona data cannot grant tool/network authority. |
| R031 | `GET /api/capabilities` | YES | 200 | Live shared capability registry with key-presence hints; this GET does not certify modality consumers. |
| R032 | `PUT /api/capabilities` | YES | 200 | Atomic revisioned shared capability settings; valid decision routes are connected to typed actor-owned advice. Buffered advice rechecks registry/identity/key generation/close; user-requested media jobs consume pinned transport, while media agent tools and other speech consumers remain separate. |
| R033 | `POST /api/capabilities/{id}/key` | YES | 200 | Identity-bound explicit key set/clear; keys remain memory-only and are never emitted. |
| R034 | `POST /api/semantic/index` | YES | 200 | Bounded confirmed-memory indexing through the shared capability and SQLite owners; exact consent=true and shared scope required for external egress, with current document/identity rechecks and cancellation before cache publication. |
| R035 | `POST /api/semantic/search` | YES | 200 | Lexical/vector search with lexical fallback and fresh document checks; external query embedding requires exact consent=true. Request-scoped cancellation and a 30-second deadline apply. |
| R036 | `GET /api/media/jobs` | YES | 200 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R037 | `POST /api/media/jobs` | YES | 202 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R038 | `DELETE /api/media/jobs/{sha256}` | YES | 200 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R039 | `POST /api/media/jobs/{sha256}/cancel` | YES | 200 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R040 | `POST /api/media/jobs/{sha256}/resume` | YES | 200 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R041 | `GET /api/media/assets/{uuid}` | YES | 200 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R042 | `HEAD /api/media/assets/{uuid}` | YES | 200 | Native user-requested media jobs with pinned capabilities, durable handles, bounded polling/resume/cancel and asset-byte cleanup. Synthetic local fixtures; live providers and media agent tools remain unverified/unported. |
| R043 | `POST /api/tools/import/preview` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R044 | `POST /api/tools/import/apply` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R045 | `POST /api/tools/connect/preview` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R046 | `POST /api/tools/connect/apply` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R047 | `POST /api/tools/search` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R048 | `POST /api/tools/{id}/discover` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R049 | `GET /api/model-catalog` | YES | 200 | Local bounded catalog search; metadata is unverified and does not enable a provider or guarantee price/model quality. |
| R050 | `POST /api/model-catalog/import` | YES | 200 | Bounded validated catalog import persists provenance/hash; no executable content, model probe or installation. |
| R051 | `POST /api/model-catalog/refresh` | YES | 200 | Explicit models.dev refresh through checked web network policy, 24 MiB bound and cancellation; no automatic refresh. |
| R052 | `GET /api/computer` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R053 | `PATCH /api/computer` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R054 | `POST /api/computer/windows` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R055 | `POST /api/computer/status` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R056 | `POST /api/computer/release` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R057 | `GET /api/network` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R058 | `PATCH /api/network` | PARTIAL | 200 | Checked network revocation cancels setup when leaving online mode. Dictation/other peripheral probes and embedded-media tokens remain unported. |
| R059 | `GET /api/providers` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R060 | `PUT /api/providers` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R061 | `POST /api/providers/{id}/key` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R062 | `POST /api/providers/{id}/probe` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R063 | `GET /api/setup` | YES | 200 | Live first-use snapshot and persisted transfer recovery; reads do not start discovery, downloads or model calls. |
| R064 | `POST /api/setup/install-help` | YES | 200 | Explicit request opens the fixed official Ollama download page with the platform opener; does not install a package. |
| R065 | `POST /api/setup/scan` | YES | 200 | Explicit checked loopback discovery with expiring candidates and local Ollama tag/digest checks; no model call. |
| R066 | `POST /api/setup/dismiss` | YES | 200 | Persist dismissal and emit updated setup state; no network effect. |
| R067 | `POST /api/setup/select` | YES | 200 | Exact consentTest=true and fresh candidate required; safe probe precedes actor-serialized atomic settings/registry/receipt activation. Busy, stale, cancelled or configured-registry changes fail closed. |
| R068 | `POST /api/setup/install` | YES | 202 | Online mode checked before body parsing; exact consentDownload=true, fresh local engine and fixed catalog selection required. Bounded cancellable Ollama pull; never installs a runtime package or auto-selects a model. |
| R069 | `POST /api/setup/stop` | YES | 200 | Cancel setup probe/download and report stopping; transfer progress settles asynchronously. Scan is cancelled on shutdown, not by this route. Partial data remains managed by Ollama. |
| R070 | `POST /api/inputs` | YES | 201 | Atomic bounded text/PNG/JPEG staging and metadata; actor-correlated model input delivery is connected through the agent input route with its documented image limits. |
| R071 | `DELETE /api/inputs/{id}` | YES | 200 | Staged deletion retains the baseline referenced-job guard. |
| R072 | `POST /api/runtime/discover` | YES | 200 | Explicit discovery of fixed local runtime endpoints through checked model transport; availability is not model-quality certification. |
| R073 | `POST /api/voice/edit` | YES | 200 | Native single-flight device-only dictation proposals through existing provider protocols, 12-second deadline, exact UTF-16 edits and owned cancellation. Synthetic loopback evidence only; real model acceptance remains separate. |
| R074 | `POST /api/voice/start` | YES | 200 | Native single-session streaming speech: ordered/idempotent 16kHz Float32 PCM, two-minute budget/timer, partial/final text and owned cancellation. Synthetic loopback evidence only; real capture/ASR remains separate; dictation is covered by R073. |
| R075 | `POST /api/voice/chunk` | YES | 200 | Native single-session streaming speech: ordered/idempotent 16kHz Float32 PCM, two-minute budget/timer, partial/final text and owned cancellation. Synthetic loopback evidence only; real capture/ASR remains separate; dictation is covered by R073. |
| R076 | `POST /api/voice/finish` | YES | 200 | Native single-session streaming speech: ordered/idempotent 16kHz Float32 PCM, two-minute budget/timer, partial/final text and owned cancellation. Synthetic loopback evidence only; real capture/ASR remains separate; dictation is covered by R073. |
| R077 | `POST /api/voice/cancel` | YES | 200 | Native single-session streaming speech: ordered/idempotent 16kHz Float32 PCM, two-minute budget/timer, partial/final text and owned cancellation. Synthetic loopback evidence only; real capture/ASR remains separate; dictation is covered by R073. |
| R078 | `POST /api/voice/transcribe` | YES | 200 | Native configured-ASR multipart upload with 120-second deadline and owned cancellation; 12 MiB audio, 256,000-byte response, 32,000 UTF-16 transcript and eight-flight bounds. Synthetic loopback evidence only; actual capture/ASR remains separate. |
| R079 | `GET /api/artifacts/{id}/revisions` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R080 | `GET /api/artifacts/{id}/revisions/{version}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R081 | `PATCH /api/artifacts/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R082 | `GET /api/artifacts` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R083 | `GET /render/{id}?v={version}` | YES | 200 | RG-012 corrected at ac6c52dd3ddcf31046bd906efad9305eb3d51e39: internal codec content remains encoded until exactly one HTTP UTF-8 decode; actual HTTP CAS/revision/render fixture covers literal marker collisions and isolated surrogates. |
| R084 | `GET /api/display` | YES | 200 | Revisioned display configuration, validation, import/export, reset and undo; real Workspace/HTTP regression coverage. |
| R085 | `PATCH /api/display` | YES | 200 | Revisioned display configuration, validation, import/export, reset and undo; real Workspace/HTTP regression coverage. |
| R086 | `POST /api/display/undo` | YES | 200 | Revisioned display configuration, validation, import/export, reset and undo; real Workspace/HTTP regression coverage. |
| R087 | `POST /api/display/reset` | YES | 200 | Revisioned display configuration, validation, import/export, reset and undo; real Workspace/HTTP regression coverage. |
| R088 | `GET /api/display/export` | YES | 200 | Revisioned display configuration, validation, import/export, reset and undo; real Workspace/HTTP regression coverage. |
| R089 | `POST /api/display/import` | YES | 200 | Revisioned display configuration, validation, import/export, reset and undo; real Workspace/HTTP regression coverage. |
| R090 | `GET /api/doctor` | PARTIAL | 200 | OS diagnostics are partial across platforms: RAM implementation is Linux-only; native marker/note differs. Real model/GPU and packaged Windows/macOS behavior remain unverified. |
| R091 | `POST /api/shared/scan` | ABSENT | 200 | Local/shared skill discovery, SHA-bound enabling and lazy content loading is not implemented in native-service. Saved metadata does not provide the behavior. |
| R092 | `PATCH /api/skills/{id}` | YES | 200 | Stored-skill enabled-flag validation, metadata/order preservation, skill.updated and actor prompt refresh are matched under --agent. Discovery and the native skill content-loading tool remain unavailable. |
| R093 | `DELETE /api/skills/{id}` | YES | 200 | Stored-skill deletion, including missing-document success, skill.deleted and actor prompt refresh are matched under --agent. No skill file is read or deleted; discovery/content loading remain unavailable. |
| R094 | `POST /api/skills` | YES | 201 | Custom-skill text validation, UTF-16/trim semantics, enabled defaults, ordered persistence, skill.updated and actor prompt refresh are matched under --agent. No discovery or content-loading tool is added. |
| R095 | `PATCH /api/settings` | YES | 200 | Existing application preferences and atomic network revocation coupling are implemented; unknown fields do not grant permissions. |
| R096 | `POST /api/presence` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R097 | `GET /api/avatar` | YES | 200 | Revisioned avatar recipe state, validation, import/export, reset and undo; custom asset upload/byte-serving is implemented in R103–R107. |
| R098 | `PATCH /api/avatar` | YES | 200 | Revisioned avatar recipe state, validation, import/export, reset and undo; custom asset upload/byte-serving is implemented in R103–R107. |
| R099 | `POST /api/avatar/undo` | YES | 200 | Revisioned avatar recipe state, validation, import/export, reset and undo; custom asset upload/byte-serving is implemented in R103–R107. |
| R100 | `POST /api/avatar/reset` | YES | 200 | Revisioned avatar recipe state, validation, import/export, reset and undo; custom asset upload/byte-serving is implemented in R103–R107. |
| R101 | `GET /api/avatar/export` | YES | 200 | Revisioned avatar recipe state, validation, import/export, reset and undo; custom asset upload/byte-serving is implemented in R103–R107. |
| R102 | `POST /api/avatar/import` | YES | 200 | Revisioned avatar recipe state, validation, import/export, reset and undo; custom asset upload/byte-serving is implemented in R103–R107. |
| R103 | `GET /api/avatar/assets` | YES | 200 | Local image/VRM/image-set/mesh inspection, original bytes, quotas, deduplication, metadata/events, deletion/reset and restart. Synthetic fixtures only; deep JSON parser boundary and [validation](RUST-AVATAR-ASSETS.md). |
| R104 | `PUT /api/avatar/assets` | YES | 200 | Local image/VRM/image-set/mesh inspection, original bytes, quotas, deduplication, metadata/events, deletion/reset and restart. Synthetic fixtures only; deep JSON parser boundary and [validation](RUST-AVATAR-ASSETS.md). |
| R105 | `DELETE /api/avatar/assets/{uuid}` | YES | 200 | Local image/VRM/image-set/mesh inspection, original bytes, quotas, deduplication, metadata/events, deletion/reset and restart. Synthetic fixtures only; deep JSON parser boundary and [validation](RUST-AVATAR-ASSETS.md). |
| R106 | `GET /api/avatar/assets/{uuid}/files/{relativePath}` | YES | 200 | Local image/VRM/image-set/mesh inspection, original bytes, quotas, deduplication, metadata/events, deletion/reset and restart. Synthetic fixtures only; deep JSON parser boundary and [validation](RUST-AVATAR-ASSETS.md). |
| R107 | `HEAD /api/avatar/assets/{uuid}/files/{relativePath}` | YES | 200 | Local image/VRM/image-set/mesh inspection, original bytes, quotas, deduplication, metadata/events, deletion/reset and restart. Synthetic fixtures only; deep JSON parser boundary and [validation](RUST-AVATAR-ASSETS.md). |
| R108 | `GET /api/frame` | YES | 200 | Native local signature/dimension inspection, bounded inert-byte import, hash dedupe, persisted ordering, GET/HEAD, deletion and frame.updated events. Synthetic fixtures only; no image decoding or personal-photo access. |
| R109 | `PUT /api/frame/photos` | YES | 200 | Native local signature/dimension inspection, bounded inert-byte import, hash dedupe, persisted ordering, GET/HEAD, deletion and frame.updated events. Synthetic fixtures only; no image decoding or personal-photo access. |
| R110 | `GET /api/frame/photos/{uuid}` | YES | 200 | Native local signature/dimension inspection, bounded inert-byte import, hash dedupe, persisted ordering, GET/HEAD, deletion and frame.updated events. Synthetic fixtures only; no image decoding or personal-photo access. |
| R111 | `HEAD /api/frame/photos/{uuid}` | YES | 200 | Native local signature/dimension inspection, bounded inert-byte import, hash dedupe, persisted ordering, GET/HEAD, deletion and frame.updated events. Synthetic fixtures only; no image decoding or personal-photo access. |
| R112 | `DELETE /api/frame/photos/{uuid}` | YES | 200 | Native local signature/dimension inspection, bounded inert-byte import, hash dedupe, persisted ordering, GET/HEAD, deletion and frame.updated events. Synthetic fixtures only; no image decoding or personal-photo access. |
| R113 | `POST /api/memories` | YES | 201 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R114 | `PATCH /api/memories/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R115 | `DELETE /api/memories/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R116 | `POST /api/mcp` | ABSENT | 201 | Persistent stdio/HTTP connection configuration and live revocation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R117 | `PATCH /api/mcp/{id}` | ABSENT | 200 | Persistent stdio/HTTP connection configuration and live revocation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R118 | `DELETE /api/mcp/{id}` | ABSENT | 200 | Persistent stdio/HTTP connection configuration and live revocation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R119 | `POST /api/connector/weather` | YES | 200 | Saved city/current consent, fixed Open-Meteo URLs, 48-hour projection, 15-minute in-memory cache and owned Stop/shutdown cancellation. Bounded mock-only validation; real provider acceptance unverified. |
| R120 | `POST /api/connector/news` | YES | 200 | Saved feed/current consent, source RSS/Atom extraction and UTF-16/title/text limits, 10-minute in-memory cache and owned Stop/shutdown cancellation. Returned links remain inert. |
| R121 | `POST /api/media/open` | ABSENT | 200 | External opener and tokenized third-party embedded viewer is not implemented in native-service. Saved metadata does not provide the behavior. |
| R122 | `POST /api/media/embed` | ABSENT | 200 | External opener and tokenized third-party embedded viewer is not implemented in native-service. Saved metadata does not provide the behavior. |
| R123 | `GET /media-view/{token}` | ABSENT | 200 | External opener and tokenized third-party embedded viewer is not implemented in native-service. Saved metadata does not provide the behavior. |
| R124 | `GET /api/context/export` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R125 | `POST /api/context/import` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R126 | `GET /` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R127 | `HEAD /` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R128 | `GET /index.html` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R129 | `HEAD /index.html` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R130 | `GET /app.bundle.js` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R131 | `GET /styles.css` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R132 | `HEAD /styles.css` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R133 | `GET /avatar.css` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R134 | `HEAD /avatar.css` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R135 | `GET /favicon.svg` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R136 | `HEAD /favicon.svg` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R137 | `GET /pcm-worklet.js` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R138 | `HEAD /pcm-worklet.js` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R139 | `GET /vrm-stage.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R140 | `HEAD /vrm-stage.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R141 | `GET /mesh-avatar.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R142 | `HEAD /mesh-avatar.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R143 | `GET /three-body.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R144 | `HEAD /three-body.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R145 | `GET /vendor/{allowlistedFile}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R146 | `HEAD /vendor/{allowlistedFile}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R147 | `GET /{allowlistedSourceModule}.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R148 | `HEAD /{allowlistedSourceModule}.mjs` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |

## Remaining release gates

- Complete unsupported vision bridges and custom avatar asset/photo workflows; retain separate real-runtime setup and image acceptance
- Connect remaining media consumers; port MCP/computer, speech, dream optimization and optional plugin compatibility
- Preserve one database owner and actor-only state commits across pending effects, Stop, Resume and shutdown
- Verify auth/CSRF/SSE disconnects, exact approval arguments, revocation, session visibility and filesystem boundaries on actual supported platforms
- Keep original source differential tests and independent baseline evidence; do not relabel known failures as passing gates
- Verify desktop packaging and lifecycle before switching normal launch or consolidating V3

Ordinary streaming speech R074–R077 is available only with `--agent`; local-workspace-only mode remains effect-free. See [RUST-SPEECH-STREAM](RUST-SPEECH-STREAM.md) for lifecycle, transport bounds and synthetic-only evidence.
