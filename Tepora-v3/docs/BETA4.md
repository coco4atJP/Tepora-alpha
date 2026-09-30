# Beta.4 implementation ledger

## Baseline
- Repository: coco4atJP/Tepora-alpha
- Target branch: v3.0-beta/companion-os
- Verified remote starting commit: ad06f14b8fb6ff823c461b3cf7e1743a00013183
- This build does not assume that earlier beta.2/beta.3 conversational claims were saved.
- V2 sources and its quality gates are not rewritten by this change.

## Source-of-truth
The source tree, test files, versioned scenario map and CI results are authoritative.
The generated HTML preview is not an inference implementation and never claims that it is.
The original 100-scenario JSON is losslessly archived in spec/ with its digest.

## Verified locally before publishing
- Node JavaScript tests: 78 passed, 0 failed (model responses and speech decoders are fixtures).
- Python worker tests: 13 passed, 0 failed; no model download or GPU inference.
- Browser preview: default home, display customization/undo, shared-draft visibility,
  retained iframe across task updates, three artifact revisions, desktop and 390px layouts.
- The implementation map has 100 unique scenario IDs. Every evidence path exists.
- Real model/ASR quality, native behavior on the user's machines, and full journeys are not certified.

## Important fixes
1. Independent conversation/background scheduling now includes actual delegation.
2. Work is checkpointed rather than discarded at a step limit.
3. New instructions cancel stale reasoning and invalidate old approvals.
4. Unknown side effects require review, not automatic replay.
5. Workspaces are per task; artifacts require an exact base revision before an existing artifact is edited.
6. Model self-declared completion is review state; user acceptance is version checked.
7. A second service cannot mark the active service's tasks interrupted.
8. Memory retrieval/export no longer loses the 1,001st and older entries.
9. Memory events avoid durable copies of the full memory body.
10. Display changes cannot alter runtime/network/credential permissions.
11. Shared display now hides a private draft as well as documents and notifications.
12. Input occupies its own layout row rather than obscuring artifact controls.
13. Pinned artifact browsing contexts survive unrelated status updates.
14. Late speech cannot overwrite manual edits; quoted text is not automatically executed.
15. Audio chunk identity and sequence are checked on both sides.
16. Laya is multilingual, bounded, local and advisory.
17. Shared skills require explicit discovery/enabling and retain a task-local version.
18. Revocation stops current work and prevents resending its old permitted context.
19. Native close/hide and explicit Quit are separate.
20. v2 context import is transactional and cannot automatically execute imported work.

## What must not be claimed
Not a finished plug-and-play AgentOS. No actual Laya/ASR/GPU benchmark was executed here.
No semantic free-form voice editor, managed runtime/model installer, true sandbox, autonomous
scheduler, full OAuth service catalogue, Computer Use or Codex App Server integration exists yet.
No comparison establishes that Laya is more accurate than DiffusionGemma/Jev on Tepora tasks.
No test count is presented as a count of PDCA cycles.

## Release policy
Only exact tested source bytes should be pushed. New failures must be fixed or reported, never
hidden by weakening tests. Existing legacy V2 CI failures are reported separately.
