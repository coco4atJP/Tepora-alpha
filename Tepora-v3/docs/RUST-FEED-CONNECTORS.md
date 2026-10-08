# Native ordinary weather and news connectors

The opt-in `--dev-native --agent` host implements R119/R120: `POST /api/connector/weather` and `POST /api/connector/news`. The workspace-only development host returns 503. Normal Node/Tauri startup and the JavaScript/CSS GUI are unchanged.

## Source contract

`workspace/feed_connectors.rs` reads the existing saved `weatherCity`, `newsUrl` and network permission settings. Request bodies do not supply alternate destinations. Both operations use the existing `NativeNetwork` feed admission, without changing URL validation, DNS/destination policy, persistent authentication or provider configuration. Weather uses the unchanged fixed Open-Meteo geocoding and forecast URLs, source query order and `encodeURIComponent` formatting. Forecast hourly arrays are independently sliced to at most the first 48 time entries; current/daily data, source attribution and fetch timestamps retain their source shape.

Successful responses are cached in memory by the exact saved city/feed value for 15 and 10 minutes respectively. Expiry uses source-compatible wall-clock subtraction, including backward clock movement; failed requests do not populate the cache. Current saved network permission is checked before a cache hit. An uncached fetch still passes through the existing current network policy. No connector documents, events, keys or credentials are written.

The ordinary RSS/Atom extractor preserves the source's conservative text behavior: inspect the first 12 item/entry matches before filtering unusable links; remove CDATA wrappers and tags; replace only `&amp;`, `&lt;`, `&gt;` and `&quot;`; preserve publication-field priority and Atom href fallback. Feed and item titles retain JavaScript UTF-16 slicing at 120/240 units, including a slice inside a surrogate pair. Links are inert output strings, validated with the source ordinary HTTP(S)-URL rule; they are never fetched or opened. This is not a general XML parser, entity evaluator or browser renderer.

## Native ownership and deliberate bounds

An ephemeral owner tracks at most eight concurrent feed operations. Async HTTP waits hold no SQLite guard or blocking worker. Request drop cancels its flight. Counted Stop All/tray/shutdown barriers signal sibling speech, voice and feed owners before any drain; shutdown drains accepted work before closing SQLite. Cache publication and Stop invalidation share one lock, so a stopped request cannot publish a late successful cache value. Stop permits subsequent explicit requests; close permanently withdraws admission.

Each HTTP fetch has the source ten-second deadline, including body reading. Weather geocoding and forecasting receive separate deadlines. The news text decoder preserves UTF-8 chunk boundaries and the source strict less-than-1,000,000 UTF-16-unit check after each streamed chunk (the decoder's final flush retains the source behavior).

The native host additionally caps each weather JSON response at 1 MiB, raw feed bytes at 4,000,000, and cache entries at 32 (the earliest completion wall-clock timestamp is evicted; equal timestamps have unspecified order, and a backward clock can make a newer completion eligible). The source cache and weather response had no corresponding finite bounds. Oversized native responses fail rather than allocating without a limit. Existing native JSON decoding rejects invalid UTF-8/overdeep malformed provider JSON and reports its checked-transport error rather than promising identical JavaScript parser exception text. These explicit limits do not alter network authority. Source title/array extraction and ordinary error messages are compared directly with frozen fixtures.

## Focused verification

`tests/fixtures/freeze-feed-connectors.mjs` executes the existing source `Connectors` against a response-only injected transport and a fixed clock. It freezes five weather cases, nine ordinary RSS/Atom cases, ten ordinary configuration/provider-status errors and twelve cache/time/settings transitions. It cannot make a network request. Fictional city names and synthetic public URLs are used throughout.

Rust tests replay those fixtures through `NativeNetwork` with both DNS and transport injected. The transport never creates a socket. Thus the production Open-Meteo URLs stay unchanged while no request can reach them. Additional tests exercise incremental Unicode decoding, the one-million-unit limit, native admission/cache bounds, timeout, request drop, overlapping barriers and no cache publication after cancellation.

Two real authenticated HTTP tests use loopback client/server sockets and inject that same mock-only network into every native resource. They verify saved settings rather than body overrides, cache hits, current permission checks, workspace-only 503, Stop All/tray Stop/shutdown cancellation and subsequent explicit retry. They do not use a real location, feed, credential, provider or external DNS/socket.

These are focused synthetic/local checks. No full quality, broad security/approval-policy/regex review, real provider acceptance, GUI/browser/media opening, cross-platform CI, desktop packaging or default-host cutover is claimed.

Local Linux results on 2026-10-08: all 12 feed-connector Rust tests passed, including the two real HTTP cases; adjacent voice and speech lifecycle suites each passed 6/6. The 36 source fixtures/transitions regenerated byte-identically under Node 22.16.0 after the required core build. Native check, fixture-script syntax and diff whitespace checks passed. The inventory remains 148 total rows: 92 substantially matched / 12 partial / 22 absent application variants, plus 22 unchanged static rows. Only the pre-existing core dead-code warning was emitted; no broad aggregate gate was run.
