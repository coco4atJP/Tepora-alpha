# Actual pi-ai model connections — V3 beta.11

## What runs

`@earendil-works/pi-ai` **1.3.0** is a pinned production dependency, not a copied list or an unused import. The normal Node service and packaged desktop route `engine: "pi-ai"` profiles through `PiAIService` → isolated `pi-worker.mjs` → the SDK's `builtinModels().streamSimple()`. Login uses the SDK's `login()` interaction contract and credential refresh uses its `CredentialStore`. Tepora retains its agent loop, Rust-owned state/context/accounting, tools, workers and approvals.

The actual SDK exposes **42 provider entries, 1,614 chat-model entries and 9 OAuth implementations** at this version. Entries are provider/model pairs, not 1,614 unique model weights. **39 providers have a chat adapter enabled in Tepora**: Bedrock and Vertex have dedicated transports that have not been connected to the network guard, and Typesafe has no chat models. These entries remain visible with a disabled explanation. Listing a model is not proof of account entitlement or live inference quality.

Tepora applies a narrow, dated [OpenCode Go metadata supplement](../core/pi-catalog.mjs) to this SDK snapshot. It adds `minimax-m3.1-flash-free` and `step-5-preview`, updates `deepseek-v4.1-flash`, `mimo-v2.6-flash` and `muse-spark-1.3-contributor` to the current `/inference/go/openai/v1` endpoint and preserves interleaved reasoning during tool continuation. Muse retains the SDK's Responses API; MiMo retains Chat Completions. The total application catalog therefore differs from the upstream count. It uses the SDK's existing authentication and adapters in both host and Worker. Existing account snapshots require explicit refresh; no saved user profiles or credentials are rewritten automatically. OpenCode dispatch identifies the client as Tepora and sends a stable per-conversation `x-opencode-session` header. This does not establish Console Logs visibility, model availability or account entitlement.

The nine OAuth implementations are **OpenAI (ChatGPT), OpenAI Codex (legacy), Anthropic, GitHub Copilot, OpenRouter, Kimi Coding, Meta, Radius and xAI**. OpenRouter's OAuth mints an API key and is not a free subscription allowance. The SDK at this version has no built-in Gemini CLI/Antigravity OAuth, so no such support is advertised. Protocol support and account/provider terms are separate: use only accounts and third-party integrations permitted by their service, organization and plan. Tepora does not confer permission or guarantee free usage.

## Source launch and UI

Use Node **22.19.0 or newer** (CI uses 22.22.0), Rust stable and the normal platform build tools:

```sh
npm ci --prefix Tepora-v3 --ignore-scripts
npm start
```

Open **設定 → AIとの接続 → 知能と通信の使い分け → pi-aiで接続**. Choose the provider, search/select a model, choose account authentication or an explicit API key, inspect the destination and save a named profile. **アカウント / OAuth** presents provider-specific browser/device-code/manual-code/choice/secret prompts from the SDK. A connection has its own local account ID and does not silently replace another conversation/work route.

The former 22 manual templates remain under **ローカル / カスタム接続** for local inference servers and custom endpoints. Existing profiles and the legacy ChatGPT registration/vault are preserved, not automatically migrated or deleted. New pi-ai profiles really use the SDK; old manual profiles still use the legacy adapters. The 32 saved-profile bound is an active-configuration limit, not the provider catalog size.

The built-in catalog is the baseline. The authenticated, consent-required `/api/pi/models/refresh` operation persists the SDK's complete returned chat-model definitions for the selected local provider/account in the private credential vault. An account snapshot replaces that account's baseline, including an empty result; it is not shared with other accounts or manual-key profiles. Save validation, context/pricing metadata and each isolated inference worker resolve the same account-scoped definition, including after service re-open. Unsupported transports, new unregistered endpoint scopes and credential-bearing model headers are rejected rather than synthesized. SDK-version changes require explicit refresh before cached definitions can be reused. No silent SDK/model download or live inference occurs during catalog refresh.

## Security, cancellation and accounting

