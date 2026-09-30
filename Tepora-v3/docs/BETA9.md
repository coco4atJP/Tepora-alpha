# Tepora V3 beta.9 — one conversation across ongoing work

## This milestone

The improvement is an addressing and continuity layer, not a collection of shortcut keywords.
The selected job is the shared focus for the visible reply, artifact and follow-up. A correction
updates the same durable job; an unrelated side task has its own lane and a return point. Returning
only changes what is in focus. The background job is not restarted and unknown actions are not replayed.

- Explicit Continue / New / Side remains the default and requires no classifier call.
- Optional natural-intent mode uses the configured focused model with bounded focused user context.
  It shows destination/privacy/cost scope once per route/permission scope. Clear proposals can use
  the same request path; ambiguous targets ask for clarification. There is no magic-keyword execution.
- The classifier cannot rewrite the instruction, choose an arbitrary job, change engine, approve a
  tool or introduce a provider. New/side jobs carry no automatic origin context or file access.
- A lost continuation response can be retried with the same receipt without appending twice.
  Instruction, user message and receipt are committed together; replay safety survives restart.
- Draft, focus and asynchronous voice results are pinned to revisions; new focus, edits, stopping
  or hiding cannot retarget a late result. Unknown sends retain their original body and receipt.
- Optional finalized push-to-talk sending follows the same guarded path. It is deliberately limited
  to an empty initial draft, no attachments and no dictation-edit mode; intermediate ASR results never
  dispatch. Existing action approvals still apply.

## Honest limits

This is not always-listening full-duplex voice, wake-word operation, trained natural-target quality
or a verified Samantha/Joi-equivalent experience. Cross-lane natural references require explicit
selection; the classifier sees only the selected lane. New attachments to existing tasks are not
supported. An uncertain or consequential operation still pauses for the existing approval/review.
The optional speech adapter can download missing model weights when manually started; that baseline
provisioning behavior was not changed. No ASR/model downloads or real paid API calls were run here.

Local deterministic fixtures test protocols, race behavior and persistence, not real ASR accuracy,
latency, native microphone permissions, learned intent quality or native Windows/macOS integration.
Cloud-browser loopback access was blocked by `ERR_BLOCKED_BY_CLIENT` on 2026-09-30; no browser security
setting was bypassed. Final fresh test results are recorded in STATUS.md and QA.md.
