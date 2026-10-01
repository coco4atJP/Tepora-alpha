# Beta.6 — First-use loop and regression fixes

Baseline: the user-visible, delivered beta.5 source ZIP. This work does not assume that
unpublished intermediate Git objects are the current remote branch. V2 is untouched.

## User-visible changes

- A guided starting surface discovers local AI without asking for URL/model strings.
- With an existing running Ollama, a fixed model can be downloaded only after consent.
  Progress, cancellation and retry are explicit; shared models are not deleted. A safe
  tool-use round trip must pass before the new connection replaces existing settings.
- First success is a non-demo artifact the person accepted, not a model-list response.
- Up to six selected UTF-8 source files can be attached and removed from the draft.
  Originals stay untouched. Content is not sent at upload time; external/Codex targets
  require a destination-specific confirmation. Model access is per-job and hash-bound.
- Requests have persistent identity. Lost acceptance replies can be retried without a
  second job; known failure and uncertain receipt have different messages.
- Shared display hides attachment names, errors and drafts. Closing setup preserves input.
- Input copies are not treated as produced artifacts. Truncated ordinary JSON completions
  are not accepted. Saved external URLs no longer prevent revocation of their permissions.

## Development loop

`npm run improve:watch` re-runs gates only on actual source changes and records exact-source
logs. It is a repeatable verification loop, not a code-editing agent. Code changes in this
turn were performed and checked explicitly. See IMPROVEMENT-LOOP.md for actual red/green cases.

## Verification boundary

The final per-stage counts, hashes and exit codes are in the accompanying verification
archive, not inferred from older versions. Node tests perform real HTTP, SQLite, process and
filesystem work with scripted model responses. Python worker tests use mock decoders/models.
The browser uses the explicit offline preview; no real inference is simulated as a success.
Full Windows/macOS installer, real GPU/model, ASR quality and competitor comparisons remain
unmeasured. All 100 fictional scenarios retain their specific uncompleted acceptance work.

## Open scope

Runtime installation itself remains a one-time OS step; the app may open a fixed official
vendor download page but does not silently install executables. Model downloads are currently
Ollama-only and catalog-bounded. Candidate storage/RAM labels are not speed/quality promises.
PDF, Office and image attachment ingestion are not implemented. Attached source contents are
kept in the local database, are not yet part of context export, and are not erased by forgetting
an unrelated memory. Native automatic updates, resource reservation, complete Computer Use,
OAuth service onboarding, true host sandboxing and complete uninstall remain incomplete.

Laya multilingual, Codex, routines, plans and local dictation from beta.5 are retained. Their
real inference quality is not certified by additional setup or transport tests.

No GitHub write/branch update or remote CI execution was performed in this turn. Release
source ZIP, preview, patch and local verification evidence are the verified deliverables.
