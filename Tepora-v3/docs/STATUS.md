# Current beta.9 verification

Source baseline: the provided beta.8 distribution, with the remote-only browser_check.py retained.
See [BETA9.md](BETA9.md) and [architecture](ARCHITECTURE.md).

Fresh validation on 2026-09-30, after final code changes:
- `npm test`: 348/348 passed (including 46 frontend/capture/routing tests)
- `npm run check`: 86 JavaScript modules passed syntax checks
- `npm run test:workers`: 13 isolated Python tests passed
- `npm run test:capabilities`: passed using deterministic local HTTP fixtures; zero external network calls
- `npm run preview:build`: passed; building HTML is not proof of rendered UI correctness
- `npm run test:scenarios`: catalogue consistency passed, with 100 cases classified as 1 mechanism-tested,
  93 partial, and 6 not implemented. These are not 100 passing end-user journeys

The tests execute actual Node/HTTP/SQLite/persistence and injected model/ASR protocol fixtures.
They do not establish learned-model quality, real ASR accuracy, voice latency, paid-provider behavior,
real Codex execution, Windows UIA, macOS microphone permissions, or native desktop packaging.

Rendered QA remains unverified: the dot cloud browser blocked loopback navigation with
ERR_BLOCKED_BY_CLIENT; local Chromium could not launch because socket creation was not permitted.
No browser security setting was bypassed. No real model, ASR model downloads or paid API calls
were used for this validation. Optional speech/server.py may download missing model weights when
manually launched; its provisioning behavior is unchanged.

SOURCE-SHA256.json covers source files, excluding itself, generated preview HTML, validation output,
Python caches, runtime databases, package caches and node_modules. start.command remains executable.

## Windows CI diagnostic follow-up

The first published beta.9 commit passed both macOS jobs. Both Windows jobs reached the
40-minute job limit after the reporter printed 260 successful tests, without a test failure
message or completed runner summary. The cause is not yet established.

Windows CI now adds opt-in worker lifecycle/resource-type logs and an eight-minute test-step
limit. The normal test discovery, assertions and concurrency are unchanged. The supported
Node test timeout bounds test execution; the separate CI step limit covers leftover handles.
There is no test skipping or force-exit success. This is diagnostic instrumentation, not a
claim that the Windows cause has been fixed. All 348 tests, including the added teardown regression, pass locally with this instrumentation.

## Restart fixture correction

The diagnostic Windows run identified an EBUSY failure in the network-policy restart test:
the original fixture tried to remove its directory before the reopened service had released
SQLite. The failed cleanup left an HTTP listener alive. The test now scopes the reopened
service in try/finally and closes it before the original fixture removes the directory.
A new real HTTP/SQLite regression deliberately throws an assertion, verifies that exact error
is preserved, and checks that the store/listener are closed before removal. No EBUSY errors
are suppressed or retried, and no assertions are skipped. The analogous direct Store restart
fixture already closes its reopened store before deletion.

The corrected source passes 348 local Node tests and 86 syntax checks. Its fresh Windows CI
result is pending; local success is not a Windows or native-installer success claim.
