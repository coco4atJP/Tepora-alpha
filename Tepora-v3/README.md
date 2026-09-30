# beta.9 companion continuity

See [the beta.9 milestone and its limits](docs/BETA9.md), [current verification](docs/STATUS.md), and [architecture](docs/ARCHITECTURE.md).

# Tepora V3 · 3.0.0-beta.8

A quiet, customizable smart monitor that can keep working while you talk.
Local-first, provider-neutral, with explicit control over cloud/LAN access.
This is an executable **development beta**, not a finished replacement for the operating system.

## Start

Unzip and run in `Tepora-v3` with Node **22.16 or newer**:

```sh
node core/server.mjs --open
```

No runtime `npm install` is required for the core service. Use its printed launch URL (contains
an ephemeral token); do not share that URL. The service binds to loopback with cookie/CSRF,
Host/Origin and CSP controls. Windows/macOS Tauri build sources are included separately.

For a model-free UI preview:

```sh
node scripts/build-preview.mjs
```

Open `tepora-v3-preview.html`. The preview explicitly refuses AI inference, account login, real
MCP startup and PC operations; it does not invent working AI output. Its sample revises an
artifact three times. Real requests need configured runtimes or providers.

## What to do in the UI

**接続 → 能力をつなぐ** adds independent decision, embedding, voice, image/edit and video endpoints.
Select an endpoint for each role. There is no need to move the main LLM to the same provider.
A local embedding/TTS service can run alongside a cloud text model; a local VLM can supply image
observations to that text model. A lossy observation retains the source image's privacy scope.

**返事を聴く** requests speech. A configured local endpoint needs one explicit speaker click;
an external endpoint first displays the text and recipient. Playback lives beside the input,
not in a modal you must keep open. Starting the mic or sharing the display stops playback.

**つくったもの** starts text-to-image, image editing, text/image-to-video or explicit readout.
The exact text, input image and provider are confirmed before creation. Progress and stored
results remain available while you keep talking. A received request ID is not a finished result.

**記憶 → 意味で探す** builds/queries a bounded semantic index. Prefer a local embedding endpoint.
Remote indexing is opt-in and restricted to confirmed shared memories. Lexical search remains
available offline or when the optional embedding endpoint fails. Similarity is not truth.

**接続 → 設定をまとめて取り込む / まとめて接続** accepts `mcpServers` JSON. Review imported
configuration, then select which connections to start. They are not launched just because they
were imported. Discovered tools are searched on demand instead of filling every prompt.

**モデル一覧を探す** imports/refreshes optional models.dev metadata and can use its cached JSON
offline. It never installs packages from metadata or treats a capability listing as a passed test.

**Codex設定 → ChatGPTの契約でサインイン** uses the installed official App Server's managed
browser/device-code flow. Tokens stay with Codex; no token extraction. Existing API-key auth is
reported separately and is not silently converted. Limits and billing follow the account.

## Supported API families

| Role | API adapter in this build |
| --- | --- |
| Main/chat/work/vision/dictation | Chat Completions, Responses, Anthropic Messages, Gemini generateContent |
| Typed decisions | System One `state + questions -> answers`, including Laya multilingual/Jev-compatible servers |
| Embeddings | OpenAI-compatible `/embeddings`, Ollama `/embed` |
| TTS | OpenAI-compatible `/audio/speech` |
| Images | OpenAI-compatible `/images/generations` and multipart `/images/edits` |
| Video | xAI asynchronous `/videos/generations` and `/videos/{request_id}` |

Protocol support is not universal provider/model/auth compatibility. Keys are bound to their
endpoint in RAM or referenced by environment variable. Editing an endpoint invalidates its key.
Generated-file origins must be explicitly approved and never receive the model API credential.
No Vercel account, hosted gateway, or Vercel AI SDK dependency is introduced.

Additional subscription plans have provider-specific scope/auth requirements. This build does
not impersonate other clients or treat a coding-only plan as unlimited general-purpose inference.
Official OpenCode Go's required coding/session-header integration and other subscription OAuth
flows are not implemented; Codex managed login is the new concrete subscription connection.

## Local floor and optional workers

Use **接続と使い始め** to detect already running local servers. If Ollama is already installed,
the UI supports confirmed model acquisition, interruption/resume and a safe tool-use probe.
Automatic OS runtime installation, all model weights and platform drivers are still not bundled.

