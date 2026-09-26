# Verification record

Environment: Linux container, Node 22.16.0, Python 3.13, Chromium through Playwright. The product priorities remain Windows/macOS; this environment is a test host, not an additional supported native release target.

## Automated results

- `node scripts/check.mjs`: 18 JavaScript modules passed syntax checking at this revision.
- `node --test`: **21 passed, 0 failed**.
- `python -m pytest -q speech/test_adapter.py`: **2 passed**. These tests inject a stub transcriber and do not measure ASR quality.

Node coverage includes endpoint consent; path traversal/symlink rejection; memory confirmation and cloud sharing; SQLite persistence and interrupted restart status; fragmented UTF-8/tool-call SSE; truncated output errors; the Jev-like request contract; two concurrent work tasks with an independent conversation slot; three persisted artifact revisions; real CLI execution only after approval; denied/cancelled approvals; cancellation of a real child process; stdio MCP initialization/tool calls; authenticated HTTP/CSRF/Origin/Host checks; ephemeral keys and import rules; separate artifact/media CSP policies; SSE replay and Last-Event-ID reconnect precedence; and MCP registration without execution.

## Native CI

GitHub Actions run [36222819002](https://github.com/coco4atJP/Tepora-alpha/actions/runs/36222819002) built Windows NSIS and macOS DMG successfully from commit `9ca9b790a9a81a75ea78715f99e728ef01b5c50f`. Both targets passed the then-current 19 Node tests, generated the preview, prepared the Node sidecar, compiled Tauri and uploaded artifacts. This proves packaging, not application launch or installation behavior.

The subsequent runtime-launch fix adds `--jinja` for llama.cpp, requires an explicit vLLM tool parser, adds two tests (21 total locally), and includes the macOS microphone usage description. Use PR #237 checks for the matching latest native package; do not confuse the earlier build with later source changes.

## Browser checks

The available Chromium has a managed `URLBlocklist` that blocks ordinary URL navigation. That policy was **not disabled**. No browser plugin was available in this environment. The application was rendered by supplying the generated standalone HTML to Playwright's `set_content`; the real loopback backend was exercised separately through Node HTTP tests.

At 1512×1000 and 390×844, the following were checked: initial render, actual sample iframe content after three revisions, task status, memory create/edit, MCP registration UI, skill registration UI, voice and appearance settings, task details, invalid external-media URL rejection, focus timer, ambient mode and Escape, onboarding, task cancellation, and absence of horizontal overflow. **No JavaScript page errors or console errors were observed in that run.**

This does not verify live browser cookie/SSE integration, browser persistence under every file-URL policy, external provider access, native Tauri integration or actual speech/media playback. Screenshots are render captures of the supplied code, not an image-generation concept or a claim that fictional tasks ran.

## Findings corrected during implementation

- Test teardown initially closed SQLite before harness cleanup; fixture cleanup order was corrected and rerun.
- Node fetch did not send an overridden Host as the test expected; the hostile-Host check now uses a real HTTP request with the explicit header.
- Inline artifact scripts would inherit the parent CSP in srcdoc. Live artifacts now have a distinct restricted response rather than relying on an inner meta policy to loosen the parent.
- Media is moved into a capability-addressed separate wrapper, keeping the main frame-navigation policy self-only.
- Growing streamed text was initially durable on every update. Token output and CLI tails now use volatile broadcasts to avoid unnecessary database growth.
- MCP output-limit failure now terminates its process tree rather than leaving a producer running.
- One shared sample template now drives both preview and service, avoiding divergent screenshots and runtime artifacts.

- Real target CI exposed canonical temporary-path differences on macOS/Windows. The path test now compares `realpath` values and passes on both targets.
- Installed runtime launch now explicitly enables llama.cpp Jinja and requires a selected vLLM tool parser instead of silently launching a server unable to handle auto tools.

## Still unverified

Windows/macOS actual application launch and installation; signing/notarization; graceful native shutdown; WebView iframe/navigation/cookie/CSP differences; microphone capture on target WebViews; Qwen or Whisper inference; actual vLLM/DiffusionGemma; external cloud providers; the user's actual Context Hub; Brave/login/YouTube playback; live weather/RSS retrieval; hardware throughput and cost; sustained unattended operation; filesystem race resistance; model-driven adversarial behavior.

A passing controlled test suite is not a substitute for those gates.
