# Tepora 3.0.0-beta.11 — QA

## Real-model acceptance benchmark

The selectable matrix also includes MiMo V2.6 Flash and Muse Spark 1.3 Contributor. MiMo uses Chat Completions; Muse uses Responses, including native tool-call replay and nested streamed usage accounting. Their current Go endpoints and SDK round trips are covered by the deterministic regression; their actual API results must be recorded separately.

The [benchmark method](BENCHMARK.md) covers 22 basic behaviors with explicit cloud consent, real Pi SDK registrations and Jev-selected Computer Use actions. It is separate from `quality:full`: local fixture success does not imply real-provider success. Results record source fingerprints, independent exact oracles, latency, provider response log IDs, known/unknown usage and missing capabilities. Initial manual-protocol pilot runs are exploratory evidence and do not certify the Pi path. The corrected connection audit verified actual Pi native responses for all three requested models; the user supplied matching Console Logs evidence (2026-10-21 11:21 JST, three HTTP 200 requests). Ongoing provider failures remain separate from registration correctness. The new deterministic OpenCode regression exercises real SDK login, account refresh, three current model IDs, credential/session/client headers and native reasoning/tool-result continuation without external inference.

## macOS signing and current browser gates

`npm run build` now requests a complete ad-hoc macOS signature instead of leaving
the linker signature on an unsealed app. Hardened runtime remains enabled; the
entitlements allow V8 JIT and the separately signed Rust addon. Tauri applies
the file to its executable signing targets. Developer ID signing can override
the default with `APPLE_SIGNING_IDENTITY`; Apple notarization credentials and
a valid signing identity are separate release requirements. Ad-hoc signing does
not establish a notarized, Gatekeeper-approved public distribution.

The [post-build verifier](../scripts/verify-macos-bundle.mjs) checks the complete
resource seal with `codesign --verify --deep --strict`, verifies the Node/addon
signatures, then executes V8 and loads the actual addon without opening user data.
The macOS CI smoke applies the same verifier to the installed copy from the DMG.
A [macOS regression](../tests/macos-signing.test.mjs) signs a temporary real app,
accepts it, and rejects a subsequent resource modification; it skips other OSes.
Native addon/runtime staging replaces files atomically rather than rewriting
an executable inode, preserving mapped bytes and avoiding stale macOS signature
state during debug/release switches. A failed copy preserves the prior binary.

The Computer Use gate exposed Chrome's macOS updater retaining stderr after the
browser itself exits normally. Shutdown still waits for `close` before releasing
the owned profile, with a bounded 30-second drain for an already exited process;
the live-process kill bound remains five seconds. Clock-driven lifecycle tests
cover the extra drain and retain the existing blocked-restart/failed-kill checks.

The routing E2E saves and reopens the current Computer Use form. The lamp E2E
waits for the asynchronous weather subtitle. The capability E2E uses unambiguous
accessible button names and both current OAuth entry points, requiring preview
authentication rejection without network authentication requests or fake panels.
Native inspection also exposed stale legacy permission rendering in Settings;
the switch now displays the effective network policy, matching the provider
dialog. Routing E2E covers both enable and disable without changing policy defaults.
The gate remains `npm run quality:full`; set `PYTHON` to a Python environment with
Playwright and `CHROMIUM_PATH` to an installed Chrome when needed. These local
browser/model fixtures do not certify real OAuth accounts or paid model quality.

Local macOS arm64 native inspection on 2026-10-21 JST used the signed release
Tauri app and its actual WebView, with the existing Accessibility/Screen Recording
permissions. Home, Settings and the provider dialog rendered and accepted native
Accessibility actions. Both permission switches agreed without changing their
values. At a 390×844 native window, the composer, bottom navigation and connection
controls remained visible; the window was restored to 1440×960 before Command-Q
exited with code zero and empty startup stderr. Screenshots and AX snapshots were
recorded separately from Chrome E2E. This is scoped screen/launch/exit acceptance,
not real-account login, microphone/audio, full-screen or long-duration acceptance.

## Compatibility-host input and download regressions (2026-10-21 JST)

The ordinary Node/Tauri service creates attachment copies exclusively, retrying
only filename collisions. Parallel same-named uploads and later attachments
retain distinct files and their original bytes. Concurrent retries with the
same request ID share preparation and delivery; successful receipts retain the
existing 500-entry service-local cache. Failed preparation releases the ID for
an explicit retry. This cache does not establish deduplication across restarts.

[Input admission fixtures](../tests/input-admission.test.mjs) exercise the real
authenticated HTTP routes, SQLite transcripts and temporary files with a
synthetic model boundary. They cover parallel filenames, existing-file
preservation, concurrent/later retries and recovery after a filesystem failure.
[Session download fixtures](../tests/session-files-http.test.mjs) reject file
and directory links outside the canonical session root, preserve internal links
and linked roots, and retain empty-file, directory and 50 MB bounds. Windows
directory cases use junctions without requiring file-symlink privileges; direct
file-symlink cases run on Unix. Downloads check the opened file and enforce the
byte limit while reading before publishing a successful response.

The [runtime budget fixtures](../tests/rust-runtime.test.mjs) now pin same-day
rechecks to UTC noon. A separate 23:55-to-00:05 case verifies that a daily-budget
wait resumes on the next UTC day without raising the limit. The prior real-time
fixture could fail during the ten minutes before UTC midnight. These fixtures
use no real provider account, paid inference or user data; cross-platform CI and
installer acceptance remain separate checks.

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


## Browser shutdown and Windows profile cleanup (2026-10-16)

At `933a7b7b`, the Windows regression Node suite completed inside its 480,000 ms budget but failed a browser fixture's after-hook with `EBUSY` removing `browser-profile/lockfile`. The same commit passed the native Windows/browser/package job. This is separate from the earlier stage-budget and failed-start repairs.

Each owned browser process now records its `close` event immediately after spawn. Graceful shutdown captures that process and connection before page/CDP teardown, shares one shutdown barrier, and waits for closed stdio rather than treating `exit` or a successful kill request as completion. After a five-second graceful window, it may request SIGKILL, but still waits up to five more seconds for actual close. An unreaped process rejects shutdown and retains ownership. A concurrent start waits for shutdown, and shutdown cancels pending startup/handshake waits without allowing late readiness to publish a connection.

Deterministic lifecycle fixtures separately exercise exit and close, including an exit before the CDP response, delayed close after SIGKILL, repeated close/start, stale callbacks, failed kill/reap and canceled startup/handshake. The real browser fixture also uses native recursive-removal retries (`maxRetries:5`, `retryDelay:100`) for transient Windows handle release; persistent cleanup errors still fail the hook. Existing browser actions, assertions, behavioral deadlines, test selection and CI budgets are unchanged. Focused lifecycle fixtures are not a substitute for the full Windows regression and native installation/startup jobs.
