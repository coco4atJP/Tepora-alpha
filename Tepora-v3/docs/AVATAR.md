# Avatar foundation (表示基板)

The character you see on the home stage is an **avatar**. What the character says and how it
answers is a **persona**. They are two separate things with two separate settings, stores and
APIs: any persona can wear any avatar, and changing one never changes the other. Nothing links
them in the data; a future "starting point" that fills in both would be a UI shortcut, not a link.

```
 state of the app ──► mood ──► pose vector ──► renderer (a "body")      ← avatar (display)
 persona (name, instructions, tone, call name, speaking frequency) ──► replies, fixed lines  ← persona (response)
```

There are no existing users, so this replaces the earlier `display.companion` switch
(しろ／あたたか／3Dモデル／表示しない), the single-model `/api/character*` routes and the drawn-only
character module outright. Nothing is migrated.

The default is **しろ・改**. A person can change every part of it, switch to another body, or bring
a character they already have (VRM, a picture, a set of pictures, a mesh-avatar-studio project)
instead of starting over.

## The contract between the app and any body

The app never draws. It tells a body three things and the body decides how to show them.

| Input | Meaning | Source |
| --- | --- | --- |
| `mood` | one of `idle listening thinking talking happy attention concerned sleepy` | `companionMood()` from what is really happening (typing, recording, waiting for a reply, a job reaching review, something waiting for you, a recent failure, night on the idle screen) |
| `pose` | a small vector derived from the mood: `energy valence alert focus lamp near speech` (0..1, `valence` −1..1) | `moodPose(mood, level)` in `web/avatar/pose.mjs` |
| `look`, `level` | gaze in −1..1 and speech loudness 0..1 | pointer, playback |

A body is `{setMood(mood), setLook(x,y), setLevel(v), setTheme(theme), setReduced(on), destroy()}`;
`createAvatar()` in `web/avatar/stage.mjs` returns one whatever the body is. Which renderer runs
follows `avatar.body` and `avatar.render`:

| Kind | Bodies | Loaded | Lamp |
| --- | --- | --- | --- |
| drawn (SVG) | しろ・改 (default), 灯守, 円相, 小箱, 狐火, 蛍, 苔玉 | in the main bundle; works offline and in the preview | drawn with the body |
| picture | one picture (PNG, JPEG, WebP, AVIF, GIF) or a **mood set** (one picture per mood, optional mouth-open picture) | in the main bundle | drawn around the picture |
| `vrm` | any VRM 1.0 / 0.x model | `/vrm-stage.mjs` with the pinned three.js and three-vrm, only when chosen | a small overlay beside the head |
| `mesh` | a project made with mesh-avatar-studio (a layered illustration moved by a mesh rig) | `/mesh-avatar.mjs` with the pinned engine, only when chosen | the same overlay |
| `solid` | **しろ・改 in 3D** (`render: "solid"`) | `/three-body.mjs` with the pinned three.js, only when chosen | a real light: the bead glows and lights the body |

Two rules hold for every renderer. Anything that fails to load, or whose GPU context is lost,
falls back to しろ・改 (flat) and the person is told why once; a choice that is replaced while it is
still loading says nothing. And no renderer runs while it cannot be seen: the 3D and mesh
renderers pause when the window is hidden or the figure is off screen, draw at 30 frames a second
(the mesh engine always; the solid body and VRM draw every frame only while talking, listening,
celebrating or asking for attention) and release their GPU context when they are destroyed.

Where a body stands, and how 大きさ (0.8–1.25) applies:

* Drawn bodies and the solid しろ・改 share one 200×224 box on the stage. The solid figure is framed so
  its outline, lamp and feet land where the flat figure's do (its canvas reaches 10% beyond the box so
  raised hands and the halo are not cut), so the glow, the work lights and the amber lamp line up
  whichever is chosen. 大きさ scales the box.
* A picture someone brings is usually the whole character edge to edge, so it gets a box 1.45 times
  larger, kept in proportion and standing on its bottom edge.
* A VRM model or a mesh project has proportions of its own and fills the stage width; 大きさ sets its
  height from 64% to 100% of the stage (80% by default).
* A body drawn on a canvas carries the character's name for screen readers (`role="img"`), as a drawn
  body does.

### How each body reads the pose

* **Drawn bodies** use CSS custom properties and classes on one SVG per body: the same lamp,
  breathing, blinking, a small act now and then while idle, and `cx-still` for reduced motion.
