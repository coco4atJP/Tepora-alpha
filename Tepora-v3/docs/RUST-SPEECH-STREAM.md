# Ordinary streaming speech: native boundary

The explicit `--dev-native --agent` host owns R074–R077 (`/api/voice/start`, `chunk`, `finish`, `cancel`) in `native-service/src/workspace/speech_stream.rs`. The local-workspace-only `--dev-native` host returns 503 for all four effects. The default Node service and Tauri launcher do not change.

## Contract

- One ephemeral session, including a pending start. No audio or transcript is stored in SQLite or written to disk.
- Existing `voiceEnabled` and `asrStreamUrl` preferences select a loopback speech worker. Existing preference validation and `NativeNetwork` admission/cancellation remain the authority. No model install, microphone permission or browser capture is performed by these routes.
- Worker POST `/api/start` receives `sample_rate:16000`; `/api/chunk` receives its session ID, sequence and base64 Float32 little-endian PCM. At most 64,000 bytes per chunk, finite samples with absolute value at most 1.01, and 1,920,000 samples per session are accepted. A 120-second wall-clock timer starts after successful worker session creation.
- Chunks must be ordered and single-flight. The last successful chunk can be retried without another worker call only with identical encoded bytes. Different content at that sequence, skipped sequences, concurrent chunks and finish during a chunk return 409. Failed chunks do not consume sequence/audio budget.
- Partial and final worker text is bounded to 32,000 UTF-16 units. Finish returns `final:true, submitted:false`; it does not submit text into a conversation. Finish success or error releases the session. Cancel is idempotent.
- Cancel, Stop All, tray Stop and shutdown invalidate local state and cancel/drain in-flight start/chunk/finish before acknowledging completion. Counted stop barriers immediately cancel local speech operations and exclude new sessions while cleanup is pending; sibling owners receive their cancellation before best-effort worker cleanup is awaited. Late worker replies cannot restore a session or publish text. This deliberately fixes lifecycle gaps in the compatibility source.
- Worker calls use the existing checked transport, 15-second total timeout, no redirects, 100,000-byte request and 256,000-byte response bounds. The optional existing `TEPORA_SPEECH_TOKEN` environment variable is sent only to the checked loopback worker; it is not stored or returned.

## Limits

Upstream cancel is best-effort. If start is cancelled before the worker session ID reaches the host, the remote session cannot be explicitly named for cleanup; the local socket is cancelled and no local session is created. The worker may already have processed audio when its response is lost. No claim of remote rollback is made. Malformed/noncanonical base64 padding may be rejected earlier than Node's permissive Buffer decoder; normal padded and unpadded PCM are accepted.

`/api/voice/transcribe`, dictation editing, speech capability consumers, actual ASR quality, browser microphone capture, codecs and real workers remain separate. The tests use zero-filled synthetic PCM and a loopback JSON worker. They do not use private audio, credentials, external accounts or paid APIs. Focused tests are not full quality, cross-platform package, installation or real-model acceptance.

## Verification

Rust tests in `workspace/speech_stream/tests.rs` exercise ordering/retry, malformed PCM/transcripts, the audio budget, concurrent operations, wall-clock expiry, and pending start/chunk/finish drains. `tests/native-speech-stream.test.mjs` compares ordinary HTTP replies with the compatibility host, checks both native modes, and exercises real loopback socket cancellation through Stop All, tray Stop and shutdown. The media HTTP fixture additionally holds the speech worker cancel response while proving that other active media transport is cancelled for each stop path. Run with the binary built from this exact source and a matching native-core addon.

Focused Linux evidence (2026-10-08): six Rust speech tests passed. Node 22.16.0 and 24.19.0 each passed 17 tests (two speech HTTP, five media HTTP including multi-owner held-cancel coverage, ten compatibility speech regressions), with no skips. JavaScript syntax checked 237 modules and the route inventory totals reconcile at 85 implemented / 12 partial / 29 unavailable. HTTP tests used native binary SHA-256 `1bf241f14ff67b13be70337d6765cc1f3173651730560a29143daaa87a419843`. Cargo build/check succeeded; the existing native-core dead-code warning remains. No broad approval-policy/security suite or full quality/package gate was run for this slice.
