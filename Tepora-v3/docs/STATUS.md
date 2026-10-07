# Tepora 3.0.0-beta.11 — current status

This branch now uses V3 for root startup, development, regression checks and native packaging. Earlier application sources, tools and archived documents have been removed from this checkout. Git history retains earlier revisions; existing user data are not automatically migrated or deleted.

## Agent harness rebuild (2026-10-06 to 2026-10-07, branch `feat/agent-harness`)

The agent runtime was rebuilt ([AGENT-HARNESS.md](AGENT-HARNESS.md)): a resident character that delegates to asynchronous work agents, a loop that recovers instead of failing, batch-only prompt rewrites for cache hits, careful compaction (exact ledger, chapters, identifier rescue, `recall`), decision-model features (Liquid d1 / Laya), schedule and change-driven check-ins, plugin hooks, skills, media generation, image input, and computer use (CDP browser, decision-model control loop, macOS Accessibility helper).

Evidence on this Mac (2026-10-07):

- `node --test` (before the real-model runs): **368 tests passed, 0 failed** (old tests for removed subsystems were deleted or moved to the new API). Syntax checks for 170 modules; `scripts/verify-scenarios.mjs` passes (every case that depended on the old implementation is now `partial` until re-verified).
- `npm run test:computer`: 5/5 with real headless Chrome (open/observe, direct actions, decision loop to a locally verified completion, screenshot, macOS helper build and permission report). `npm run test:capabilities`: 5/5 with deterministic local endpoints.
- A live UI run against a scripted model: delegation, work agent, completion self-check, report, and the new settings rows and computer-use sheet, with no console errors.

Real-model runs (2026-10-07, `scripts/eval-agent.mjs`, 11 cases, Liquid d1 `d1:free` as the decision model):

- **DeepSeek V4.1 Flash via OpenCode Go**: **11/11 passed**, 0 tool errors, 53 steps, 288,604 input tokens, cache hit rate 47–86% per case (86% on the 14-step long-log case; the first request of each case is necessarily uncached).
- **LFM2.5-Thinking 1.2B on the local Ollama** (native API): 3/11. The model often claims work it never did or overwrites files it has not read; the harness now catches both (missing-file check, read-before-overwrite, evidence-based completion check), which turns silent failures into partial progress, but a 1.2B model remains too small for most cases.
- Real Liquid d1: drove the headless-Chrome form fixture to a verified completion (`check-computer.mjs --liquid`, 2.7 s for three actions); picked the right sections for a Japanese question over a mixed Japanese/English page (including an English section lexical scoring missed); judged a partial report incomplete (p≈0.0003). `d1:free` rate-limits parallel requests (HTTP 429), so requests are serialized and retried.
- A live app run in an isolated data folder: the character on DeepSeek V4.1 Flash delegated a file task, the work agent wrote and verified it, and the report came back to the conversation. With the 1.2B model as the character, it answered "I can't create files" instead of delegating, which led to the decision-model delegation safety net.
- `node --test`: 388 passed; 175 modules syntax-checked; `verify-scenarios` passes.

Metacognition and learning from experience (2026-10-07, later the same day):

- Metacognition: harness-measured self-checks (context use, failures, stalled checklist, missing or low-confidence `reflect` notes, interval) appended to the transcript, and the agent's own `reflect` notes kept verbatim in the checkpoint ledger. In a live run DeepSeek V4.1 Flash received an "unreflected" self-check after 10 tool calls and wrote its notes; the scripted test confirms the previous request stays a byte-identical prefix.
- Dream-RSI-style tuning of the decision-model checks, on real runs sharing one record (`eval-agent.mjs --state … --dream`): LFM2.5 1.2B (4/11) and DeepSeek V4.1 Flash (11/11) gave 20 labelled completion episodes (15 complete, 5 incomplete). Replaying them through the real Liquid d1 with the three candidate questions gave leave-one-out costs c0 4, c1 7, c2 3, so the policy switched to c2 ("is anything missing?") at threshold 0.7 (revision 1). The next LFM run under it (5/11) produced 10 new episodes judged 9/10 correctly (the earlier run under c0: 7/9); on the latest 30 episodes c0 and c2 tie (10 each), so nothing further changed. The samples are small; this shows the loop working end to end, not a measured improvement.
- A live run surfaced and fixed: claimed files checked only in the session folder (now also folders the task names and tools used), the read-before-overwrite guard blocking files the agent's own commands had just made, the character not passing `cwd` for "the work folder", and a 429 retry timer that let a script exit mid-wait.

