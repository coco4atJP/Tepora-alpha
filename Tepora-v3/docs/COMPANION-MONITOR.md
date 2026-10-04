# Companion monitor UI and stacked approvals

This update rebuilds the V3 screen around one idea: a quiet monitor with a character in front,
and work that keeps moving while the person is away. Safety boundaries are unchanged; the
conversation, draft, voice and consent logic is carried over byte-for-byte and still covered by
the existing tests.

## Layout

The screen shows one thing per place. A count, a status or a reply appears once; explanations
and metadata are one click away instead of always on screen.

- **Top bar**: ホーム・仕事・記憶・設定, then only what needs attention: 「AIを接続」 (or the
  network mode when it is not online), **あなたの番 N** when something waits for you, and
  **すべて停止** while anything runs. The idle screen, 共有表示 and full screen sit in one 画面の表示
  menu. In 共有表示 the bar shows only 「共有表示を終える」.
- **Conversation**: on ホーム the message box sits under the character and the latest reply is
  the speech bubble; 「会話の履歴」 opens the full conversation as a column. On 仕事・記憶・設定 a
  small 「会話」 button opens the same column, and it stays open until closed. Messages carry no
  per-message names or times (time is on hover and marks pauses of 30 minutes or more). Worker
  results are reduced to the job, its state, three lines of the report and one way in; a worker's
  open question keeps its full text and 「回答する」. Character and worker text is rendered as a
  small Markdown subset after escaping; links are shown as text with their address and never
  become clickable.
- **Main area**: its layout follows its own width (a ResizeObserver sets `data-width`), so a
  narrow window and an open conversation both lay out correctly.
- **Panels vs sheets**: task details, the あなたの番 stack and generated media open as non-modal
  panels. Modal sheets are kept for focused edits and confirmations. Escape, the backdrop and the
  close button ask before discarding typed changes.
- **Narrow windows / phones**: one pane at a time with a bottom tab bar (ホーム・会話・仕事・記憶・
  設定). On ホーム the message box takes its own row under the page; jobs scroll sideways above the
  selected one.

## Home stage (smart monitor)

The home stage shows the character, its latest reply (or a short greeting tied to the hour; the
weather is mentioned only when it changes what you would do), a large clock with the date and one
card at a time from a rotating deck: 進めている仕事, 天気 (Open-Meteo, current/hourly/high-low),
ニュース (the RSS you chose), 音楽 (files from this PC played in place through blob URLs; nothing is
uploaded and the list lasts while the window is open; YouTube is in 設定) and つくったもの
(generated images as a photo frame). A card appears only when it has something to show; setup lives
in 設定 → ホームと待機画面, and an empty deck leaves a single 「ホームのカードを設定」 link. When
the weather card is in the deck, the clock line carries only the date. Feeds load only with the
existing network permission and configured sources.

After the configured idle time on ホーム the screen switches to a **待機画面**: the conversation
and toolbar step aside, the page drifts a few pixels now and then against burn-in, and at night
it dims (optional). The only extra element is 「あなたの番 N件」 when something waits. A click or
key press returns. Entering the idle screen, or hiding the window for a minute, reports the
person as away to the service (see stacked approvals below).

共有表示 hides conversation and work content entirely and removes controls that change work; the
work card shows only a count.

## Character

The built-in character is a small cream figure whose antenna light is the dot in `tepora•`.
Its mood is derived from what is actually happening: listening (typing or recording), thinking
(waiting for a reply), talking (a new reply or speech playback), happy (a job reached review),
attention (something is waiting for you), concerned (a recent failure) and sleepy (idle at night).
It blinks, breathes and follows the pointer; `prefers-reduced-motion` stops the motion.

**VRM**: 設定 → キャラクター accepts a `.vrm` (VRM 1.0 or 0.x). The service checks the GLB
container and VRM extension, rejects external file references, stores the file only under the
data directory and serves it back to the page. Rendering uses pinned copies of three.js 0.186.1
and @pixiv/three-vrm 3.5.5 in `web/vendor/` (MIT; licences and hashes in `web/vendor/VENDOR.json`),
loaded only when a VRM is selected. `node scripts/vendor-vrm.mjs` refreshes them from the npm
registry with integrity checks; nothing is downloaded at runtime. The avatar receives the same
moods (expressions, blinking, breathing, gaze, lip movement while talking). If WebGL or the model
fails, the built-in character is shown instead. The main page CSP now allows `connect-src blob:`
so GLTFLoader can decode embedded textures; no remote origin is added.

