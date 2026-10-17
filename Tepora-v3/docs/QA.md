# Tepora 3.0.0-beta.11 — QA

## Confirmed voice interruption and runtime cost (2026-10-17 UTC)

The opt-in reference-aware path adds playback → candidate pause → acoustic-tail
wait → fresh wake confirmation → ASR, with owned-playback resume on timeout.
It retains the default half-duplex path. These are synthetic model/audio
contracts, not proof of acoustic echo cancellation or real-room wake quality.
No real microphone, model download, credentials or paid inference were used.

Final local source checks under Node 24.19.0:

- **253/253** focused audio/controller/playback/dialogue/bundle/Node/native HTTP
  checks passed, including malformed stereo pairs, cancellation, delayed/stale
  output and timer races, exact-player resume, mute and a 500-readout source
  lifetime bound. Another **6/6** runtime projection and **5/5** route-inventory
  checks passed. Projection checks include 800 seeded histories, 480 admission
  cases, two real Rust controllers and preservation of real SQLite payloads.
- Rust: **561 native library + 2 native CLI + 142 core = 705** tests passed.
- Python: **50/50** passed with local NumPy. The isolated stdlib-only CI command
  runs the same 50 cases with **46 passes and 4 explicit NumPy math skips**;
  model/transport/cancellation fakes still run there.
- **13/13** rendered production-bundle browser checks cover default opt-out,
  the double-wake interruption/confirmation path, timeout resume, immediate mute
  and the visible status at 320 px. Audio, reference and worker responses are
  synthetic; Chromium uses an isolated profile with `--no-sandbox` and external
  HTTP(S) blocked. This does not verify actual audio capture or AEC.
- Broad `npm test`: **1005/1009** passed, zero skips. The same four host
  environment failures remain: three existing Computer Use browser fixtures
  cannot start the installed Chromium SUID sandbox; one bwrap fixture cannot
  create its UID map on the read-only host. They were executed and failed,
  rather than skipped or weakened. This is not a passing local quality gate.
