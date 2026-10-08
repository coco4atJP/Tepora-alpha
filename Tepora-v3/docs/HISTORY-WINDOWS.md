# Bounded history reads — 3.0.0-beta.11

## Scope and compatibility

The shared Rust state core adds two read operations:

- `session.page` seeks to a sequence boundary and returns the newest requested rows in ascending order. Both the ordinary Node HTTP host and opt-in native host use it for normal `before` pages. The existing 500-entry HTTP cap and tool/checkpoint public projection stay unchanged.
- `session.contextEntries` returns the latest checkpoint and its complete live tail in one SQLite read snapshot. The native agent's ordinary context effect uses this owned snapshot; it does not impose a new token/history truncation policy.

The Node route retains its existing query coercion. Positive safe-integer limits use bounded SQL. Zero, negative, fractional, NaN and infinite inputs retain the previous slice/error behavior; unusual JavaScript limits deliberately fall back to the previous implementation. Explicit zero/negative requests can still return many rows. Native validation is unchanged.

The full transcript remains stored. Explicit entry, entries, search, export, compaction and recall paths are unchanged. No-checkpoint context reads still require all history. Checkpoint metadata, clear events, tool-call/result order and unknown fields are preserved. This patch does not alter events, revisions, mutation durability, synchronous commit behavior, or the existing KV duplicate-write suppression.

## Additive index and existing databases

`session_header_overrides` is a sparse partial index on `(session_id, seq)`. Ordinary entries do not enter it. Legacy bodies can override the returned `seq` or `type` header; the index lets context and page reads detect these exceptional records and use the exact old full-read path instead of silently changing their meaning. Explicit null overrides count. Page fallback also retains the old decode error for syntactically malformed off-page JSON in its candidate prefix. A guarded JSON predicate also indexes malformed legacy JSON, so creating the index does not newly prevent database opening.

A bounded compatibility difference is intentional for out-of-band legacy corruption: SQLite can consider JSON valid even when Rust cannot represent its numbers or nesting depth. An unrepresentable row outside the requested page or checkpoint live window no longer has to block unrelated valid rows. Selecting that invalid row still errors; full recall is unchanged. No data is rewritten, repaired, deleted or migrated. This is not an assertion of identical error behavior for every malformed database.

The first open of an existing database scans the log to construct this index. It does not rewrite the transcript table. Later opens are idempotent. SQLite evaluates the predicate when log rows are inserted or updated; only matching records add index entries. Older clients continue to read and write the unchanged tables and SQLite maintains the index for their writes. Rolling the application back does not require removing the index or converting data.

Independent query-plan review found bounded indexed ranges and a primary-key point lookup for the retained checkpoint. At the same 100-row live window, 10,000-row and 100,000-row fixtures used identical SQLite VM counts: override probe 42, latest checkpoint 92, context union 1,340, page 484 (SQLite 3.53.1). Checkpoint lookup scans backwards through the live tail; it is not a new checkpoint index.

## Focused validation

Use an isolated `CARGO_TARGET_DIR` for each build configuration. Do not share generated native adapters with another worktree.

- Core compatibility/restart/schema gate: `cargo test --offline --manifest-path native-core/Cargo.toml --no-default-features tests::history_`
- Native snapshot equivalence: `cargo test --offline --manifest-path native-service/Cargo.toml --lib history_window_context_matches_full_snapshot`
- Build the adapter with `npm run build:core`, then run only `node --test tests/session-page.test.mjs`

Core fixtures compare before-page output to the original read-all/slice implementation, including zero/negative limits and sequence boundaries. They compare checkpoint/live-tail views, unknown metadata, header overrides and malformed checkpoint boundaries; check unchanged mutation counts; exercise older-client SQL writes; and verify byte-identical database reopen. The native fixture compares the complete built context and plan, including clear and tool-pair entries. Node fixtures compare query coercions and errors to the original route, then exercise the real default HTTP host with synthetic data, public projections, bounded-operation assertions and outbound networking denied.

These are targeted storage/context/paging checks, not full quality, platform packaging, model quality, or held policy/security acceptance.

## Reproducible local measurements

