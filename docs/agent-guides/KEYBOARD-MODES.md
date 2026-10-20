---
type: reference
title: Keyboard Modes
created: 2026-10-20
tags:
  - keyboard
  - shortcuts
  - vim
---

# Keyboard Modes

How Maestro runs two complete keyboard binding sets off one table of actions:
the persistence model, the resolver that turns a sparse override bucket into a
live binding set, the invariants that keep a mode switch from stranding the
user, and the tests that enforce each of them.

Read this before touching `src/renderer/constants/shortcuts.ts`,
`src/renderer/constants/vimShortcuts.ts`, `src/renderer/constants/deckMode.ts`,
`src/shared/effectiveShortcuts.ts`, or the shortcut slice in
`src/renderer/stores/settingsShortcutsSlice.ts`. The user-facing reference is
[docs/keyboard-shortcuts.md](../keyboard-shortcuts.md); this file is the
architecture behind it.

---

## 1. One live mode, two persisted buckets

`KeyboardMode` (`src/shared/shortcut-types.ts`) is `'default' | 'vim'`, with
`KEYBOARD_MODES` as the ordered list, `KEYBOARD_MODE_LABELS` as the one spelling
of each name in user copy, and `asKeyboardMode()` as the only way to narrow an
unknown value. Anything arriving from outside the renderer's own state (a
persisted setting, a hand-edited settings file, an older build) goes through
`asKeyboardMode()` rather than a cast: an unrecognized string reads as "not
default" everywhere downstream and matches an override table that does not
exist.

**Exactly one mode is live at a time.** The two sets are never matched
together. That single fact is what lets Vim mode reuse a chord default mode
gives to a different action: no keypress can reach two actions, because only
one table is being matched.

### The two buckets

| Bucket                             | Shape                                      | Meaning                                                     |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `shortcuts` / `tabShortcuts`       | `Record<string, Shortcut>`, COMPLETE       | Default mode. Every registered action, with its binding.    |
| `vimShortcuts` / `vimTabShortcuts` | `Record<string, ShortcutOverride>`, SPARSE | Vim mode's differences from default mode, and nothing else. |

Each bucket is a separate settings key, with its own setter and its own
hydration branch in `hydrateShortcutsSettings()`.

> [!IMPORTANT]
> **No code path reads one bucket and writes the other.** `setShortcuts` must
> never be reached while Vim mode is live, and `setVimShortcuts` must never be
> reached while default mode is live. A user who customizes a chord in one
> mode, switches, and switches back finds it exactly as they left it. The wrong
> pairing is silent in both directions: reading the default bucket in Vim mode
> matches chords the user cannot see, and writing it in Vim mode edits the set
> they are not looking at.

`useActiveShortcuts()` (`src/renderer/hooks/settings/useActiveShortcuts.ts`) is
the one door. It returns the live mode's effective maps plus setters that write
the live mode's bucket, a `resetToDefaults()` scoped to the live mode,
`isInherited(actionId)`, and the `displaced` list. Nothing outside that hook
pairs a bucket with a mode by hand. Outside React, use
`selectActiveShortcuts()` / `selectActiveTabShortcuts()` from
`settingsShortcutsSlice.ts`.

Switching modes **writes no binding**. `setKeyboardMode` sets one field,
persists it, and disarms Deck mode (see §7); the buckets are untouched.

### Why Vim mode is sparse

A mode that listed only its own chords would silently unbind every action it
forgot, and an action unreachable in one mode is indistinguishable from a bug.
The base map is the floor; an override only ever REPLACES.

### Resetting

`resetToDefaults()` in Vim mode restores `VIM_SHORTCUTS` / `VIM_TAB_SHORTCUTS`,
which is NOT an empty bucket: the shipped tables carry Vim mode's own chords,
and clearing them would leave the mode inheriting default mode wholesale. A
reset in one mode never touches the other's customizations.

### The three states of an override entry

`ShortcutOverride.keys` and `.sequence` are each optional, and the distinction
carries meaning in the persisted bucket:

- **omitted** - inherit the default-mode binding for this action
- **a value** - replace the default-mode binding in this mode
- **`[]`** - the user CLEARED the binding in this mode

`keys: []` is not a state the shipped tables use (omitting the field already
says "no opinion"), but it arrives from persisted settings and the hydration
path keeps it. A fourth state exists only on disk: an id no base map declares
is a retired action, kept by hydration and ignored by the resolver.

---

## 2. `resolveEffectiveShortcuts`