- All SDK fetches run through the host's existing `NetworkPolicy`: endpoint scope, DNS address classification/pinning, cloud/LAN/offline modes, redirect denial, body/stream bounds and deadlines remain enforced. Workers inherit no environment keys, proxy variables or SDK endpoint overrides. Bedrock/Vertex native transports fail closed rather than bypassing these controls. Account-derived Copilot individual/business/enterprise API origins are explicitly checked; arbitrary enterprise auth hosts are not supported.
- `credentials/pi-ai.json` is separate from SQLite, session exports and browser storage. Atomic replacement uses POSIX 0600/0700 permissions and the user's Windows directory ACLs. **This is not encryption or OS keychain integration.** Preserve the private data directory; never commit or share it. Corrupt credential files are retained and authentication is disabled, not overwritten.
- The existing exclusive service-owner lease plus per-account in-process locks serialize refresh/write operations. Caller cancellation returns promptly and stops model dispatch/output; an already-leased OAuth refresh may finish its bounded credential commit before its isolated Worker drains, so a rotated token is not discarded. Logout, network revocation and close hard-cancel associated work; a late refresh cannot restore disconnected credentials. Re-login edits the selected local registration; identity/tenant semantics are delegated to the provider SDK, not normalized across services.
- Re-login clears the selected registration's catalog before credentials can change; logout withdraws credentials and blocks late refresh publication while retaining non-secret cached metadata for editing. Newer refreshes supersede older completions; cancellation, network revocation, close and failed persistence cannot publish a replacement. The cache remains outside SQLite/exports and shares the vault's private permissions and bounded atomic writes.
- Disconnect removes the local credential and stops its operations. It does **not** guarantee remote token revocation; revoke app access at the provider when required. Automatic Copilot model-policy changes are blocked: users must enable any required model in their provider settings themselves.
- Fallback chains cannot change account or cross OAuth/API-key billing classes. No automatic paid-API escape from subscription limits. Account/plan-side credit charging remains controlled by the provider, not Tepora.
- Streaming text/thinking/tool calls are converted to Tepora's canonical result. Provider-native signatures and response IDs survive replay only on the identical profile; changed routes/accounts use canonical messages. Rust compaction also bounds old pi-ai `toolCall.arguments` payloads without deleting signatures. Missing wire usage is unknown, not invented as zero. Interrupted output after a delivered delta is not silently retried or duplicated.

Each operation starts an isolated Node Worker; this favors contained SDK globals and cancellability over worker-start latency. A resident worker pool has not been benchmarked or introduced.

## Host and distribution boundary

This is the **ordinary Node/Tauri host**, not full migration of pi-ai to Rust. The experimental standalone `--dev-native` host refuses SDK profile inference, probes, keys and editing before dispatch. It does not implicitly start Node or reinterpret the profile as a paid API connection.

`bundle-dependencies.mjs` copies lockfile-resolved production modules and their license files into Tauri resources. No dev CLI dependency or runtime npm install is required in the packaged service. Cross-platform installers and real WebView OAuth callbacks still need real-device acceptance; copying the dependency tree is not a signed release certification.

## Verification

Deterministic tests execute the installed **real SDK**, with synthetic credentials and mocked upstream responses; no live account, user quota or paid inference is used.

```sh
node --test Tepora-v3/tests/pi-ai.test.mjs Tepora-v3/tests/pi-ai-refresh.test.mjs Tepora-v3/tests/pi-model-catalog.test.mjs Tepora-v3/tests/pi-ai-http.test.mjs Tepora-v3/tests/pi-packaging.test.mjs
npm run quality
npm run test:native
```

The focused suite covers all nine actual OAuth implementations; login choices, PKCE/callback and manual/device-code exchanges; streamed model inference and tool continuation; missing usage; serialized refresh; cancellation/logout races; invalid endpoint/account/billing boundaries; no retries after partial output; authenticated HTTP routing/CSRF/prompt freshness; and loading the SDK from staged production dependencies. Shared Rust tests cover native argument compaction and refusal by the unported standalone host.

UI validation used the actual settings modules and styles with an in-memory bridge/catalog fixture: provider/model selection, save/re-edit, generic API-key login, secret-field retention during polling, OAuth selection and disconnect. Desktop 1440×1050 and mobile 390×844 rendered without horizontal overflow or page errors. The environment blocks browser access to localhost, so this was a component harness, **not live-browser end-to-end OAuth**. The real app HTTP lifecycle was exercised separately by Node integration tests.

Not established by fixtures: live provider policy acceptance, every catalog model, paid usage, arbitrary enterprise tenants, sustained rate-limit behavior, performance under heavy parallel inference, real Windows/macOS callback browsers or final installer startup.

## Upstream

- Pi source and API documentation: https://github.com/earendil-works/pi/tree/main/packages/ai
- Pinned implementation and license: `node_modules/@earendil-works/pi-ai` (installed from the lockfile, not committed)