Optional Laya multi-language worker:

```sh
python -m pip install -r workers/requirements-laya.txt
python workers/laya_server.py --model-dir /path/to/installed/laya-multilingual --device cpu
```

Use a dedicated environment. Model acquisition must be explicit; pin an approved revision when
using `--allow-download`. Connect base URL `http://127.0.0.1:8767/v1`, System One protocol, model
`multilingual`. The worker remains independent of the main LLM. Published latency/accuracy claims
are not this release's measurements. No GPU/model inference was run in its verification.

Streaming Qwen3-ASR adapter needs an explicitly installed supported `qwen-asr[vllm]` environment:

```sh
python workers/speech_server.py --model /path/to/installed/Qwen3-ASR-checkpoint --port 8768
```

Windows may require WSL/a supported inference host. Captured chunks are 200 ms, **not a 200 ms
latency claim**. Existing speech capture, local semantic-draft editing and protected manual edits
remain. No full-duplex voice, wake-word/diarization or Pixel-equivalent quality claim is made.
New local TTS/image/video/embedding runtime managers are deliberately not added.

## Computer Use and work

Choose **LLM / typed decision / both** in the Computer Use settings. The LLM lane issues explicit
observed-control actions; the decision lane batches operation and matching current target choices.
Both pass through the same consent, observation revision, bounded driver and independent result
checks. Neither a high probability nor a model's DONE is completion evidence.

Owned browser automation and selected Windows UIA are included. Python, Playwright and a local
browser are optional dependencies. Windows UIA is not verified on a real Windows machine; macOS
full-desktop accessibility control is not implemented. Existing private browser profiles are not
copied. Host CLI and MCP execution are **not** OS-sandboxed and remain explicitly permissioned.

The background harness retains conversation/work lanes, durable checkpoints and effect receipts,
steering, scoped approvals, interrupted-work handling, accepted-vs-verified results, work plans,
routines, provider routing, bounded recovery and per-task workspaces. See [BETA8](docs/BETA8.md).

**Full offline** restricts Tepora-controlled calls to already available on-device capabilities.
**Trusted LAN** permits the specifically pinned inference endpoints, not the whole LAN. Public
network calls and uncontained host tools are blocked in restricted modes. This is not an OS
firewall, and cannot prevent a user-run local server from forwarding data elsewhere on its own.

## Verification and 100-scenario traceability

```sh
npm run improve:check        # syntax, all Node tests, Python contracts, scenarios, preview
npm run test:capabilities    # actual harness/HTTP/files with deterministic capability fixtures
npm run improve:full         # also UI and owned-browser Computer Use; existing browser required
npm run improve:watch        # recheck only after source changes; Ctrl+C stops
```

`spec/Tepora_V3_100_Scenarios_v2.json.gz` preserves the user's original specification and digest.
`spec/answers.mjs` maps every original scenario to real source/test files and remaining work.
`node scripts/verify-scenarios.mjs` writes the traceability report; **it does not certify 100 user
journeys**. `docs/BETA8.md` records the implemented paths, observed defects/fixes and limits.
The release is re-extracted, hashed, re-tested and its generated preview compared byte-for-byte.

No real provider account, paid API, learned generator, Laya/ASR accuracy benchmark or multi-week
soak was used. Browser policy in the validation environment blocks loopback navigation, so the
unchanged self-contained UI and real backend HTTP tests are separate evidence. Native CI sources
are included, but no GitHub push, CI run or new signed installer is claimed for this artifact.

## Data and exit

Confirmed memory and task state are separate. Shared skills under `~/.agents/skills` are read-only
references with explicit enabling and task-local hashes, never owned by Tepora. Appearance presets
cannot change runtime/network permissions. Shared display is presentation privacy, not account isolation.

Generated media are saved locally with integrity hashes and individual downloads/deletion. Existing
context export does **not** package media bytes, workspace files, credentials or entire runtimes.
Application data are currently unencrypted in SQLite and depend on OS/disk protections. Deletion
cannot remove exported or provider-side copies. Do not treat this as a completed secure backup or
full uninstall-ownership system. Already submitted generation may continue/cost money provider-side.
