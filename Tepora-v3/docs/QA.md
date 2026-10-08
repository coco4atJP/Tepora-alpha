# Tepora 3.0.0-beta.11 — QA

## Standard gate

From the repository root:

```sh
npm run quality
```

The gate checks JavaScript syntax, all V3 Node regressions, isolated Python worker contracts, the original 100-scenario digest and source/test references, preview generation, capability integration with local deterministic providers, and repository entry points/release helpers. `PYTHON` selects an existing Python executable; otherwise Windows uses `python` and other systems use `python3`.

The V3 improvement loop records source fingerprints, exit codes, actual elapsed time (`ms`), configured stage budgets (`timeoutMs`) and stage logs in `Tepora-v3/validation/loop/`. A source change during the gate prevents a stable pass. Generated output is excluded from source fingerprints. Windows test runs retain bounded hang diagnostics without masking failures. The whole `node-tests` stage has a fixed 360-second budget; all other stages retain 180 seconds. The existing 1.5-second termination grace and individual test deadlines remain unchanged. These are orchestration ceilings, not expected durations or performance targets.

Local integration evidence on 2026-10-02 after the security fixes: **482 V3 Node tests**, **13 Python tests**, **103 syntax modules**, capability fixtures and preview build passed. All **5 repository checks** passed separately in the root suite. The 28 added security regressions cover private-address rejection, valid local integrations, context references, routine reactivation and UI form identity. [STATUS](STATUS.md) states the limits of these results.

A separate live Chrome check with bundled Node Playwright used temporary data, synthetic credentials and controlled local HTTP. Imported and older stored markup created no settings form; unregistered forms made no settings request. Real settings and conversation forms still worked. This check made zero external provider calls and did not exercise a native WebView or real model.

Local evidence on 2026-10-04 after the companion monitor and stacked-approval changes: **500 V3 Node tests**, **13 Python tests**, **122 syntax modules**, scenario consistency, preview build and capability fixtures passed, with all **5 repository checks**. The browser stages of `quality:full` (`browser-first-use`, `browser-routing`, `browser-capabilities`, `browser-capability-components`) and the separate `browser-preview.py`, `browser-agentos.py` and `browser_check.py` were updated to the current screen and passed with Python Playwright and the installed Google Chrome selected by `CHROMIUM_PATH`. The `computer` stage was not run.

Local evidence on 2026-10-05 after the one-lamp redesign (work lights and the amber lamp, window light, approval seals, screensaver-style idle screen, photo frame): **531 V3 Node tests**, **13 Python tests**, **132 syntax modules**, scenario consistency (1 / 93 / 6), preview build and capability fixtures passed, with all **5 repository checks**. `improve-loop --browser --capabilities` passed through `browser-first-use`, `browser-routing`, the new `browser-lamp`, `browser-abilities` and `browser-ability-components`, and `browser-preview.py`, `browser-agentos.py` and `browser_check.py` passed separately, all with Python Playwright and the installed Google Chrome selected by `CHROMIUM_PATH`. One `browser-agentos.py` run timed out while waiting for a saved routine card; seven full re-runs and seventy repetitions of the same steps, some under heavy CPU load, did not reproduce it. The `computer` stage was not run. [COMPANION-MONITOR](COMPANION-MONITOR.md) lists what these checks do not cover (native WebView, Wake Lock and full-screen behaviour in the desktop window, touch hardware, screen readers, long-running photo frames).

Local evidence on 2026-10-05 after the avatar foundation: **560 V3 Node tests**, **13 Python tests**, **163 syntax modules**, scenario consistency (1 / 93 / 6), preview build and capability fixtures passed, with all **5 repository checks**. `improve-loop --browser --capabilities` passed, now including `browser-avatar` (the real service, the studio, the solid 3D body, a VRM, a mesh project, a picture and a picture set made by `tests/fixtures/avatar-fixtures.mjs`; WebGL from a software GL, reported as skipped when a browser has none), and `browser-preview.py`, `browser-agentos.py` and `browser_check.py` passed separately, all with Python Playwright and the installed Google Chrome selected by `CHROMIUM_PATH`. The `computer` stage was not run. [AVATAR](AVATAR.md) lists what these checks do not cover (other VRM models, a real mesh-avatar-studio export, real GPUs and drivers, native WebViews).

## Node-suite orchestration budget repair (2026-10-08)