## Stacked approvals (あなたの番)

Before this change an approval held its worker slot and, after ten minutes without an answer,
was treated as a refusal. Now:

- If someone decides within the **presence window** (about 90 s while the person is present),
  the operation runs inline exactly as before.
- Otherwise a **stackable** operation is kept as a pending request and the worker receives
  `{deferred: true, notExecuted: true}`. It is told never to assume the operation happened and to
  continue independent work. When only dependent work remains it ends its turn and the job is
  **parked** (`waiting_approval`, `parked: true`) without holding a worker slot.
- Stackable: `run_command`, `mcp_call`, `mcp_tools`, `computer_open`, media generation and
  capability disclosure, for work jobs. Live screen operations (`computer_action`,
  `computer_screenshot`, decision-driven control), Codex sessions and conversation-lane
  approvals stay interactive because their state goes stale; silence pauses the job instead of
  counting as refusal.
- A later approval replays **exactly the approved request** (same tool, arguments, task revision
  and consent epoch) through the normal dispatch path, effect receipt and broker grant. A refusal
  is reported to the worker. Steering, pausing, cancelling or a permission change withdraws or
  invalidates pending requests; nothing is replayed after an unknown outcome.
- Parked jobs and their pending requests survive a service restart. While no window is connected
  the service treats the person as away, so requests stack immediately.
- 「あなたの番」collects pending approvals (plain-language summary, the unmodified request one click
  away), worker questions, results to review, stopped jobs and routine/plan proposals that run only
  after a yes. Several approvals can be reviewed and allowed together after a confirmation that
  lists each one, or all refused at once.

API: `GET/POST /api/approvals` (list; batch decision), `POST /api/approvals/:id`,
`POST /api/presence`, `GET /api/character`, `GET/PUT/DELETE /api/character/model`,
`GET /api/artifacts/:id/revisions[/:version]`.

## Fixed in this update

Raw `waiting_approval` in the conversation; duplicated 「作業担当 作業担当」; two different status
vocabularies; Markdown artifacts shown as raw text; collapsed 150 px artifact frames at narrow
widths; buttons wrapping mid-word; state-independent task actions; approvals shown only as raw
JSON; focus and scroll lost on every update; transcript re-announced to screen readers on every
change; missing composer focus indicator and share-toggle state; the lost 「返事を聴く」 entry point;
Enter/Escape during Japanese IME composition in WebKit (`keyCode 229` is now ignored); errors shown
twice; worker-question IDs exposed in the composer; failures masking pending approvals on the home
screen; AI readiness hidden behind 「オンライン」; settings scattered over seven entry points; a
checkbox that needed a separate 「反映する」 button; modal initial focus on 「閉じる」; an expanded
artifact staying expanded after leaving 仕事; the artifact frame reloading (and losing the reading
position) when a version was pinned or the job changed state; the same reply shown twice on the
home screen; the あなたの番 count shown four times; weather repeated in the greeting, the clock
line and the card.

## Verified here / not verified here

- `node --test` (Node suite including the stacked-approval, character-model and home-monitor
  tests), `node scripts/check.mjs` and `node scripts/improve-loop.mjs --capabilities` (worker
  contracts, scenario traceability, preview build, capability fixtures) pass, plus the
  repository entry tests.
- The Playwright checks in `tests/browser-*.py` and `tests/browser_check.py` were updated to the
  current screen and pass locally with Python Playwright and the installed Google Chrome
  (`CHROMIUM_PATH`), including `improve-loop --browser`. They now find the browser through
  `CHROMIUM_PATH`, then `chromium`/`google-chrome` on PATH, then Playwright's own.
- Screens were checked in headless Chrome at 1440×900, 1180×760, 1024×768, 900×700,
  768×1024, 620×800, 390×844 and 360×640, light and dark, including the idle screen, shared view,
  the display menu, panels and sheets, and 160% text at 390 px.
- An end-to-end run against the real service with a scripted (not intelligent) OpenAI-compatible
  peer verified: character handoff → stacked media approval while away → independent work →
  parking → approval from the inbox → exact replay → generated image in the home photo card.
- VRM rendering was checked with the three-vrm VRM 1.0 sample model in headless Chromium.

Not verified: real models, macOS WKWebView or Windows WebView2 rendering, WebKit IME behaviour on
a real keyboard, screen-reader output, GPU/driver variation for WebGL, long-running idle screens on
real displays, or VRM models beyond the sample.
