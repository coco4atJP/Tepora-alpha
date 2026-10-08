# Native media-job checkpoint — beta.11

The opt-in `--dev-native --agent` host implements R036–R042 from
`core/media-jobs.mjs` and the media routes in `core/server.mjs`. Normal Node/Tauri
launch and the JavaScript/CSS GUI are unchanged. Local-workspace-only mode does
not submit media jobs.

## Scope and lifecycle

- List and submit user-requested TTS, image, image-edit and asynchronous video
- Request-ID intent hashes, explicit consent, pinned capability identity,
  permitted network domain and original input/source-asset checks
- Source-compatible create admission rejects when 16 stored jobs are queued,
  submitting, running or downloading. Awaiting-download records do not count,
  and explicit resume does not repeat this check; this is not a hard bound on
  all outstanding handles. Execution is independently limited to two workers.
  Video polls retain the same remote ID, wait five seconds, and pause after
  180 pending polls
- Source-compatible queued/submitting/running/awaiting-download/ready states,
  cancellation, failed/unknown outcomes, explicit resume and result deletion
- A lost create response stays unknown. Startup never automatically resubmits
  paid work. Resume can poll a retained ID, download a retained URL, or submit a
  queued request proven not previously sent, only after an explicit user action
- Generated asset signatures/modality, 32 MiB output and 512 MiB library budgets,
  hash-checked local reads, GET/HEAD, single byte ranges and download headers

`workspace/media_jobs.rs` owns lifecycle state and tasks, using the existing
Workspace/SQLite and event owner. The lifecycle lock serializes state transitions
and bounded output writes; SQLite guards are released for file/provider I/O.
This also serializes quota accounting without a second pending-byte reservation.
Capability I/O uses the existing native transport and cancellation/resource
leases. Stop All and tray Stop stop active media processing. Unlike the Node source
status-only loop, these operations also cancel owned awaiting-download workers.
Dormant awaiting-download handles remain resumable. The worker token and the
completion boundary share lifecycle ownership, so a cancelled download cannot
publish a late ready result. This is an intentional lifecycle improvement, not
strict Node parity; it never retries generation. Close persists the
recovery state, cancels and joins workers/timers before the database closes.
Cancellation cannot establish that a provider stopped generating or charging.

## Focused verification

All inputs were synthetic. No actual image/audio/video API, account, private file
or paid provider was used.

- 14 native lifecycle fixtures cover signatures/public projection, consent and
  validation, idempotency/events/cleanup, uncertain and rejected submissions,
  modality mismatch, two-worker/16-job limits, cancellation/drain, queued and
  remote restart states, typed TTS/edit payloads, video polling, hash integrity,
  resume-only download, stale inputs, explicit unsent resume, storage quota and owned poll-timer cancellation, active-download Stop All, dormant-handle
  preservation and rejected late completion
- Two native HTTP fixtures cover ordinary mode-specific route dispatch,
  GET/HEAD range formatting and download headers
- Three tests in `tests/native-media-jobs.test.mjs` compare real compatibility and Rust HTTP
  services with a synthetic loopback provider: all four generation modalities,
  idempotency, result bytes/ranges/download/deletion, unknown submission across
  restart and cancellation without replay. A fourth native-only test holds a
  download socket and checks both HTTP Stop All and tray Stop, socket cancellation
  and no late ready publication. The native process has an empty PATH
  and isolated home, so its service execution does not invoke Node

Reproduce after building the exact checkout:

```sh
npm run build:core
npm run build:native
cargo test --locked --manifest-path Tepora-v3/native-service/Cargo.toml workspace::media_jobs
cargo test --locked --manifest-path Tepora-v3/native-service/Cargo.toml http::tests::media_
node --test Tepora-v3/tests/native-media-jobs.test.mjs
```

`TEPORA_NATIVE_SERVICE_BINARY` selects an explicit exact-source binary when using
an isolated Cargo target. Do not reuse a different checkout's binary as evidence.

## Limits

Media agent tools are not connected by these seven user HTTP routes. Voice
capture/transcription, media embed/open helpers, browser rendering, MCP and
Computer Use remain separate. The media signatures are inexpensive format
checks, not decoding or content-quality verification. No real provider billing,
remote-account behavior, GUI playback, GPU, native WebView, Windows/macOS package
or broad security acceptance is established by these focused tests. Full quality
and exact-head cross-platform CI remain the publisher's integration gates.

Coverage limits also include the 180-poll cutoff/resume edge, dispatch after a
retained remote/download handle is reloaded from disk, and injected partial-file
write or metadata-commit failures. The fixtures validate retained restart state,
ordinary resume and cleanup but do not claim those additional failure injections.