Before this repair, every improvement-loop stage had a 180,000 ms outer timeout. At source `765d786d711321890db5c9d7260d8c45bc2e52c3`, the [Windows quality job](https://github.com/coco4atJP/Tepora-alpha/actions/runs/37759171597/job/113251103103) stopped the Node stage after 180,021 ms. The [separate Windows native job at the same source](https://github.com/coco4atJP/Tepora-alpha/actions/runs/37759171705/job/113251103777) completed its Node suite in 212,318.4464 ms with 588 passes, zero failures and two existing skips. The aggregate budget was shorter than an observed successful suite run.

After this repair, only the whole Node-suite budget is 360,000 ms, giving about 148 seconds of headroom above that observation. Other stage budgets remain 180,000 ms. Existing Windows diagnostic flags, the 120,000 ms per-test runner timeout, individual 8/12-second behavioral deadlines, assertions, test selection and skips are unchanged. Each result records its configured budget separately from its measured duration, including termination grace when used.

Focused unit fixtures exercise the production stage runner with fake clocks and processes: exact budget selection, command configuration, a 212,318 ms completion, finite SIGTERM/SIGKILL timing, cleanup and error reporting. They start no child processes and do not run the full quality/security suite. This is a bounded CI orchestration repair, not a measured performance improvement or evidence that the patched full quality/platform gate has passed. A new full CI result is still required for that claim.

## Additional checks

- `npm run quality:full`: adds UI and controlled-browser checks using already installed Python Playwright and Chromium or Chrome. The scripts use `CHROMIUM_PATH`, then `chromium` or `google-chrome` on PATH, then Playwright's own browser. It does not install packages or models.
- `npm run test:scenarios`: verifies the preserved specification and writes traceability output; it does not certify real user journeys.
- `npm run test:capabilities`: runs actual harness/HTTP/SQLite/media bytes with deterministic local endpoints and zero external provider calls.
- From `Tepora-v3/`, `node scripts/check-executor.mjs --image repository@sha256:<digest> --approve-image`: optionally executes an explicitly approved preinstalled image to check non-root behavior, storage boundaries, absent sentinel/secret, interfaces and cleanup. No image pull is automatic. This is outside the standard gate.

## Native checks

`.github/workflows/tepora-v3-beta.yml` builds the current revision for Windows/macOS and records installation/startup evidence and screenshots. The bundled service must report the package version **3.0.0-beta.11**. The separate manual native-smoke workflow requires an explicit artifact run and matching exact commit; it has no defaults pointing at older betas.

Local macOS arm64 `.app`/DMG creation and bundled Node service startup passed during this cutover; the native WebView was not exercised. Native startup, screenshots and regression tests are different evidence. Do not infer real-model quality, microphone/ASR success, signed/notarized distribution or unattended reliability from service readiness. A configured workflow is not a successful remote CI run.

Earlier failure/reproduction records are available through Git history. They are historical evidence rather than current test counts.

## Native ordinary streaming speech

The focused speech gate uses synthetic zero-filled PCM and a loopback JSON worker, without microphone capture or real model execution. Rust tests cover sequence/retry, sample/text validation, budget/timer, single-flight behavior and cancellation drains. Real HTTP tests compare ordinary compatibility/native replies, verify effect-free-mode 503 availability, and cancel pending start/chunk/finish through Stop All, tray Stop and shutdown. This is not full quality or platform/package acceptance. See [RUST-SPEECH-STREAM](RUST-SPEECH-STREAM.md).

## Native ordinary dictation and uploaded audio

The [voice-route gate](RUST-VOICE-ROUTES.md) compares the real Node/native HTTP paths using synthetic Unicode text/audio and a credential-free loopback provider. It verifies proposal/error parity, multipart contents, dictation timeout and owned Stop/tray/shutdown cancellation, plus focused Rust validation, deadlines, budgets and overlapping barriers. It does not use a microphone, real ASR, external provider or private credentials and is not full quality/platform acceptance.

## Native ordinary custom-skill CRUD

The [custom-skill gate](RUST-CUSTOM-SKILLS.md) uses inert synthetic text and both real HTTP hosts to compare create/patch/delete, UTF-16 validation, exact errors, saved ordering, SSE event-before-refresh, cached prompt metadata and cross-host restart. Isolated Rust tests also verify refresh-failure persistence and agent-only admission. No skill dispatch, discovery, model/provider, or held policy/security probes are run. These focused checks do not establish full quality or platform acceptance.

## Native ordinary weather and news

The [feed-connector gate](RUST-FEED-CONNECTORS.md) freezes ordinary source projections, errors and cache/time transitions using fictional cities and synthetic URLs. Rust and real loopback HTTP tests inject every outbound request into a socket-free transport, including the unchanged fixed weather URLs. They cover saved settings, Unicode/chunk/title limits and owned Stop/tray/shutdown cancellation. Real feeds/locations/providers, held security work and full quality/platform acceptance remain untested.

## Native ordinary media embed/view

The [embed/view gate](RUST-MEDIA-EMBED.md) compares source/native response bytes, CSP/cache headers, ordinary validation/method errors, 32-entry FIFO behavior, restart invalidation, network-mode transitions and effect-free-mode availability. Rust tests also cover concurrent admissions and no durable handle events. Synthetic IDs and local HTTP only: no browser, third-party video request, playback, external opener, real account or held security-policy work is exercised. Focused checks do not establish full quality or platform acceptance.
