# Tepora 3.0.0-beta.11 — QA

## Standard gate

From the repository root:

```sh
npm run quality
```

The gate checks JavaScript syntax, all V3 Node regressions, isolated Python worker contracts, the original 100-scenario digest and source/test references, preview generation, capability integration with local deterministic providers, and repository entry points/release helpers. `PYTHON` selects an existing Python executable; otherwise Windows uses `python` and other systems use `python3`.

The V3 improvement loop records source fingerprints, exit codes, elapsed time and stage logs in `Tepora-v3/validation/loop/`. A source change during the gate prevents a stable pass. Generated output is excluded from source fingerprints. Windows test runs retain bounded hang diagnostics without masking failures.

Local integration evidence on 2026-10-02 after the security fixes: **482 V3 Node tests**, **13 Python tests**, **103 syntax modules**, capability fixtures and preview build passed. All **5 repository checks** passed separately in the root suite. The 28 added security regressions cover private-address rejection, valid local integrations, context references, routine reactivation and UI form identity. [STATUS](STATUS.md) states the limits of these results.

A separate live Chrome check with bundled Node Playwright used temporary data, synthetic credentials and controlled local HTTP. Imported and older stored markup created no settings form; unregistered forms made no settings request. Real settings and conversation forms still worked. This check made zero external provider calls and did not exercise a native WebView or real model.

Local evidence on 2026-10-04 after the companion monitor and stacked-approval changes: **500 V3 Node tests**, **13 Python tests**, **122 syntax modules**, scenario consistency, preview build and capability fixtures passed, with all **5 repository checks**. The browser stages of `quality:full` (`browser-first-use`, `browser-routing`, `browser-capabilities`, `browser-capability-components`) and the separate `browser-preview.py`, `browser-agentos.py` and `browser_check.py` were updated to the current screen and passed with Python Playwright and the installed Google Chrome selected by `CHROMIUM_PATH`. The `computer` stage was not run.

Local evidence on 2026-10-05 after the one-lamp redesign (work lights and the amber lamp, window light, approval seals, screensaver-style idle screen, photo frame): **531 V3 Node tests**, **13 Python tests**, **132 syntax modules**, scenario consistency (1 / 93 / 6), preview build and capability fixtures passed, with all **5 repository checks**. `improve-loop --browser --capabilities` passed through `browser-first-use`, `browser-routing`, the new `browser-lamp`, `browser-abilities` and `browser-ability-components`, and `browser-preview.py`, `browser-agentos.py` and `browser_check.py` passed separately, all with Python Playwright and the installed Google Chrome selected by `CHROMIUM_PATH`. One `browser-agentos.py` run timed out while waiting for a saved routine card; seven full re-runs and seventy repetitions of the same steps, some under heavy CPU load, did not reproduce it. The `computer` stage was not run. [COMPANION-MONITOR](COMPANION-MONITOR.md) lists what these checks do not cover (native WebView, Wake Lock and full-screen behaviour in the desktop window, touch hardware, screen readers, long-running photo frames).

Local evidence on 2026-10-05 after the avatar foundation: **560 V3 Node tests**, **13 Python tests**, **163 syntax modules**, scenario consistency (1 / 93 / 6), preview build and capability fixtures passed, with all **5 repository checks**. `improve-loop --browser --capabilities` passed, now including `browser-avatar` (the real service, the studio, the solid 3D body, a VRM, a mesh project, a picture and a picture set made by `tests/fixtures/avatar-fixtures.mjs`; WebGL from a software GL, reported as skipped when a browser has none), and `browser-preview.py`, `browser-agentos.py` and `browser_check.py` passed separately, all with Python Playwright and the installed Google Chrome selected by `CHROMIUM_PATH`. The `computer` stage was not run. [AVATAR](AVATAR.md) lists what these checks do not cover (other VRM models, a real mesh-avatar-studio export, real GPUs and drivers, native WebViews).

## Additional checks

- `npm run quality:full`: adds UI and controlled-browser checks using already installed Python Playwright and Chromium or Chrome. The scripts use `CHROMIUM_PATH`, then `chromium` or `google-chrome` on PATH, then Playwright's own browser. It does not install packages or models.
- `npm run test:scenarios`: verifies the preserved specification and writes traceability output; it does not certify real user journeys.
- `npm run test:capabilities`: runs actual harness/HTTP/SQLite/media bytes with deterministic local endpoints and zero external provider calls.
- From `Tepora-v3/`, `node scripts/check-executor.mjs --image repository@sha256:<digest> --approve-image`: optionally executes an explicitly approved preinstalled image to check non-root behavior, storage boundaries, absent sentinel/secret, interfaces and cleanup. No image pull is automatic. This is outside the standard gate.

## Native checks

`.github/workflows/tepora-v3-beta.yml` builds the current revision for Windows/macOS and records installation/startup evidence and screenshots. The bundled service must report the package version **3.0.0-beta.11**. The separate manual native-smoke workflow requires an explicit artifact run and matching exact commit; it has no defaults pointing at older betas.

Local macOS arm64 `.app`/DMG creation and bundled Node service startup passed during this cutover; the native WebView was not exercised. Native startup, screenshots and regression tests are different evidence. Do not infer real-model quality, microphone/ASR success, signed/notarized distribution or unattended reliability from service readiness. A configured workflow is not a successful remote CI run.

Earlier failure/reproduction records are available through Git history. They are historical evidence rather than current test counts.
