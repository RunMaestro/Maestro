// Import the shortcut type from the shared module rather than `../types`, for
// the same reason `shortcuts.ts` and `vimShortcuts.ts` do: these tables are read
// by display code that also runs outside the renderer, and `../types` drags
// renderer-only, DOM-dependent modules into that build. This file imports
// NOTHING else, deliberately - see "Why this file imports nothing" below.
import type { Shortcut } from '../../shared/shortcut-types';

/**
 * DECK MODE: the leader-chord table.
 *
 * Deck mode is tmux's prefix idea. One leader chord arms a one-shot mode, the
 * next single BARE key fires an action, and the mode ends. Nothing is held
 * down, nothing stays armed, and the whole interaction is two keystrokes.
 *
 * ## Why Maestro wants it
 *
 * A bare key cannot be bound through `Shortcut.keys` (a `keys` binding fires
 * wherever focus sits, so a bare `j` would move the focus ring while the user
 * was writing a prompt) and a bare key bound through `Shortcut.sequence` is
 * gated on normal mode (focus outside a text field, no modal layer open). So
 * before Deck mode, the Vim-native letters were reachable only when the user
 * had already left the composer.
 *
 * Deck mode is the third way in. The leader IS a chord, so it fires from
 * anywhere including a focused textarea; once armed, the bare key that follows
 * is matched against this table alone and never reaches the field. That makes
 * region focus and the tab actions reachable without first leaving a text
 * field, which is the one thing the sequence matcher cannot offer.
 *
 * ## The one thing a terminal multiplexer cannot do
 *
 * tmux arms its prefix silently and the user is expected to have memorized the
 * table. Maestro renders it: the hint bar appears the moment the mode arms and
 * lists every key below with its label, read from THESE arrays rather than from
 * a hard-coded copy. That is the reason the table is data in a constants file
 * instead of a switch in the keyboard handler, and the reason each row is a
 * full {@link Shortcut} rather than a bare key string: the hint bar, the help
 * sheet, and Settings all format a `Shortcut` already, so reusing the shape
 * means `formatShortcutKeys` renders `Escape` as `⎋` on macOS and `Esc`
 * elsewhere with no new formatting code anywhere.
 *
 * ## Each row's `id` IS the action id
 *
 * A Deck key does not get an id of its own. `h` carries `focusRegionLeft`, the
 * same id Settings lists, the same id `VIM_SHORTCUTS` binds to Ctrl+Shift+H,
 * and the same id the keyboard handler passes to `trackShortcut`. One action,
 * one id, however it was fired: firing `focusRegionLeft` through Deck `h` and
 * later through its chord therefore records ONE used action for keyboard
 * mastery rather than two, and no Deck-specific id ever leaks into usage
 * stats or the mastery denominator.
 *
 * `keys` holds the single bare Deck key, which is only ever matched while the
 * mode is armed. It is NOT a chord the global matcher ever sees.
 *
 * ## These keys are scoped to the armed state
 *
 * A Deck key is live only between the leader and the next keystroke, so it
 * cannot collide with anything: `t` here and `Cmd+T` in `TAB_SHORTCUTS` are
 * never candidates for the same keypress. Deck rows are therefore NOT part of
 * either keyboard mode's collision checks (`shortcutKeysCollide` over the
 * effective set, `findReservedShortcutCombo`, `shortcutSequencesCollide`), and
 * must not be merged into the effective set to make them so. The LEADER chord
 * is a different matter: it is an ordinary entry in `DEFAULT_SHORTCUTS`, it is
 * matched globally, and it answers to every one of those checks.
 *
 * ## Why `v` and `s` are missing
 *
 * `prefix v` and `prefix s` (or `prefix %` and `prefix "`) split a pane in
 * every terminal multiplexer, and they are the two keys a tmux user will reach
 * for first. They are omitted because Maestro has no equivalent action to fire.
 * The Main Window is one surface at a time, and the closest thing to a split -
 * the pane-tiling family matched by `isPaneShortcut` - tiles EXISTING tabs
 * rather than splitting the current one, so binding `v` to it would answer a
 * different question than the one the user asked. Both keys are left free so
 * that a real split action, if Maestro ever grows one, can take the key a tmux
 * user already expects rather than having to displace a stand-in.
 *
 * `n` / `p` (next and previous window) are omitted for a related reason: they
 * are a REPEATED motion, and a one-shot mode disarms after one key, so walking
 * three tabs would mean three leader chords. `g t` / `g T` and `Ctrl+PageUp` /
 * `PageDown` already serve that, and `1` through `9` below reach any of the
 * first nine tabs in one keystroke, which is what the leader shape is good at.
 *
 * ## Why this file imports nothing
 *
 * No import of `shortcuts.ts`, no import of the services whose actions these
 * ids name. Two reasons. The table is data the hint bar renders during a
 * keydown, so it must not pull a store or a service module into its import
 * graph. And the action ids have to be verifiable from OUTSIDE: a test in
 * `src/__tests__/renderer/constants/shortcuts.test.ts` asserts every id below
 * exists in `DEFAULT_SHORTCUTS` or `TAB_SHORTCUTS` with the IDENTICAL label, so
 * a renamed action or a retitled label fails there rather than silently
 * rendering a stale string in the hint bar. Importing the tables here to
 * self-check would move that failure from a test into a cycle.
 */

