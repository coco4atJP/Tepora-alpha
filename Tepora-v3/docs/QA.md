# Current beta.9 verification

Source baseline: the provided beta.8 distribution, with the remote-only browser_check.py retained.
See [BETA9.md](BETA9.md) and [architecture](ARCHITECTURE.md).

Fresh validation on 2026-09-30, after final code changes:
- `npm test`: 347/347 passed (including 46 frontend/capture/routing tests)
- `npm run check`: 85 JavaScript modules passed syntax checks
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
