# Acceptance status — 3.0.0-beta.1

2026-09-26. These are implementation and verification distinctions, not a production-readiness claim.

| Requirement | Implemented here | Verification / remaining gate |
|---|---|---|
| Rich companion smart display | Home, time, buddy, artifacts, activity, media/information slots, focus/ambient modes | Chromium rendering and interactions; desktop/mobile screenshots |
| Preserve original direction | Warm espresso/brass/tea tokens, local-first; original app remains untouched | Relevant original docs/CSS reviewed through GitHub |
| Asynchronous work while chatting | Separate work and chat lanes, queue, streaming, cancellation, steering | Automated concurrency test with real scheduler and controlled model transport |
| Live artifacts | Early publish, same-ID revision, separate renderer and persisted history | Three-version test; preview render interaction test |
| Local/cloud runtime | llama.cpp/vLLM/Ollama/LM Studio/compatible endpoint adapters, discovery and installed-process launch | HTTP/SSE contract tests; no live GPU/model benchmark |
| Local Jev-like decisions | DiffusionGemma `/v1/systemone` client with actual criteria schema | Request/response test; local weights and vLLM not executed |
| Voice input | PCM/WAV capture, ASR HTTP adapter, Qwen and faster-whisper inference loaders | ASR API tests with stub; microphone and actual recognition unverified |
| CLI-first working agent | Workspace read/write, exact per-command approval, real process execution and stop | Real harmless child-process test; no host sandbox guarantee |
| Computer use / admin operations | Not implemented | Required for tasks that cannot be expressed through CLI/MCP |
| Personal context | SQLite, confirmation, privacy scope, edit/delete/export/import | Persistence, private/shared retrieval and import tests |
| Full EM-LLM replacement | Not implemented | Current memory is lexical; semantic/episodic consolidation and migration required |
| MCP and user's Context Hub | stdio/HTTP tools client; Hub registration instructions | Fake stdio server integration test; user's actual Hub not launched |
| Agent Skills | Metadata + Markdown store, on-demand tool read, SKILL.md export | UI add/read; no dependency installer, file-tree skill package or registry |
| YouTube / YouTube Music | Live-service embed wrapper + external Brave app mode | URL/policy tests; real playback/login/Shields unverified |
| Ad blocker in Tauri | Not implemented | No guarantee to remove ads. Optional external Brave owns Shields |
| Weather / news | Opt-in Open-Meteo + selected RSS/Atom feed | Code paths and explicit UI states; outbound live providers not exercised here |
| Modular companion | Renderer boundary; two CSS styles | UI style toggle. Live2D/VRM/image plugin loading not implemented |
| Windows first / macOS second | Source launchers, Tauri host, native build script and workflow example | Native builds, WebView microphone/media/fullscreen behavior unverified |
| Absolute plug-and-play | Not complete | Need signed/notarized native installers, model/runtime onboarding, device profiling and recovery tests |
| No required vendor subscription | Baseline service/UI run offline with no npm runtime dependencies; endpoint independence | Cloud model/service fees and external API terms still apply |
| Continuous autonomous agent OS | Task-based async service, not a permanent autonomous scheduler | Wake word, background triggers, calendar jobs, event subscriptions, continual planning not implemented |

## Release gates

1. Run the native workflow on Windows and macOS, fix compilation/runtime issues, verify clean install/uninstall and no orphan processes. Do not publish a stable release merely because the JavaScript tests pass.
2. Validate actual local models: tool calls, failure/refusal handling, memory limits, parallel request behavior and cost. For DiffusionGemma, validate the specific vLLM commit and selected quantization; 8GB GPU suitability is not assumed.
3. Validate Japanese voice on the target PC, microphone permission/revoke flows, playback, WebView behavior, and caption latency. Benchmark rather than treating upstream model results as the application's own results.
4. Add runtime/model installation with license consent, disk/VRAM checks, resumable downloads, verified checksums and rollback. This is the missing part of strict plug-and-play.
5. Define the memory migration path and whether to port the harness into the original Rust backend or keep the sidecar boundary. Preserve existing personal data; never silently replace the V2 store.
6. Add durable checkpoint semantics before enabling unattended external side effects or resumable execution. Extend the threat model before adding desktop control or privileged actions.

The visual beta is useful now for direction and interaction review. The source service is useful for controlled tool-capable models. Neither justifies a claim to have surpassed Codex/Cowork/Muse or completed an all-purpose agent operating system.
