# Capturing the Screenshot Set

How every screenshot in `docs/` and on runmaestro.ai gets made: Showcase Mode
seeds a fake workspace, and `capture.js` drives the running app over Chrome
DevTools Protocol to photograph each surface in each theme.

Run it when the UI has moved enough that the published set misreports the app,
which in practice is a few times a year.

---

## The two halves

**Showcase Mode** is the SET: `scripts/showcase/seed/data/` holds a fictional
twelve-agent fleet, a group chat, settings, and window bounds. `setup.js` copies
that into a throwaway data directory and `launch.js` starts the dev app against
it. Nothing here touches your real workspace.

**The capture driver** is the CAMERA: `capture.js` opens each surface and
shoots it.

They are separate because the set is reusable. `npm run dev:showcase` gives you
the same fake workspace to click around in by hand, with no capture involved.

---

## Running it

```bash
# Everything: every shot, all three published themes
npm run capture:showcase

# One theme while you iterate
npm run capture:showcase -- --themes pedurple

# A few shots, left running so you can look at the app afterwards
npm run capture:showcase -- --themes dracula --only main-screen,cue-dashboard --keep

# A set destined for the website, shot against a neutrally-located checkout
npm run capture:showcase -- --cwd /Users/maestro/Projects/Maestro
```

| Flag           | Default                             | What it does                                                              |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `--themes`     | `dracula,catppuccin-latte,pedurple` | Comma-separated theme ids from `THEMES` in `src/shared/themes.ts`.        |
| `--size`       | `2480x1400`                         | Logical window size. The published set is this, which is 4960x2800 at 2x. |
| `--only`       | all                                 | Comma-separated shot names from `shots.js`.                               |
| `--out`        | `docs/screenshots`                  | Output directory.                                                         |
| `--cwd`        | this checkout                       | Working directory the demo agents point at (see below).                   |
| `--typography` | `default`                           | Typography preset id from `src/shared/typographyPresets.ts`.              |
| `--keep`       | off                                 | Leave the app running after the last shot.                                |

Output is `<out>/<shot>.<theme>.png`, so a docs page or the website gallery can
switch themes by substituting one path segment.

---

## What to know before you trust a run

**The path in the Files panel is published.** `$CWD` in the seed becomes a real
directory, because a made-up one renders an empty file tree, which looks broken
rather than anonymous. The default is whatever checkout you ran from, so a set
going on the website should use `--cwd` pointing at a clone living somewhere
neutral.

**A first-run modal will cover the hero if the seed misses it.** The onboarding
series shows one modal per step, each with its own seen flag, so a step added
later defaults to unseen. `setup.js` reads `ONBOARDING_STEPS` out of
`src/shared/onboardingSeries.ts` and refuses to seed when the settings file does
not dismiss every one, which turns a ruined run into a loud error. If you see
that error, add the named flag to
`scripts/showcase/seed/data/maestro-settings.json`.

**The set is shot in the Default typography preset, not the store default.**
Maestro was monospace everywhere before per-surface fonts existed, and the
store still defaults that way so a returning user's app does not change
underneath them; a new install is steered to the proportional `default` preset
by the typography step of the onboarding series. This seed dismisses that step,
so `setup.js` writes the preset explicitly, or every shot would come out in
`hacker` and advertise a look nobody is offered any more. The twelve values are
loaded out of `src/shared/typographyPresets.ts` rather than copied into the seed
JSON, so retuning the Default face moves the published set on the next run.
Pass `--typography hacker` to shoot the monospace look deliberately.

**The seed widens both side panels, deliberately.** `leftSidebarWidth` and
`rightPanelWidth` in the seed settings are 470 and 575 against app defaults of
256 and 384. The app's defaults are the MINIMUM each panel supports, and at the
minimum both are visibly degraded in ways that photograph badly: the Left Bar
drops the MAESTRO wordmark entirely (it renders in full or not at all, so there
is no partial state) and wraps "UNGROUPED AGENTS" onto two lines, while the
Files toolbar sheds its button labels and the footer sheds the words around its
counts. A screenshot is read as what the product looks like, so the published
set shows each panel with the room its own layout gates ask for. Widen further
only if a shot needs it - every pixel here comes out of the main window, which
is the subject of most of the set.

