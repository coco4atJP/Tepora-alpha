# Redundant KV writes (beta.11)

The shared Rust SQLite owner now skips saving an exactly equal serialized KV
value. Missing keys insert and changed values update synchronously through a conditional
UPSERT, avoiding unnecessary primary-key-index replacement.
The primary-key equality check is part of the same write statement, retaining
write-first locking and existing transaction behavior.

Document and FTS persistence are unchanged. There is no batching, debounce,
lost-update window, new retention policy or event dropping. Revisions, timestamps,
final results, errors and committed restart state retain their existing semantics.
WAL, synchronous/fsync, checkpoint and OS settings are unchanged.

KV UPSERT intentionally changes SQL diagnostic metadata: total_changes,
KV rowids and last_insert_rowid (also returned in diagnostic delete results) need
not match REPLACE, including for changed values. Existing KV rowids are retained;
UPDATE triggers would replace DELETE/INSERT trigger behavior on conflicts, while
BEFORE INSERT triggers still run. No production KV triggers or diagnostic-value
consumers exist in the current schema/application; domain compatibility does not mean identical SQL diagnostic metadata.

## Evidence

Use `npm run build:core`, then `node scripts/bench-disk-writes.mjs current`.
`ITERATIONS`, `INDEXED_DOCUMENTS` and comma-separated `WORKLOAD` select synthetic
fixture sizes/workloads. `BENCH_NATIVE_BINARY` can select a separately built,
immutable baseline N-API binary. Do not overwrite a mapped binary during a run.

The comparison uses actual baseline a1b9b849 and changed debug N-API cores, three
alternating runs, isolated temporary databases and synthetic values. Automatic
checkpoints are disabled **only inside the benchmark fixture** after TRUNCATE to
measure appended WAL frames. Production settings are not changed.

For 1,000 identical KV saves, baseline WAL append size was 8,240,032 bytes and
changed append size was zero. SQLite logical changes fell from 1,000 to zero.
Changed-value KV saves retained 1,000 logical changes and wrote 4,120,032 WAL
bytes versus 8,240,032 in baseline. Both results were identical across three runs.

To reduce cross-process timing noise, `scripts/bench-kv-paired.mjs` alternates
baseline/current 500-operation blocks in one process (10 blocks each):

| 5,000 operations | Baseline WAL | UPSERT WAL | Baseline time | UPSERT time |
| --- | ---: | ---: | ---: | ---: |
| identical KV | 41,200,032 B | 0 B | 7,169 ms | 1,130 ms |
| changed KV | 41,200,032 B | 20,600,032 B | 1,499 ms | 1,444 ms |

The changed-value negative-control block medians were 146 / 139 ms. These
container observations are not a production speed guarantee. Set
`BENCH_NATIVE_BINARY` to the baseline binary when running the paired script.

The script records WAL bytes, SQLite total_changes, /proc/self/io wchar/syscw/
write_bytes, process CPU and elapsed time. Here, write_bytes stayed zero even
when WAL grew: it cannot establish physical media writes. WAL/wchar measure
application/OS-visible writes only, not NAND wear or SSD lifetime. Do not
extrapolate the synthetic saving to the application's total workload.

## Rejected candidates

- FTS no-op detection saved WAL but required an unindexed uniqueness scan to
  preserve repair behavior. With 10,000 rows, median time for 100 identical-job
  saves rose from 894 to 1,684 ms. It is **not shipped**; original FTS ordering,
  repair and writes remain intact
- An unchanged-document predicate eliminated logical updates, but SQLite already
  appended zero WAL frames for identical document UPDATEs. In the changed-4KiB
  document control, 1,000 saves took median 4,049 / 4,728 ms and wrote the same
  4,152,992 WAL bytes. That candidate is **not shipped** either

Timing was variable in the container. No whole-application speed improvement is
claimed. The final change only adds a primary-key equality check to KV saves.

## Checks and limits

Nine focused Node tests cover zero-WAL/logical-change repeated KV saves, changed
KV visibility, missing-key creation, JSON null and binary-exact serialized equality, original document/FTS behavior and repair, rollback, ordered
progress/final/error events, and abrupt process exit preserving committed
KV/document/FTS/event state while discarding an unfinished transaction. The
SIGKILL fixture is Unix-only and does not simulate power loss.

Eight individually selected Rust regressions cover reopen, concurrent sequence
allocation, inbox rollback, failed-index atomicity, artifact revisions/CAS,
nested savepoints, document ordering and legacy FTS/float values. Independent
review found no blockers in the final KV-only change. These are focused checks,
not full quality, platform/package or security acceptance.

Other audited paths are unchanged: streaming deltas and connector caches are
already memory-only; event retention already exists; media polling persists
observable status/poll/timestamp changes; ready-media export can rewrite a file;
optional speech adapters create temporary WAVs; development logs retain evidence.
Coalescing or deleting those writes needs a separate behavior/retention contract.
