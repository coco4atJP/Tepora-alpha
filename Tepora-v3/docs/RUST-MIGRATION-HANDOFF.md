# Native migration handoff — beta.11

The opt-in Rust development host is still a partial application. Normal Node/Tauri launch and the JavaScript/CSS GUI remain unchanged. Keep the migration PR draft; this checkpoint does not authorize or establish a default-launch cutover.

## What is connected

- Shared Rust persistence/context/provider/runtime foundations and native HTTP/SSE/workspace ownership
- Ordinary agent request/decision lifecycle, attachment delivery, session deletion, saved schedules and heartbeat timers
- Preferences, personas, display/avatar recipes, local photo-frame and avatar-asset libraries
- Capability/setup/catalog, semantic memory and ordinary web operations already described in the migration guide
- Durable media jobs and generated-asset delivery; explicit uncertainty and resume instead of automatic resubmission
- Streaming speech, device-only dictation proposals and configured multipart ASR transcription
- Agent-mode custom-skill storage and prompt-snapshot refresh, weather/news connectors, and local media embed/view handles

These are narrower contracts than full feature availability. In particular, custom-skill CRUD does not provide the native `skill` loading tool, and media HTTP jobs do not provide media agent tools. Returning a saved configuration is not proof that its consumer exists.

## Route accounting

The canonical [machine inventory](rust-route-parity.json) and [readable inventory](RUST-ROUTE-PARITY.md) describe 126 application variants: **94 implemented, 12 partial, 20 unavailable**, plus 22 static rows (148 total). The counts are not feature-completion percentages. `tests/rust-route-parity.test.mjs` checks that both inventories agree.

The 20 unavailable routes cover tool import/connect/search/discovery (6), computer integration (5), policy/dream/plugin operations (4), MCP mutation routes (3), shared-skill discovery (1), and external media opening (1).

## Why the partial routes remain partial

| Routes | Remaining contract |
| --- | --- |
| R003 bootstrap, R004 events | Missing peripheral/plugin/tool owners cannot provide genuine projections or events; computer state remains explicitly inert |
| R005 agent snapshot | Observable results from absent browser/media-agent/plugin consumers are not supplied by the shared snapshot handler |
| R007 agent input | Vision bridges, image reads through the separate read tool, and cross-platform oversized-image conversion remain incomplete |
| R009 spawn | Native tool consumers still omit find/grep/skill/MCP/media/computer, browser-rendered retrieval and image reads |
| R010 session read | Paging retains intentionally stricter integer validation after HTTP coercion; some fractional/NaN requests differ from JavaScript. This is a compatibility difference, not an absent transcript handler |
| R017 session download | Existing binary handling does not establish complete filesystem-boundary parity; separate review remains required |
| R018/R019 agent settings | Persistence/refresh/heartbeat work exists, but dream optimization and absent peripheral/plugin consumers are not made functional by saved settings |
| R028 Stop All | Integrated owners are cancelled and drained; missing tool-discovery/computer hosts cannot yet participate |
| R058 network settings | Voice and embed handling are connected; remaining peripheral-owner lifecycle parity has not been fully reconciled |
| R090 doctor | The bounded system-fact update is still undergoing verification; R090 stays partial because this does not establish the wider diagnostic contract or real model/GPU acceptance |

## Deferred boundaries

- Approval-policy/regex/security reproduction work remains outside these ordinary migration slices. Do not infer its completion from a passing route or aggregate test run
- R091 shared discovery includes canonical-path, approved-root and later hash-checked read semantics. No real-home scan or incomplete filesystem-boundary port is included
- R121 external opening remains unavailable. A separate local fake-adapter candidate was not integrated because source-synchronous admission ordering was not verified against concurrent native changes. Serial fake-launch checks do not clear that boundary
- Computer, MCP, browser rendering and plugin/tool discovery require their own usable owners, lifecycle integration and acceptance. Do not substitute stored metadata or fabricated success

## Evidence and limits

The last completed package/quality checkpoint before the follow-on diagnostic metadata work is `04f41934e7cdd53e07f02f06addb6859216a4728`: [native package run](https://github.com/coco4atJP/Tepora-alpha/actions/runs/37762655777), [quality run, including retry](https://github.com/coco4atJP/Tepora-alpha/actions/runs/37762655378).

- Both Windows NSIS installation/startup and macOS DMG/bundled startup passed
- Native core: 109 tests on each platform; service: macOS 522 plus 2 CLI tests, Windows 488 plus 2 CLI tests
- Node: macOS 604 passed; Windows 602 passed with 2 platform skips
- Three-OS quality passed after one Linux retry. The initial Linux headless-browser startup failure and finite suite timeout are retained as failed evidence, not erased or described as fixed

Later commits require their own exact-head CI results; consult [draft PR243](https://github.com/coco4atJP/Tepora-alpha/pull/243), not a previous head's green checks.

The whole Node-suite budget is now bounded at 360 seconds; other validation stages remain at 180 seconds. This addresses a measured successful 212.3-second Windows suite being killed by a 180-second aggregate limit. Individual behavior/test deadlines, assertions and platform skips are unchanged. It is an orchestration correction, not a speed improvement.

Focused tests use synthetic files/audio, inert skill text, local HTTP and injected feed/launcher adapters. They do not establish real microphone, paid-provider billing, real-model quality, GPU/browser playback, native-WebView rendering or full default-host parity.

## Continue safely

1. Start from the exact published migration head and retain source/tree hashes with test evidence
2. Pick a missing ordinary owner/tool contract, including its Stop/close/restart behavior, rather than treating route counts as completion
3. Preserve explicit uncertainty, supported-mode boundaries and documented deliberate differences
4. Review and test the combined candidate, then require exact-head platform/package results before claiming acceptance
5. Resolve deferred boundaries and real-provider/platform acceptance separately before considering the default launcher