- **296** JavaScript syntax modules, preview build, scenario traceability,
  **5/5** synthetic capability checks and **13/13** repository entry checks
  passed. OS CI and packaged startup evidence are recorded on
  [PR #248](https://github.com/coco4atJP/Tepora-alpha/pull/248).

With synthetic eight-worker plus foreground traffic, scheduling facts shrink
from **3,177,731 to 80,331 bytes**. Forty alternating real Rust SQLite dispatches
give median **273.530 → 207.877 ms**, CPU **276.185 → 209.310 ms** and p95
**309.325 → 251.223 ms**. The full transcript stays in storage and model context;
there is no new cache or telemetry write. SQLite reads still dominate. The
bridge-only result is **69.792 → 4.228 ms** and must not be presented as the
end-to-end dispatch time. See [the benchmark recipe](HARNESS-RELIABILITY.md#scheduling-snapshot-projection).

The final worklet's mono path preserves 960,000 output samples for each 60-second
fixture at 16/44.1/48/96 kHz. Compared with `31d4353` in the same Node VM run,
process CPU was **611.72/1,223.10/1,045.13/1,626.17 ms**, versus
**1,867.56/4,081.73/3,377.87/5,850.08 ms** (about **67–72% less**). This excludes
models, browser deadlines, reference inference, power and RSS. The opt-in FFT
veto alone measured median **1.317 ms** for a 500 ms history and **4.845 ms** for
a 2000 ms history over 100 synthetic comparisons; these are not wake-model costs.

Required hardware acceptance remains: compatible real wake/ASR/TTS checkpoints,
voice quality and false activations, nonlinear/delayed echo and double-talk,
headphones/speakers, real AEC, CPU/model RSS, autoplay, microphone unplug,
sleep/resume and Windows/macOS native WebViews. The new option reports browser
AEC configuration and uses conservative reference veto plus confirmation;
it does not establish reliable speakerphone barge-in.
[Setup, bounds and exact behavior](HANDS-FREE-VOICE.md).

## Initial local hands-free voice (`64f56be`, 2026-10-17 UTC)

Base: canonical V3 `31d4353` (remote branches and open PRs inspected first).
The original manual voice path passed 31 Node tests and 13 Python contracts.
No existing wake detector or automatic endpointing was present. The pi-ai
provider bridge was already integrated and has been retained.

The new wake/ASR worker routes, cancellation, state machine, output gating,
endpointing, local-only automatic readout and microphone lifecycle are tested
with synthetic PCM, fake models and loopback JSON workers. No credentials,
paid model calls, model downloads or real microphone were used.

Passed locally under Node 24.19.0 and the supplied Rust toolchain:

- Native-service Rust: **560 library + 2 CLI tests**; native-core: **142 tests**.
- Python worker contracts: **35/35**, using isolated stdlib-only fakes, including
  openWakeWord and optional CPU endpoint Whisper adapters.
- Production live-mode browser bundle with synthetic bridge/microphone:
  **8/8** rendered checks, no runtime/console errors, at 1440/390/320 px.
  It exercises wake → ASR → endpoint → actual UI send handler → synthetic
  reply, readout opt-in, and mute preserving an independent worker. Chromium
  uses an isolated profile and the existing fixture convention `--no-sandbox`;
  external HTTP(S) is blocked. This does not verify a real microphone/WebView.
- Root entry-point tests **13/13**, syntax, preview build, scenario traceability
  and synthetic capability checks **5/5** passed.

**Final focused voice gate: 150/150 passed**, including existing capture,
production bundle, reply handoff, playback, Node speech and real native/Node
loopback HTTP cancellation. The final broad `npm test` run passed **896/900**
with no skips. Four environment failures remain in the broad gate:
three existing `agent-computer.test.mjs` browser checks cannot start Chromium
with its installed SUID sandbox configuration; `agent-tools.test.mjs` cannot
create bwrap's UID map (`Read-only file system`). The command was executed and
failed; these checks were not skipped or weakened, and no successful complete
quality gate is claimed.

The synthetic PCM benchmark compares the initial V3 worklet and the new fixed
buffer resampler, feeding 60 seconds per sample rate in Node VM. It uses no
microphone/inference and reports process CPU separately from elapsed time.
The initial worklet lost 106 output samples at 44.1 kHz and emitted 3,204-sample
chunks; the new worklet preserves all **960,000** samples and emits **300 ×
3,200** at 16/44.1/48/96 kHz. Per-render-block PCM copies are removed. These are
preprocessing measurements, not real-model latency, RSS or browser deadlines.

| Input Hz | Baseline CPU ms | New CPU ms | CPU reduction |
| --- | ---: | ---: | ---: |
| 16,000 | 1,776.60 | 651.15 | 63.3% |
| 44,100 | 3,977.07 | 1,221.43 | 69.3% |
| 48,000 | 3,317.07 | 1,083.57 | 67.3% |
| 96,000 | 5,605.75 | 1,784.89 | 68.2% |

Reproduce with `node scripts/bench-voice.mjs --baseline /tmp/old-worklet.js`,
where the supplied baseline is `31d4353:Tepora-v3/web/pcm-worklet.js`.

Real-device acceptance remains: actual compatible models, wake quality and
false activation rates, noisy rooms, feedback/headphones, CPU/model RAM,
ASR/TTS latency, autoplay, unplug, sleep/resume and packaged native WebViews.
The initial path above is half duplex with immediate explicit interruption
and an 800 ms output tail. The subsequent experimental two-stage voice
interruption retains that default and is recorded below. Endpointing is
a local energy gate rather than learned speech VAD. [Setup and exact limits](HANDS-FREE-VOICE.md).


## pi-ai refresh durability and saved catalogs (2026-10-17 UTC)

Focused local checks under Node **24.19.0** passed **19 tests**: seven inert
catalog-validation fixtures, three production settings-controller fixtures, the
production dependency staging test and eight existing UI regressions. The full
JavaScript syntax gate and preview bundle also passed. A socket-free schema
smoke accepted all **1,407 models across 39 supported SDK providers**, including
Azure's inert empty-endpoint sentinel and Radius's bounded gateway labels.
Separate real-SDK Worker probes verified Radius discovery and inference using a
new returned model, and caller-cancelled Kimi refresh committing its rotated
credential without inference dispatch.

The added core-backed regressions cover cancellation/drain bounds and failure
cleanup, account-scoped discovery/save/inference, durable service re-open,
overlapping refresh/logout, stale limits/prices, empty/disabled snapshots,
SDK-version mismatch and corrupt-vault preservation. They were **not run
locally**: the Rust toolchain and native addon were absent, and `build:core`
failed rather than substituting another storage engine. Exact-head Node 22,
Rust, full host suites and Windows/macOS/Linux CI remain required. These checks
use synthetic credentials and no external account or paid inference; Worker and
controller probes do not establish live OAuth, browser or installer acceptance.

## Configurable monitor and bounded redraws

Follow-up review adds display-reset defaults/history/revision/undo regressions, exact customizer
control-focus regressions, and actual Scheduler/bootstrap/event/replay coverage for the schedule
card. Saved schedules load with bootstrap/reconnect; live views carry one committed row or its
removal, so recurring receipts with the old occurrence and one-shot receipts without a tombstone
cannot leave stale rows. The offline monitor test also covers repeated Space/Enter changes, and
Linux regression CI now runs it plus the existing layout browser suite without sandbox bypasses.
Local pure Node checks and preview generation pass. Rust/core-backed/HTTP and browser execution
were unavailable in this Linux executor: Rust/Cargo is absent and Chromium's process-singleton IPC
socket is denied. Their new exact-commit CI results are required before claiming those stages pass.

The monitor changes retain the Node/Tauri default host and explicit native development boundary.
Focused regressions cover wall-clock countdowns, pause/resume, delayed completion, display-only
scene validation, UTF-16 note limits, carousel deadlines and the generated-image widget identity.
`node tests/browser-monitor.mjs` adds six optional installed-Chrome checks for the actual offline
bundle: render-independent timing, preserved pinned-card controls/focus, an unchanged customizer,
clock-only approval access, image unpinning and all four layouts at 1440/390 px. The existing five
`browser-ui-layout.mjs` checks also pass with an isolated profile and no external provider calls.

An Apple M5/macOS arm64 headless-Chrome comparison used the reviewed feature checkpoint versus
its fixes, synthetic jobs/memories and CDP 4× CPU slowdown. With the work scene, running timer and
customizer open, 80 redraws gave a 95th percentile of **9.9 → 1.3 ms** for 20 jobs/200 memories,
and **10.8 → 3.6 ms** for 1,000 jobs/10,000 memories. Ten unchanged redraws went from 20 customizer
body replacements to zero. Six timer ticks no longer replace the pinned board. A deterministic
8-second carousel observed **0 → 2** transitions over 20 seconds of per-second updates.

In 2,000 additional redraws, GC-retained JS heap moved about 1.75 → 1.80 MiB; listener count stayed
44 and DOM nodes stayed 960 apart from a transient three-node animation. These are synthetic local
observations, not browser RSS, GPU/power measurements, a real low-end-device score, a long-running
leak guarantee or native WebView acceptance. Generated harnesses/results remain under ignored
`validation/performance-review/`; the committed browser and unit regressions are reproducible.

## Harness reliability repairs (2026-10-13 JST)

The [reliability repair record](HARNESS-RELIABILITY.md) links the changed behavior
and remaining Windows/macOS work. The focused Node run passed **63 tests** across
runtime, reliability, computer boundaries and evaluation. The native host also
checks actual repository instruction loading, change/deletion notices and failed
schedule recovery against its real Workspace owner. The computer regressions use
synthetic surfaces/CDP transport; they do not establish real desktop acceptance.

Final Linux gate and separately completed stages:

| Check | Result |
| --- | --- |
| Shared Rust core | 137 passed |
| Native service / CLI | 551 + 2 passed |
| V3 Node suite | 666 passed, 4 failed, 0 skipped; failures are the 3 Chromium tests and 1 bwrap test below |
| JavaScript syntax | 256 modules passed, plus root script checks |
| Python worker contracts | 13 passed |
| Root entry/release/CI checks | 11 passed |
| Local capability integration | 5 / 5 passed |
| Preview build | passed |
| Specification traceability | 100 references checked; 94 partial and 6 not implemented, not 100 successful user journeys |

`npm run quality` exits nonzero at the Node stage because of the four environment
failures. Its source fingerprint stayed stable during the run. The Python,
traceability, preview, capability and root stages were then run separately, with
successful exit codes. Generated logs and the combined local evidence are under
`validation/loop/` and `validation/harness-reliability/`; this evidence-only QA
update follows that gate run.

The Linux cloud environment cannot currently launch sandboxed Chromium (its SUID
helper is not configured for this container), and bwrap cannot establish its UID
map (`Read-only file system`). These failures are retained in the standard gate;
no sandbox is disabled and no failing assertion is skipped. Full quality success,
real-model scores and Windows/macOS AX/UI Automation acceptance must not be inferred
from the passing deterministic regressions. When using a shared Cargo output
directory, set `TEPORA_NATIVE_SERVICE_BINARY` to the built executable for the
native-process HTTP tests.

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

The Windows package startup failure at `7804be9c` passed the regression matrix,
Node tests and NSIS installation, but the native host reported every unexpected
backend termination as exit 0 and discarded startup stderr. The native gate now
imports the installed service without starting it, retains bounded backend
startup errors and the real failure status, and writes failure evidence even
before readiness. Import success is not native startup acceptance: the same
installed-app readiness and 25-second liveness assertions still run. The exact
Windows diagnostic run `38924273866` then proved the installed imports succeeded
(including the SDK manifest and native addon), while Node 22.22 failed before
entry execution with `EISDIR: lstat 'D:'` in its main-file resolver. This matches
[Node's Windows verbatim-path issue](https://github.com/nodejs/node/issues/61165).
The Tauri launcher now passes lossless `Path` arguments through
`dunce::simplified`, which removes the disk verbatim prefix only when ordinary
Win32 semantics are identical. UNC, reserved names and long paths are retained,
and the inherited cwd is unchanged. Release-mode launcher unit tests cover those
boundaries in package CI; a pipe-backed entry fixture also covers spaces,
Unicode and dependency imports. The final installed-app CI still provides
the acceptance evidence; these fixture checks alone do not establish a pass.

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

## Native ordinary doctor system facts

The [doctor fact gate](RUST-DOCTOR-FACTS.md) injects OS/architecture labels, memory/CPU results, zero/error responses, page arithmetic overflow and sysctl output lengths. A separate real HTTP test compares the source host and both explicit native modes with Node's local OS facts, using isolated data and an empty native executable path. It preserves the native marker/note and verifies repeated reads. This verifies local facts only; real model/GPU/provider/account checks, broader policy/security suites and exact-head Windows/macOS package acceptance remain separate.

## Redundant SQLite writes

See [write-budget evidence](DISK-WRITES.md) for focused same-value, index-order/repair, rollback/restart checks and isolated baseline comparisons; the FTS and document candidates are explicitly excluded. Logical/WAL writes are not physical NAND wear. These checks do not establish whole-application performance or full platform/quality acceptance.

## Bounded history paging and context snapshots

The [history-window gate](HISTORY-WINDOWS.md) compares SQL-bounded before-pages and native context snapshots with the previous full-read behavior, including legacy header overrides, checkpoint/clear/tool ordering, JavaScript limit coercion, older-client writes and reopen. A synthetic real-HTTP Node fixture checks public projections and the 500-entry cap without external networking. The sparse compatibility index has a one-time construction cost and an append predicate cost; see the focused measurement recipe and limits. These checks do not establish full quality or platform acceptance.

## Shared model-dispatch accounting (2026-10-08)

The ordinary Node host now uses the same bounded Rust receipt/estimate/aggregate
store as the opt-in native host. The focused local gate passed **43 Node tests**
(15 new accounting lifecycle tests plus compaction, usage UI and frozen protocol
compatibility), **10 shared-core tests**, and **13 native accounting tests**.
The new Node tests exercise actual network admission and provider decoders with
socket-free synthetic transport, plus loopback HTTP through the normal server and
agent. They verify receipt and legacy-session stats survive normal and compaction
updates, partial/zero/missing usage, unknown prices, cache categories, retry and
fallback attempts, typed-decision failure/cancellation, rollback without model
resend or a later provider-retry timer, and shutdown persistence across reopen.

The shared-core gate additionally checks bounded content-free metadata, Unicode,
UTC completion-day boundaries, retention and deduplication, transactional rollback,
and raw reported usage before legacy diagnostic normalization. Only existing
Cargo targets and temporary test databases were used. No external provider calls,
paid inference, model installation, broad boundary/security suites, full quality,
or Windows/macOS package acceptance were run. See [coverage and recovery limits](RUST-MODEL-USAGE.md).


## Windows CI startup and stage budgets (2026-10-16)

The native-service Rust stage now has a separate 300,000 ms budget for test-target compilation and execution. At `f4d95e9e`, the separate native job successfully used 57.02 s for compilation plus 135.13 s for the 512 unit tests, while the regression gate terminated the same stage at its former 180,000 ms outer limit. Node has a 480,000 ms aggregate budget; other stages retain 180,000 ms.

Both Windows Node gates explicitly run one test file at a time, reducing contention between synchronous SQLite fixtures and cold browser startup. Assertions, test selection, skips and the 120,000 ms file timeout are unchanged. Startup failures now close the partial DevTools connection and kill and reap their owned browser process before a retry can reuse its profile; an unreaped process blocks a new launch. The production 20-second startup deadline is unchanged.

Focused process/clock fixtures cover shared starts, fragmented readiness, startup timeout, failed handshake, spawn/exit errors, cleanup, profile reuse and an unresponsive process. Stage fixtures cover the measured Rust duration and bounded termination. These fixtures do not replace full Windows/macOS/Linux CI, real browser startup or package installation/startup evidence.

Windows also sets `RUST_TEST_THREADS=2` in both gates. An unchanged native integration fixture hit its existing 10-second completion wait while 511 other Rust tests passed in the first validation run; bounding simultaneous independent SQLite/runtime fixtures limits competing host work without extending behavioral deadlines or changing runtime code. Full platform CI remains the acceptance check.

The first two-file Windows replay passed delegation, the first compaction fixture and all three browser fixtures, but deterministic fallback reached only step 17 of 18 within its unchanged 30-second deadline. The Node stage reached 592 tests before its former 360,000 ms aggregate limit. The serial Windows replay therefore has a bounded 480,000 ms Node budget, a 10-minute native Node step and a 20-minute regression job budget. All inner behavioral deadlines and assertions are unchanged; the longer outer bounds do not turn an individual failure into a pass.


## Windows aggregate Node budget (2026-10-17)

At `6c86be0`, the [Windows regression job](https://github.com/coco4atJP/Tepora-alpha/actions/runs/39056142303/job/117464658538) stopped the serial Node suite at **480,013 ms** under its 480,000 ms aggregate limit. The diagnostic log showed successful tests through test 921 and no TAP failure blocks before the cutoff. The [same commit's native Windows job](https://github.com/coco4atJP/Tepora-alpha/actions/runs/39056142275/job/117464627868) completed the full serial Node suite successfully from **18:07:24 to 18:15:58 UTC (514 seconds)** within its existing 600-second step budget.

The aggregate Node budget now matches that 600,000 ms bound. The 120,000 ms individual file deadline, test selection and assertions, and the 20/40-minute workflow limits are unchanged. Stage fixtures simulate the measured 514-second success and retain bounded termination plus the 1.5-second kill grace. These fixture checks do not replace the complete regression and package CI matrices.


## Browser shutdown and Windows profile cleanup (2026-10-16)

At `933a7b7b`, the Windows regression Node suite completed inside its 480,000 ms budget but failed a browser fixture's after-hook with `EBUSY` removing `browser-profile/lockfile`. The same commit passed the native Windows/browser/package job. This is separate from the earlier stage-budget and failed-start repairs.

Each owned browser process now records its `close` event immediately after spawn. Graceful shutdown captures that process and connection before page/CDP teardown, shares one shutdown barrier, and waits for closed stdio rather than treating `exit` or a successful kill request as completion. After a five-second graceful window, it may request SIGKILL, but still waits up to five more seconds for actual close. An unreaped process rejects shutdown and retains ownership. A concurrent start waits for shutdown, and shutdown cancels pending startup/handshake waits without allowing late readiness to publish a connection.

Deterministic lifecycle fixtures separately exercise exit and close, including an exit before the CDP response, delayed close after SIGKILL, repeated close/start, stale callbacks, failed kill/reap and canceled startup/handshake. The real browser fixture also uses native recursive-removal retries (`maxRetries:5`, `retryDelay:100`) for transient Windows handle release; persistent cleanup errors still fail the hook. Existing browser actions, assertions, behavioral deadlines, test selection and CI budgets are unchanged. Focused lifecycle fixtures are not a substitute for the full Windows regression and native installation/startup jobs.
