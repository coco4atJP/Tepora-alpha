# Model connections and ChatGPT plan authentication (beta.11)

## Ordinary service / desktop

Open **Settings → AI connection → 知能と通信の使い分け**. The existing protocol adapters and Tepora's harness remain in use; no third-party agent runtime replaces the conversation, memory, or tools.

- The connection editor includes 22 templates: local Ollama, llama.cpp, vLLM and LM Studio; OpenAI, Anthropic, Gemini, OpenRouter, Vercel AI Gateway, Groq, Cerebras, Together, Fireworks, NVIDIA, DeepSeek, Mistral, xAI, Moonshot, Z.ai and OpenCode Go; user-managed CLIProxyAPI and LiteLLM. Templates only fill protocol/domain/base URL. Select a model yourself and check actual account/model support. Azure/Bedrock/Vertex-specific authentication is not implemented by these templates.
- API keys remain scoped to the saved endpoint/protocol. The **モデル一覧** button performs a user-approved catalog request, not inference or proof of entitlement. Manual model IDs remain available. Server catalogs have a 500-model display cap; pagination and every provider's specialized catalog API are not implemented.
- **ChatGPTプランで接続 → Continue with ChatGPT → OpenAIの認証ページを開く** uses the official public-client registration flow. After consent, return to Tepora, choose an account's **モデルを選ぶ**, select a model, and register it. Later accounts/profiles do not silently replace existing routes. Configure role assignments explicitly.
- ChatGPT and API-key profiles cannot share an automatic fallback chain. Neither another ChatGPT account nor a paid API key is an automatic escape from a subscription limit. ChatGPT's own plan/credit limits remain controlled in ChatGPT; Tepora does not promise unlimited/free calls or disable charges configured there.
- CLIProxyAPI/LiteLLM are optional user-managed endpoints. Tepora does not install, launch, update, or authenticate these proxies, read their credentials, or bypass their upstream terms. A loopback proxy may forward to the internet; Tepora's network mode cannot firewall another process.

## OAuth and credential boundaries

`core/provider-auth.mjs` owns a fixed `127.0.0.1` ephemeral callback listener at `/auth/callback`, one-use state, nonce, S256 PKCE, dynamic client registration, issuer/audience/time/nonce/signature validation against OpenAI's JWKS, and explicit `chatgpt.tokens.use.direct` permission checking. RS256 and ES256 are accepted; unrecognized JWT algorithms/key types fail closed. The callback listener is separate from, and does not weaken, the app's cookie, CSRF, Host or Origin checks.

Each installation persists its opaque host ID. Each verified subject/client-ID registration has a distinct local account ID and label, including multiple workspaces with the same email. Reauthorization reuses the issued client ID and checks the original subject. Sign-out retains the registration but removes tokens, aborts associated requests, and attempts remote revocation; an unconfirmed revocation is disclosed. Reauthorization hints are deliberately omitted rather than returning an ID token to browser JavaScript.

Credentials live in `<Tepora data directory>/credentials/chatgpt.json`, outside SQLite, context exports, browser storage and event logs. Writes use atomic replacement; POSIX file/directory modes are 0600/0700. **This is not encrypted storage or OS keychain integration. Windows uses the user's directory ACLs; configure those appropriately.** Do not share or commit this file. Corrupt storage is preserved and authentication disabled rather than overwritten. The existing service-owner lease excludes a second owner of the same data directory; in-process refresh is single-flight per account. Separate copies of the credentials in different directories must not share refresh ownership.

Subscription profiles are bound to `https://api.openai.com/v1` + Responses + a verified local account. No Codex auth-file import, private `backend-api` endpoint or static Codex OAuth client ID is used. The shared Rust encoder supplies full history, `store:false`, `stream:true`, namespaced local function tools and omits unsupported subscription parameters. An incomplete stream is not accepted as successful inference. Model choices come from the selected account's `models` array with `visibility: list`, preserving order. Catalog availability is not quality or completed-inference certification.

## Native development host boundary

The ordinary Node compatibility service and packaged desktop can perform OAuth. The opt-in standalone **`--dev-native` host does not yet own OAuth login/refresh**. It preserves the new profile fields/identities, rejects API keys on subscription profiles, blocks mixed-auth fallback chains, and fails subscription inference/probes before network dispatch with an explicit instruction to use ordinary launch. It does not silently reinterpret a subscription profile as a paid API profile. Shared Rust wire-format changes are used by the ordinary service through N-API as well.

The standalone host's dedicated model-catalog button is also not ported in this change; its existing metadata catalog, manual model configuration, and API-key inference remain available. This change is not a full native-host cutover.

## Verification scope

Tests use synthetic tokens, generated signing keys, mocked OpenAI responses, isolated data and real loopback callback HTTP. They cover state/nonce/issuer/audience/signature rejection, missing plan permission, account separation, token rotation/single-flight, cancellation/logout races, redacted public state, corrupt storage, credential pinning, fallback boundaries, and shared Rust request/response restrictions. No real ChatGPT login, user subscription, paid API, proxy upstream, remote model quality, or packaged Windows/macOS sign-in is certified by fixtures.

## Upstream contracts

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://developers.openai.com/siwc/website (published JWKS and identity validation)
