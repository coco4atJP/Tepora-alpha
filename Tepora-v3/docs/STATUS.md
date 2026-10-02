# Tepora 3.0.0-beta.11 — current status

This branch now uses V3 for root startup, development, regression checks and native packaging. V2 source and data remain preserved; default commands do not launch V2 and no automatic data migration is performed.

## Local evidence

On 2026-10-02, after integrating beta.11 into `main`, the V3 suite passed **454 Node tests**, **13 isolated Python worker tests** and syntax checks for **102 JavaScript modules**. Capability integration used deterministic local HTTP providers with **zero external network calls**. Scenario consistency and preview generation passed.

The branch cutover passed **5 repository entry-point and release-helper tests** separately. The current reproducible gate is `npm run quality` from the repository root; detailed logs and stage outcomes are written under `Tepora-v3/validation/loop/`. These checks do not invoke a trained model or prove UI rendering.

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

## Acceptance still required

The 100-scenario inventory is **1 mechanism-tested / 93 partial / 6 not implemented**. It is implementation traceability, not 100 end-user passes.

Real-model quality, GPU contention, real ASR/TTS, paid-provider compatibility, real Codex execution, Windows UIA, macOS microphone behavior, Windows installers, native UI acceptance and actual Docker isolation are not established by the local fixture suite. The local macOS package build and bundled-service check are recorded separately above. Automatic runtime provisioning, broad root-capable VM/VPS workers, PDF/Office input, macOS full-desktop automation and complete V2 persona/profile migration remain unfinished.

The restricted executor has no network, package installation or host mounts. Host integrations require explicit legacy-host mode and are not OS-sandboxed. SQLite data are not encrypted. The source manifest describes source bytes, not successful release acceptance.

See [BETA11](BETA11.md), [QA](QA.md) and [architecture](ARCHITECTURE.md). Historical validation records are in [history](history/README.md).