`src/shared/effectiveShortcuts.ts`. Pure, DOM-free, and the only place a mode's
effective set is computed. `maestro-cli` resolves the same function so it can
print the hotkey the user actually has; the renderer reaches it through the
memoized selectors in `settingsShortcutsSlice.ts`.

```ts
const { shortcuts, tabShortcuts, displaced } = resolveEffectiveShortcuts(
	{ shortcuts: DEFAULT_SHORTCUTS, tabShortcuts: TAB_SHORTCUTS },
	{ vimShortcuts: VIM_SHORTCUTS, vimTabShortcuts: VIM_TAB_SHORTCUTS }
);
```

### Inheritance

The resolver iterates the BASE maps, not the override buckets. For each action
it takes the override's value if one exists and the default's otherwise. An id
no base map declares is never reached.

An id is looked up in BOTH override buckets, preferring the one that mirrors
the base map declaring it, falling back to the other. The preference is what
keeps a user's edit from being shadowed by a shipped override: Settings writes
a Previous Tab re-bind to `vimShortcuts` while the shipped chord sits in
`vimTabShortcuts`, and without the preference the shipped chord would keep
winning while the recording looked accepted.

### Two triggers, resolved independently

An action carries up to two triggers, a chord (`keys`) and a key sequence
(`sequence`), and **both fire**. They are collected in separate passes, so an
override that spells out a `sequence` and omits `keys` keeps the inherited
chord, and vice versa. Resolving them together would mean a mode could not add
a sequence without restating the chord, and the restated chord would freeze at
that day's default.

### Displacement

Within a mode, one chord fires one action. When an override takes a chord some
other action INHERITS, both would answer the same keypress and the winner would
come down to branch order in the keyboard handler. So:

1. The override wins - the user chose it for this mode.
2. The inheriting action is dropped to `keys: []`.
3. Its id is appended to `displaced`, in base-map declaration order
   (`shortcuts` first, then `tabShortcuts`).

Collision uses `shortcutKeysCollide`, so the Meta/Ctrl collapse counts (§4). An
override of `keys: []` displaces nothing - an empty chord collides with
nothing.

**A sequence never displaces.** Sequence conflicts are a PREFIX relation rather
than an equality (`g` fights `g g`), so they need `shortcutSequencesCollide`
and are caught structurally at build time instead of being silently unbound at
runtime.