Not verified: macOS desktop control itself (Accessibility was not granted in the test environment), Anthropic/OpenAI cache behaviour against the real APIs (the 20-block lookback and TTL rules come from the providers' documentation), the local Laya worker, and the delegation safety net against a real small character model end to end (it is covered by a scripted test; the d1 routing question was calibrated on 15 sample messages).

## Local evidence

On 2026-10-02, after integrating beta.11 into `main` and fixing the two security findings, the V3 suite passed **482 Node tests**, **13 isolated Python worker tests** and syntax checks for **103 JavaScript modules**. Capability integration used deterministic local HTTP providers with **zero external network calls**. Scenario consistency and preview generation passed.

The repository suite passed **5 entry-point and release-helper tests** separately. The current reproducible gate is `npm run quality` from the repository root; detailed logs and stage outcomes are written under `Tepora-v3/validation/loop/`. These checks do not invoke a trained model or prove UI rendering.

A separate live Chrome fixture verified rejected private Web fetching and imported markup, inert older stored references, denied forged settings forms, and working legitimate settings/conversation forms. It used temporary data and synthetic credentials with zero external provider calls. The fixes preserve explicit local inference/MCP/RSS scopes and future routine execution after explicit reactivation; imported jobs are never resumed by that activation.

On 2026-10-04, after the companion monitor, stacked approvals and the calmer screen layout, the V3 suite passed **500 Node tests**, **13 isolated Python worker tests** and syntax checks for **122 JavaScript modules**; scenario consistency, preview generation and capability fixtures passed, and the **5 repository tests** passed separately. The Playwright UI checks were updated to the current screen and passed locally with Python Playwright and the installed Google Chrome (`improve-loop --browser --capabilities`, plus `browser-preview.py`, `browser-agentos.py` and `browser_check.py`). Screens were reviewed in headless Chrome from 360 to 1440 px wide, light and dark. A live run against the real service with a scripted, non-intelligent OpenAI-compatible peer exercised character handoff, an approval stacked while away, independent work, parking, approval from あなたの番, exact replay and the generated image on the home card. VRM rendering was checked with the three-vrm sample model only. None of this exercises a native WebView, real models, a screen reader or WebKit IME input on a real keyboard.

On 2026-10-05, after the one-lamp redesign (work as lights and one amber lamp, window light by hour and weather, approval seals, a screensaver-style idle screen with wallpapers and an on-device photo frame), the V3 suite passed **531 Node tests**, **13 isolated Python worker tests** and syntax checks for **132 JavaScript modules**; scenario consistency (still **1 / 93 / 6**), preview generation and capability fixtures passed, and the **5 repository tests** passed separately. `improve-loop --browser --capabilities` passed with Python Playwright and the installed Google Chrome, including the new `tests/browser-lamp.py`; `browser-preview.py`, `browser-agentos.py` and `browser_check.py` also passed. One `browser-agentos.py` run timed out waiting for a saved routine card and could not be reproduced in 7 full re-runs and 70 repetitions of the same steps (also under heavy CPU load), so its cause is unknown. Photo upload was exercised once against the real service in headless Chrome. None of this exercises a native WebView, Wake Lock or full-screen behaviour inside the Tauri window, a VRM model with the work lights, a held seal on a real touch screen, a screen reader or a photo frame left running on a real display.

On 2026-10-05, after the avatar foundation (what the character looks like is a validated recipe drawn by any body, and its voice is saved apart from it), the V3 suite passed **560 Node tests**, **13 isolated Python worker tests** and syntax checks for **163 JavaScript modules**; scenario consistency (still **1 / 93 / 6**), preview generation and capability fixtures passed, and the **5 repository tests** passed separately. `improve-loop --browser --capabilities` passed with Python Playwright and the installed Google Chrome, including the new `tests/browser-avatar.py`, which drives the real service through the studio, the solid 3D body, a VRM, a mesh-avatar-studio project, a picture and a set of pictures (all generated by `tests/fixtures/avatar-fixtures.mjs`; WebGL came from a software GL); `browser-preview.py`, `browser-agentos.py` and `browser_check.py` also passed. The pixiv VRM 1.0 sample was loaded outside the repository. Not established: VRM models other than that sample, a real mesh-avatar-studio export, real GPUs and drivers, and the native WebViews. See [AVATAR](AVATAR.md).

## Local native build evidence

The cutover also built the macOS arm64 `.app` and `3.0.0-beta.11` DMG with Node 24.14.0 and Rust 1.96.1. The bundled Node service was checked using temporary data: version, authenticated launch, protected execution, character session and browser-bundle delivery passed. Native WebView rendering, microphone behavior and real models were not exercised by that check. This is a local development package, not a signed/notarized release claim.

The initial build reproduced a macOS LINKEDIT loader failure in build-time Rust macros. The desktop build profiles now preserve their debug information and disable stripping; the full native build passed afterward. See the [recorded workaround](../../docs/guides/troubleshooting.md).

## Implemented scope

- Persistent character session with separate persona snapshots and asynchronous worker jobs.
- Revision-bound questions, sourced progress/results, bounded selected history and consented cross-recipient result excerpts.
- Durable job checkpoints, scoped operation approvals, effect uncertainty and explicit stop/resume reconciliation.
- Provider routing, typed capability adapters, source attachments, versioned artifacts, memory references and optional host integrations.
- Protected built-in tools by default; optional restricted Docker execution, immutable context capsules, execution journal and staged artifact promotion.
- Windows/macOS Tauri host and CI definitions for the current source and its bundled runtime.
- Avatar: what the character looks like is a validated recipe (body, material, lamp, face, ears, small items, flat or solid) shown by any body — the drawn bodies (しろ・改 by default), a solid 3D しろ・改, or a VRM, a picture, a set of mood pictures or a mesh-avatar-studio project a person brings — and the persona's tone, call name and wording are saved apart from it. See [AVATAR](AVATAR.md).
- Companion monitor home (the avatar, caption, clock, rotating cards, work as lights, window light) with a screensaver-style idle screen (wallpapers and an on-device photo frame), and あなたの番, where approvals are stamped with a seal, stack while the person is away and replay exactly once allowed. See [COMPANION-MONITOR](COMPANION-MONITOR.md).

## Acceptance still required

The 100-scenario inventory is **1 mechanism-tested / 93 partial / 6 not implemented**. It is implementation traceability, not 100 end-user passes.

Real-model quality, GPU contention, real ASR/TTS, paid-provider compatibility, real Codex execution, Windows UIA, macOS microphone behavior, Windows installers, native UI acceptance and actual Docker isolation are not established by the local fixture suite. The local macOS package build and bundled-service check are recorded separately above. Automatic runtime provisioning, broad root-capable VM/VPS workers, PDF/Office input, macOS full-desktop automation and complete V2 persona/profile migration remain unfinished.

The restricted executor has no network, package installation or host mounts. Host integrations require explicit legacy-host mode and are not OS-sandboxed. SQLite data are not encrypted. The source manifest describes source bytes, not successful release acceptance.

See [BETA11](BETA11.md), [QA](QA.md) and [architecture](ARCHITECTURE.md). Historical validation records are available through Git history.
