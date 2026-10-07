# Native backend route parity: process checkpoint

This source inventory compares the existing application routes with the explicit Rust development host. It is not a default-switch approval. The GUI and normal Node/Tauri launch remain unchanged.

The inventory contains 126 application method/path variants and 22 separately grouped static rows. In this checkpoint, **33 are substantially matched, 13 are partial and 80 are absent**. Thus 46 have handlers, and the 13 partial routes are included in those 46. A route count is not an end-to-end feature completion percentage.

Verification: 302 Rust service library tests + 2 CLI tests; 23 offline HTTP process tests and 9 native-agent process tests pass locally. The child service starts without Node in PATH; the added process fixture runs an actual shell builtin through exec and checks its receipt. No real model or paid service is used. CI at the preceding commit 60cb4ae passes Ubuntu and native build/tests on Windows/macOS; its later platform Node failures are tracked separately. This new checkpoint still needs its own CI.

Scope: native exec/process is connected. Capabilities configuration and typed transport components are implemented; decision/web/semantic/media consumers remain pending. Attachments can be staged but not yet delivered to the model. A saved or newly configured decision route is rejected rather than ignored. Session download deliberately adds a resolved-root symlink guard. Missing effects are not fabricated and do not fall back to Node inside this host.

## Complete route inventory

YES means a real handler is present in the supported scope, not that every model/platform is certified. PARTIAL identifies a missing behavior or deliberate compatibility boundary. ABSENT means the route has no native implementation (normally503; media-view remains404). All API routes retain the outer authentication, CSRF, Host/Origin and body-size boundary.

