# Current beta.10 verification

Baseline: published beta.9 commit `b6afa7d815d54f4772beca868b437eef5c9a44ac` on
`v3.0-beta/companion-os`. Its remote-only browser_check.py, Windows diagnostic workflow, corrected
restart fixture teardown, and executable start.command are retained. The beta.9 source manifest
matched before beta.10 changes. Main is not merged or edited by this milestone.

## Fresh validation on 2026-09-30

- Isolated Python workers: 13 tests passed
- Capability integration: passed, with deterministic local HTTP fixtures and zero external calls
- Scenario catalogue: consistency passed; 1 mechanism-tested, 93 partial, 6 unimplemented
- Full beta.10 Node suite: **408/408 passed**, including 28 dialogue service tests,
  8 independent dialogue regressions and 3 real HTTP dialogue/relay tests
- Syntax check: 93 JavaScript modules passed
- Preview build: passed; generated HTML is not proof of rendered UI correctness
- Independent final review: no remaining blocking finding; same 408 tests passed separately

The new checks cover persistent character identity across detail focus and service restart,
foreground responsiveness during worker execution, immutable persona snapshots, bounded handoffs,
no global worker memory/history, duplicate/revision-safe worker questions, cancellation and late
results, uncertain effects preventing resume, context/recipient changes, explicit bounded result
sharing, ordinary follow-up grounded in worker results, and read-only archive round trips.
Frontend tests cover persistent transcript, old question rejection, exact relay consent, focus
independence, uncertain-request retry, draft preservation and consented finalized PTT sends.

The final review caught an over-broad relay title and a missing-title fixture error; the fix
returns task titles only to the already-identical recipient, keeps cross-recipient grants limited
to the approved excerpt, and adds a dedicated independent regression. No failing test was skipped.

These execute Node/HTTP/SQLite/persistence and injected model/ASR protocol fixtures. They do not
establish trained-model quality, real ASR accuracy, voice latency, paid-provider behavior, real
Codex execution, Windows UIA, macOS microphone permissions or native desktop packaging.

Rendered QA is not claimed. Previously the cloud browser rejected loopback navigation and local
Chromium could not create its sockets; no security policy was bypassed. No real model downloads,
paid API calls or user-PC work are used. Optional speech/server.py provisioning is unchanged.

SOURCE-SHA256.json records the baseline, checkpoint, every included source digest and executable
mode. Generated preview HTML, validation output, caches, runtime databases, secrets, node_modules,
compiled Tauri resources and downloaded binaries are excluded from source fingerprints.
