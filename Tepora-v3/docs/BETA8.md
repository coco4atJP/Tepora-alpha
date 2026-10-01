# Tepora V3 beta.8 — abilities that reach the conversation

## Product intent
The home remains a quiet, configurable monitor, not an endpoint dashboard. This release focuses
on concrete interactions: hear a reply, retrieve an earlier preference with different wording,
ask for an image or edit, receive a video without blocking conversation, and connect several tools
without dumping every schema into the model context. Samantha/Joi is an interaction reference,
not a claim of continuous consciousness, human-equivalent understanding or unrestricted autonomy.

## Implemented
- A revisioned registry of **decision / embeddings / TTS / text-to-image / image editing / video**
  endpoints, separate from chat providers. Local, explicit pinned LAN and cloud endpoints share
  the existing egress policy. Auth keys are endpoint-specific, in RAM or explicit environment refs.
- System One typed decisions; OpenAI-compatible Embeddings and Ollama Embed; OpenAI-compatible
  Speech, Images generations and multipart edits; asynchronous xAI video generation/polling.
- Durable media request IDs, unknown-response protection, retained remote request handles,
  bounded download origins, no API key forwarding to media CDNs, local file hashes, byte-range
  playback, deletion and per-file export. Output is labelled ready only after bytes are saved.
- Explicit one-click local reply readout; external readout shows the text/recipient first. A small
  audio player survives other sheets. Mic start, shared presentation, hide and global stop stop
  playback. It does not continuously listen or automatically read every reply. TTS is complete
  clip generation, not low-latency streaming speech. Replies over 4,096 characters require selection.
- Confirmed-memory semantic indexing, hybrid lexical/cosine RRF retrieval, and general bounded
  embedding ranking. Endpoint identity, dimensions and content hashes scope vectors. Original
  text/confirmation/privacy remain authoritative. Remote embeddings only index shared memories
  after consent; main-model recipients retain their own privacy filter. Scope changes while a
  query is running are rechecked before returning results. No trained-model quality is asserted.
- MCP configuration import (up to 100), disabled-by-default storage, separately approved startup
  (up to 12 selected, at most 3 simultaneous), paged tool discovery and relevant tool search.
  Environment secret values are not written into the configuration DB. Stop prevents queued
  servers from starting. Existing MCP tool calls now use the same prepared environment mapping.
- models.dev catalogue import, explicit online refresh, cached/offline search and model-ID copy.
  Metadata never executes package names or grants capability support. Live catalogue freshness
  is not guaranteed until the user refreshes it. No Vercel account, AI SDK or hosted gateway added.
- Official Codex App Server managed browser/device-code login. Login IDs are matched, early
  notifications retained and cancellation cannot start a later login. The current issued auth
  URL can open in the system browser. An existing API-key login is NOT called a subscription;
  changing shared Codex auth needs a distinct confirmation. Tepora does not extract OAuth tokens.
- Two Computer Use controllers: LLM explicit tools versus one-step typed decision selection.
  The decision path batches operation and type-specific candidate selection over a bounded
  observed shortlist, uses explicit supplied text, checks task/screen revision and shares the same
  approval/driver/re-observation boundary. WAIT/BLOCKED/DONE are not success. DONE requires an
  independent observation assertion. A legal candidate is not necessarily the correct or safe
  action for a goal. Probability thresholds only abstain; they do not authorize actions.

## External compatibility and contracts
- Protocol compatibility is not a promise of every provider's account, model, flags or billing.
- Codex managed login needs a sufficiently recent installed official App Server. Tests simulate
  its RPC; no real account was logged in. Service usage follows the account's plan and limits.
- Other subscriptions are not indiscriminately exposed. Claude third-party subscription OAuth
  requires provider approval. OpenCode Go explicitly requires typical coding-agent traffic, a
  self-identifying user-agent and stable conversation session headers; its provider-side balance
  fallback may add charges. A general companion must not impersonate a coding client or assume
  unlimited/free usage. Dedicated additional-plan integrations are not implemented in this build.
