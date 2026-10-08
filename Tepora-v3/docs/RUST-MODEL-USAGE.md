# Shared model-dispatch accounting — beta.11

The ordinary Node host and the opt-in Rust agent record one final receipt per
dispatched chat or summary attempt, including provider retries/fallbacks and
unsuccessful summary attempts. Typed decision `/systemone` transport requests are
counted too. Both hosts use the same Rust estimator, receipt format, aggregate
logic and transactional store on their existing sole SQLite owner. This does not
change the normal launcher, provider admission, cancellation authority, or permissions.

## Coverage and interpretation

- `usage.modelCalls` adds `today`, seven recent `days`, `total`, coverage and
  retention information to either host's agent snapshot. Session
  `stats.modelUsage` contains attributed dispatch totals. These are separate
  aggregates, never values to add to the old normal-turn totals.
- `purpose` distinguishes `normal`, `summary`, `decision`, and explicit provider
  `probe` invocations. `attempt`/`retry` distinguish provider retries/fallbacks
  and in-context summary retries. Each actual transport attempt has its own UUID.
- Decision consumers do not pass reliable session ownership through their typed
  transport. Their receipts have `sessionId: null` and appear in global/day totals,
  not a guessed session. Missing/deleted sessions are likewise not recreated.
  The typed transport has no token/rate contract: its usage and cost stay unknown,
  even on a successful transport. Later typed-answer validation is a separate step.
- Embedding, speech, image/video capability transports, and setup's isolated probe
  state are outside this ledger. They are not represented as zero-cost calls. The coverage fields name these exclusions.
- Existing databases are not backfilled. Each aggregate's `since` marks the first
  included receipt. The UI labels the shared value as today's measured portion.
  Earlier Node-host calls also remain outside the measured portion.
  Older calls, crashes before a completion receipt, and abrupt process termination
  are not reconstructed. This is not an invoice or an exact provider billing log.

## Unknown is not free

Canonical numeric usage remains compatible. The additive `usageStatus` reports
`complete`, `partial`, or `missing`, with separate input/output availability.
Actual reported zero is distinguishable from synthetic decoder defaults. Known
counters from failed/terminated streams are retained as partial; unfinished usage
cannot produce a complete estimate. A dropped native in-flight future records an
unknown outcome. Node promise completion records the observed transport outcome;
abrupt process loss has the same no-pre-dispatch-write limitation. Ordinary
cooperative cancellation records cancellation when it reaches that boundary; a timeout that drops the future may have unknown outcome.

Receipt `cost` is null when usage or rates are unknown. `costStatus` is
`estimated`, `unknown-usage`, or `unknown-price`. The numeric aggregate `cost`
remains a known subtotal for compatibility, accompanied by `unknownCostCalls`,
`unknownUsageCalls`, and aggregate `costStatus: incomplete`. The small usage UI
adds the number of unknown-cost calls and a missing-usage label.

Prices are catalog estimates, not invoices. No cache-discount, cache-write premium,
or output rate is invented. Every used category requires its own nonnegative
finite rate. Conflicting catalog matches are treated as unknown. Canonical input
already includes cache-read and cache-write tokens; those subsets are removed
before charging ordinary input. The `uncachedOnly` decoder flag is respected.
Nonstreaming Anthropic now preserves `cacheWrite`, matching its streaming path.

## Budgets and compatibility

The old `stats.steps`, `stats.cost` and `agent-usage:DAY` retain their existing
normal-successful-turn budget scope. Summary/decision/retry costs do not silently
change admission behavior. Consequently those budgets are not an all-dispatch
spend ceiling. Their existing numeric cost field is now also accompanied by an
unknown-cost counter/status, and estimates no longer invent missing rate fields.
Unknown calls do not receive an arbitrary charge. Cost estimates use reported
provider usage before the legacy context diagnostic infers whole-context/cache
counts for uncached-only transports. Those inferred diagnostic counters are not
charged. The old compaction event usage
field remains its compatibility diagnostic; the new receipts are the complete
attempt-level source for this measured coverage.

## Storage, bounds and recovery

A completion transaction uses the existing SQLite owner (the native Workspace
mutex or Node's synchronous N-API adapter):
insert receipt, update daily/lifetime/session aggregates, and prune old metadata.
It publishes no per-token receipt or progress writes. Node passes only bounded
usage/profile metadata across the accounting boundary, never full prompts or answers.
Its in-memory dispatch marker is armed only after network admission; failed
stream decoding reads the existing decoder's usage snapshot once at termination.
Normal service shutdown cancels network work and drains armed receipts before
closing SQLite. Duplicate receipt IDs among retained records do not update any aggregate. Failed transactions roll back both
the ID insertion and aggregates, so retrying the same receipt is safe.

The newest 512 receipts are retained, each at most 4 KiB, together with the newest
90 ISO UTC completion-day aggregates and one fixed-shape lifetime aggregate. Session
aggregates are fixed-shape fields on existing sessions. Receipt-ID deduplication
has the same 512-record retention horizon; old receipts are not replayed by this
implementation. Totals survive receipt/day pruning. Metadata contains bounded
model/profile/session identifiers, purpose, counters, timings and outcome, never
prompts, generated text, tool arguments, URLs, request headers, keys or upstream
error bodies. SQLite/WAL filesystem overhead is additional to the metadata bound.

The boundary means a transport request was attempted, not proof that the remote
provider billed it. Pre-dispatch configuration/admission failures produce no
receipt. A failure after the transport begins remains visible with uncertainty.
On a normal completion, a persistence failure is surfaced as an accounting error
without reissuing that call inside the provider retry loop or scheduling the
outer agent's provider-retry timer. A dropped-future
persistence failure emits only a generic local diagnostic; sudden termination
cannot guarantee a final receipt without an additional pre-dispatch write, which
this bounded low-write design deliberately avoids.

## Verification

Only synthetic protocol/provider/decision fixtures and temporary SQLite databases
are used. Focused tests cover known/unknown/zero usage and rates, cache subsets,
retry/fallback/error/cancellation, compaction attempts and rolling summaries,
content-free metadata, atomic rollback, retained-ID deduplication, day/session
aggregation and retention. The protocol compatibility suite compares unchanged
request/event/result fields to the frozen baseline and separately tests additive
usage status and intentional Anthropic counter repairs. Full quality, live paid
providers, security probes, native WebView and packaged platform acceptance are
separate gates, not implied by these focused checks.

On 2026-10-08 the shared-host focused gate passed 43 Node tests, 10 shared-core
tests and 13 native accounting tests. The Node batch includes ordinary HTTP/agent
execution, error-without-retry and shutdown/reopen persistence; no external model
or paid provider was used. See [QA](QA.md#shared-model-dispatch-accounting-2026-10-08).
