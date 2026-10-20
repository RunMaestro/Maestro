// Import the override type from the shared module rather than `../types`, for
// the same reason `shortcuts.ts` does: the CLI reads these tables (Phase 07
// resolves the effective set in `maestro-cli open` so it prints the hotkey the
// user actually has), and `../types` drags renderer-only, DOM-dependent modules
// into that build.
import type { ShortcutOverride } from '../../shared/shortcut-types';

/**
 * VIM MODE OVERRIDES.
 *
 * These tables are SPARSE. An action appears here only when Vim mode binds it
 * to a different chord than default mode; everything else inherits its default
 * chord. The rules this file lives under, each of which a test in
 * `src/__tests__/renderer/constants/shortcuts.test.ts` or
 * `src/__tests__/renderer/constants/vimShortcuts.test.ts` enforces:
 *
 * 1. **One mode is live at a time.** Default mode and Vim mode are never both
 *    being matched, so a Vim chord MAY reuse a chord that default mode gives to
 *    a different action. That is the whole reason the override bucket exists
 *    separately instead of rewriting `DEFAULT_SHORTCUTS`.
 * 2. **Collisions are checked WITHIN a mode.** Inside one mode no chord may
 *    fire two actions (bar the context-scoped pairs default mode already ships
 *    on purpose). Across modes a shared chord is expected and fine.
 * 3. **A displaced action always gets an explicit Vim chord.** When a Vim
 *    override takes a chord another action holds in default mode, that action
 *    cannot inherit its default chord here (the override wins), so it must
 *    appear in this file with a chord of its own. Switching modes never leaves
 *    an action silently unreachable. The displacement table below is the record
 *    of every one of them.
 * 4. **Ctrl and Cmd are ONE modifier.** `eventMatchesShortcutKeys` collapses
 *    `metaKey || ctrlKey` into a single flag, so `['Ctrl', 'x']` and
 *    `['Meta', 'x']` are the same binding at runtime and both physical keys fire
 *    it. Vim chords are spelled with `'Ctrl'` so macOS renders the Vim-native
 *    `⌃` glyph instead of `⌘`, and they never combine `Ctrl` with `Meta` in one
 *    chord: that spelling means the pane-tiling family, which `isPaneShortcut`
 *    matches separately by requiring both physical keys held.
 * 5. **Reserved chords are unusable in both modes.** `findReservedShortcutCombo`
 *    covers the text-field selection chords and the chords the macOS app menu
 *    swallows before the renderer sees them, so Cmd+H, Opt+Cmd+H, Cmd+Q, Cmd+M,
 *    and the Edit menu's cut / copy / paste / select-all are off the table here
 *    too.
 * 6. **A bare key is bound through `sequence`, never `keys`.** A `keys` binding
 *    fires wherever focus sits, so a bare `j` there would move the focus ring
 *    while the user was typing a prompt. A `sequence` is gated on normal mode
 *    (focus outside a text field, no modal layer open), which is what makes the
 *    Vim-native letters safe. The flip side is that a sequence alone is not a
 *    complete binding: an action reachable only by `j` cannot be fired from the
 *    composer at all, so every action here carries a chord too and the sequence
 *    is the convenience on top.
 *
 * ## Why the region family is Ctrl+Shift rather than Ctrl
 *
 * `<C-w>h/j/k/l` is Vim's own window-focus family, and `Ctrl+H/J/K/L` is how
 * every tiling keymap spells it. Maestro cannot: rule 4 collapses Ctrl and Cmd
 * into one modifier, so `['Ctrl', 'h']` IS `Cmd+H` at runtime, which rule 5
 * reserves because the macOS app menu's Hide item swallows it before the
 * renderer sees the keydown. The binding would not conflict with anything, it
 * would simply never fire, and a dead key is the one failure a user cannot
 * diagnose. `Ctrl+Alt+H/J/K/L` is out for the same reason: it collapses to
 * Opt+Cmd+H, the Hide Others item.
 *
 * `Ctrl+Shift+H/J/K/L` is the nearest spelling the matcher can express, it is
 * free of both reserved entries, and it keeps the four directions on the Vim
 * letters. The resize pair then reads as the same family one modifier over
 * (`Ctrl+Alt+Shift+,` / `.`, which is Ctrl+Alt+`<` / `>` after `<C-w><` and
 * `<C-w>>`), and the displaced actions take the same letter with Alt added.
 *
 * ## Displacements and their resolutions
 *
 * Every chord a Vim override takes from an action that holds it in default
 * mode, and the chord that action answers to in Vim mode instead. Each
 * displaced action is moved to the SAME letter with Alt added, so a user who
 * knows the default chord can guess the Vim one. `resolveEffectiveShortcuts`
 * reports `displaced` as empty for these tables because of this column.
 *
 * | Default chord   | Default action                 | Vim action on that chord        | Displaced action's Vim chord |
 * | --------------- | ------------------------------ | ------------------------------- | ---------------------------- |
 * | Cmd+Shift+H     | `goToHistory`                  | `focusRegionLeft`               | Ctrl+Alt+Shift+H             |
 * | Cmd+Shift+J     | `jumpToBottom`                 | `focusRegionDown`               | Ctrl+Alt+Shift+J             |
 * | Cmd+Shift+K     | `clearTerminal`                | `focusRegionUp`                 | Ctrl+Alt+Shift+K             |
 * | Cmd+Shift+K     | `toggleShowThinking`           | `focusRegionUp`                 | Ctrl+Alt+Shift+K             |
 * | Cmd+Shift+L     | `agentSessions`                | `focusRegionRight`              | Ctrl+Alt+Shift+L             |
 *
 * `clearTerminal` and `toggleShowThinking` share Cmd+Shift+K in default mode on
 * purpose (one is gated on terminal input mode, the other is a tab shortcut
 * reached only in AI mode), and they keep that context-scoped pairing in Vim
 * mode on Ctrl+Alt+Shift+K. They are the one group in `INTENTIONALLY_SHARED`
 * these tables touch, and the per-mode collision guard matches that group by
 * its ids rather than its chord precisely so moving it together stays legal.
 *
 * Nothing else is displaced. `Ctrl+Alt+O`, `Ctrl+Alt+Shift+,` / `.`, and the
 * `Ctrl+Shift+PageUp` / `PageDown` pair are free in the shipped default set,
 * and the actions the region family takes chords FROM are the only five above.
 *
 * Every id here must already exist in `DEFAULT_SHORTCUTS` or `TAB_SHORTCUTS`
 * with the IDENTICAL label, and no id may be a `FIXED_SHORTCUTS` id: a fixed
 * shortcut is shared by both modes and is not rebindable, so overriding one
 * would describe a binding that cannot take effect. The shipped tables never
 * use `keys: []`; omit the entry instead and let the action inherit.
 */