- xAI was used for video rather than relying on the retired OpenAI Videos API. Video protocol
  tests use deterministic handles/files, not an actual xAI account or learned generator.
- `models.dev` is optional metadata; undocumented OpenCode 2 implementation changes are not
  treated as established facts. Internal canonical protocols remain vendor-independent.

## Verified mechanisms, not model performance
The regression suite exercises actual HTTP, SQLite, child-process boundaries and local files
using deterministic inference/auth/generation fixtures. The additional capability flow exercises
an actual agent loop -> semantic recall -> prompt-specific media approval -> nonblocking image
and speech handles -> saved artifact/checks -> later media completion. The image fixture is a
known tiny PNG and the audio a valid silent WAV. It is not a creative quality demo.

The Computer Use smoke test uses the actual installed Chromium/Playwright worker on an owned
local HTML fixture. Model and decision responses are scripted. The new typed controller has
separate contract tests; the smoke's legacy choice-helper path is not called a trained-Laya test.

Browser tests use the self-contained preview because the environment's browser policy rejects
loopback navigation. The policy was not altered. The real backend is tested separately. Browser
rendering is not a native WebView, actual OAuth or full external-provider E2E certification.

## Concrete issues caught and fixed during this pass
1. The new media manager lacked the bootstrap snapshot method; integrated HTTP tests caught it.
2. A form input named `id` shadowed `form.id`, so Save silently did nothing. Use getAttribute.
3. A preview UUID depended on a secure context; retain secure random bytes as a fallback.
4. Memory privacy could change while embedding a query. Recheck original records after awaiting.
5. Background media could be reported complete before its bytes arrived. Distinguish acceptance,
   processing, ready and unknown outcomes; retain a pending-media note on the parent job.
6. Stopping a batch closed active MCP connections but could start queued ones afterwards. An
   epoch now invalidates all remaining starts. Existing already-run commands cannot be undone.
7. Gallery updates detached unrelated video elements. Update keyed cards without detaching players.
8. The audio stop path removed the element before pausing it. Pause the active player first.
9. Existing Codex API-key auth was being interpreted as subscription auth. Check account type,
   and require explicit consent before changing the shared CLI's authentication.
10. Managed login URLs need the OS browser in a restrictive native host. Only the current issued
    allowlisted auth URL is opened; arbitrary user URLs are not accepted at that API.

## Limits that remain
- No learned-model accuracy/latency/cost benchmarks, production accounts, real TTS/ASR listening
  study, long-running 24/7 soak, native Windows/macOS or installer/signing tests this turn.
- No new local image/video runtime/weights. Heavy dependency provisioning still is not zero-config.
- No complete OAuth catalogue for third-party tools or all paid subscription plans.
- Generated media files are individually downloadable but NOT bundled in the existing context
  export. Auth sessions, workspace files, remote-provider copies and full uninstall ownership are
  not a complete portable archive. SQLite content remains unencrypted at the application layer.
- No provider-side generation cancellation guarantee; already submitted work may continue billing.
- Named capabilities currently have one selected endpoint per role, not an automatic fallback chain.
- Capability resource leases are bounded but not global GPU memory reservation/preemption across
  all processes. Offline policy is application egress control, not an OS firewall or a guarantee
  about a local server's own upstream forwarding.
- TTS is an explicit clip, not a full-duplex real-time speech-to-speech companion. Actual Japanese
  semantic recall, speech and action-selection quality require measurements on chosen models.

## Reproduce
```
npm run improve:check
npm run test:capabilities
npm run improve:full
```
`full` uses already installed Python/Playwright and Chromium; never downloads models or spends
provider credits. The watcher checks changed source bytes, not unattended code generation.
The release archive is checked by extracting it elsewhere, matching hashes, running the same
gates and comparing rebuilt preview bytes. Test counts are never called PDCA-loop counts.
