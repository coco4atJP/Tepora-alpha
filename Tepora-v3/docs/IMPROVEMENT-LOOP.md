# Regression and improvement loop — beta.11

The loop checks changed source and records evidence. It does not automatically edit code, install runtimes, download models, call paid providers or count repeated passes as improvements.

From the repository root:

```sh
npm run quality
npm run quality:full
```

From `Tepora-v3/`:

```sh
npm run improve:check
npm run improve:watch
npm run improve:browser
npm run improve:full
```

The standard V3 loop runs syntax, Node regressions, the home evaluation, isolated Python contracts, scenario traceability and preview generation. The root quality command additionally enables deterministic capability integration and tests the root entry points/release helpers. `--watch` rechecks only after source bytes change; Ctrl+C stops it.

The `home-evals` stage (`node scripts/eval-home.mjs [--hosts node,native] [--out DIR]`) replays three days of home life from `evals/home-days.json` on the Node host and the Rust host through their real HTTP routes: synthetic utterance audio is uploaded to `/api/voice/transcribe`, the transcript goes to `/api/agent/input`, and the reply becomes a speech job. A scripted model, a fake transcriber (it recognises each synthetic waveform by digest) and a fake speech engine answer on loopback and charge simulated costs, so wake→first-audio is deterministic and grows with every extra model round. The host restarts between days. The run records cross-day recall through long-term memory (and whether the fact was already in the request context), barge-in (the client stops a reply mid-stream, then speaks), and unsolicited model calls or messages during quiet time. Any failure, a latency over budget, or any difference between the hosts on these figures stops the gate; the Node host is the oracle. Wake detection is simulated, no real speech recognition runs, and proactive appropriateness is a placeholder until it exists. It measures mechanisms, not model or speech quality.

Optional `--browser`, `--computer` and `--capabilities` add installed-browser UI tests, controlled browser actions and actual harness/local HTTP capability fixtures. Browser tests require an existing Python Playwright package and Chromium. `PYTHON` and `CHROMIUM_PATH` can select executables; there is no automatic dependency installation.

Each run records before/after source fingerprints, stage exit status, elapsed time and logs under `validation/loop/`. Source changes during a run prevent a stable pass; a failed stage stops later gates. Generated output, caches and native resources are excluded from fingerprints. Windows uses bounded Node test diagnostics without converting hangs into success.

beta.11 regressions cover sourced context, destination/revision checks, execution boundaries, capsules, serialization, staged candidates, promotion, operation uncertainty and restart behavior. Deterministic executor fixtures test the protocol and state transitions, not OS isolation. The optional approved real-container smoke is separate from default checks.

The original 100 scenarios remain **1 mechanism-tested / 93 partial / 6 not implemented**. Model quality, real speech/GPU performance, paid providers, Docker isolation and native installations require separate evidence. See [QA](QA.md) and [STATUS](STATUS.md). Earlier development ledgers are available through Git history.