* **Solid しろ・改** is built from a few primitives (an egg/mochi/tall body, eyes, cheeks, brows,
  ears, a bent stem with the lamp, optional glasses, headphones, cup, fan, petal, leaf or scarf)
  from the same spec as the flat one. It needs no model file and fetches nothing. Mood becomes
  posture (lean toward you when listening, a tilt when thinking, a bounce and raised hands when
  happy, one raised hand when something needs you), the face (lids, a smile or worried brows, an
  open mouth for speech) and the lamp (brighter when something needs you, dim when sleepy). The
  face slides over the body to look at the pointer. Materials follow the palette (ceramic is
  glossy, felt and moss are soft); the room's theme (day, dark, lamp) sets the light, and the
  lamp always adds its own.
* **VRM** (`web/vrm-stage.mjs`): arms are lowered from the T-pose, chest and spine breathe, the head
  follows gaze and tilts with mood, and the model's own expressions (`happy`, `sad`, `surprised`,
  `relaxed`, `blink`, `aa`, `oh`) carry the face; whatever a model does not have is skipped. Framing is
  bust or full body (a body slot). Spring bones and look-at are the model's own. A VRM 0.x model's
  normalized bones are turned half a circle about Y, so its turns about X and Z are mirrored; without
  that its arms would rise instead of rest. 動き scales the sway and breathing.
* **Mesh** (`web/mesh-avatar.mjs`): the engine owns the face, hair and sway. Mood becomes one of its
  emotion tags (`happy` and `sad` also play its nod and sigh once as the mood begins), speaking and a
  voice level drive the lips, the eyes follow the pointer, sleepy closes the lids and thinking looks
  up and aside. With reduced motion the head and body hold still and only the face, blinks and lips
  move. At night the picture is dimmed and warmed.

## The avatar spec (the "recipe")

One small object, validated by the same code in the browser and in the service
(`web/avatar/model.mjs`, like `display-model.mjs`). Only enumerated values and bounded numbers are
accepted. Unknown keys, free text, URLs, markup and anything about permissions are refused.

```json
{
 "schema": 1,
 "body": "shiro",
 "render": "flat",
 "palette": "washi",
 "hue": 30,
 "lamp": {"hue": "vermilion", "shape": "bead"},
 "face": {"eyes": "capsule", "cheeks": true, "brows": true},
 "parts": {"ears": "none"},
 "props": {"season": "off", "hobby": "none"},
 "slots": {},
 "motion": "normal",
 "size": 1,
 "asset": null
}
```

* `asset` points at a file in the library (`image`, `imageset`, `vrm`, `mesh` bodies need one).
* `render` is `flat` or `solid`; only bodies that declare a `solid` mode (しろ・改 so far) accept it.
* `lamp.hue` never offers amber: amber is the colour of "waiting for you". The lamp keeps its colour
  for every mood.
* Every body declares its own `slots` (shape, brush, screen face, framing, …), so adding a body adds
  options without touching the schema.
* Switching body keeps what is personal (material, lamp, props, motion, size) and resets what
  belongs to the old body (its slots, ears, a file).
* The spec is saved with a revision, an undo history, a reset, and an export/import
  (`tepora-avatar` v1). A preset can never carry capabilities, endpoints, files or permissions.

The studio lives in 設定 → キャラクター → 姿を作る: a live preview that stays in view while the choices
scroll, every mood to try, bodies, materials (eight plus one chosen by hue, all kept readable), lamp
colour and shape, face, ears, small items, per-body options, flat or solid, size and motion, a dice,
undo, reset and presets.

## The asset library

People bring what they already have: a VRM, a picture, a set of pictures, a mesh-avatar-studio
project. Files are inspected by content (never trusted by name), stored under `<data>/avatar/<id>/`,
served only to the signed-in page with `nosniff` and a sandboxed CSP, and never sent anywhere.

* `vrm`: a GLB that declares VRM; external references are refused. The licence and author in the
  file are shown in the library.
* `image`: a picture by signature and size. SVG is refused because it can carry script.
* `imageset`: up to 12 mood pictures plus an optional second "mouth open" picture for talking; the
  page guesses which picture is which mood from the file names and asks to confirm.
* `mesh`: `rig.json` (version 1, finite numbers, bounded image size) and the layer pictures under
  `built/` (`layers.json`, `base`, `hairmask`, the four parts of each eye, optional sprites and
  tassels). Only those paths are accepted.

Multi-file kinds travel as one request: a small container (`TPAK1`, a JSON manifest followed by the
file bytes) that the page builds from the chosen folder. Limits: 96 MB and 200 files per asset,
24 assets, 1 GB in total, and 80 MB for a VRM.

