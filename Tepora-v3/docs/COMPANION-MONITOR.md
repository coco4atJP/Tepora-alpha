# Companion monitor UI and stacked approvals

This update rebuilds the V3 screen around one idea: a quiet monitor with a character in front,
and work that keeps moving while the person is away. Safety boundaries are unchanged; the
conversation, draft, voice and consent logic is carried over byte-for-byte and still covered by
the existing tests.

## Layout

The screen shows one thing per place. A count, a status or a reply appears once; explanations
and metadata are one click away instead of always on screen.

- **Top bar**: ホーム・仕事・記憶・設定, then only what needs attention: 「AIを接続」 (or the
  network mode when it is not online), **あなたの番 N** when something waits for you (on ホーム the
  amber lamp on the stage is the way in instead, and the dot in the wordmark turns amber on the other
  pages), and **すべて停止** while anything runs. The idle screen, the photo frame, 共有表示 and full
  screen sit in one 画面の表示 menu. In 共有表示 the bar shows only 「共有表示を終える」.
- **Conversation**: on ホーム the message box sits under the character and the latest reply is
  its caption; 「会話の履歴」 opens the full conversation as a column. On 仕事・記憶・設定 a
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

Colour is kept for what calls you. Paper and ink carry everything else, and there is one lamp: a
vermilion mark for the primary action, and an amber lamp only while something waits for you. The
earlier teal accent is gone.

The stage shows the character, what it is saying as a **caption** (there is no balloon), a large
clock with the date, the day's 七十二候 (for example 「秋分 ・ 水始めて涸る」) and the weather as one
line, and one card at a time from a rotating deck: ニュース (the RSS you chose), 音楽 (files from
this PC played in place through blob URLs; nothing is uploaded and the list lasts while the window
is open; YouTube is in 設定), つくったもの (generated images as a photo frame) and 天気 (Open-Meteo,
current/hourly/high-low) — the weather card only when the weather changes what you would do: rain or
snow now or soon, a hot or a cold day. A card appears only when it has something to show; setup
lives in 設定 → ホームと待機画面, and an empty deck leaves a single 「ホームのカードを設定」 link.
Feeds load only with the existing network permission and configured sources.

- **Caption**: the character speaks in this order: what happened while you were away, a fresh reply,
  a request that waits for you, and otherwise a short greeting tied to the hour (the weather is
  mentioned only when it is notable).
- **Work as lights**: each running job is a small light near the character (five places; further
  jobs are only in 仕事). A light shows the title and state on hover and opens the job. A job that
  needs the person is not a light.
- **The amber lamp** appears while anything waits in あなたの番, says how many, and is the one way in
  from ホーム. It is the only control the idle screen keeps.
- **Welcome back**: when the person returns from the idle screen or after the window was hidden for
  a while, the caption says what finished and what waits (「おかえりなさい。確認がひとつ、お待ちです。」),
  and says nothing when nothing happened.
- **Window light**: the backdrop is a quiet room. A soft patch of sun with window-bar shadows crosses
  it with the hour (sunrise and sunset from the Open-Meteo data when weather is set up, otherwise
  06:00 and 18:00), softens under cloud, fog and snow and is gone in rain; the lamp's pool of light
  rises at dusk and on dull days. 七十二候 comes from a built-in table; nothing is fetched for it.

共有表示 hides conversation and work content entirely and removes controls that change work; the
lights carry no titles and open nothing, there is no amber lamp, and personal photos are never shown.

## Idle screen (screensaver) and photo frame

After the idle time chosen in 設定 → ホームと待機画面 (5 minutes by default, or never) the screen
switches to a **待機画面** that behaves like a screensaver.

- **Starts from any quiet view**, not only ホーム. It does not start while a panel or sheet is open,
  the message box has focus or a draft, a message is being recorded, files are attached or an
  artifact preview is open on 仕事; and it **returns to the view the person was on** when it ends.
- **Ends** on a key press, a click or touch, the wheel, or a deliberate sweep of the pointer (about
  100 px within a moment; a nudge or a vibrating desk does not). Input in the first 1.2 s is ignored
  so the action that started it does not end it.
- The conversation and toolbar step aside, the page drifts a few pixels now and then against
  burn-in, and the amber lamp (「あなたの番 N件」) is the only control left.
- Entering the idle screen, or hiding the window for a minute, reports the person as away to the
  service (see stacked approvals below).
- 設定 → 画面をつけたままにする keeps the display awake while the idle screen is shown, using the
  Screen Wake Lock API where the browser or WebView provides it; elsewhere nothing happens and
  nothing is claimed.

**Wallpapers** (設定 → ホームと待機画面 → 壁紙; drawn with CSS only, no remote file or video, and
motionless under `prefers-reduced-motion`):

