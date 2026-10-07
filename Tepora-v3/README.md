# Tepora V3 · 3.0.0-beta.11

A quiet, customizable smart monitor that can keep working while you talk.
Local-first, provider-neutral, with explicit control over cloud/LAN access.
This is an executable **development beta**, not a finished replacement for the operating system.

## Start

The repository root also provides `npm start`, `npm run quality`, `npm run desktop` and
`npm run build`. This checkout contains V3 only; earlier application sources and documentation
are available through Git history.

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
artifact three times. Real requests need configured runtimes or providers. The avatar studio works in the
preview with the drawn and picture bodies (files you bring stay in the window only); the solid 3D, VRM and
mesh bodies load their renderers from the service and are not available there.

## Companion monitor

The home screen is a quiet monitor: the character (an avatar you shape yourself, or one you bring: **VRM**, a picture, a mesh-avatar-studio project) with its
latest reply as a caption and the message box underneath, a large clock with the day's 七十二候 and
the weather in one line, and one card at a time — news, music from this PC or images you made, each
shown only when it has something to show. Running work is a small light beside the character; one
amber lamp says that something needs you, and colour is kept for that. The room behind follows the
hour and the weather.

After a few idle minutes the screen becomes a **待機画面** that works like a screensaver: it starts
from any quiet view, returns to where you were on a touch, a key or a sweep of the pointer, and shows
a wallpaper (room, plain, drifting colour, night sky) or your own photos as a digital photo frame.
Photos stay on this PC. Things that need you — approvals, worker questions, results to review,
stopped jobs — collect in **あなたの番**; an approval is a slip you allow by stamping its seal (held
for a moment when it runs on this PC or may cost money). While nobody is at the screen, operations
that need approval are kept there and other work keeps moving; the exact request runs only after you
allow it. See [COMPANION-MONITOR](docs/COMPANION-MONITOR.md).

## Persistent character conversation

Talk to the same character from the message box under it on ホーム; **会話の履歴** (or the 会話
button on other pages) opens the full conversation as a column beside your work. Work details and
artifacts open beside it; they do not redirect the composer. There are no continue/new/side
conversation modes to manage. The character can delegate work and keep responding in its separate
chat lane.

**設定 → キャラクター → 姿を作る** shapes how the character looks (and brings a character you already have; see [AVATAR](docs/AVATAR.md)); **人格と口調** edits how it answers, apart from its look: the character's and worker's names and instructions, and the character's tone, call name and how often it speaks up. Existing jobs keep
their pinned versions. **回答する** targets one worker's exact pending question; ordinary
chat never silently answers an unrelated worker. Tool approvals remain separate from answers.