/**
 * Overrides for the actions in `DEFAULT_SHORTCUTS`.
 *
 * Three groups: the region family Vim mode exists to provide, the resize pair
 * and zen toggle beside it, and the four actions the region family displaced.
 */
export const VIM_SHORTCUTS: Record<string, ShortcutOverride> = {
	// Region focus, Vim's `<C-w>h/j/k/l`. The chord is Ctrl+Shift rather than
	// Ctrl for the reason in the file header (Ctrl+H is Cmd+H to the matcher,
	// which the app menu owns), and the bare letter is the normal-mode sequence,
	// so `h` moves the focus ring only when no text field has focus.
	focusRegionLeft: {
		id: 'focusRegionLeft',
		label: 'Focus Region Left',
		keys: ['Ctrl', 'Shift', 'h'],
		sequence: [['h']],
	},
	focusRegionDown: {
		id: 'focusRegionDown',
		label: 'Focus Region Down',
		keys: ['Ctrl', 'Shift', 'j'],
		sequence: [['j']],
	},
	focusRegionUp: {
		id: 'focusRegionUp',
		label: 'Focus Region Up',
		keys: ['Ctrl', 'Shift', 'k'],
		sequence: [['k']],
	},
	focusRegionRight: {
		id: 'focusRegionRight',
		label: 'Focus Region Right',
		keys: ['Ctrl', 'Shift', 'l'],
		sequence: [['l']],
	},

	// Region resize, after Vim's `<C-w><` and `<C-w>>`. Shift+`,` and Shift+`.`
	// ARE `<` and `>`, spelled as the unshifted key plus Shift because that is
	// what `event.key` reports through `eventMatchesShortcutKeys`. No bare-letter
	// sequence: `<` and `>` are already the shifted characters, and a two-step
	// `< <` sequence belongs to the tab move below, which is the action Vim users
	// reach for far more often.
	shrinkRegion: {
		id: 'shrinkRegion',
		label: 'Shrink Region',
		keys: ['Ctrl', 'Alt', 'Shift', ','],
	},
	growRegion: {
		id: 'growRegion',
		label: 'Grow Region',
		keys: ['Ctrl', 'Alt', 'Shift', '.'],
	},

	// Vim's `<C-w>o`, "only this window": give the whole frame to the focused
	// region and put the bars away. `z` is the normal-mode key, chosen for Vim's
	// own `z` fold-and-view prefix rather than for the word zen.
	toggleZenMode: {
		id: 'toggleZenMode',
		label: 'Toggle Zen Mode',
		keys: ['Ctrl', 'Alt', 'o'],
		sequence: [['z']],
	},

	// Displaced by the region family above, each moved to the same letter with
	// Alt added so the chord stays guessable from the default one. See the
	// displacement table in the file header.
	goToHistory: {
		id: 'goToHistory',
		label: 'Go to History Tab',
		keys: ['Ctrl', 'Alt', 'Shift', 'h'],
	},
	jumpToBottom: {
		id: 'jumpToBottom',
		label: 'Jump to Bottom',
		keys: ['Ctrl', 'Alt', 'Shift', 'j'],
	},
	clearTerminal: {
		id: 'clearTerminal',
		label: 'Clear Terminal',
		keys: ['Ctrl', 'Alt', 'Shift', 'k'],
	},
	agentSessions: {
		id: 'agentSessions',
		label: 'View Agent Sessions',
		keys: ['Ctrl', 'Alt', 'Shift', 'l'],
	},
};