| 壁紙 | What it shows |
| --- | --- |
| 部屋 (default) | the room: window light and the lamp, following the hour and the weather |
| 無地 | plain paper colour; the home stage gets no window light either |
| ゆらぎ | three soft colour fields drifting slowly (animated) |
| 星空 | a fixed night sky with twinkling stars and now and then a shooting star (animated) |
| 写真 | the photo frame below; with no photos it shows 部屋 |

At night (two hours after sunset until sunrise when the weather data has them, otherwise 22:00 to
06:00) the idle screen switches to the dark **lamp palette** (行灯) instead of dimming the daytime
colours; the night sky and the photo frame use the same palette so text stays readable over a
picture. The optional night dimming also lowers the photos' brightness.

**Photo frame** (設定 → ホームと待機画面 → 写真立て → 写真を管理; 「写真立てにする」 in the 画面の表示
menu starts it at once, asks the window for full screen and keeps the display awake until it ends):

- Photos are chosen from this PC (JPEG, PNG, WebP, GIF, AVIF; HEIC/HEIF where the browser can read
  them). The page prepares each file before uploading: a picture over 3200 px on the long edge, over
  8 MB, or in another format is redrawn as a JPEG (transparency becomes white); GIFs are kept as
  they are. The service stores the files under `<data>/frame/`, recognises
  them by signature, refuses SVG and anything else that is not a picture, limits a file to 24 MB, a
  picture to 120 megapixels, the frame to 300 photos and 2 GB, and keeps one copy of the same picture.
  Photos are served only to an authenticated page (`private`, `nosniff`, sandboxed CSP). They are never
  sent anywhere, and the list the page receives has neither hashes nor file names on disk.
- Shown full screen with a slow cross-fade; the next picture is decoded before it appears and a
  picture that cannot be read is skipped. The interval is 10 s, 30 s, 1 min, 5 min, 15 min or 1 h;
  the order is shuffled (differently each time the frame starts) or as added; the fit is **cover**
  (with a slow zoom unless motion is reduced), **contain** (the whole picture over a blurred copy
  of itself) or **mat** (a paper mount); the clock is off, small or large. The images made in
  つくったもの can be mixed in.
- In the offline preview the photos live in the page only, and 「サンプルを入れる」 adds four drawn
  scenes (one portrait) for trying the fit options.

API: `GET /api/frame`, `PUT /api/frame/photos` (the raw image as the body, the name as
`X-Tepora-Filename`, URL-encoded), `GET|HEAD|DELETE /api/frame/photos/:id`. The list is part of
`/api/bootstrap` and is broadcast as `frame.updated`.

## Character

The home stage shows the **avatar**: a body chosen and shaped in 設定 → キャラクター → 姿を作る. The
default is しろ・改, a small cream figure whose antenna lamp is the dot in `tepora•`. The other
bodies are 灯守, 円相, 小箱, 狐火, 蛍 and 苔玉, each with its own options, and any of them takes the
person's own material, lamp colour, face, ears and small items (the stage composition is not
fixed; the home layout, the window light, the work lights and the amber lamp are placed around
whichever body is chosen). しろ・改 can also be drawn as a solid 3D figure. Instead of any of these a person can bring a
character they already have: a **VRM** model, a picture, a set of mood pictures, or a
**mesh-avatar-studio** project. What the character says (name, instructions, tone, call name,
how often it speaks up) is a separate setting, 人格と口調. See [AVATAR](AVATAR.md).

Its mood is derived from what is actually happening: listening (typing or recording), thinking
(waiting for a reply), talking (a new reply or speech playback), happy (a job reached review),
attention (something is waiting for you), concerned (a recent failure) and sleepy (idle at night).
Every body receives the same mood and a small pose vector, and draws it its own way. It blinks,
breathes and follows the pointer; `prefers-reduced-motion` stops the motion, and is followed while
the page is open. The lamp is the one lamp of the character's own colour (never amber): it dims when
the character is sleepy, glows on the dark lamp palette and never changes colour with the mood.
The amber lamp and the work lights are separate elements around the character.

**VRM, mesh and solid bodies** are loaded only when chosen. The service checks what a person
brings by content (a GLB with the VRM extension and no external references; pictures by signature
and size, never SVG; a mesh project by its exact file list and `rig.json`), stores it only under the
data directory and serves it back to the signed-in page with `nosniff` and a sandboxed CSP.
Rendering uses pinned copies in `web/vendor/` of three.js 0.186.1, @pixiv/three-vrm 3.5.5 and the
mesh-avatar-studio engine at one commit (all MIT; licences and hashes in `web/vendor/VENDOR.json`).
`node scripts/vendor-vrm.mjs` and `node scripts/vendor-mesh-avatar.mjs` refresh them with integrity
checks; nothing is downloaded at runtime. If WebGL or the file fails, or the GPU drops the canvas,
しろ・改 is shown instead and the person is told why. The main page CSP allows `connect-src blob:`
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

