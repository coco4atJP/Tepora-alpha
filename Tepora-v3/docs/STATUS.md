# Tepora 3.0.0-beta.11 — current status

This branch now uses V3 for root startup, development, regression checks and native packaging. Earlier application sources, tools and archived documents have been removed from this checkout. Git history retains earlier revisions; existing user data are not automatically migrated or deleted.

## Local evidence

On 2026-10-02, after integrating beta.11 into `main` and fixing the two security findings, the V3 suite passed **482 Node tests**, **13 isolated Python worker tests** and syntax checks for **103 JavaScript modules**. Capability integration used deterministic local HTTP providers with **zero external network calls**. Scenario consistency and preview generation passed.

The repository suite passed **5 entry-point and release-helper tests** separately. The current reproducible gate is `npm run quality` from the repository root; detailed logs and stage outcomes are written under `Tepora-v3/validation/loop/`. These checks do not invoke a trained model or prove UI rendering.

A separate live Chrome fixture verified rejected private Web fetching and imported markup, inert older stored references, denied forged settings forms, and working legitimate settings/conversation forms. It used temporary data and synthetic credentials with zero external provider calls. The fixes preserve explicit local inference/MCP/RSS scopes and future routine execution after explicit reactivation; imported jobs are never resumed by that activation.

On 2026-10-04, after the companion monitor, stacked approvals and the calmer screen layout, the V3 suite passed **500 Node tests**, **13 isolated Python worker tests** and syntax checks for **122 JavaScript modules**; scenario consistency, preview generation and capability fixtures passed, and the **5 repository tests** passed separately. The Playwright UI checks were updated to the current screen and passed locally with Python Playwright and the installed Google Chrome (`improve-loop --browser --capabilities`, plus `browser-preview.py`, `browser-agentos.py` and `browser_check.py`). Screens were reviewed in headless Chrome from 360 to 1440 px wide, light and dark. A live run against the real service with a scripted, non-intelligent OpenAI-compatible peer exercised character handoff, an approval stacked while away, independent work, parking, approval from あなたの番, exact replay and the generated image on the home card. VRM rendering was checked with the three-vrm sample model only. None of this exercises a native WebView, real models, a screen reader or WebKit IME input on a real keyboard.

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
- Companion monitor home (drawn character or a local VRM model, clock, rotating cards, idle screen) and あなたの番, where approvals stack while the person is away and replay exactly once allowed. See [COMPANION-MONITOR](COMPANION-MONITOR.md).

## Acceptance still required

The 100-scenario inventory is **1 mechanism-tested / 93 partial / 6 not implemented**. It is implementation traceability, not 100 end-user passes.

Real-model quality, GPU contention, real ASR/TTS, paid-provider compatibility, real Codex execution, Windows UIA, macOS microphone behavior, Windows installers, native UI acceptance and actual Docker isolation are not established by the local fixture suite. The local macOS package build and bundled-service check are recorded separately above. Automatic runtime provisioning, broad root-capable VM/VPS workers, PDF/Office input, macOS full-desktop automation and complete V2 persona/profile migration remain unfinished.

The restricted executor has no network, package installation or host mounts. Host integrations require explicit legacy-host mode and are not OS-sandboxed. SQLite data are not encrypted. The source manifest describes source bytes, not successful release acceptance.

See [BETA11](BETA11.md), [QA](QA.md) and [architecture](ARCHITECTURE.md). Historical validation records are available through Git history.
