# Web search (3.0.0-beta.11)

Web search is independent of the model/inference provider. Both `core/tools/web.mjs` and `native-service/src/agent/web.rs` support the following services. The normal launcher remains the Node compatibility host; the Rust host remains opt-in.

| Setting | Authentication | Request / result fields |
| --- | --- | --- |
| `auto` | Existing configuration | Unchanged: configured Brave, then SearXNG, then DuckDuckGo; optional browser fallback on the compatibility host |
| `brave` | Saved key or `BRAVE_API_KEY` | Existing Brave Web Search API |
| `searxng` | `searxngUrl` | Existing instance `/search?format=json` (JSON must be enabled) |
| `duckduckgo` | None | Existing HTML search |
| `tavily` | Saved key or `TAVILY_API_KEY` | POST `https://api.tavily.com/search`, Bearer header, `query`, `max_results`; `results[].content` |
| `exa` | Saved key or `EXA_API_KEY` | POST `https://api.exa.ai/search`, `x-api-key`, `query`, `numResults`, `contents.highlights`; `results[].highlights` |
| `serper` | Saved key or `SERPER_API_KEY` | POST `https://google.serper.dev/search`, `X-API-KEY`, `q`, `num`; `organic[].link/snippet` |
| `serpapi` | Saved key or `SERPAPI_API_KEY` | GET `https://serpapi.com/search.json`, `engine=google`, `q`, `api_key`; `organic_results[].link/snippet` |

Open **設定 → Web検索 → 設定**, select the service, and optionally enter its key. Blank key fields preserve saved credentials. The existing authenticated `PUT /api/agent/search-key` accepts `provider` and `key` for Brave and the four additions; an empty key removes that provider's saved key. Saved keys take precedence over environment variables. They remain in the local SQLite database, which is not encrypted, and are excluded from public settings/events. Treat database backups as sensitive.

`webSearch` keeps `provider`, `searxngUrl` and `braveKeyEnv`; optional `tavilyKeyEnv`, `exaKeyEnv`, `serperKeyEnv`, `serpapiKeyEnv` customize environment names. Partial settings updates preserve existing fields. Provider names and string fields are validated in both hosts. No existing user configuration is migrated or overwritten by this source change.

The four additions require explicit selection. Saving a key or setting an environment variable never enrolls a service in `auto`. A selected additional provider returns its empty result or fails without sending the query to another service/browser. Query text leaves the device for the selected provider; provider billing/retention terms apply. No account, credential or subscription is created by Tepora.

New adapters return `{title,url,snippet,age}`; malformed result entries and non-HTTP(S) links are skipped. Results are capped at 20 (SerpAPI returns its default page; Tepora does not issue extra pagination requests to fill the count). Tavily uses `basic` without generated answers, raw page content or automatic depth upgrades. Exa requests highlights, without a separate content/answer request. Each request uses the existing checked/pinned `web-tool` network path, a 30-second deadline and a 2 MB response cap. Credential-bearing API redirects are rejected, including same-origin redirects. Stop and network-policy changes cancel the request; native settings/key rotation also invalidates old bindings. No retry is automatically sent to a paid service.

Only bounded static error categories/statuses enter new-provider receipts. Raw response bodies, credential-bearing URLs and transport diagnostics are not copied into search errors. SerpAPI requires the key in its HTTPS query string according to its API contract; it is never returned in tool receipts or followed to a redirect destination.

## Official API references

Reviewed 2026-10-23:

- [Tavily Search reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Exa Search reference](https://exa.ai/docs/reference/search)
- [Serper public response example](https://serper.dev/) and [official request playground](https://serper.dev/playground) (request playground requires login; no login/signup or live request was performed)
- [SerpAPI Google Search reference](https://serpapi.com/search-api) and [organic results](https://serpapi.com/organic-results)

The integration does not use deprecated Google Custom Search.

## Verification scope

`tests/fixtures/web-search-providers.json` is shared by Node and Rust contract tests. Tests check request fields, query encoding, normalization, key absence, empty results, malformed/error responses, 401/429/5xx, redirect rejection, cancellation and denied network policy. Native lifecycle tests retain atomic settings/key snapshots and stale-request cancellation; authenticated process tests cover key save/delete and settings validation without exposing keys in bootstrap/events.

All credentials in these tests are dummy values. No live/paid API acceptance, account billing, remote search relevance, provider-side retention or desktop WebView is certified. Local regression/build results are recorded in the task report.
