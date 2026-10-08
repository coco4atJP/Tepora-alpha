# Native ordinary media embed/view

The opt-in `--dev-native --agent` host implements R122 `POST /api/media/embed` and R123 `GET /media-view/{token}`. Both require the normal authenticated local HTTP flow. The effect-free `--dev-native` host returns 503; it does not construct externally embeddable media frames. Normal Node/Tauri startup and all JavaScript/CSS remain unchanged. R121 `POST /api/media/open` remains unavailable.

## Source contract

- Embed parses the ordinary bounded JSON body and requires a string of exactly 11 ASCII letters, digits, underscores or hyphens. Invalid IDs return 400 before the network check. The source's top-level null-body error remains 500. Malformed JSON keeps the HTTP parser's 400 error
- Both operations use the existing agent `NativeNetwork` policy with cloud/web permission. Embed checks after ID validation; view checks before looking up a handle. Blocked responses retain the distinct source messages and `blocked: true`
- The existing OS-random 32-byte generator supplies an ephemeral 64-character hex handle. The shared Workspace state owner stores at most 32 handle/ID pairs in insertion order. Admission evicts the oldest; reading never consumes or refreshes a handle. There is no TTL
- Handles are not account credentials, session replacements, durable database values, snapshots or events. A restart drops every handle. A successful network patch whose resulting mode is not online clears all handles. Toggling internetTools or allowNetwork alone blocks viewing but preserves handles for re-enable, exactly as the source does
- The same State lock orders admission, lookup, successful network-mode changes and close. No new SQLite connection, network-policy owner, background task or dependency is introduced
- View returns the source HTML bytes, `text/html; charset=utf-8`, `Cache-Control: no-store`, and the source CSP restricted to the fixed youtube-nocookie frame destination and current app ancestor origin. The successful viewer omits X-Frame-Options; ordinary errors retain DENY. Existing outer HTTP checks are unchanged
- Only POST embed and GET view are implemented. Unsupported methods retain ordinary source API/static fallbacks. Missing or evicted handles return 404 `Media view expired` after the policy check

The native service only constructs a local HTML response. It does not fetch the media URL, open a browser or start playback. An actual browser rendering that returned document can contact the third-party frame destination; constructing or testing response bytes is not permission to do so.

## Focused validation

Build the exact core and native service before running the process fixtures:

```sh
npm run build:core
npm run build:native
cargo test --locked --manifest-path Tepora-v3/native-service/Cargo.toml media_embed
node --test Tepora-v3/tests/native-media-embed.test.mjs Tepora-v3/tests/rust-route-parity.test.mjs
```

For a separate Cargo target directory, set `TEPORA_NATIVE_SERVICE_BINARY` to that target's exact built debug executable. Repeat the Node fixtures with the supported Node 22.16.0 executable when the host default differs.

The local-only process fixtures compare the real Node/native HTTP hosts using synthetic IDs, ordinary authenticated requests and inert response-byte inspection. Coverage includes exact HTML/CSP/header bytes, repeated reads, JSON/ID/type errors, method fallbacks, all 32 retained entries, FIFO eviction without access refresh, same-data-directory restart, network validation order, both restricted modes, internetTools/settings toggles and effect-free-mode availability. Source networking is replaced with a fail-on-call transport. Rust tests use a fail-on-call DNS/transport, test concurrent admissions against the same owner, and verify that no media handle events are persisted.

Local focused results on 2026-10-08: core/native builds passed; five new Rust domain/lifecycle tests and two existing ordinary media HTTP regressions passed; the six process-fixture groups and four inventory checks passed on both Node 22.16.0 and Node 24.19.0 (10/10 each). The root syntax check passed for 242 JavaScript modules. These checks do not run the full native or application test suites.

No live third-party request, browser playback, external opener, real provider/model, account credential, full quality gate or platform/package acceptance is claimed. Route inventory is 94 implemented / 12 partial / 20 unavailable among 126 application variants, plus 22 static rows (148 total). These are scope counts, not feature-completion percentages.