**Seals (押印).** An approval is a slip: a plain-language summary, a tag for what it touches (このPC,
クラウド・費用, 外へ送る, 画面操作, 外部の道具), the unmodified request one click away, and a seal.
Requests that run on this PC or may cost money must be **held** on the seal for 0.7 s (a ring fills;
letting go early does nothing); the others are allowed by a tap. With a keyboard or assistive
technology the seal is activated twice — the first activation arms it and says so, the second one, at
least 0.35 s later and within 4 s, stamps it — so a stray Enter or a double click cannot approve. The
stamp lands (a still mark under reduced motion, the hold ring keeps its 0.7 s) and then the
existing approve action runs once; 見送る stays an ordinary button, and 「まとめて確認…」 keeps its
own confirmation that lists each request. The seal changes how a decision is made, not what is
allowed: the approved request, revision and consent checks are the ones described above.

API: `GET/POST /api/approvals` (list; batch decision), `POST /api/approvals/:id`,
`POST /api/presence`, `GET /api/artifacts/:id/revisions[/:version]`. The avatar has its own
routes (`/api/avatar*`, listed in [AVATAR](AVATAR.md)); the earlier `/api/character*` routes are gone.

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
line and the card; a message box that stayed at its old height after the window was resized (it is
measured again whenever the width changes); a toast left floating over the idle screen.

## Verified here / not verified here

- `node --test` (558 tests, including the stacked-approval, home-monitor, one-lamp, photo-frame,
  avatar-model, avatar-assets and voice-lines tests), `node scripts/check.mjs` and `node scripts/improve-loop.mjs
  --capabilities` (worker contracts, scenario traceability, preview build, capability fixtures)
  pass, plus the repository entry tests. The 31 tests added for the lamp work cover the 七十二候
  table, window-light and lamp numbers, the lights' slots, the seal's hold/arm rules, wallpaper and
  palette choice, idle rules, photo signatures and limits, and the photo API (CSRF, hostile names and
  ids, SVG refusal, byte-identical serving, restart, `frame.updated`).
- The Playwright checks in `tests/browser-*.py` and `tests/browser_check.py` pass locally with Python
  Playwright and the installed Google Chrome (`CHROMIUM_PATH`), including `improve-loop --browser
  --capabilities`. They find the browser through `CHROMIUM_PATH`, then `chromium`/`google-chrome` on
  PATH, then Playwright's own. `tests/browser-lamp.py` drives the offline preview through the caption
  and season line, the amber lamp, a short press and a hold on the seal (the approval goes through
  exactly once), the drifting and night-sky wallpapers from another view and waking back to it, the
  photo frame with a real file and the samples (fit and clock options, removal, no photos in the
  shared view), the night lamp palette, dark theme and a 390 px phone.
- Uploading to the real service was checked in headless Chrome with a 5200×3400 picture: the page
  shrank it to 3200×2092 before storing and the frame showed it. The welcome-back caption and the
  photo frame were checked on the offline preview.
- Screens were checked in headless Chrome at 1440×900, 1180×760, 1024×768, 900×700,
  768×1024, 620×800, 390×844 and 360×640, light and dark, including the idle screen, shared view,
  the display menu, panels and sheets, and 160% text at 390 px. The lamp, lights, seal, wallpapers
  and photo frame were reviewed at 1440×900 (light, dark and the night palette) and the home stage
  also at 390×844; they were not reviewed at every width above.
- An end-to-end run against the real service with a scripted (not intelligent) OpenAI-compatible
  peer verified: character handoff → stacked media approval while away → independent work →
  parking → approval from the inbox → exact replay → generated image in the home photo card.
- `tests/browser-avatar.py` runs the real service and drives the studio and everything a person can
  bring: the chips, undo, dice, reset and presets, every mood of the drawn and solid bodies, solid 3D in
  the day, dark and lamp themes, a VRM, a mesh-avatar-studio project, a picture and a set of pictures (made by
  `tests/fixtures/avatar-fixtures.mjs`, so no one's artwork is in the repository), removing the file in
  use, a live reduced-motion change, and a 390 px phone with the preview kept in view. The pixiv VRM 1.0
  sample (`VRM1_Constraint_Twist_Sample`, kept outside the repository) was also loaded and its
  expressions checked in headless Chrome with a software GL.

Not verified: real models, macOS WKWebView or Windows WebView2 rendering, WebKit IME behaviour on
a real keyboard, screen-reader output (the arm-then-confirm seal in particular), GPU/driver
variation for WebGL, long-running idle screens or photo frames on real displays and TVs, the effect
of Screen Wake Lock and full-screen requests inside the native window, holding the seal on a real
touch screen, HEIC/AVIF decoding in the native WebViews, the work lights around a VRM model, VRM
models beyond the sample (VRM 0.x, heavy MToon materials), a real mesh-avatar-studio export (the test
project is synthetic and has no eye or mouth sprites), or the solid body on a real GPU.
