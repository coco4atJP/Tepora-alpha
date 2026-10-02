> Historical Earlier V3 beta document. The current release is **3.0.0-beta.11**; use the [current guide](../../../README.md). This record does not describe the default application.

# beta.10: one character, asynchronous workers

The conversation belongs to a persistent character session. Opening a job or an artifact changes
only the detail view, never the person you are talking to or the destination of a draft.
Short replies and clarification stay in the foreground chat lane. Real work is delegated to
independent work slots with separate persona snapshots and bounded handoff context.

## Boundaries

- Character and worker names/instructions are configured separately. ProviderRegistry's chat and
  work roles still select their respective model routes. Editing a persona does not rewrite jobs
  that already captured a persona version.
- The session, user turns, character replies, worker notifications, request receipts and pending
  questions are stored in SQLite. Worker question answers target an exact job/question/revision.
- Worker handoffs carry explicit task text and provenance, not the full character transcript.
  Isolated workers cannot automatically recall unrelated global memories or search old chats.
- Worker events are untrusted reports. A returned artifact is not accepted or independently
  verified merely because a worker says it finished. Existing tool receipts, effect approvals,
  consent epochs, uncertain-operation checks and review states remain authoritative.
- A character may inspect its linked work through a bounded status/result interface. Result text
  is recipient-scoped; moving it to a different model requires explicit consent. Raw tool logs
  are not copied into the foreground dialogue context.
- Voice remains user-started. Optional end-of-recording send is explicitly enabled for the
  character destination; final recognition only, never partial transcripts.

## Migration and scope

beta.9 navigation/focus, old jobs and old transcripts remain available. They do not silently become
new character history, resume, or receive new permissions. Legacy memories retain their current
confirmed/private/shared properties, but are not automatically injected into either new role. There is no automatic V2 CHAR/PROF memory or config import.
This is a meaningful V3 persona/context split, not a claim that every V2 character feature has
been ported. The default character name can be taken from the existing V3 companion setting.

The source keeps optional Codex and other execution integrations, but beta.10 development and
validation use injected local model/ASR fixtures only. No paid inference is part of these tests.
Context exports include the current dialogue and persona configuration. Importing restores these
as read-only archives, never as an active conversation, pending question or sharing grant. Old
jobs stay interrupted and resume-blocked through the existing import safety rules.

Cross-recipient handoff sends the current explicit user utterance and selected attachments only;
a model-written purpose/check list from older dialogue is not silently forwarded to a new model.
For requests that rely on unshared past context, the character/worker must clarify scope rather
than assume access. Explicit question replies are separately bound to that worker revision.

See [STATUS.md](../STATUS.md) for the exact tested and unverified boundaries.
