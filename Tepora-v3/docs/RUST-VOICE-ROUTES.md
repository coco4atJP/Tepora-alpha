# Native ordinary dictation and transcription

The opt-in `--dev-native --agent` host implements R073 `POST /api/voice/edit` and R078 `POST /api/voice/transcribe`. The GUI, normal Node/Tauri launcher and effect-free `--dev-native` mode remain unchanged. This is synthetic loopback transport evidence, not microphone, real-ASR, platform/package or model-quality acceptance.

## Contract

- Dictation requires the existing exact `dictationEditing: true` setting and the device-only filtered `dictation` provider chain. It uses the existing ProviderRuntime protocol, identity, network, resource and cancellation checks, one pending edit and a 12-second overall deadline. The prompt, tool schema, draft/spoken/utterance/revision/selection validation, 32,000-unit draft/replacement budget and returned proposal fields match `core/dictation.mjs`. No draft is applied, sent, scheduled or persisted.
- Selection/range comparisons, replacement and summary truncation use the shared JavaScript JSON/UTF-16 codec, including emoji splits, isolated surrogate units and literal private-use markers. Provider fallback and key handling remain inside the existing registry; this route adds no configuration or authentication authority.
- Transcription accepts raw uploaded bytes within the source 12 MiB request cap. The existing configured ASR endpoint validator and NativeNetwork `worker` admission apply unchanged. The multipart form carries `file` (`recording.wav`, `audio/wav`), the configured `model`, `language=ja`, and `response_format=json`. The existing optional `TEPORA_ASR_KEY` environment value is used only in memory. No credential is saved, discovered or altered.
- Transcription's overall deadline is 120 seconds. Missing ASR configuration, upstream non-2xx status and missing/non-string text retain the source error/status. Explicit overall deadlines retain the source 500 `The operation was aborted due to timeout` response. Ordinary success is exactly `{text}`; no inferred transcript or real audio capture is performed.

## Ownership and bounded differences

`workspace/voice_operations.rs` owns only ephemeral flights. HTTP awaits run on the async reactor and cancel on request-future drop. Stop All, tray Stop and shutdown acquire counted cancellation barriers for streaming speech and these voice operations before draining media or other owners. All admitted requests are cancelled; overlapping barriers keep admission closed; a closed owner cannot restart. Final publication checks the same lifecycle lock and token as Stop, so a cancelled response cannot become a successful late proposal/transcript. No voice request is persisted or replayed after restart.

Native Stop cancellation deliberately returns 499 and closes in-flight transports. During shutdown the outer HTTP lifecycle may instead return 503 `Service is closing` or close the client connection; it cannot publish a successful late result. Source dictation's Stop error is 500 and the source ASR connector lacks a Stop-owned cancellation scope. Native ASR also bounds each response to 256,000 bytes, each transcript to 32,000 UTF-16 units (413 if exceeded), and active transcriptions to eight (429 if exceeded). These bounds are deliberate native limits; source ASR has no corresponding transcript or single-owner admission bound. Provider response collection retains the existing bounded provider protocol limits. The source request cap and normal validation/status cases are unchanged.

No microphone access, private audio, cloud ASR, provider account, persistent key, model installation or policy widening is involved in validation. Existing approval-policy, regex and security reproduction work is outside this slice.

## Focused verification

Rust tests exercise UTF-16/surrogate fidelity, source validation/status, multipart encoding, ASR response/text limits, reduced-duration deadline, request-future drop, single-edit admission, overlapping Stop barriers, permanent close and late-result rejection. Real HTTP tests use both the Node compatibility service and the native binary with synthetic text/audio and a credential-free loopback provider, covering proposals, source errors, multipart contents, 12-second dictation deadline, effect-free-mode availability and simultaneous edit/transcription Stop All, tray Stop and shutdown. Existing speech/media lifecycle tests remain part of the focused regression gate.

Commands (after building the core and native binary from this tree):

```sh
cargo test --locked --manifest-path Tepora-v3/native-service/Cargo.toml workspace::voice_operations -- --test-threads=2
TEPORA_NATIVE_SERVICE_BINARY=/absolute/path/to/tepora-native-service node --test Tepora-v3/tests/native-voice-routes.test.mjs Tepora-v3/tests/native-speech-stream.test.mjs Tepora-v3/tests/native-media-jobs.test.mjs
```

Focused Linux evidence (2026-10-08): six voice, six existing streaming-speech and fourteen existing media Rust tests passed. The short ASR deadline/budget fixture passed 50 repeated runs, plus 100 independent reviewer repetitions after fixing both timer orderings. Node 22.16.0 and 24.19.0 each passed 26 tests: nine new voice HTTP tests and seventeen existing speech/media regressions, with no skips. All process tests used native binary SHA-256 `c208622211f7ac61c4d1e0622805108f54d2eb35bb99d6cbafaba5463846dc41`. Syntax checks cover 238 JavaScript modules; route totals reconcile at 87 implemented / 12 partial / 27 unavailable. Cargo build and core digest/load checks passed; the existing native-core dead-code warning remains. These focused checks are not the full quality/package gate. No held approval-policy/regex/security reproductions or real providers were exercised.