**The seed zooms the interface to 1.1.** One `fontZoom` setting rather than
twelve retuned sizes: zoom is a multiplier over whatever the typography preset
wrote, so it scales every surface by the same ratio and preserves the
proportions the preset was tuned at, and it is the same knob `Cmd+=` moves.
`applyTypographyVars` publishes it as the root `font-size`, so rem-based
spacing, the `.modal-w-*` widths, and the per-surface sizes all follow together
rather than the text growing inside chrome that did not. Nudging it is the one
lever for "the set reads too small"; do NOT scale `TYPOGRAPHY_PRESETS` to get
there, which would change what the app ships.

**The window has to fit the operator's display.** The shot is a real window,
not an emulated viewport, so a window larger than the screen is clamped by the
window manager and every image comes out undersized while the run still reports
success. `assertViewport` reads `innerWidth`/`innerHeight` once the shell has
painted and fails the theme when they disagree with `--size`, and the run logs
the viewport it got. `2480x1400` needs a display of at least about 2560x1440
logical; pass a smaller `--size` on a laptop panel rather than letting it clamp.

**The seeded execution queue is HELD, and it has to be.** Twelve items are
seeded across three agents (7 on Maestro, the active one, plus 2 and 3
elsewhere) so the Execution Queue reads `Current Agent (7)` against
`All Agents (12)` rather than the same number twice. Every one of them carries
`paused: true`.

That is not decoration. `useQueueProcessing` drains any agent that is `idle`
with a runnable item, on the first render after the session load - well before
the shutter - and `nextRunnableQueueItem` skips paused items and returns the
first one that is not, so the hold is all-or-nothing. Seeding the queue without
it means the showcase app spawns real provider processes against the seeded
prompts, and the count drifts from run to run.

Seeding `state: 'busy'` on the agent instead does NOT work, though it looks like
it should: it was tried, and two of seven items dispatched anyway, leaving a
real "Session not found" error in the transcript behind the modal. The `HELD`
badge on every card is the honest cost of a set that is identical on every run.

Nothing about the hold reduces what the surface demonstrates: depth, per-tab
grouping, the model and effort pills, Send Now, and the edit / reorder / delete
/ copy controls are all present and all live, and a held queue is a state a
user can genuinely reach. Editing a queued message from the showcase app works
normally - pausing blocks dispatch, not editing.

`src/__tests__/shared/showcaseSeed.test.ts` holds the seed to that: every item
paused, the queue spread over more than one agent, every `tabId` resolving to a
real AI tab, and no em or en dash anywhere in the file. Nothing else reaches
this data - `scripts/` is in ESLint's global `ignores`, the dash-only pass
matches `.mjs` / `.js` / `.cjs` and never `.json`, and Prettier checks only
whitespace.

**An Encore-gated surface is refused rather than shot.** `openUiSurface` turns
down a surface whose Encore Feature is off, and the driver treats that as a skip
instead of photographing whatever is behind it. Concerto, Pianola, Plugins,
Coworking, and Groups+ default OFF, so the seed turns them on; a new gated
surface needs the same.

**The driver waits for paint, not for a port.** The bridge file and the CDP
target both exist while the splash is still up. Readiness is the splash being
gone AND the Left Bar header having rendered. When it times out it prints the
splash's own progress line, which names the gate that stalled.

**The app window has to be in front, or nothing finishes.** Chromium suspends
`requestAnimationFrame` in a window it thinks is hidden or fully occluded, and
Maestro lifts its splash from inside a double rAF. The first launch of a run
comes to the front on its own and every launch after it opens behind your
terminal, so themes two and three used to load completely and then sit on the
splash until the driver gave up. The driver calls `Page.bringToFront` on every
readiness poll and before every shot, and that is still not enough on its own:
whether macOS honors it depends on what else grabs focus during a 20-minute
run. So once the Left Bar has rendered with the splash still up, the driver
waits `SPLASH_GRACE_MS` and then calls the app's own `window.__hideSplash()` -
the function the rAF callback would have called, whose internals are timer- and
promise-driven rather than rAF-driven. It only ever reveals a shell that has
already rendered. Practically: the run owns your screen while it is going, and
a single-theme run is not evidence that a full one works.