API: `GET|PATCH /api/avatar`, `POST /api/avatar/undo|reset|import`, `GET /api/avatar/export`,
`GET /api/avatar/assets`, `PUT /api/avatar/assets` (headers `X-Tepora-Asset-Kind`,
`X-Tepora-Filename`), `GET /api/avatar/assets/:id/files/<path>`, `DELETE /api/avatar/assets/:id`.
`avatar` and `avatarAssets` are part of `/api/bootstrap`; `avatar.updated` and `avatar.assets`
are broadcast. In the offline preview the files stay in the window as blobs.

### What is loaded from where

Nothing is fetched from another origin. The page serves only an explicit list of files: the
bundle, `avatar.css`, the three lazily loaded renderers, and these pinned copies under
`web/vendor/` (each recorded with its SHA-256 in `web/vendor/VENDOR.json`, and checked byte for byte
against what the service serves by `tests/avatar-assets.test.mjs`):

| Package | Version | Licence |
| --- | --- | --- |
| three | 0.186.1 | MIT |
| @pixiv/three-vrm | 3.5.5 | MIT |
| mesh-avatar-studio engine (`mesh-avatar/`) | git `8713e85a00e50f5cdf8fe33294b961d1d6506fc9` | MIT, © 2026 Yuki Shindo |

`node scripts/vendor-vrm.mjs` and `node scripts/vendor-mesh-avatar.mjs` are maintainer tools: they
fetch exact versions, refuse a file whose hash differs from the one pinned in the script, and
record the result. Nothing is downloaded at runtime. The licence files and `VENDOR.json` are kept
in the folder but not served.

## Persona and voice

The persona's character now has structured style next to its free instructions:

```json
{"name": "Tepora", "instructions": "…",
 "voice": {"tone": "polite", "callName": "", "proactive": "normal", "lines": {}}}
```

* `tone` picks a tone pack (`web/voice-lines.mjs`, shared by the browser and the service): the fixed
  lines the screen speaks (greetings, welcome back, "something needs you", "finished") and a
  matching style hint for the model. `lines` lets a person rewrite any of those lines.
* `callName` is how the character addresses the person; `proactive` is `quiet`, `normal` or `chatty`.
* The model receives name, instructions and the style hint. The screen-only `lines` never reach it.
* A persona never widens permissions; that rule is unchanged.
* It is edited in 設定 → キャラクター → 人格と口調, apart from 姿.

## Checked and not checked

Checked in this change: the spec and registry (`avatar-model.test.mjs`), the library, inspection,
API, restart and static serving of the lazily loaded parts (`avatar-assets.test.mjs`), voice and
persona (`voice-lines.test.mjs`, `dialogue-ui.test.mjs`), and the whole thing in a real browser on
the real service (`browser-avatar.py`, with things made by `tests/fixtures/avatar-fixtures.mjs`: a VRM
1.0 and a VRM 0.x humanoid, a mesh project with drawn eye and mouth sprites, square, wide and tall
pictures, and a picture set): all seven drawn bodies in every mood, the studio's controls, undo,
dice, reset and presets, solid 3D in every mood and theme and in the flat figure's box, 大きさ on the
solid body and on a model, the lamp's colour and shape (or none) beside a model, the name for screen
readers, the four kinds of thing a person brings, a live reduced-motion change, and a 390 px phone. How the drawn bodies look in the day, dark
and lamp themes, and what happens when the GPU drops a mesh canvas, were checked by looking at
headless-Chrome screenshots and a scripted context loss, not by assertions, as were the pose of the
VRM 0.x humanoid (arms resting) and the mesh sprites changing with the mood (closed eyes when sleepy,
an open mouth when talking). The pixiv VRM 1.0 sample (`VRM1_Constraint_Twist_Sample`) was also
loaded, outside the repository, in bust and full framing.

Not checked: real VRM 0.x models and VRM models other than that sample (heavy MToon materials, other
rigs; the 0.x model checked is a synthetic one), a real mesh-avatar-studio export (the test project is
synthetic, though it carries sprites, hair strands and the same files and fields), real GPUs
and drivers (the checks ran on a software GL), the macOS and Windows native webviews, and a person
actually living with the solid body for a while.

## Not decided here

Screen layouts that fix the composition (a room scene, a shoji frame) are out: the stage stays
composable. The home layout, window light, work lights and the amber lamp are unchanged and are
placed around whatever body is chosen. Only しろ・改 has a solid mode; the other bodies are flat
until someone draws a 3D version of them against the same spec.