/**
 * Overrides for tab actions, the ones matched through `isTabShortcut`.
 *
 * `prevTab` / `nextTab` are the only override whose action already existed when
 * this file was added. They sit in THIS table rather than `VIM_SHORTCUTS`
 * because `isTabShortcut` is what matches them, even though the two ids are
 * declared in `DEFAULT_SHORTCUTS` rather than `TAB_SHORTCUTS` (`isTabShortcut`
 * reads `tabShortcuts[id] || shortcuts[id]`, so a tab action can be declared in
 * either map). `resolveEffectiveShortcuts` therefore has to look an override id
 * up in BOTH base maps and apply it to whichever one declares the action. If it
 * only ever matched this table against `TAB_SHORTCUTS` it would drop these two
 * on the floor, and if it wrote them into the resolved tab map while leaving the
 * general map's inherited chord in place, Settings > Shortcuts would list
 * Previous Tab twice with two different chords (it renders `shortcuts` and
 * `tabShortcuts` as separate sections).
 *
 * `Ctrl+PageUp` / `Ctrl+PageDown` are Vim's own `<C-PageUp>` / `<C-PageDown>`.
 * No shipped table binds `PageUp` or `PageDown` in any chord, so these displace
 * nothing, and `Ctrl+Shift+PageUp` / `PageDown` for the move pair is the same
 * chord one modifier over.
 */
export const VIM_TAB_SHORTCUTS: Record<string, ShortcutOverride> = {
	// `g t` / `g T` are Vim's own tab walk. The chords are unchanged from the
	// phase that added this table; the sequences are the addition, and both
	// triggers fire (`resolveEffectiveShortcuts` resolves `keys` and `sequence`
	// independently, so spelling one out here does not take the other away).
	prevTab: {
		id: 'prevTab',
		label: 'Previous Tab',
		keys: ['Ctrl', 'PageUp'],
		sequence: [['g'], ['Shift', 't']],
	},
	nextTab: {
		id: 'nextTab',
		label: 'Next Tab',
		keys: ['Ctrl', 'PageDown'],
		sequence: [['g'], ['t']],
	},

	// Nudge the active tab one slot, after Vim's `<C-w><` / `<C-w>>` for a
	// window. These ship unassigned in default mode, so the chords displace
	// nothing. `< <` and `> >` are the doubled forms, which keeps a single `<`
	// free and keeps the sequence out of the way of `g`.
	moveTabLeft: {
		id: 'moveTabLeft',
		label: 'Move Tab Left',
		keys: ['Ctrl', 'Shift', 'PageUp'],
		sequence: [
			['Shift', ','],
			['Shift', ','],
		],
	},
	moveTabRight: {
		id: 'moveTabRight',
		label: 'Move Tab Right',
		keys: ['Ctrl', 'Shift', 'PageDown'],
		sequence: [
			['Shift', '.'],
			['Shift', '.'],
		],
	},

	// `g g` and `G`, Vim's first-line and last-line motions, read here as first
	// tab and last tab. Sequence only: both keep their inherited Cmd+1 / Cmd+0
	// chord, which is already the chord every other `goToTab*` answers to, so
	// overriding it would split the family across two spellings for no gain.
	goToTab1: {
		id: 'goToTab1',
		label: 'Go to Tab 1',
		sequence: [['g'], ['g']],
	},
	goToLastTab: {
		id: 'goToLastTab',
		label: 'Go to Last Tab',
		sequence: [['Shift', 'g']],
	},

	// Displaced by `focusRegionUp` taking Ctrl+Shift+K. It shares Cmd+Shift+K
	// with `clearTerminal` by context in default mode (terminal input mode vs
	// AI mode), and it keeps that same context-scoped pairing here on
	// Ctrl+Alt+Shift+K rather than being split onto a chord of its own.
	toggleShowThinking: {
		id: 'toggleShowThinking',
		label: 'Toggle Show Thinking',
		keys: ['Ctrl', 'Alt', 'Shift', 'k'],
	},
};
