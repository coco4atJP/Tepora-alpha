# Tepora 3.0.0-beta.11 — QA

## Standard gate

From the repository root:

```sh
npm run quality
```

The gate checks JavaScript syntax, all V3 Node regressions, isolated Python worker contracts, the original 100-scenario digest and source/test references, preview generation, capability integration with local deterministic providers, and repository entry points/release helpers. `PYTHON` selects an existing Python executable; otherwise Windows uses `python` and other systems use `python3`.

The V3 improvement loop records source fingerprints, exit codes, elapsed time and stage logs in `Tepora-v3/validation/loop/`. A source change during the gate prevents a stable pass. Generated output is excluded from source fingerprints. Windows test runs retain bounded hang diagnostics without masking failures.

Local integration evidence on 2026-10-02: **454 V3 Node tests**, **13 Python tests**, **102 syntax modules**, capability fixtures and preview build passed. All **5 repository cutover checks** passed separately in the root suite. [STATUS](STATUS.md) states the limits of these results.

## Additional checks

- `npm run quality:full`: adds UI and controlled-browser checks using already installed Python Playwright and Chromium; `CHROMIUM_PATH` can select a local browser. It does not install packages or models.
- `npm run test:scenarios`: verifies the preserved specification and writes traceability output; it does not certify real user journeys.
- `npm run test:capabilities`: runs actual harness/HTTP/SQLite/media bytes with deterministic local endpoints and zero external provider calls.
- From `Tepora-v3/`, `node scripts/check-executor.mjs --image repository@sha256:<digest> --approve-image`: optionally executes an explicitly approved preinstalled image to check non-root behavior, storage boundaries, absent sentinel/secret, interfaces and cleanup. No image pull is automatic. This is outside the standard gate.

## Native checks

`.github/workflows/tepora-v3-beta.yml` builds the current revision for Windows/macOS and records installation/startup evidence and screenshots. The bundled service must report the package version **3.0.0-beta.11**. The separate manual native-smoke workflow requires an explicit artifact run and matching exact commit; it has no defaults pointing at older betas.

Local macOS arm64 `.app`/DMG creation and bundled Node service startup passed during this cutover; the native WebView was not exercised. Native startup, screenshots and regression tests are different evidence. Do not infer real-model quality, microphone/ASR success, signed/notarized distribution or unattended reliability from service readiness. A configured workflow is not a successful remote CI run.

Earlier failure/reproduction records are available through Git history. They are historical evidence rather than current test counts.
