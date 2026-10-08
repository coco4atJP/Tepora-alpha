# Native web components

These components are connected to the native agent through WebHost, exact tool approvals and ordered receipts. They use the existing NativeNetwork permission, DNS/TLS and cancellation boundary; no Node runtime or implicit browser fallback exists.

Frozen source fixtures preserve HTML extraction, entity handling, DuckDuckGo parsing and source decoder behavior. Regenerate source fixtures with Node22.16.0 using `native-service/scripts/web-source-fixtures.mjs`; the separate `--current-decodes` vectors document current decoder behavior. `web-single-byte-tables.mjs` reproduces the frozen single-byte tables. Scripts use pure code and mocked network responses, never providers or keys.

Explicit differences/limits:
- Windows-1252 uses the approved current WHATWG decoder correction; other frozen single-byte behavior is retained
- Cross-origin redirects strip credentials; same-origin redirects retain them
- Extraction bounds return413 instead of a fabricated empty result; no result is cached after cancellation or stale network policy
- Browser rendering is unavailable unless a permission-preserving renderer is supplied
- Cached page data can be read offline, but explicit internetTools disable still denies the tool
- Cache remains 64 FIFO entries for 10 minutes, matching the source rather than claiming an aggregate-byte bound

WebHost captures settings and the selected Brave credential atomically through the existing Workspace owner. Credential/config changes revoke active requests and cached bindings. Trusted authority checks repeat after DNS/resource admission and after TCP/TLS immediately before request dispatch; response/cache delivery also checks the binding. No credential is included in public state or events. Scripted local providers and deterministic DNS fixtures validate these boundaries; no real search-provider quality is claimed.