| ID | Method/path | Native agent | Successful source status | Boundary |
|---|---|---|---|---|
| R001 | `GET /health` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R002 | `GET /launch?token={token}` | YES | 303 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R003 | `GET /api/bootstrap` | PARTIAL | 200 | Live provider/capability overlays implemented. Setup/computer/media/display/avatar/photo behavior still incomplete. |
| R004 | `GET /api/events?since={seq}` | PARTIAL | 200 | Atomic replay/reconnect includes live provider health/limits/resources and capability key hints. Events from unported peripheral hosts remain absent. |
| R005 | `GET /api/agent` | PARTIAL | 200 | Projected agent state works for admitted native sessions; web/media/scheduler/plugin effects remain incomplete. |
| R006 | `GET /api/agent/dialogue` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R007 | `POST /api/agent/input` | PARTIAL | 202 | Text input works; nonempty attachmentIds still fail explicitly. Staging exists, but copying/image delivery, vision bridging and decision routing remain pending. |
| R008 | `GET /api/agent/sessions` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R009 | `POST /api/agent/spawn` | PARTIAL | 202 | Native 19-tool worker path includes exec/process. find/grep/web/skill/MCP/media/computer/schedule remain unavailable; unsupported cached tools block admission. |
| R010 | `GET /api/agent/sessions/{id}` | PARTIAL | 200 | Transcript paging and live process projection are implemented. Fractional/NaN paging coercion remains intentionally stricter than the JS endpoint. |
| R011 | `DELETE /api/agent/sessions/{id}` | ABSENT | 200 | Session deletion is not yet connected to native actor/process cleanup. |
| R012 | `POST /api/agent/sessions/{id}/message` | YES | 202 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R013 | `POST /api/agent/sessions/{id}/stop` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R014 | `POST /api/agent/sessions/{id}/resume` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R015 | `POST /api/agent/sessions/{id}/accept` | YES | 200 | Actor-compatible session acceptance; source timestamp and projection retained. |
| R016 | `GET /api/agent/sessions/{id}/files` | YES | 200 | Bounded session-folder listing, hidden/build directories skipped; symlinks not traversed. |
| R017 | `GET /api/agent/sessions/{id}/download?path={relativePath}` | PARTIAL | 200 | Binary download and 50MB bound implemented; deliberately rejects symlink escapes accepted by the old lexical-only check. Ancestor rename races are not claimed eliminated. |
| R018 | `GET /api/agent/settings` | PARTIAL | 200 | Settings and real process sandbox availability are returned. Some preserved optimizer/scheduler/peripheral settings still have no native consumer. |
| R019 | `PATCH /api/agent/settings` | PARTIAL | 200 | Policy/config mutations and prompt refresh work; enabling heartbeat is rejected. Optimizer, scheduler, web search setup and broader settings effects are unported. |
| R020 | `GET /api/agent/policy` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R021 | `POST /api/agent/policy/revert` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R022 | `POST /api/agent/dream` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R023 | `PUT /api/agent/search-key` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R024 | `POST /api/agent/plugins/reload` | ABSENT | 200 | Settings, policy learning/revert, web search credentials, live plugins/hooks is not implemented in native-service. Saved metadata does not provide the behavior. |
| R025 | `GET /api/agent/approvals` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R026 | `POST /api/agent/approvals` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R027 | `POST /api/agent/approvals/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R028 | `POST /api/stop` | PARTIAL | 200 | Correct for integrated actors and probes with sticky queue cancellation. Baseline setup/tool-discovery/media/computer/speech cancellation has no native host to target. |
| R029 | `GET /api/dialogue/personas` | ABSENT | 200 | Text/attachments/vision and persona prompt/voice changes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R030 | `PUT /api/dialogue/personas` | ABSENT | 200 | Text/attachments/vision and persona prompt/voice changes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R031 | `GET /api/capabilities` | YES | 200 | Live shared capability registry with key-presence hints; this GET does not certify modality consumers. |
| R032 | `PUT /api/capabilities` | PARTIAL | 200 | Atomic revisioned capability settings. Nonempty decision routes are explicitly rejected until the decision host is connected. |
| R033 | `POST /api/capabilities/{id}/key` | YES | 200 | Identity-bound explicit key set/clear; keys remain memory-only and are never emitted. |
| R034 | `POST /api/semantic/index` | ABSENT | 200 | Embedding/vector indexing and consent-aware memory retrieval is not implemented in native-service. Saved metadata does not provide the behavior. |
| R035 | `POST /api/semantic/search` | ABSENT | 200 | Embedding/vector indexing and consent-aware memory retrieval is not implemented in native-service. Saved metadata does not provide the behavior. |
| R036 | `GET /api/media/jobs` | ABSENT | 200 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R037 | `POST /api/media/jobs` | ABSENT | 202 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R038 | `DELETE /api/media/jobs/{sha256}` | ABSENT | 200 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R039 | `POST /api/media/jobs/{sha256}/cancel` | ABSENT | 200 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R040 | `POST /api/media/jobs/{sha256}/resume` | ABSENT | 200 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R041 | `GET /api/media/assets/{uuid}` | ABSENT | 200 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R042 | `HEAD /api/media/assets/{uuid}` | ABSENT | 200 | Persistent generation handles, poll/resume/cancel and protected asset bytes is not implemented in native-service. Saved metadata does not provide the behavior. |
| R043 | `POST /api/tools/import/preview` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R044 | `POST /api/tools/import/apply` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R045 | `POST /api/tools/connect/preview` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R046 | `POST /api/tools/connect/apply` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R047 | `POST /api/tools/search` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R048 | `POST /api/tools/{id}/discover` | ABSENT | 200 | Staged imports/connections, consent manifests, live discoveries and search is not implemented in native-service. Saved metadata does not provide the behavior. |
| R049 | `GET /api/model-catalog` | ABSENT | 200 | Local catalog import/search and guarded remote refresh for limits/prices is not implemented in native-service. Saved metadata does not provide the behavior. |
| R050 | `POST /api/model-catalog/import` | ABSENT | 200 | Local catalog import/search and guarded remote refresh for limits/prices is not implemented in native-service. Saved metadata does not provide the behavior. |
| R051 | `POST /api/model-catalog/refresh` | ABSENT | 200 | Local catalog import/search and guarded remote refresh for limits/prices is not implemented in native-service. Saved metadata does not provide the behavior. |
| R052 | `GET /api/computer` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R053 | `PATCH /api/computer` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R054 | `POST /api/computer/windows` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R055 | `POST /api/computer/status` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R056 | `POST /api/computer/release` | ABSENT | 200 | Browser/desktop state, permissions/window enumeration, guarded control and release is not implemented in native-service. Saved metadata does not provide the behavior. |
| R057 | `GET /api/network` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R058 | `PATCH /api/network` | PARTIAL | 200 | Core checked network revocation works; baseline stops setup, dictation/other probes and clears embedded media tokens. Those hosts/tokens are absent. |
| R059 | `GET /api/providers` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R060 | `PUT /api/providers` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R061 | `POST /api/providers/{id}/key` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R062 | `POST /api/providers/{id}/probe` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R063 | `GET /api/setup` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R064 | `POST /api/setup/install-help` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R065 | `POST /api/setup/scan` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R066 | `POST /api/setup/dismiss` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R067 | `POST /api/setup/select` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R068 | `POST /api/setup/install` | ABSENT | 202 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R069 | `POST /api/setup/stop` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R070 | `POST /api/inputs` | YES | 201 | Atomic bounded text/PNG/JPEG staging and metadata. Model input attachment delivery remains missing in the agent input route. |
| R071 | `DELETE /api/inputs/{id}` | YES | 200 | Staged deletion retains the baseline referenced-job guard. |
| R072 | `POST /api/runtime/discover` | ABSENT | 200 | Discovery/install/probe/select workflow, verified model application and resumable download is not implemented in native-service. Saved metadata does not provide the behavior. |
| R073 | `POST /api/voice/edit` | ABSENT | 200 | Ordered PCM, partial/final transcript, local ASR/dictation and cancellation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R074 | `POST /api/voice/start` | ABSENT | 200 | Ordered PCM, partial/final transcript, local ASR/dictation and cancellation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R075 | `POST /api/voice/chunk` | ABSENT | 200 | Ordered PCM, partial/final transcript, local ASR/dictation and cancellation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R076 | `POST /api/voice/finish` | ABSENT | 200 | Ordered PCM, partial/final transcript, local ASR/dictation and cancellation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R077 | `POST /api/voice/cancel` | ABSENT | 200 | Ordered PCM, partial/final transcript, local ASR/dictation and cancellation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R078 | `POST /api/voice/transcribe` | ABSENT | 200 | Ordered PCM, partial/final transcript, local ASR/dictation and cancellation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R079 | `GET /api/artifacts/{id}/revisions` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R080 | `GET /api/artifacts/{id}/revisions/{version}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R081 | `PATCH /api/artifacts/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R082 | `GET /api/artifacts` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R083 | `GET /render/{id}?v={version}` | YES | 200 | RG-012 corrected at ac6c52dd3ddcf31046bd906efad9305eb3d51e39: internal codec content remains encoded until exactly one HTTP UTF-8 decode; actual HTTP CAS/revision/render fixture covers literal marker collisions and isolated surrogates. |
| R084 | `GET /api/display` | ABSENT | 200 | Revisioned appearance, undo/reset and validated portable presets is not implemented in native-service. Saved metadata does not provide the behavior. |
| R085 | `PATCH /api/display` | ABSENT | 200 | Revisioned appearance, undo/reset and validated portable presets is not implemented in native-service. Saved metadata does not provide the behavior. |
| R086 | `POST /api/display/undo` | ABSENT | 200 | Revisioned appearance, undo/reset and validated portable presets is not implemented in native-service. Saved metadata does not provide the behavior. |
| R087 | `POST /api/display/reset` | ABSENT | 200 | Revisioned appearance, undo/reset and validated portable presets is not implemented in native-service. Saved metadata does not provide the behavior. |
| R088 | `GET /api/display/export` | ABSENT | 200 | Revisioned appearance, undo/reset and validated portable presets is not implemented in native-service. Saved metadata does not provide the behavior. |
| R089 | `POST /api/display/import` | ABSENT | 200 | Revisioned appearance, undo/reset and validated portable presets is not implemented in native-service. Saved metadata does not provide the behavior. |
| R090 | `GET /api/doctor` | PARTIAL | 200 | OS diagnostics are partial across platforms: RAM implementation is Linux-only; native marker/note differs. Real model/GPU and packaged Windows/macOS behavior remain unverified. |
| R091 | `POST /api/shared/scan` | ABSENT | 200 | Local/shared skill discovery, SHA-bound enabling and lazy content loading is not implemented in native-service. Saved metadata does not provide the behavior. |
| R092 | `PATCH /api/skills/{id}` | ABSENT | 200 | Local/shared skill discovery, SHA-bound enabling and lazy content loading is not implemented in native-service. Saved metadata does not provide the behavior. |
| R093 | `DELETE /api/skills/{id}` | ABSENT | 200 | Local/shared skill discovery, SHA-bound enabling and lazy content loading is not implemented in native-service. Saved metadata does not provide the behavior. |
| R094 | `POST /api/skills` | ABSENT | 201 | Local/shared skill discovery, SHA-bound enabling and lazy content loading is not implemented in native-service. Saved metadata does not provide the behavior. |
| R095 | `PATCH /api/settings` | ABSENT | 200 | Legacy application settings and network revocation coupling is not implemented in native-service. Saved metadata does not provide the behavior. |
| R096 | `POST /api/presence` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R097 | `GET /api/avatar` | ABSENT | 200 | Validated avatar selection/look, material/body rules and preset history is not implemented in native-service. Saved metadata does not provide the behavior. |
| R098 | `PATCH /api/avatar` | ABSENT | 200 | Validated avatar selection/look, material/body rules and preset history is not implemented in native-service. Saved metadata does not provide the behavior. |
| R099 | `POST /api/avatar/undo` | ABSENT | 200 | Validated avatar selection/look, material/body rules and preset history is not implemented in native-service. Saved metadata does not provide the behavior. |
| R100 | `POST /api/avatar/reset` | ABSENT | 200 | Validated avatar selection/look, material/body rules and preset history is not implemented in native-service. Saved metadata does not provide the behavior. |
| R101 | `GET /api/avatar/export` | ABSENT | 200 | Validated avatar selection/look, material/body rules and preset history is not implemented in native-service. Saved metadata does not provide the behavior. |
| R102 | `POST /api/avatar/import` | ABSENT | 200 | Validated avatar selection/look, material/body rules and preset history is not implemented in native-service. Saved metadata does not provide the behavior. |
| R103 | `GET /api/avatar/assets` | ABSENT | 200 | Validated VRM/picture/mood/mesh packs, quotas, hashes and exact byte serving is not implemented in native-service. Saved metadata does not provide the behavior. |
| R104 | `PUT /api/avatar/assets` | ABSENT | 200 | Validated VRM/picture/mood/mesh packs, quotas, hashes and exact byte serving is not implemented in native-service. Saved metadata does not provide the behavior. |
| R105 | `DELETE /api/avatar/assets/{uuid}` | ABSENT | 200 | Validated VRM/picture/mood/mesh packs, quotas, hashes and exact byte serving is not implemented in native-service. Saved metadata does not provide the behavior. |
| R106 | `GET /api/avatar/assets/{uuid}/files/{relativePath}` | ABSENT | 200 | Validated VRM/picture/mood/mesh packs, quotas, hashes and exact byte serving is not implemented in native-service. Saved metadata does not provide the behavior. |
| R107 | `HEAD /api/avatar/assets/{uuid}/files/{relativePath}` | ABSENT | 200 | Validated VRM/picture/mood/mesh packs, quotas, hashes and exact byte serving is not implemented in native-service. Saved metadata does not provide the behavior. |
| R108 | `GET /api/frame` | ABSENT | 200 | Local photo signatures/dimensions, quotas, dedupe, bytes and events is not implemented in native-service. Saved metadata does not provide the behavior. |
| R109 | `PUT /api/frame/photos` | ABSENT | 200 | Local photo signatures/dimensions, quotas, dedupe, bytes and events is not implemented in native-service. Saved metadata does not provide the behavior. |
| R110 | `GET /api/frame/photos/{uuid}` | ABSENT | 200 | Local photo signatures/dimensions, quotas, dedupe, bytes and events is not implemented in native-service. Saved metadata does not provide the behavior. |
| R111 | `HEAD /api/frame/photos/{uuid}` | ABSENT | 200 | Local photo signatures/dimensions, quotas, dedupe, bytes and events is not implemented in native-service. Saved metadata does not provide the behavior. |
| R112 | `DELETE /api/frame/photos/{uuid}` | ABSENT | 200 | Local photo signatures/dimensions, quotas, dedupe, bytes and events is not implemented in native-service. Saved metadata does not provide the behavior. |
| R113 | `POST /api/memories` | YES | 201 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R114 | `PATCH /api/memories/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R115 | `DELETE /api/memories/{id}` | YES | 200 | No route-specific missing implementation identified within the admitted native scope; this does not establish real-model/platform acceptance. |
| R116 | `POST /api/mcp` | ABSENT | 201 | Persistent stdio/HTTP connection configuration and live revocation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R117 | `PATCH /api/mcp/{id}` | ABSENT | 200 | Persistent stdio/HTTP connection configuration and live revocation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R118 | `DELETE /api/mcp/{id}` | ABSENT | 200 | Persistent stdio/HTTP connection configuration and live revocation is not implemented in native-service. Saved metadata does not provide the behavior. |
| R119 | `POST /api/connector/weather` | ABSENT | 200 | Weather/news network fetch with current consent and document updates is not implemented in native-service. Saved metadata does not provide the behavior. |
| R120 | `POST /api/connector/news` | ABSENT | 200 | Weather/news network fetch with current consent and document updates is not implemented in native-service. Saved metadata does not provide the behavior. |
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

- Complete input delivery, setup and existing persona/display/avatar/photo workflows
- Connect native web/decision/semantic/media consumers; port MCP/computer, speech, schedules/heartbeat and optional plugin compatibility
- Preserve one database owner and actor-only state commits across pending effects, Stop, Resume and shutdown
- Verify auth/CSRF/SSE disconnects, exact approval arguments, revocation, session visibility and filesystem boundaries on actual supported platforms
- Keep original source differential tests and independent baseline evidence; do not relabel known failures as passing gates
- Verify desktop packaging and lifecycle before switching normal launch or consolidating V3