**Every shot presses Escape first, including the ones that open a surface.**
Only the full-window DESTINATION modals close each other; everything else
LAYERS. A run that opened one surface per shot without clearing the last one
accumulated a stack and photographed whichever modal happened to sit on top, so
eleven shots in one run came back byte-identical to four others. Nothing
errored: the bridge answers `success: true` for a modal that opens behind
another, which is why the run reported a full set while filing the same picture
under several names. It is also what made `--tab` look broken on Cue - the
modal was already mounted, so the deep-link had nothing to do.

---

## What this set does NOT cover

The shot list reaches every surface in `UI_SURFACES`, and that registry holds
MODALS. A large share of what the docs and the website publish is not a modal
but an app STATE - a file tab open on a CSV, a terminal tab, a git log, a group
chat, the composer in command mode - and `open_modal` cannot express any of
them. Reaching those needs two things this rig does not have yet: seed data
that contains them (the seeded fleet has AI tabs and nothing else, no
`cue.yaml`, no `stats.db`) and a shot verb that can drive the app into a state.

Known gaps, all currently published somewhere:

| View                                                     | Why it is out of reach                 |
| -------------------------------------------------------- | -------------------------------------- |
| `tabs-code`, `tabs-csv`, `tabs-json-jq`, `tabs-markdown` | no file tabs in the seed               |
| `tabs-terminal`, `tabs-browser`                          | no terminal/browser tabs               |
| `git-diff`, `git-logs`                                   | not in `UI_SURFACES`                   |
| `group-chat`, `group-chat-over-ssh`                      | a view, not a modal                    |
| `document-graph`                                         | destination lives outside the registry |
| `command-interpreter`                                    | composer state                         |
| `chat-code-latex`, `chat-mermaid`                        | transcript content                     |
| `achievements`                                           | not in `UI_SURFACES`                   |
| `autorun-1`, `autorun-2`                                 | Right Bar tab, no playbook seeded      |
| `wizard-inline`                                          | inline wizard state                    |
| `mobile-chat`, `mobile-groups`, `mobile-history`         | web-desktop at a phone viewport        |

Separately, most of `docs/screenshots/` is CROPS rather than full windows (95
of 113 at the last audit): a toolbar strip, a right-click menu, a settings row.
Those are deliberate and this rig does not try to reproduce them.

---

## Changing what gets shot

`shots.js` is the shot list, and it is editorial rather than generated.
`UI_SURFACES` in `src/shared/uiSurfaces.ts` is everything that CAN be opened;
the shot list is what is worth publishing.

```js
{ name: 'cue-pipeline', surface: 'cue', tab: 'pipeline', settleMs: 1600 }
```

- `name` is the output basename. Renaming one orphans every doc embedding it.
- `surface` is a `UI_SURFACES` id, opened through the same `open_modal` path
  `maestro-cli open` uses. Omit it for the main window with nothing open.
- `settleMs` buys time for a surface that loads async (charts, the Cue canvas).

---

## Why it is built this way

**The bridge opens, CDP only shoots.** Surfaces are opened over the WebSocket
bridge because that is the same path `maestro-cli open` takes, so it honors
Encore gating and the modal layer stack: a shot can never capture a state a user
could not reach. CDP is confined to `Page.captureScreenshot` and an Escape
keypress, so the driver cannot drift from what the app supports.

**One launch per theme.** The theme is applied by seeding settings before the
app starts. Switching live would leave a repaint race on exactly the surfaces
that are slowest and most worth photographing.

**There is no `close_modals` verb, deliberately.** A main-window shot presses
Escape, the same key a user presses, rather than reaching for a back door that
could drift from the layer stack.

---

## Related

- [THEMES.md](../../THEMES.md) - the theme gallery and Showcase Mode commands.
- `scripts/showcase/` - seed data, setup, launcher, shot list, driver.
- `src/shared/uiSurfaces.ts` - the surface registry the shot list draws from.