> [!IMPORTANT]
> **A displaced action always gets an explicit Vim chord.** Rule 3 in
> `vimShortcuts.ts`: when a Vim override takes a chord another action holds in
> default mode, that action must appear in `VIM_SHORTCUTS` with a chord of its
> own. Switching modes never leaves an action silently unreachable. Every one is
> recorded in the displacement table in that file's header, and each displaced
> action moves to the SAME letter with Alt added so a user who knows the default
> chord can guess the Vim one. `resolveEffectiveShortcuts(...).displaced` is
> therefore `[]` for the shipped tables, and
> `src/__tests__/renderer/constants/shortcuts.test.ts` ("gives every action a
> shipped Vim chord displaces a Vim chord of its own") asserts it.

When a displacement is left unresolved at runtime (a user override, not a
shipped one), `selectVimDisplacedActions` reports it, the mode-switch toast
names the actions in yellow, and `useActiveShortcuts().displaced` surfaces them
in Settings > Shortcuts.

### Identity preservation

The resolver returns the SAME object for an entry a mode does not change, the
same map when nothing in it changed, and a shared `NO_DISPLACED` array. The
store selectors re-run on every settings change (a font size, a theme, a panel
width) and `useSyncExternalStore` compares with `Object.is`, so a fresh map each
time would re-render every keyboard consumer in the app on an unrelated
setting. `resolvedVimSet()` and `selectMasteryBoundShortcuts()` each keep a
one-entry cache keyed on input identity for the same reason.

### Writing an edit back: `overridesWithEdits`

The write-side mirror. The recorder in Settings > Shortcuts edits one row and
hands back the WHOLE map it was shown, so the only way to learn which binding
changed is to diff that map against the one the user was looking at. Writing
the map wholesale would turn the entire inherited set into explicit overrides
on the first edit and freeze that day's default chords.

- `before` is the EFFECTIVE map the user saw, not the base map, which makes
  re-recording a chord an action already has a no-op.
- `current` is ONE bucket, the one mirroring the base map the edited rows are
  declared in, matching the preference the read side applies.
- Chord and sequence are diffed separately; an untouched sequence is carried
  across from the bucket, never from the effective map (copying an inherited
  sequence there would promote it to an explicit override).
- Returns `current` unchanged when nothing differs, so the caller can skip a
  settings write - every write notifies the other windows, which reload.

`isOverrideInherited(id, overrides)` answers whether an action takes its CHORD
from the default buckets in this mode. Scoped to the chord deliberately: an
action whose only override is a `sequence` still inherits its chord.

---

## 3. Per-mode collision and reachability

Both rule sets are per MODE, and both are enforced structurally.

### Collision: one chord, one action, within a mode

Across modes a shared chord is expected and fine. Inside one mode it means one
action loses silently, with nothing in the UI to explain it. The guards live in
`src/__tests__/renderer/constants/shortcuts.test.ts` (shipped defaults, and the
per-mode sweep) and `src/__tests__/renderer/constants/vimShortcuts.test.ts`
(Vim's effective set), both built on one assembly in
`src/__tests__/helpers/shortcutModes.ts`:

- `SHORTCUT_BASE_MAPS` - the default buckets every mode inherits from.
- `MODE_OVERRIDES` - each mode's override bucket, so adding a mode is one row.
  Default mode's is empty on purpose, and that is not a stand-in: default mode
  IS the base tables.
- `effectiveActionsForMode(mode)` - the resolved pair PLUS `FIXED_SHORTCUTS`,
  which both modes are matched against unchanged. A second copy of that
  assembly would eventually drift, and the copy that drifted would be the one
  quietly leaving a table out, which makes every collision and reachability
  test in that file pass vacuously.

### The context-scoped allowlist

Some actions deliberately share a chord because they can never be live at the
same moment. `INTENTIONALLY_SHARED` in
`src/__tests__/helpers/shortcutModes.ts` is the one list, each group carrying
the gate that keeps it apart:

| Chord          | Ids                                                                                                   | Gate                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Meta+f`       | `filterFiles`, `filterSessions`, `filterHistory`, `searchLogs`, `searchOutput`, `searchDirectorNotes` | Each is scoped to the surface that has focus, and only one surface is focused at a time. |
| `Meta+e`       | `toggleMarkdownMode`, `renameAgentSession`                                                            | The Sessions Browser is a blocking modal layer whose own handler consumes the key first. |
| `Meta+Shift+k` | `clearTerminal`, `toggleShowThinking`                                                                 | Mutually exclusive by input mode: terminal vs AI.                                        |

Two rules keep it honest:

- **Match is EXACT.** Listing a chord does not license a future action to join
  the group - a new arrival is a new decision about scope.
- **The per-mode guards match on `ids` alone**, not on the chord. The gate is
  the group's scope, not the chord it happens to sit on, so a mode that MOVES
  the group keeps the exemption, and a group that gains a member loses it.
  `vimShortcuts.test.ts` also asserts a shared group moves TOGETHER: splitting
  one onto two chords collides with nothing and fails nothing else, while
  quietly turning one deliberate context-scoped pair into two chords the user
  has to learn separately.

### Reachability: a mode switch strands nothing

Three rules, each a test in `vimShortcuts.test.ts`:

1. **Every action with a chord in default mode has one in Vim mode.** The
   failure it catches is an override silently taking a chord another action
   inherits.
2. **Every sequence-bound action has a chord too.** A sequence only fires in
   normal mode, so an action bound to one alone cannot be reached from the
   composer at all. The sequence is the convenience on top of a chord, never the
   whole binding.
3. **Exactly the eleven intended actions carry a normal-mode key.** A vacuity
   guard with teeth: every sequence test passes trivially on an empty set, so
   the list is spelled out rather than derived, and LOSING one is a failure here
   rather than a silently narrower run.

`src/__tests__/shared/effectiveShortcuts.test.ts` covers the resolver itself
(inheritance, bucket preference, the three override states, displacement
including the Meta/Ctrl collapse, identity preservation, and the independent
chord/sequence passes).

---

## 4. The Meta / Ctrl collapse, and reserved chords

`eventMatchesShortcutKeys` (`src/renderer/utils/shortcutMatch.ts`) collapses
`metaKey || ctrlKey` into ONE flag, so `['Ctrl', 'x']` and `['Meta', 'x']` are
the same binding at runtime and both physical keys fire it. One binding table
therefore serves every platform.

It folds a second pair the same way: a Shift-rewritten character and the
unshifted key a binding names. Shift+`,` produces `<`, so the shipped Vim
`moveTabLeft` sequence spells a step `['Shift', ',']` while RECORDING that same
press captures `['Shift', '<']` - and the matcher fires on either. The fold
lives in `SHIFT_REWRITTEN_KEYS` (`src/shared/shortcutKeys.ts`) and both the
matcher and the collision checks read that one table, because a chord the two
disagree about is one the recorder reports as free and the matcher then answers
for two actions at once, leaving whichever resolves second unreachable. The
table deliberately holds only the pairs the matcher accepts: `_`, `+`, `:`, `"`,
`?`, `|` and `~` are Shift-rewritten too, and folding them would refuse a
binding that is genuinely available.

Every comparison that asks "do these two chords fire on the same keypress" has
to model that collapse, and `shortcutKeysCollide` in
`src/shared/shortcutKeys.ts` is the one that does. It is stricter than
`shortcutKeysEqual`, which only asks whether two chords are spelled the same
(order-independently):

| Function                          | Question                                     | Use for                               |
| --------------------------------- | -------------------------------------------- | ------------------------------------- |
| `shortcutKeysEqual(a, b)`         | Same chord, same spelling, any order?        | "Did this row change?" diffs          |
| `shortcutKeysCollide(a, b)`       | Same KEYPRESS, after the Meta/Ctrl collapse? | Every conflict and displacement check |
| `shortcutSequencesEqual(a, b)`    | Same run of keypresses?                      | Diffs                                 |
| `shortcutSequencesCollide(a, b)`  | Prefix relation, so unusable side by side?   | Sequence conflict checks              |
| `findReservedShortcutCombo(keys)` | Does something outside the renderer own it?  | The recorder, and the hydration strip |

An empty chord is "registered but unassigned" and collides with nothing,
including another empty chord - several shipped actions ship unbound on
purpose.

### `RESERVED_SHORTCUT_COMBOS`

Two families, in `src/shared/shortcutKeys.ts`:

- **Text-field chords.** `Cmd/Ctrl+Shift+Arrow` extends a selection to the top,
  bottom, start, or end of the line. A Maestro binding on one wins everywhere,
  including in the composer, and the user cannot tell that apart from a broken
  text box.
- **App-menu chords.** The menu built in `src/main/app-menu.ts` registers these
  as roles: `hide` (Cmd+H), `hideOthers` (Opt+Cmd+H), Quit (Cmd+Q), `minimize`
  (Cmd+M), and the Edit menu's cut / copy / paste / paste-and-match-style /
  select-all. **A registered NSMenu accelerator is swallowed before the renderer
  ever sees the keydown**, so a Maestro binding on one simply never fires and
  reads as a dead shortcut.

Because `Meta` here covers `Ctrl` too, a chord owned on macOS is reserved on
every platform. The alternative is a chord that works on Windows and is silently
dead on a Mac, which is worse than not offering it.

Checked at BOTH ends: the recorder refuses a fresh binding, and
`migrateShortcuts` strips one already on disk and falls back to the action's
bundled default (only when that default is itself free, or the next load would
strip it again and re-persist forever through the settings file watcher).
`shortcuts.test.ts` asserts the shipped tables contain none - a reserved chord
shipped as a default does not just fail to fire, it silently unbinds the action
for every user who never customized it.

### Why the region family is `Ctrl+Shift+H/J/K/L`

`<C-w>h/j/k/l` is Vim's own window-focus family and `Ctrl+H/J/K/L` is how every
tiling keymap spells it. Maestro cannot: the collapse makes `['Ctrl', 'h']` the
same keypress as `Cmd+H`, which the Hide menu item swallows.
`Ctrl+Alt+H/J/K/L` is out for the same reason - it collapses to Opt+Cmd+H, Hide
Others. `Ctrl+Shift+H/J/K/L` is the nearest spelling the matcher can express, it
is free of both reserved entries, and it keeps the four directions on the Vim
letters.

### Why the pane family's `Control`+`Meta` chords stay distinct

`canonicalChordKeys` does NOT deduplicate repeated modifiers.
`['Control', 'Meta', 'w']` canonicalizes to `meta+meta+w` while `['Meta', 'w']`
canonicalizes to `meta+w`, so the two are different chords. That is deliberate:
the pane-tiling family is matched by `isPaneShortcut`
(`src/renderer/hooks/keyboard/useKeyboardShortcutHelpers.ts`), which requires
BOTH physical keys held, so it is a genuinely different keypress from the plain
Meta chord and must not be reported as colliding with it.

The flip side is a rule for every new binding: **a Vim chord never combines
`Ctrl` with `Meta`.** That spelling means the pane family. Vim chords are
spelled with `'Ctrl'` alone, which also renders the Vim-native `⌃` glyph on
macOS instead of `⌘`. `vimShortcuts.test.ts` enforces this over the chords Vim
mode CHANGED, so the inherited pane family keeps its spelling without needing a
hand-written exception list.

---

## 5. `toggleKeyboardMode` lives in `FIXED_SHORTCUTS`

The mode toggle is `Opt+Cmd+V` (`Ctrl+Alt+V` off macOS) and it is **not
rebindable, in either mode**. It sits in `FIXED_SHORTCUTS` and is deliberately
excluded from `DEFAULT_SHORTCUTS`, `TAB_SHORTCUTS`, and both Vim override
tables.

The reason is that it is the way back OUT of the mode you just switched into,
so it has to be the SAME chord in every mode. A rebindable toggle could be
rebound by the mode it switches to, or displaced by one of that mode's own
chords, and the user would be stuck in a binding set whose exit key no longer
exists.

Read the chord from `KEYBOARD_MODE_TOGGLE_KEYS`
(`src/renderer/services/keyboardMode.ts`), never written out again, so the
handler, the shadow check, and the badges in the palette and the menu cannot
drift from what Settings and the help modal render.

### The user's binding still wins

`Opt+Cmd+V` was `toggleConcerto`'s default once, and anyone may bind it
deliberately. `findKeyboardModeToggleShadow(shortcuts, tabShortcuts)` answers
whether some action's own binding has taken the chord (through
`shortcutKeysCollide`, so a Windows `Ctrl+Alt+V` counts), and the toggle handler
stands down when it has. `keyboardModeToggleShadow()` is the same question
asked of the live mode's effective set, which is the one the keydown handler
asks.

### `switchKeyboardMode` is the route

Four surfaces switch modes: the chord, the command palette, the hamburger menu,
and the toggle at the top of Settings > Shortcuts. The first three go through
`switchKeyboardMode(target?)`, which sets the mode and raises the
acknowledgement toast - the only thing that tells the user which set is now
live, and the only place a displaced action is named unprompted.

The Settings toggle is the one exception: it calls `setKeyboardMode` directly,
because it also has to disarm its own pending reset and **the list of rows below
it IS the visible acknowledgement**. Do not "fix" this by routing it through
`switchKeyboardMode`.

`nextKeyboardMode()` derives the cycle from `KEYBOARD_MODES` rather than
flipping two values, so a third mode becomes a step in the cycle instead of a
mode the keyboard can never reach.

---

## 6. Key sequences

`src/renderer/utils/shortcutSequence.ts`. The model is Vimium and Gmail, not a
Vim emulator: a flat list of sequences, no counts (`3j`) and no
operator-pending grammar (`d i w`). Those only pay off inside a text buffer, and
CodeMirror owns that (§7).

`createSequenceMatcher()` holds a prefix buffer, the pinned candidate list, and
the timestamp of the last capture, and nothing else. There is no mode and no
state machine to desync from the DOM. `feed(event, bindings)` returns one of
three outcomes:

| Outcome             | Meaning                  | Caller does                                     |
| ------------------- | ------------------------ | ----------------------------------------------- |
| `'no-match'`        | Not part of any sequence | Falls through to the chord ladder, untouched    |
| `'consumed-prefix'` | Advanced a live sequence | `preventDefault()` and returns                  |
| `'matched'`         | `actionId` fired         | Dispatches it and records usage against that id |

`collectSequenceBindings(...maps)` flattens the LIVE mode's effective maps into
the list `feed` wants. Entries are keyed by their MAP KEY rather than by
`shortcut.id`, because the key is the dispatch address the handler passes back
into `isShortcut(e, id)`.

### The rules

- **A chord is never a sequence step.** Any event carrying Meta, Ctrl, or Alt
  clears the prefix and returns `'no-match'`, so every chord in the app works
  exactly as it did before sequences existed.
- **Escape clears unconditionally and returns `'no-match'`.** The layer stack
  keeps first claim; a half-typed `g` must not swallow the key that closes a
  modal.
- **A step that matches no live prefix clears the buffer.** The run is over the
  moment it stops being a run.
- **A modifier-only keydown is invisible.** It returns `'no-match'` and LEAVES
  the prefix alone, which is different from every other non-matching key. Shift
  fires its own keydown before the character arrives, so treating it as a failed
  step would make `g G` impossible to type. `MODIFIER_ONLY_KEYS` is exported so
  `recordSequenceStep` in `src/renderer/utils/shortcutRecorder.ts` ignores
  exactly the same keys while capturing.
- **The timeout is lazy.** `SEQUENCE_TIMEOUT_MS` is 1000 ms (the Vimium and
  Gmail figure), measured since the last capture and checked when the buffer is
  next READ rather than with a timer. No timer means no DOM globals, nothing to
  cancel on unmount, and no pending callback firing into an unmounted component.
  A consumer that needs to repaint when the prefix expires (the prefix
  indicator, `src/renderer/components/SequencePrefixIndicator.tsx` over
  `src/renderer/stores/sequencePrefixStore.ts`) owns its own timer on the same
  constant.
- **Ambiguity resolves SHORT.** A step that both completes one sequence and
  prefixes a longer one fires the completion immediately. Waiting out the
  timeout to see whether more keys arrive would make the shorter action feel
  broken for a full second on every press.
- **Identical sequences resolve by binding order.** The first entry wins. That
  is the tie-break, not the conflict strategy.
- **Candidates are PINNED when the prefix starts.** A `bindings` array that
  changes mid-run (a settings write, a mode switch) cannot retarget a half-typed
  prefix at a different action. Callers end a run that is no longer meaningful
  with `reset()`.

### The prefix rule

Because ambiguity resolves short, binding `g` beside `g g` does not produce a
race - it produces a sequence that can NEVER fire. So a sequence conflict is a
PREFIX relation, not an equality, and `shortcutSequencesCollide` compares step
by step over the shared length with the same Meta/Ctrl collapse:
`g g` collides with `g`, with `g g`, and with `g g g`, and not with `g t`. The
only place to catch it is where a sequence is recorded, plus the structural test
over the shipped tables.

A sequence carrying an EMPTY STEP is dead rather than free - the matcher never
matches an empty chord, so the run can never advance past it - and reporting it
as a conflict would refuse a sequence that is in fact available.
`vimShortcuts.test.ts` asserts no shipped step is empty.

### Why bare keys only live in `sequence`

A `keys` binding fires **wherever focus sits**, so a bare `j` there would move
the focus ring while the user was writing a prompt. A `sequence` is gated on
normal mode (§7), which is what makes the Vim-native letters safe. The shipped
tables therefore carry no bare chord, and `vimShortcuts.test.ts` enforces it.

The one way to break the rule is to record a bare chord by hand, and the result
is not a conflict but a split: in normal mode the sequence layer runs first and
the sequence wins, while the chord still fires inside every text field, where
the sequence gate is closed.

### Normal mode is the CALLER's gate

`feed` knows nothing about focus or modals. `useMainKeyboardHandler` checks
`isNormalMode()` and `ctx.hasOpenLayers()` before feeding an event in. Keeping
the gate out of the matcher is what lets it stay pure and event-shaped, so it
can be unit tested with plain objects.

---

## 7. Normal mode, Deck mode, and Escape

### Normal mode is a predicate, not a state machine

`isNormalMode(event, doc?)` in
`src/renderer/utils/messageScrollNavigation.ts`, beside `isTextEntryTarget()`.
There is deliberately NO mode flag. A flag would need an enter and an exit for
every path focus can take (clicking the composer, a modal autofocusing its first
input, CodeMirror mounting, xterm taking focus back after a tab switch, a window
blur) and the first path anyone forgot would leave it reading "normal" while the
user typed prose. Focus already IS that state and the DOM already tracks it
correctly.

Both the event target AND `document.activeElement` have to be free, because they
disagree in both directions: a `window` handler sees `<body>` as the target when
focus sits on the body, and the image annotator leaves a composer textarea
focused under its own overlay. Requiring both is the conservative side - a
wrongly rejected keystroke costs one Vim motion, a wrongly accepted one steals a
character out of something the user is writing.

Normal mode is focus PLUS no open layer. The second half lives in the layer
stack, which is React context rather than DOM, so it stays with the caller:
`ctx.hasOpenLayers()`.

### Deck mode

`src/renderer/constants/deckMode.ts`. tmux's prefix idea: one leader chord arms
a one-shot mode, the next single BARE key fires an action, and the mode ends.
The leader IS a chord, so it fires from anywhere including a focused textarea;
once armed, the bare key that follows is matched against `DECK_MODE_KEYS` alone
and never reaches the field. That is the one thing the sequence matcher cannot
offer.

Three properties matter architecturally:

- **Each row's `id` IS the action id.** Deck `h` carries `focusRegionLeft`, the
  same id Settings lists and `VIM_SHORTCUTS` binds to `Ctrl+Shift+H`. Firing it
  through Deck and later through its chord records ONE used action for mastery,
  and no Deck-specific id leaks into usage stats.
- **Deck keys are scoped to the armed state**, so they cannot collide with
  anything and are NOT part of either mode's collision checks. Do not merge them
  into the effective set to make them so. The LEADER is a different matter: it
  is an ordinary `DEFAULT_SHORTCUTS` entry, matched globally, and answers to
  every check.
- **The file imports nothing.** The table is data the hint bar renders during a
  keydown, so it must not pull a store or a service into its import graph, and
  the ids have to be verifiable from outside.

State is `armDeckMode()` / `disarmDeckMode()` / `deckModeArmedNow()` /
`deckModeExpired()` in `src/renderer/stores/uiStore.ts`; never read the raw
`deckModeArmed` flag. `setKeyboardMode` disarms it, because every chord in the
app may have just changed including the leader itself, and the key pressed next
would be matched against a table armed from the other mode. Disarming in the
setter rather than in a mode-watching effect catches all four switch routes at
once.

### Escape's precedence

`LayerStackProvider` (`src/renderer/contexts/LayerStackContext.tsx`) listens on
`window` in the CAPTURE phase, so it runs before anything inside the app
including CodeMirror's own handlers. The order it applies:

1. **An armed Deck mode cancels first.** The single documented exception, and
   the shape every later exception copies: the provider ASKS rather than being
   outranked, because no listener order can beat a capture listener registered
   with the app.
2. **A Vim editor in insert or visual mode, or with a `:` / `/` command line
   open, keeps it.** `vimEditorOwnsEscape(e)` in
   `src/renderer/components/FilePreview/markdownEditor/vimKeys.ts`. In NORMAL
   mode the editor DECLINES: Escape there only clears a pending count or
   operator, and swallowing it would strand the user in a modal whose Escape had
   silently stopped working.
3. **Otherwise the topmost layer's `onEscape` runs.**

The sequence matcher is below all of this: it clears its prefix on Escape and
returns `'no-match'`, never consuming the key.

### The markdown editor's Vim keys

Gated on `keyboardMode === 'vim'` AND `vimEditorEnabled`, ANDed in
`useVimKeysActive()` and nowhere else. Three things the gate encodes:

- The Vim compartment goes FIRST in the extension array, ahead of whatever holds
  `keymap.of([...defaultKeymap])`. Two extensions at the same precedence are
  offered the key in ARRAY ORDER, so Vim behind the default keymap is a no-op on
  every key they share. A host handler at `Prec.highest` still outranks both,
  which is how Cmd+S / Cmd+E and the template autocomplete keep winning.
- The switch is applied by RECONFIGURING the compartment, which keeps the same
  `EditorState` - document, caret, scroll offset, and undo history all survive
  the user flipping the setting. Recreating the view throws away all four.
- `vimEditorOwnsEscape` and `vimEditorOwnsCtrlChord` (over
  `VIM_EDITOR_CTRL_BINDINGS`) are the two predicates the rest of the app asks
  "who wins this key" through.

The in-field escape (`jk`) is separate again: a STRING setting
(`vimInsertEscapeSequence`), not a bindable action, parsed by
`parseInsertEscapeSequence` in `src/renderer/utils/vimInsertEscape.ts`. It fires
INSIDE a text field, which is the one place the sequence matcher's bindings
deliberately never reach, and it records no mastery usage because no table
declares an id for it.

---

## 8. Keyboard mastery

Mastery is **one figure across both modes**, and the rule follows from the
numerator: usage has always been recorded by ACTION ID.

- **Numerator.** `trackShortcut(id)` inside `useMainKeyboardHandler`, and
  `trackShortcutUsage(id)` in `src/renderer/utils/shortcutTracking.ts` for any
  call site handling a shortcut outside the central handler. Both bump
  `keyboardMasteryStats.usedShortcuts` (a de-duplicated list of action ids) and the
  main-process daily counter. The handler's local `reported` set makes one
  keypress one usage: the Deck and sequence layers record the action they
  matched before the ladder runs, and the branch that then fires records the
  same id.
- **Denominator.** `selectMasteryBoundShortcuts(state)` in
  `settingsShortcutsSlice.ts`, over `collectBoundShortcutsAcrossModes()` in
  `src/renderer/constants/keyboardMastery.ts`. **This is the only way to compute
  it.** It is the UNION of actions bound in EITHER mode, counted once, so
  switching modes cannot move the percentage and an action learned in one mode
  is not reported as unlearned in the other.

Four properties the union depends on:

- A later map never REMOVES an id an earlier map bound.
  `collectBoundShortcuts()` (the one-mode primitive, kept for the rule it pins)
  merges first and filters second, so a mode leaving an action unbound would
  delete it from a total another mode binds it in. `collectBoundShortcutsAcrossModes`
  can only ever add.
- "Bound" is a chord **or** a sequence. An action with only a sequence is as
  reachable as one with only a chord, so leaving it out would pin the user below
  100% exactly as an unbound one does.
- `selectMasteryBoundShortcuts` resolves the Vim set even while default mode is
  live - that is the point. Which mode is LIVE only decides which mode's ENTRY
  represents an id, so a surface that renders these (the Usage Dashboard's
  unused list) shows the chord the user would press right now.
- A switched-off Encore Feature's shortcut is excluded in both modes, through
  `availableShortcuts()` in `src/renderer/utils/encoreShortcuts.ts`. The
  keyboard handler refuses it, so it can never be fired, and counting it would
  hold the user below 100% forever.

`countUsedBoundShortcuts(bound, usedIds)` is the numerator helper: it is not
`usedShortcuts.length`, which keeps ids whose binding was later cleared or
removed and would push the count past the denominator.

---

## 9. Display reads the same place behavior does

A chord is drawn in dozens of places at once, and a hard-coded combo is already
wrong for a user who rebound the action - in Vim mode it is a lie about a whole
binding set.

| Need                              | Use                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| One action's chord in a component | `useShortcutKeys(actionId)` (`src/renderer/hooks/keyboard/useShortcutKeys.ts`)      |
| Many chords, or outside React     | `resolveShortcutKeys(actionId, maps)` (`src/renderer/utils/shortcutResolve.ts`)     |
| Drawing the result                | `<ShortcutHint>` / `<ShortcutKeys>` (`src/renderer/components/ui/ShortcutHint.tsx`) |
| Formatting outside the renderer   | `formatShortcutKeysFor(keys, isMac)` (`src/shared/shortcutKeys.ts`)                 |

`resolveShortcutKeys` falls back in the order `FIXED_SHORTCUTS`, then
`tabShortcuts`, then `shortcuts`, matching what `isTabShortcut` matches on so
display and behavior agree about which of two declarations fires. An id present
with `keys: []` resolves to that entry rather than falling through - an action
the user cleared, or one an override displaced, is genuinely unbound and must
not be shown wearing another table's chord. Both it and
`src/renderer/utils/shortcutResolve.ts` as a whole are DOM-free and React-free,
because `maestro-cli open --list` resolves the same set from persisted settings.

`src/__tests__/renderer/shortcutDisplayLiterals.test.ts` guards against new
hard-coded chord literals in component code.

---

## Adding a keyboard mode

1. Add the id to `KeyboardMode` and `KEYBOARD_MODES`
   (`src/shared/shortcut-types.ts`), and a label to `KEYBOARD_MODE_LABELS` - the
   `Record` keyed by the union makes every surface a compile error until it is
   handled.
2. Add its two override buckets to `ShortcutsState`, with their own setters,
   their own settings keys, and their own `hydrateShortcutsSettings` branches
   through `migrateShortcuts(..., 'override')`. Read nothing from the other
   mode's bucket.
3. Add one row to `MODE_OVERRIDES` in `src/__tests__/helpers/shortcutModes.ts`.
   The per-mode collision and reachability guards then cover it automatically.
4. Resolve every displacement with an explicit chord in the new table, so
   `resolveEffectiveShortcuts(...).displaced` stays `[]` for the shipped set.
5. Extend `selectActiveShortcuts` / `selectActiveTabShortcuts` and
   `selectMasteryBoundShortcuts` to include the new mode's resolved maps.
6. Leave `FIXED_SHORTCUTS` alone - it is shared by every mode and no override
   bucket may name it.

---

## Related

- [[UI-PATTERNS]] - surfaces, modals, and the "three ways in, two ways out"
  rule a new shortcut is half of.
- [[STATE-PATTERNS]] - the Zustand store conventions `settingsShortcutsSlice`
  follows, including selector-based subscriptions and non-React `getState()`
  access.
- [docs/keyboard-shortcuts.md](../keyboard-shortcuts.md) - the user-facing
  reference these tables render into.
- [[CANONICAL-UTILITIES]] - full entries for `useActiveShortcuts`,
  `resolveEffectiveShortcuts`, `shortcutKeysCollide`, `useShortcutKeys`,
  `selectMasteryBoundShortcuts`, the sequence matcher, `isNormalMode`, and the
  region focus service.
