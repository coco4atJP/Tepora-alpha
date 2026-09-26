# V3: boundaries before features

## Product direction

The default surface is not a chat transcript or a settings dashboard. It is a companion smart display: time and presence on the left; emerging work on the right; ambient media/information below; one always-available composer. A user can ask for work, continue a separate conversation, inspect an artifact, or stop the entire queue without leaving this surface. There is no kiosk lock and no attempt to make the operating system inaccessible.

The current implementation is an isolated V3 subtree. V2's Rust/Axum/React/Tauri application and its EM-LLM store remain intact in the parent repository. Its warm theme and architectural intention are preserved, but its internal database and runtime are not silently reused. The V3 loopback service is new Node 22 code. This is a deliberate reversible beta boundary, not a claim that the V2 Rust backend was fully ported or integrated.

## Module map

```text
Tauri native host (or ordinary browser for source edition)
  └─ web/app.mjs          interactions and screens
      ├─ ui.mjs          escaped UI + replaceable companion renderer
      ├─ voice.mjs       user-initiated PCM capture
      ├─ bridge.mjs      real HTTP/SSE OR explicit visual preview
      └─ demo.mjs        deterministic sample shared with the service

Protected loopback HTTP service
  ├─ server.mjs          authentication, CSRF, routes, CSP, SSE
  ├─ harness.mjs         independent conversation/work lanes and tools
  ├─ store.mjs           SQLite documents, revisions, bounded event history
  ├─ runtime.mjs         OpenAI-compatible models + optional System One
  ├─ mcp.mjs             small MCP stdio/HTTP client
  ├─ connectors.mjs      process launch, weather, RSS, media, ASR forwarding
  └─ policy.mjs          endpoints, workspace paths, input bounds

Optional external processes (not downloaded on first run)
  ├─ llama.cpp / Ollama / LM Studio
  ├─ vLLM in WSL or a compatible host
  ├─ DiffusionGemma structured_server.py
  ├─ speech/server.py → Qwen3-ASR or faster-whisper
  └─ Context Hub or other user-configured MCP servers
```

The same real frontend source generates the standalone preview. Preview operations are deliberately bounded to configuration/memory editing and the fixed sample task. A free-form request does not produce an invented model response. External videos are not fetched in preview mode.

## Concurrency contract

There is one conversation slot plus 1–4 work slots (default 2). Work commands do not consume the conversation slot. This is application-level scheduling; an underlying inference server may still serialize requests or be constrained by VRAM. We do not promise simultaneous GPU execution just because the harness is asynchronous.

A task owns its AbortController, messages, pending approvals, and steering queue. It reads a snapshot of runtime settings on start. Additional instructions are inserted at the next model turn, not spliced into an in-flight model request. Tool calls inside one turn run sequentially; independent tasks run concurrently. Artifacts are published before a final answer and can be revised with the same ID. A task cannot overwrite another task's artifact.

Task states are queued → running ↔ waiting_approval → completed/failed/cancelled. On process restart, unfinished durable records become interrupted. We intentionally avoid automatic side-effect replay. There is no checkpoint-resume guarantee for a half-executed external CLI or MCP request.

SSE carries durable event sequence numbers. Reconnection can replay recent committed events; when history was trimmed, a full snapshot is returned. Token-stream updates and CLI log tails are volatile, avoiding quadratic database writes for growing text. A reconnect may miss an intermediate token but later updates carry the full current prefix. Slow SSE clients are disconnected rather than buffered without limit.

## Model contract and cost

The baseline is an OpenAI-shaped HTTP API, not a required OpenAI account. Models, endpoint, and key source are user-selected. No cloud provider is hardcoded as an invisible fallback. Context, output token budget, task step count, and work concurrency are bounded. Setting tool schemas is not a guarantee that every compatible provider/model can use them correctly.