`native-core/examples/history_window_bench.rs` uses synthetic content only. Prepare a new fixture with `history_window_bench NEW_DB prepare N`, then run each of `page-before`, `page-after`, `context-before`, and `context-after` in a fresh process against that fixture. Preparation and append controls refuse an existing destination. The example reports 30 warmed measurements after one warm-up, returned serialized payload size, and a deterministic output digest. The context fixture has a 1,000-entry live window after a checkpoint; the page has 500 entries.

`open` measures schema open/index construction. `append-before` and `append-after` use separate new databases, 1,000 ordinary appends with identical durability, and disabled WAL autocheckpointing solely in the measurement fixture so WAL byte counts remain comparable. Disabling autocheckpointing is not a production change. Measure each process's peak RSS externally; do not include fixture construction in read-process RSS.

## Measured result (2026-10-08)

Release-mode shared-core reads and synthetic context assembly were measured on Linux x86_64, with 512-byte text bodies plus metadata. Each timing process made one warm-up and 30 measured reads. Known task compilers were paused, but this shared host still showed substantial scheduling variance. These are local synthetic observations, not HTTP/UI latency guarantees. The context benchmark includes the shared context view/build computation, not provider work or full agent execution.

Peak RSS below comes from separate fresh **single-read** processes, using `TEPORA_HISTORY_BENCH_READS=1` and a minimal native resource launcher. It excludes fixture creation and the Python orchestration process's high-water memory. DB body bytes count the returned UTF-8 body payloads, including the context operation's separate checkpoint lookup; they exclude column/header/index overhead.

| History | Read | p50 ms before → after | p95 ms before → after | Peak RSS MiB before → after | DB body bytes before → after |
|---:|---|---:|---:|---:|---:|
| 1,000 | page | 20.3 → 8.9 | 27.7 → 16.5 | 9.8 → 7.2 | 564,824 → 282,498 |
| 1,000 | context | 245.5 → 291.7 | 551.1 → 1,387.9 | 27.4 → 27.5 | 565,391 → 565,455 |
| 10,000 | page | 588.6 → 14.0 | 2,711.9 → 21.2 | 51.9 → 6.9 | 5,667,826 → 283,000 |
| 10,000 | context | 798.3 → 290.8 | 3,361.7 → 774.7 | 51.9 → 27.6 | 5,668,394 → 566,568 |
| 100,000 | page | 9,984.0 → 48.7 | 18,850.6 → 353.6 | 463.3 → 7.2 | 56,787,826 → 283,500 |
| 100,000 | context | 6,113.2 → 134.8 | 13,627.0 → 804.6 | 463.1 → 27.6 | 56,788,395 → 567,569 |

At 100,000 entries, page body transfer fell 99.50% and context body transfer fell 99.00%. All output digests matched their full-read baseline and all immutable read-fixture SHA-256 hashes remained unchanged. The 1,000-entry context fixture has no omitted history; it shows no memory/body reduction and was slower in the sampled timing run. Do not infer a universal speedup for short or uncompacted histories.

The first additive-index open took 17.4 / 47.2 / 186.3 ms at 1,000 / 10,000 / 100,000 rows and added exactly one 4,096-byte index page. Repeat opens took 3.9 / 5.0 / 1.5 ms and left database bytes unchanged. A pre-change N-API binary also opened the additive schema, appended normally, and the new binary read the durable result.

Three paired 1,000-ordinary-append controls each produced exactly **9,694,392 WAL bytes** before and after. There is a CPU/latency tradeoff: the median of per-run append p50s rose from 0.0351 to 0.0501 ms (about 15 microseconds); corresponding p95 medians were 0.4568 and 0.6392 ms. This is an observed predicate cost, not a claim of unchanged write latency. Durability was identical; autocheckpointing was disabled only for both measurement controls so total WAL growth could be compared.

Final focused gates passed: five core history tests, one native full-context/plan equivalence test, and three adapter/real-HTTP tests under each of Node 22.16.0 and Node 24.19.0. The JavaScript coercion matrix uses a small fixture, with separate 1,000-row adapter and 600-row HTTP cases, to keep the ordinary test suite bounded. Independent SQL/schema and Node-adapter reviews found no remaining blocker; the intentionally bounded malformed-data difference above is explicitly covered.
