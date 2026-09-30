# Improvement loop — beta.6

The loop is about fixing a person's blocked task, not generating more review tables or
counting repeated test runs as improvements. The supplied sharp-perspective skill was used
as an internal viewpoint, not as a second independent evaluator and not as a production persona.

## Run it

```
npm run improve:check
npm run improve:watch
npm run improve:browser
```

`improve:watch` waits for a change in source bytes and runs the gates again. Ctrl+C stops it.
It never edits source, downloads models, accesses accounts, sends messages, or calls paid APIs.
`improve:browser` needs an installed Python Playwright package and Chromium. `CHROMIUM_PATH`
and `PYTHON` may choose their local executables. Without browser support use the normal gate;
its report explicitly records that the browser was not run.

Each run records the before/after source hash, stage exit status, elapsed time and logs. A
source modification during a run prevents a stable PASS. Failures stop the remaining gates.
The native workflow uses this same gate before its existing Windows/macOS build/smoke stages.
This archive is not a claim that GitHub executed that workflow.

## Actual work loops in this change

1. **First-use obstruction:** beta.5 opened a connection/settings form, not an end-to-end
   first task. Implemented local discovery, consented model acquisition through an existing
   Ollama service, protocol probe before activation, explicit source selection and an intent
   receipt. The HTTP integration test exercises acquisition → probe → source read → artifact
   → user acceptance with a clearly labelled scripted model. That is mechanics evidence,
   not real-model quality evidence.
2. **Truncated result accepted:** a non-streaming completion with `finish_reason=length`
   was accepted. Added a failing regression, then validated finish reason, type/size limits
   and JSON/SSE bounds. See `loop1-red.tap`, `loop1-green.tap` and later consolidated runs.
3. **Revocation did not work:** turning off cloud/feed access failed while their saved
   remote URLs remained configured. Added two failing regressions, then separated saving
   an unchanged URL from permission to use it. Execution still rejects the revoked access.
   See `loop3-red.tap` → `loop3-green.tap`.
4. **Known rejection looked like unknown delivery:** the preview refused inference, but
   the input UI called this an ambiguous network outcome. Fixed transport error status and
   draft/attachment retention. Verified desktop and mobile screens; no fake AI output.
   See `loop4-ui.log` → `loop4-ui-green.log`.
5. **Source material masqueraded as a result:** Codex input copies could be auto-published
   and satisfy an artifact-existence condition. A failing real-filesystem test reproduced
   this. Reserved `inputs/` is excluded from produced-document publication; the new output
   file remains discoverable. See `loop5-red.tap` → `loop5-green.tap`.

The final source receives a full gate, then the release ZIP is extracted and checked again.
The source and evidence archives contain the exact files needed to repeat these checks.

## What this does not prove

No real Laya/Qwen/Codex inference or end-user study was run here. Download tests use a
scripted loopback provider, not a multi-gigabyte model transfer. Installed engine discovery
and model acquisition must still be exercised on real Windows/macOS machines. Browser
loopback navigation was denied by environment policy, so explicit offline UI checks and
real Node HTTP tests remain separate. No policy was removed to obtain a green test.

## beta.7 extension

The current loop adds `--computer` / `npm run improve:full` for **installed** Python/Playwright and
Chromium. It never installs dependencies or pulls model weights. `--browser` now includes provider,
network-mode, image-attachment and scoped Computer Use settings. Standard gates include provider/
network/vision/rebind/recovery and Computer Use controller contracts without requiring a browser.
Real controlled-browser actions are a separate optional stage with model and decision fixtures.

Reproduction/fix details for this release are in `BETA7.md`. In particular, retain the failed provider
form UI trace and async-compute trace next to the successful reruns. All browser policy limitations
remain; no administrator policy is disabled to obtain a pass.


## beta.8 extension

`npm run improve:full` additionally runs the new abilities UI and the actual-harness/local-HTTP
capability scenario. Readout/image output and embeddings in that scenario are deterministic
fixtures. The stages do not access accounts or incur provider costs. New regressions cover
late memory/privacy updates, media receipt identity, queued MCP startup after stop, typed action
selection, managed login cancellation and API-key-vs-subscription detection. Tests are distinct
from a benchmark of language understanding or a full-loop autonomous code improver.