The optional System One adapter uses the actual question/criteria schema from vLLM's DiffusionGemma example. Its result is a routing hint in the agent context. It does not decide authorization, establish whether evidence is true, or replace the main working model. Calibration, latency, quantization, VRAM requirements and utility have not been benchmarked in this delivery.

## Memory

Each record has an ID, source, timestamp, confirmation flag and sharing scope. User-entered memories are confirmed; proposed or imported memories require approval. Retrieval is currently conservative lexical matching, including short Japanese segments. It is **not** an implementation of V2's EM-LLM, vector retrieval, learned memory consolidation, conflict resolution, automatic decay or a personal knowledge graph.

Cloud retrieval requires both the global share permission and each record's shared scope. Unconfirmed records are not retrieved. Conversation history is separated by local/cloud origin to avoid automatically carrying a previous local transcript into a cloud conversation.

Context export contains memories, artifacts and skills, not model API keys or executable connection settings. Import currently accepts only memories, with fresh IDs, unconfirmed and private. Skills and endpoint configuration are never executed or enabled merely because a context file contains them.

Database encryption and OS-keystore persistence are not provided. Session keys are in memory; an environment-variable name may be persisted. The storage directory inherits OS permissions. Users requiring at-rest secrecy should use OS disk encryption and a dedicated account.

## Execution and trust

The web service binds only to 127.0.0.1 on a random port. The launch capability exchanges for an HttpOnly/SameSite cookie; write endpoints also require a CSRF token. Host and Origin checks resist ordinary cross-site access and DNS rebinding. There is no permissive CORS.

Workspace helpers reject absolute paths, traversal and symlink components. They are guardrails for the file tools, **not a race-proof filesystem sandbox**. CLI execution runs the real executable on the real host under the current user, with an argument array and no implicit shell. Every call requires explicit approval. Command output, time and memory-facing buffers are bounded; child process trees are terminated on cancellation when the platform permits it. This does not reverse completed side effects.

MCP registration does not start a server. Connection and tool invocation require approval. Incoming server outputs are data, not authorization policy. stdio and Streamable HTTP tools are implemented; sampling, OAuth flows, roots negotiation and the newer Tasks extension are not claimed. Context Hub owns its existing cross-device synchronization; Tepora does not recreate or bypass its pairing and safety policy.

The text rendered in the UI is escaped. HTML artifacts are loaded from a separate authenticated response with an opaque sandbox origin, no fetch/network/font/image source except bounded data/blob images/fonts, no forms, no parent-page access and no top-navigation/popup permission. The parent application's frame navigation is self-only. YouTube uses a separate capability-addressed wrapper with its own narrowly scoped frame policy, preventing the artifact frame from directly navigating to YouTube as an exfiltration channel. This policy needs real WebView2/WKWebView adversarial verification before production claims.

Downloading an HTML artifact and opening it outside Tepora loses these in-app policies; the UI explicitly warns about this. Do not equate an exported HTML file with a sandbox.

There is no privilege escalation helper, desktop screenshot/click tool, credentials broker, unrestricted computer-use daemon, or guarantee against a malicious program after the user approves it. Those are explicit future subsystems, not hidden capabilities.

## Native shell and distribution

Tauri is a thin host for the exact same loopback UI. An unmodified Node executable plus the core/web source is bundled as resources. The host launches the sidecar with a fixed script path, uses its local startup URL, and allows only the selected loopback port as top-level navigation. Frontend native shell/filesystem permissions are empty.

Closing the window asks the service to cancel tasks and close storage, then forces termination after a bounded interval. The source/browser edition can instead be stopped with Ctrl+C. Native close semantics and media navigation are not yet tested on either target OS.

The implementation intentionally avoids a required service subscription, third-party gateway, hosted vector store, or proprietary plugin registry. Language/runtime choices can change without changing the HTTP/event contract. A companion renderer can be replaced independently from the harness. A production plugin loader for Live2D, VRM and user assets is still future work.
