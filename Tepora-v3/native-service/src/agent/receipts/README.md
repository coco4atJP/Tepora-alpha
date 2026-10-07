# Ordered tool-receipt planning

`plan_receipts_with_unicode` is the version-aware pure port of `AgentLoop.record`. It consumes already-ordered
ExecutionEngine calls/outputs, the live session stats, immutable tool metadata,
loop memory, context budget and a sequence reserved by the state owner. It does
not execute tools, run another reducer, or access SQLite. Both result fitting and
small-result retention use the supplied Unicode version, which must match the
host context/budget estimator. The `plan_receipts` compatibility wrapper uses
Unicode 16 for frozen Node 22 fixtures.

The owner must commit evidence documents, ordered tool entries and stats before
publishing `ReceiptBatch.memory` or applying each `read_result` to
`FileMemory::record_read(seq, result)`. This preserves recalled evidence IDs and
read-reference visibility without letting failed persistence create phantom
reads. The actor owns the stop/drain continuation permission.

The implementation preserves exact repaired/notExecuted/interrupted prefixes,
600–10,000-token result budgeting, UTF-16 argument bounds, full evidence text,
default/custom stubs, eight-image cap, ephemeral keys, strict `< 300` small-result
keep behavior, 16-hex SHA256 call/result signatures, last-12 call history, error
streak, todo step and tool counts. Formatting/token logic calls the existing core
harness APIs; it is not copied into this host module.

`source-fixtures.json` freezes eight scenarios / 36 calls from the original Node
`AgentLoop.record`, including evidence, images, actual interrupted success, missing
arguments, primitive results, numeric-key order, lone-surrogate hashing and source
JS counter coercion. Regeneration uses
`native-service/scripts/receipt-fixtures.mjs` under the supported Node 22 toolchain.
There is no Node/process invocation in the production implementation.