/**
 * The action id of the leader itself, registered in `DEFAULT_SHORTCUTS` like any
 * other action so it appears in Settings > Shortcuts and can be rebound in
 * either keyboard mode.
 *
 * Exported as a constant rather than spelled inline at each call site because
 * three places need the same string for three different purposes: the keyboard
 * handler matches it, `trackShortcut` records it, and the hint bar looks its
 * live chord up to show in its title.
 */
export const DECK_MODE_LEADER_ID = 'deckMode';

/**
 * Every Deck key that FIRES something, in hint-bar display order.
 *
 * An array rather than a `Record` keyed by id, because order is the contract
 * here: the hint bar renders these rows top to bottom, and the grouping below
 * (directions, then tab actions, then tab jumps, then the palette) is what
 * makes an eighteen-row overlay scannable in the half second the mode is armed.
 * A `Record` would hand that order to whatever the insertion order happened to
 * be after the next edit.
 *
 * `goToTab1` through `goToTab9` are spelled out rather than generated in a loop
 * so that grepping `goToTab7` finds its Deck binding, the same way grepping
 * finds its entry in `TAB_SHORTCUTS`.
 */
export const DECK_MODE_KEYS: readonly Shortcut[] = [
	// Region focus, on the Vim letters. These are the actions Deck mode exists
	// for: `focusRegionLeft` and friends have a Vim-mode chord (Ctrl+Shift+H) and
	// a normal-mode sequence (`h`), and the sequence is the one a user reaches
	// for - but it is gated on focus being outside a text field, which is exactly
	// where it is least useful. The Deck route restores the bare letter from
	// inside the composer.
	{ id: 'focusRegionLeft', label: 'Focus Region Left', keys: ['h'] },
	{ id: 'focusRegionDown', label: 'Focus Region Down', keys: ['j'] },
	{ id: 'focusRegionUp', label: 'Focus Region Up', keys: ['k'] },
	{ id: 'focusRegionRight', label: 'Focus Region Right', keys: ['l'] },

	// Tab actions. `t` and `x` are tmux's own `prefix c` / `prefix x` one letter
	// over: `c` is taken by nothing here, but `t` matches Maestro's own Cmd+T and
	// is the letter a user who knows the chord will guess, while `x` is the kill
	// key in every multiplexer. `z` is tmux's `prefix z` (zoom a pane), which is
	// the same intent as zen mode: give the whole frame to one thing.
	{ id: 'newTab', label: 'New Tab', keys: ['t'] },
	{ id: 'closeTab', label: 'Close Tab', keys: ['x'] },
	{ id: 'toggleZenMode', label: 'Toggle Zen Mode', keys: ['z'] },

	// Jump to a tab by position, tmux's `prefix 0`-`prefix 9`. Maestro's own
	// chords are Cmd+1 through Cmd+9, so the digit is already the right mnemonic;
	// the Deck route is the one that works while the composer has focus.
	//
	// There is no `0` row. Cmd+0 is `goToLastTab` rather than a tenth tab, and a
	// bare `0` next to nine positional digits would read as "tab zero". A user
	// after the last tab has `G` in Vim mode and Cmd+0 everywhere.
	{ id: 'goToTab1', label: 'Go to Tab 1', keys: ['1'] },
	{ id: 'goToTab2', label: 'Go to Tab 2', keys: ['2'] },
	{ id: 'goToTab3', label: 'Go to Tab 3', keys: ['3'] },
	{ id: 'goToTab4', label: 'Go to Tab 4', keys: ['4'] },
	{ id: 'goToTab5', label: 'Go to Tab 5', keys: ['5'] },
	{ id: 'goToTab6', label: 'Go to Tab 6', keys: ['6'] },
	{ id: 'goToTab7', label: 'Go to Tab 7', keys: ['7'] },
	{ id: 'goToTab8', label: 'Go to Tab 8', keys: ['8'] },
	{ id: 'goToTab9', label: 'Go to Tab 9', keys: ['9'] },

	// The escape hatch out of memorizing anything: the palette, where every
	// action is searchable by name. Space is the key no other Deck row wants and
	// the easiest one to hit without looking, which is what a "show me
	// everything" key should cost.
	{ id: 'quickAction', label: 'Quick Actions', keys: ['Space'] },
];

