# beta.5 release ledger

## Intent
Keep the quiet, customizable smart monitor. Strengthen actual delegated work rather than adding
permanent dashboard controls. The goal is competitive quality, not an unmeasured performance claim.

## Changes from the verified beta.4 archive
Codex App Server adapter; routine scheduler; dependency plans; declarative verification and repair;
bounded context/evidence retrieval; CJK FTS5 and skill proposals; local dictation editing; real model
protocol readiness probe; workspace file access; new controls and regression tests.

## Verification basis
Node tests exercise actual local HTTP, filesystem and SQLite plus deterministic model fixtures.
Codex protocol tests spawn a deterministic server process, not the Codex product. Worker tests use
stub ASR/Laya. Browser checks use system Chromium with the explicit offline preview because live
loopback browser navigation is blocked by administrator policy; the policy was not changed.
Actual model/GPU/ASR accuracy, actual Codex authentication and native platform behavior are not
established by these results. The eight-case opt-in eval runner is shipped but not run on a model.

## Findings repaired during this iteration
- Restrict tool dispatch by the actual execution lane, not just by global tool-name recognition.
- Separate history by execution destination rather than by a single cloud/local boolean.
- Keep acceptance checks as fixed task state and feed their failures back into bounded repairs.
- Reject a successful command receipt after its workspace files change.
- Coalesce routine catch-up and retain a deterministic run ID across the submit/save crash gap.
- Queue Codex notifications/approvals that arrive before turn/start replies.
- Bind external approval responses to the owned thread and turn; decline unsupported escalation.
- Preserve original text/revision in local semantic dictation; never expose execution tools.
- Revalidate imported scheduling/plan data before activation.
- Stop future schedules as well as current tasks during the global stop operation.

## Scope still open
No finished turnkey model installation, full Computer Use, arbitrary third-party widgets,
full per-user encrypted profile system, Hermes ACP, complete OAuth catalogue or complete uninstall.
None of the four competing products has been benchmarked head-to-head here.


## Final local release checks
129 JavaScript tests and 13 Python worker contract tests passed. No real model was called.
The source archive is reopened, its file digests checked, and its extracted source re-tested.
The browser checks cover the real shipped no-AI preview, not the blocked live loopback WebView.
Additional fixes: late notifications cannot change a failed external turn into completed;
external evidence is bounded; failing approval UI is explicitly declined; deep unobserved source
files cannot be certified by a partial command-check snapshot. Successful command checks name
source-snapshot exclusions instead of claiming to validate the whole dependency environment.

## Publication state
The GitHub connector's create_tree safety check blocked publication in this turn. The existing
remote branch was not updated, and no beta.5 CI/native build result is claimed. The source ZIP
contains the native CI workflow alongside the source for normal repository integration.