Worker reports arrive in the character conversation with their source and verification state.
Ask about a result naturally. If the character and worker use different recipients, **引用を
会話に共有** (in the job's details) lets you review and explicitly share only a bounded result excerpt. No raw tool logs
are sent back into the character context. Legacy memories are preserved but not automatically
injected into either new role; full V2 CHAR/PROF migration is not included.

## What to do in the UI

**設定 → 声・画像・意味検索 → 能力の接続 → 管理** adds independent decision, embedding, voice, image/edit and video endpoints.
Select an endpoint for each role. There is no need to move the main LLM to the same provider.
A local embedding/TTS service can run alongside a cloud text model; a local VLM can supply image
observations to that text model. A lossy observation retains the source image's privacy scope.

**読み上げる** (under the latest character reply) requests speech. A configured local endpoint needs one explicit speaker click;
an external endpoint first displays the text and recipient. Playback lives beside the input,
not in a modal you must keep open. Starting the mic or sharing the display stops playback.

**仕事 → つくったもの** starts text-to-image, image editing, text/image-to-video or explicit readout.
The exact text, input image and provider are confirmed before creation. Progress and stored
results remain available while you keep talking. A received request ID is not a finished result.

**記憶 → 意味で探す** builds/queries a bounded semantic index. Prefer a local embedding endpoint.
Remote indexing is opt-in and restricted to confirmed shared memories. Lexical search remains
available offline or when the optional embedding endpoint fails. Similarity is not truth. The local native-agent candidate also connects semantic index/search and agent memory tools with explicit external consent, lexical fallback and scoped cancellation. It remains an opt-in development host; normal Node launch and JavaScript/CSS are unchanged. See [native scope and verification](native-service/README.md).

**設定 → 仕事の実行 → 道具（MCP）→ まとめて追加 / まとめて接続** accepts `mcpServers` JSON. Review imported
configuration, then select which connections to start. They are not launched just because they
were imported. Discovered tools are searched on demand instead of filling every prompt.

**設定 → AIとの接続 → モデルを探す** imports/refreshes optional models.dev metadata and can use its cached JSON
offline. It never installs packages from metadata or treats a capability listing as a passed test.

## Supported API families

| Role | API adapter in this build |
| --- | --- |
| Main/chat/work/vision/dictation | Chat Completions, Responses, Anthropic Messages, Gemini generateContent |
| Typed decisions | System One `state + questions -> answers`: Liquid d1 (cloud) and the local Laya multilingual worker |
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
flows are not implemented.

## Local floor and optional workers

Use **AIを接続** (top bar) or **設定 → AIとの接続** to detect already running local servers. If Ollama is already installed,
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

## Agents

The character is the resident chief of staff: it talks with you, delegates anything substantial to
asynchronous work agents (as many as you like), receives their reports and decides what to tell you.
The loop does not stop on failures; it classifies and recovers (backoff and failover, learned waits for
slow models, overflow and silent-truncation recovery, truncated replies continued, broken tool arguments
repaired). Long work is compacted with an exact ledger kept by the harness, chapter summaries that are
never re-summarised, and lossless `recall` / `history_search`. The prompt prefix only changes in batches,
so provider caches keep hitting. Agents are self-aware in a measured way: the harness appends the facts of a
run (context use, failures, a stalled checklist, stated confidence) when they matter, and each agent keeps its
own account of what is verified and what is only assumed (`reflect`), which survives compaction verbatim. The
decision-model checks learn from their own record, after Dream-RSI: every check is kept as an episode, outcomes
label it, and alternative thresholds and questions are replayed offline and adopted only when they do better. Design: [docs/AGENT-HARNESS.md](docs/AGENT-HARNESS.md).

Work agents run shell commands, read/write/edit files (images too), search and read the Web
(question-focused reading returns only the relevant sections), generate media, keep a checklist,
use skills (`~/.agents/skills`, Agent Skills format), MCP tools and plugins (`<data>/plugins/*.mjs`,
which may also hook tool calls, requests and turn ends), and operate a computer.

**Protection is off by default**: commands run directly on this computer, in a work folder (`~/Tepora`).
One setting confines them: work folder only (Seatbelt/bubblewrap), read-only, or a container. Approval
rules (`allow` / `ask` / `deny`) can be added per tool and argument pattern. An optional spending limit
pauses work instead of stopping it.

## Computer use

Work agents operate a Chromium-family browser over the DevTools protocol (headless by default, one tab per
agent, nothing to install) and, on macOS, desktop apps through the Accessibility API (a small Swift helper
built on first use; needs the Accessibility and Screen Recording permissions). The preferred way is
**decision-model control**: the agent gives a small goal, the text to enter and checks that prove
completion; the decision model (Liquid d1 or Laya) picks each next action from controls that exist on
screen, with probability gates, freshness checks and local verification. Without a decision model the
agent's own model chooses from the same shortlist. Direct actions (click, type, key, scroll, screenshot,
coordinates) are always available too.

**Full offline** restricts Tepora-controlled calls to already available on-device capabilities.
**Trusted LAN** permits the specifically pinned inference endpoints, not the whole LAN. Public
network calls and uncontained host tools are blocked in restricted modes. This is not an OS
firewall, and cannot prevent a user-run local server from forwarding data elsewhere on its own.

## Verification and 100-scenario traceability

```sh
npm run improve:check        # syntax, all Node tests, Python contracts, scenarios, preview
npm run test:capabilities    # agent -> embedding/image/speech endpoints -> files, deterministic fixtures
npm run test:computer        # real headless browser: direct actions, decision loop, screenshot (+ macOS helper)
node scripts/eval-agent.mjs --run --url http://127.0.0.1:8080/v1 --model <model>   # real-model eval with metrics
npm run improve:full         # also UI and owned-browser Computer Use; existing browser required
npm run improve:watch        # recheck only after source changes; Ctrl+C stops
```

`spec/Tepora_V3_100_Scenarios_v2.json.gz` preserves the user's original specification and digest.
`spec/answers.mjs` maps every original scenario to real source/test files and remaining work.
`node scripts/verify-scenarios.mjs` writes the traceability report; **it does not certify 100 user
journeys**. [QA](docs/QA.md) records the current gates and their limits.
The current source manifest records source hashes; validation of a source checkout does not certify a native installer.

No real provider account, paid API, learned generator, Laya/ASR accuracy benchmark or multi-week
soak was used. Browser UI, native installations and real-container isolation need separate validation.
The branch defaults, CI and native builds now target V3; see [STATUS](docs/STATUS.md) for what
was actually checked. Local tests do not establish a successful remote CI run or signed installer.

## Data and exit

Confirmed memory and task state are separate. Shared skills under `~/.agents/skills` are read-only
references with explicit enabling and task-local hashes, never owned by Tepora. Appearance presets
cannot change runtime/network permissions. Shared display is presentation privacy, not account isolation.

Generated media are saved locally with integrity hashes and individual downloads/deletion. Existing
context export does **not** package media bytes, workspace files, credentials or entire runtimes.
Application data are currently unencrypted in SQLite and depend on OS/disk protections. Deletion
cannot remove exported or provider-side copies. Do not treat this as a completed secure backup or
full uninstall-ownership system. Already submitted generation may continue/cost money provider-side.