/**
 * The id carried by the cancel row, which is NOT an action id.
 *
 * Cancelling is the mode's own behaviour rather than an action anyone can fire:
 * there is no `deckModeCancel` entry in `DEFAULT_SHORTCUTS`, no handler for it,
 * and nothing to record against it. The id exists only so the cancel row can be
 * keyed and rendered by the same code as every other row.
 */
export const DECK_MODE_CANCEL_ID = 'deckModeCancel';

/**
 * Escape, the one Deck key that fires nothing.
 *
 * It lives OUTSIDE {@link DECK_MODE_KEYS} on purpose, and the separation is
 * load-bearing in two directions. {@link findDeckModeAction} walks only the
 * firing rows, so Escape can never be returned as an action to dispatch or
 * passed to `trackShortcut` - it is structurally impossible rather than
 * guarded. And the structural test that checks every id in `DECK_MODE_KEYS`
 * against `DEFAULT_SHORTCUTS` does not have to carve out an exception for the
 * one row that is deliberately not an action.
 *
 * Escape is handled by the keyboard handler before any table lookup, and in
 * that one spot it does NOT reach the layer stack: an armed Deck mode is what
 * Escape dismisses, not the topmost modal.
 */
export const DECK_MODE_CANCEL: Shortcut = {
	id: DECK_MODE_CANCEL_ID,
	label: 'Cancel',
	keys: ['Escape'],
};

/**
 * Every row the hint bar draws, firing keys then cancel.
 *
 * One export so the hint bar, the help-sheet section, and their tests all
 * render the same list in the same order. Cancel is last because it is the row
 * a user stops needing first.
 */
export const DECK_MODE_HINT_ROWS: readonly Shortcut[] = [...DECK_MODE_KEYS, DECK_MODE_CANCEL];

/**
 * A `KeyboardEvent.key` reduced to the spelling {@link DECK_MODE_KEYS} uses.
 *
 * Two rewrites, both because `event.key` reports what was TYPED rather than
 * which key was struck:
 *
 *  - A space arrives as `' '`, a single character that no table could spell
 *    readably. The tables say `'Space'`, which is also what the display maps in
 *    `shared/shortcutKeys.ts` key off to render `␣` / `Space`.
 *  - A letter arrives capitalized when Shift is held, so `Shift+H` reports
 *    `'H'`. Lowercasing means a stray Shift still fires the row rather than
 *    counting as a miss and disarming, which is the kinder failure: the table
 *    has no capital rows for Shift to select between, so there is nothing the
 *    user could have meant by `H` other than `h`. (In tmux `prefix H` resizes a
 *    pane. Maestro has no pane to resize, so the key is free to be forgiving.)
 *
 * Multi-character names (`Escape`, `Enter`, `Tab`) pass through untouched: they
 * are already the `event.key` spelling the display maps use.
 */
export function deckModeKeyName(eventKey: string): string {
	if (eventKey === ' ' || eventKey === 'Spacebar') return 'Space';
	return eventKey.length === 1 ? eventKey.toLowerCase() : eventKey;
}

/**
 * The Deck row a keypress fires, or `undefined` for a miss.
 *
 * Takes the raw `event.key` and normalizes it through
 * {@link deckModeKeyName}. Modifiers are the CALLER's business: this function
 * answers "which row is this key", and the keyboard handler is what decides
 * that a Deck key held with Ctrl, Meta, or Alt is not a Deck key at all (it is
 * some other chord the user meant for the app, and the armed mode should get
 * out of its way).
 *
 * A miss is a real answer rather than a failure. The handler disarms on one,
 * swallows the key so it is not typed into a focused field, and deliberately
 * does NOT fall through to the normal binding ladder: a one-shot mode that
 * sometimes passes the key along would make the user guess whether the leader
 * had taken effect.
 */
export function findDeckModeAction(eventKey: string): Shortcut | undefined {
	const name = deckModeKeyName(eventKey);
	return DECK_MODE_KEYS.find((row) => row.keys[0] === name);
}

/** Whether a keypress is the cancel key, by the same normalization. */
export function isDeckModeCancelKey(eventKey: string): boolean {
	return deckModeKeyName(eventKey) === DECK_MODE_CANCEL.keys[0];
}
