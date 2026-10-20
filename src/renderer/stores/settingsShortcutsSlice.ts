/**
 * Keyboard shortcuts settings slice for settingsStore, including the
 * macOS Alt-key-character and one-time default-remap migration logic that
 * runs on load.
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import { shortcutKeysEqual, findReservedShortcutCombo } from '../../shared/shortcutKeys';
import { resolveEffectiveShortcuts } from '../../shared/effectiveShortcuts';
import type { EffectiveShortcuts } from '../../shared/effectiveShortcuts';
import { asKeyboardMode } from '../../shared/shortcut-types';
import type { KeyboardMode, ShortcutOverride } from '../../shared/shortcut-types';
import type { EncoreFeatureFlags, Shortcut } from '../types';
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS, TAB_SHORTCUTS } from '../constants/shortcuts';
import { VIM_SHORTCUTS, VIM_TAB_SHORTCUTS } from '../constants/vimShortcuts';
import { DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE } from '../utils/vimInsertEscape';
import { collectBoundShortcutsAcrossModes } from '../constants/keyboardMastery';
import { availableShortcuts } from '../utils/encoreShortcuts';
import type { SettingsStore } from './settingsStore';
import { useUIStore } from './uiStore';

export interface ShortcutsState {
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	/**
	 * Which binding set is live. Exactly ONE mode is active at a time: the two
	 * key sets are never matched together, which is what lets a non-default mode
	 * reuse a chord default mode gives to another action.
	 *
	 * This field says which bucket is live, nothing more. Switching it never
	 * rewrites a binding - each mode keeps its own customizations in its own
	 * bucket - so a user can switch back and forth and find both sets exactly as
	 * they left them.
	 */
	keyboardMode: KeyboardMode;
	/**
	 * Vim mode's overrides, SPARSE: an action appears only when Vim mode binds
	 * it to a different chord than default mode. Everything else inherits its
	 * default chord, which is what stops a mode switch from unbinding anything.
	 *
	 * These two buckets and the `shortcuts` / `tabShortcuts` pair above are
	 * INDEPENDENT, and no code path may read one and write the other. Each mode
	 * has its own settings key, its own setter, and its own hydration, so a user
	 * who customizes a chord in one mode, switches, and switches back finds it
	 * exactly as they left it. `setShortcuts` must never be reached while Vim
	 * mode is live, and `setVimShortcuts` must never be reached while default
	 * mode is live - `useActiveShortcuts()` is the one door that picks the right
	 * setter for the live mode.
	 */
	vimShortcuts: Record<string, ShortcutOverride>;
	/** Vim mode's overrides for the tab actions. See `vimShortcuts`. */
	vimTabShortcuts: Record<string, ShortcutOverride>;
	/**
	 * The characters that leave a text field in Vim mode (`jk`), or `''` for
	 * off.
	 *
	 * A STRING rather than a `Shortcut`, because it is not a bindable action: it
	 * has no row in Settings > Shortcuts, nothing records it, and it fires
	 * INSIDE a text field, which is the one place the sequence matcher's
	 * bindings deliberately never reach. `parseInsertEscapeSequence` turns it
	 * into the one-binding list the handler feeds, and reads any unusable value
	 * (too short, whitespace) as off.
	 *
	 * Lives in this slice because it is a keyboard-mode setting and is only read
	 * while `keyboardMode` is 'vim'.
	 */
	vimInsertEscapeSequence: string;
	/**
	 * Whether the markdown editor runs real Vim keys (operators, motions,
	 * counts, registers) while Vim mode is live.
	 *
	 * A SECOND switch in front of `keyboardMode`, not a third mode: it is only
	 * read while `keyboardMode` is 'vim', and switching it off changes nothing
	 * about Vim navigation, the shortcut tables, or the in-field escape - the
	 * markdown editor simply gets its plain CodeMirror keymap back. That is the
	 * escape hatch for the user who wants Vim chords around the app but types
	 * prose in the editor, and for anyone the editor's own Ctrl chords get in
	 * the way of.
	 *
	 * Defaults ON, because a user who asked for Vim mode asked for Vim editing;
	 * this exists to be turned off, not to be found.
	 *
	 * Lives in this slice for the same reason `vimInsertEscapeSequence` does: it
	 * is a keyboard-mode setting with no row in Settings > Shortcuts' tables,
	 * because it gates an editor extension rather than binding an action.
	 */
	vimEditorEnabled: boolean;
}

export interface ShortcutsActions {
	setShortcuts: (value: Record<string, Shortcut>) => void;
	setTabShortcuts: (value: Record<string, Shortcut>) => void;
	setKeyboardMode: (value: KeyboardMode) => void;
	setVimShortcuts: (value: Record<string, ShortcutOverride>) => void;
	setVimTabShortcuts: (value: Record<string, ShortcutOverride>) => void;
	setVimInsertEscapeSequence: (value: string) => void;
	setVimEditorEnabled: (value: boolean) => void;
}

export type ShortcutsSlice = ShortcutsState & ShortcutsActions;

export const createShortcutsSlice: StateCreator<SettingsStore, [], [], ShortcutsSlice> = (set) => ({
	shortcuts: DEFAULT_SHORTCUTS,
	tabShortcuts: TAB_SHORTCUTS,
	keyboardMode: 'default',
	vimShortcuts: VIM_SHORTCUTS,
	vimTabShortcuts: VIM_TAB_SHORTCUTS,
	vimInsertEscapeSequence: DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE,
	vimEditorEnabled: true,

	setShortcuts: (value) => {
		set({ shortcuts: value });
		window.maestro.settings.set('shortcuts', value);
	},

	setTabShortcuts: (value) => {
		set({ tabShortcuts: value });
		window.maestro.settings.set('tabShortcuts', value);
	},

	setKeyboardMode: (value) => {
		set({ keyboardMode: value });
		window.maestro.settings.set('keyboardMode', value);
		// Every chord in the app may have just changed, including the Deck leader
		// itself, so an armed Deck mode no longer describes a decision the user
		// made in the set that is now live: the key they press next would be
		// matched against a table they armed from the other mode. Disarming here
		// rather than in a mode-watching effect catches all four routes at once
		// (the chord, the palette, the hamburger menu, and the Settings toggle,
		// which goes straight to this setter without passing through
		// `switchKeyboardMode`).
		useUIStore.getState().disarmDeckMode();
	},

	setVimShortcuts: (value) => {
		set({ vimShortcuts: value });
		window.maestro.settings.set('vimShortcuts', value);
	},

	setVimTabShortcuts: (value) => {
		set({ vimTabShortcuts: value });
		window.maestro.settings.set('vimTabShortcuts', value);
	},

	setVimInsertEscapeSequence: (value) => {
		// Stored exactly as typed, including a value the parser will read as off.
		// Normalizing here would fight the user mid-edit: clearing the field to
		// retype it momentarily leaves one character, and rewriting that to ''
		// would delete what they were halfway through typing.
		set({ vimInsertEscapeSequence: value });
		window.maestro.settings.set('vimInsertEscapeSequence', value);
	},

	setVimEditorEnabled: (value) => {
		set({ vimEditorEnabled: value });
		window.maestro.settings.set('vimEditorEnabled', value);
	},
});

/**
 * One resolution, cached on the identity of the four inputs it reads.
 *
 * Every selector below is re-run by zustand on EVERY settings change, whatever
 * changed - a font size, a theme, a panel width. Resolving afresh each time
 * would hand back a new `shortcuts` object on each of those, and `useSyncExternalStore`
 * compares with `Object.is`, so every keyboard consumer in the app would
 * re-render on an unrelated setting. One entry is enough: the store holds one
 * live value set at a time, so a miss means the buckets really did change.
 */
let resolvedCache: {
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	vimShortcuts: Record<string, ShortcutOverride>;
	vimTabShortcuts: Record<string, ShortcutOverride>;
	result: EffectiveShortcuts;
} | null = null;

function resolvedVimSet(state: ShortcutsState): EffectiveShortcuts {
	const { shortcuts, tabShortcuts, vimShortcuts, vimTabShortcuts } = state;
	if (
		resolvedCache &&
		resolvedCache.shortcuts === shortcuts &&
		resolvedCache.tabShortcuts === tabShortcuts &&
		resolvedCache.vimShortcuts === vimShortcuts &&
		resolvedCache.vimTabShortcuts === vimTabShortcuts
	) {
		return resolvedCache.result;
	}
	const result = resolveEffectiveShortcuts(
		{ shortcuts, tabShortcuts },
		{ vimShortcuts, vimTabShortcuts }
	);
	resolvedCache = { shortcuts, tabShortcuts, vimShortcuts, vimTabShortcuts, result };
	return result;
}

/**
 * The general-shortcut map the LIVE mode is matched against.
 *
 * Default mode returns the bucket itself, unchanged and identical to what every
 * caller read before keyboard modes existed. Vim mode returns the resolved map.
 */
export function selectActiveShortcuts(state: ShortcutsState): Record<string, Shortcut> {
	return state.keyboardMode === 'vim' ? resolvedVimSet(state).shortcuts : state.shortcuts;
}

/** The tab-shortcut map the LIVE mode is matched against. See `selectActiveShortcuts`. */
export function selectActiveTabShortcuts(state: ShortcutsState): Record<string, Shortcut> {
	return state.keyboardMode === 'vim' ? resolvedVimSet(state).tabShortcuts : state.tabShortcuts;
}

/**
 * Actions whose inherited chord a Vim override takes, so they are unbound in
 * Vim mode until the user records one.
 *
 * Reports Vim mode's displacement WHATEVER mode is live, unlike the two
 * selectors above: the mode toggle has to be able to name these at the moment
 * it switches, which is read while default mode is still the live one.
 */
export function selectVimDisplacedActions(state: ShortcutsState): string[] {
	return resolvedVimSet(state).displaced;
}

/**
 * The state {@link selectMasteryBoundShortcuts} reads: the binding buckets plus
 * the Encore flags, which decide whether a feature's shortcut exists at all.
 */
export interface MasteryShortcutsState extends ShortcutsState {
	encoreFeatures: EncoreFeatureFlags;
}

/**
 * One entry, on the identity of every input, for the same reason
 * `resolvedCache` above has one: this selector runs on EVERY settings change,
 * and it builds a fresh array, so an uncached result would hand
 * `useSyncExternalStore` a new value each time and re-render every mastery
 * surface on an unrelated setting.
 */
let masteryCache: {
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	vimShortcuts: Record<string, ShortcutOverride>;
	vimTabShortcuts: Record<string, ShortcutOverride>;
	keyboardMode: KeyboardMode;
	encoreFeatures: EncoreFeatureFlags;
	result: Shortcut[];
} | null = null;

/**
 * The keyboard-mastery DENOMINATOR: every action the user could fire in ANY
 * mode, counted once.
 *
 * Mastery is one figure across modes. The numerator has always been keyed by
 * action id, so the denominator has to be too: a per-mode total would move the
 * percentage the moment the user switched modes, and an action learned in one
 * mode would read as unlearned in the other. Which mode is LIVE therefore does
 * not change the set - it only decides which mode's entry represents an id,
 * so a surface that also renders these shows the binding the user would press
 * right now.
 *
 * Unlike the two matching selectors above, this one resolves the Vim set even
 * in default mode. That is the point: the total has to include an action Vim
 * mode binds and default mode leaves unbound.
 *
 * A switched-off Encore Feature's shortcut is excluded in both modes. The
 * keyboard handler refuses it, so it can never be fired, and counting it would
 * hold the user below 100% forever. `FIXED_SHORTCUTS` is shared by both modes
 * and is not rebindable, so it contributes the same ids whichever one is live.
 */
export function selectMasteryBoundShortcuts(state: MasteryShortcutsState): Shortcut[] {
	const { shortcuts, tabShortcuts, vimShortcuts, vimTabShortcuts, keyboardMode, encoreFeatures } =
		state;
	if (
		masteryCache &&
		masteryCache.shortcuts === shortcuts &&
		masteryCache.tabShortcuts === tabShortcuts &&
		masteryCache.vimShortcuts === vimShortcuts &&
		masteryCache.vimTabShortcuts === vimTabShortcuts &&
		masteryCache.keyboardMode === keyboardMode &&
		masteryCache.encoreFeatures === encoreFeatures
	) {
		return masteryCache.result;
	}

	const available = (map: Record<string, Shortcut>) => availableShortcuts(map, encoreFeatures);
	const fixed = available(FIXED_SHORTCUTS);
	const vim = resolvedVimSet(state);
	const defaultMode = [available(shortcuts), available(tabShortcuts), fixed];
	const vimMode = [available(vim.shortcuts), available(vim.tabShortcuts), fixed];
	const live = keyboardMode === 'vim' ? vimMode : defaultMode;
	const other = keyboardMode === 'vim' ? defaultMode : vimMode;

	const result = collectBoundShortcutsAcrossModes(...live, ...other);
	masteryCache = {
		shortcuts,
		tabShortcuts,
		vimShortcuts,
		vimTabShortcuts,
		keyboardMode,
		encoreFeatures,
		result,
	};
	return result;
}

/** macOS Alt+key special character to normal key mapping for shortcut migration */
const MAC_ALT_CHAR_MAP: Record<string, string> = {
	'¬': 'l',
	π: 'p',
	'†': 't',
	'∫': 'b',
	'∂': 'd',
	ƒ: 'f',
	'©': 'g',
	'˙': 'h',
	ˆ: 'i',
	'∆': 'j',
	'˚': 'k',
	'¯': 'm',
	'˜': 'n',
	ø: 'o',
	'®': 'r',
	ß: 's',
	'√': 'v',
	'∑': 'w',
	'≈': 'x',
	'¥': 'y',
	Ω: 'z',
};

/**
 * One-time default remaps: when we change a bundled DEFAULT_SHORTCUTS binding,
 * users who still had the OLD default bound get migrated to the NEW default. If
 * they had customized the binding themselves (any other key combo), we leave it
 * alone.
 *
 * Each entry: `shortcut id` → `{ every old default we recognize, new default keys }`.
 * `fromKeys` is a LIST of old defaults because a binding can be remapped more
 * than once over time, and a user who skipped an update still carries the
 * oldest one.
 */
const SHORTCUT_DEFAULT_REMAPS: Record<string, { fromKeys: string[][]; toKeys: string[] }> = {
	// moveToGroup moved off Cmd+Shift+M to free that combo for openMemoryViewer.
	moveToGroup: {
		fromKeys: [['Meta', 'Shift', 'm']],
		toKeys: ['Alt', 'Meta', 'm'],
	},
	// toggleAutoRunExpanded moved off Cmd+Shift+2 to free that combo for
	// openBatchRunner, then off Cmd+Shift+E to free that combo for
	// editLastQueuedMessage. It now sits on Cmd+Shift+3, next to the other Auto
	// Run number bindings (Cmd+Shift+1 tab, Cmd+Shift+2 run).
	toggleAutoRunExpanded: {
		fromKeys: [
			['Meta', 'Shift', '2'],
			['Meta', 'Shift', 'e'],
		],
		toKeys: ['Meta', 'Shift', '3'],
	},
	// focusActiveTab moved off Opt+Cmd+F to free that combo for searchAllTabs
	// (cross-tab message search), which reads as an escalation of Cmd+F.
	focusActiveTab: {
		fromKeys: [['Alt', 'Meta', 'f']],
		toKeys: ['Alt', 'Meta', 'ArrowUp'],
	},
	// newGroupChat gave up Opt+Cmd+C so Concerto - toggled far more often - could
	// take the mnemonic C. This remap is what stops the two from COLLIDING: a user
	// who has ever opened the Shortcuts tab has the whole map persisted, so
	// without it they would keep Opt+Cmd+C on New Group Chat while Concerto also
	// claimed it, and whichever branch runs first in the keyboard handler would
	// silently swallow the other.
	newGroupChat: {
		fromKeys: [['Alt', 'Meta', 'c']],
		toKeys: ['Alt', 'Meta', 'g'],
	},
	// Concerto's stage started on a bare Opt+C, which types "ç" on macOS and so
	// never fired from the composer, then briefly sat on Opt+Cmd+V before landing
	// on the C freed above. Both old defaults are listed: a user who skipped a
	// build still carries the older one.
	toggleConcerto: {
		fromKeys: [
			['Alt', 'c'],
			['Alt', 'Meta', 'v'],
		],
		toKeys: ['Alt', 'Meta', 'c'],
	},
	toggleCadenzas: {
		fromKeys: [
			['Alt', 'Shift', 'c'],
			['Alt', 'Meta', 'Shift', 'v'],
		],
		toKeys: ['Alt', 'Meta', 'Shift', 'c'],
	},
	// jumpToBottom is back on Cmd+Shift+J, the chord it ORIGINALLY shipped with
	// (b37423abf). It briefly went to Opt+J, then to Opt+Cmd+Down, both times to
	// get out of the way of a tiling default that has since moved to Ctrl+Cmd.
	// Both interim eras are listed, plus Opt+J for the installs that never left
	// it: a user who skipped a build carries whichever one they last received.
	// Cmd+Shift+J itself is NOT listed - it is the destination, and remapping a
	// chord onto itself would set needsMigration on every load.
	jumpToBottom: {
		fromKeys: [
			['Alt', 'j'],
			['Alt', 'Meta', 'ArrowDown'],
		],
		toKeys: ['Meta', 'Shift', 'j'],
	},
	// nextUnreadTab used to be remapped here from Opt+Cmd+Down to Cmd+Shift+Down.
	// That destination later became a reserved OS chord (select-to-end in a text
	// field), so the guard below stripped it straight back to the default, which
	// IS Opt+Cmd+Down: a remap that undoes itself. Every load then flagged a
	// migration, wrote the identical map, and told the other window to reload,
	// which did the same - a settings:set ping-pong measured at over 100 writes a
	// second that pinned the main process. Do not remap onto a reserved chord.
	// The tiling family moved from unbound (and, before that, Cmd+Shift+J for the
	// terminal one) onto Ctrl+Cmd + the same letter its plain "new tab" chord
	// uses. Both eras are listed, and the UNBOUND one is the important half: the
	// merge below preserves a saved `keys` whenever it is present, and `[]` is
	// present, so anyone who has opened Settings -> Shortcuts since these shipped
	// has an empty array persisted and would never see the new default. Remapping
	// from `[]` is safe here because nothing can WRITE an empty binding - the
	// recorder rejects modifier-only presses and there is no clear-binding
	// control, so a persisted `[]` can only be an inherited unbound default.
	tileTerminalBelow: {
		fromKeys: [[], ['Meta', 'Shift', 'j']],
		toKeys: ['Control', 'Meta', 'j'],
	},
	tileAiBelow: {
		fromKeys: [[]],
		toKeys: ['Control', 'Meta', 't'],
	},
	tileBrowserBelow: {
		fromKeys: [[]],
		toKeys: ['Control', 'Meta', 'b'],
	},
	tileFileBelow: {
		fromKeys: [[]],
		toKeys: ['Control', 'Meta', 'f'],
	},
};

/**
 * The two table shapes `migrateShortcuts` runs over.
 *
 * A `Shortcut` always carries `keys`; a `ShortcutOverride` may omit the field to
 * mean "inherit the default-mode chord". One constraint covers both so the Vim
 * override buckets reuse the Alt-character repair, the reserved-chord strip, and
 * the merge with the shipped table instead of growing a second copy of each.
 */
type MigratableShortcut = { keys?: string[]; sequence?: string[][] };

/**
 * Which kind of table is being migrated.
 *
 *  - `'base'`: `DEFAULT_SHORTCUTS` / `TAB_SHORTCUTS`. These enumerate every
 *    registered action, and they are the tables `SHORTCUT_DEFAULT_REMAPS` is
 *    written in terms of.
 *  - `'override'`: `VIM_SHORTCUTS` / `VIM_TAB_SHORTCUTS`. Sparse, and the id
 *    space they draw from lives in the base tables, which this function never
 *    sees.
 */
type ShortcutTableKind = 'base' | 'override';

/**
 * `entry` with a different chord, or with no chord at all.
 *
 * The cast is the standard generic-spread one: TypeScript cannot prove that
 * `{ ...entry, keys }` is still a `T` when `T` is only known to extend
 * `MigratableShortcut`. Nothing else about the entry changes, which is the
 * whole reason this is one helper rather than a cast at each of the three
 * rewrite sites.
 */
function withKeys<T extends MigratableShortcut>(entry: T, keys: string[] | undefined): T {
	return { ...entry, keys } as T;
}

/**
 * The default entry's metadata, carrying the SAVED entry's bindings - BOTH of
 * them.
 *
 * The merge takes the label from the shipped table so a renamed action reads
 * correctly, and the bindings from disk so a customization survives. There are
 * two bindings now, a chord and a key sequence, and both have to come across
 * under the same rule: a saved entry is authoritative about a binding whenever
 * the ENTRY exists, even when the field itself is absent, because on an
 * override bucket an absent field is the spelling for "inherit the
 * default-mode binding".
 *
 * Taking the chord from disk and the sequence from the table would be the worst
 * of both: a sequence the user recorded in this mode is dropped on the next
 * load, and one they cleared comes back. `withKeys` alone cannot do this,
 * because here the spread base is the DEFAULT entry rather than the saved one.
 */
function withBindings<T extends MigratableShortcut>(defaults: T, saved: T): T {
	return { ...defaults, keys: saved.keys, sequence: saved.sequence } as T;
}

/**
 * The saved `keys` value if it can be used as a chord, otherwise `undefined`.
 *
 * `keys` is read straight off disk, so it can hold any JSON value: a
 * hand-edited settings file, a half-written sync, an older schema that spelled
 * a chord as a string. Everything downstream assumes an array of strings -
 * `migrateShortcuts` calls `.map` on it, `findReservedShortcutCombo`
 * lowercases each member, and `shortcutKeysCollide` spreads it - so a string, a
 * number, or an array with a `null` in it throws.
 *
 * The throw is the part that matters. `hydrateShortcutsSettings` runs inside
 * `loadAllSettings`, whose `catch` abandons the ENTIRE patch, so one unusable
 * chord silently reverts every other setting in the file: theme, font size,
 * panel widths, the lot. Dropping the value instead costs that one binding and
 * nothing else.
 *
 * Not written back: the repair is deterministic and idempotent, so leaving the
 * bad value on disk costs one `Array.isArray` per load, while persisting it
 * would notify every other window to reload for a setting the user never
 * touched.
 */
function usableChordKeys(keys: unknown): string[] | undefined {
	if (!Array.isArray(keys)) return undefined;
	return keys.every((key) => typeof key === 'string') ? (keys as string[]) : undefined;
}

/**
 * Migrate shortcuts: fix macOS Alt+key special characters, apply one-time
 * default remaps, and merge with current defaults. Returns the merged shortcuts
 * (for store state), the raw migrated map (for persistence write-back), and
 * whether a migration write is needed.
 *
 * `migratedRaw` applies BOTH migrations so writing it back makes `needsMigration`
 * false on the next load. Writing only a partially-migrated map caused an
 * infinite re-persist loop via the settings file watcher.
 *
 * Generic over the entry shape so the Vim override buckets run through the same
 * repairs as the default buckets. `kind` is what the two cases differ by, and
 * both differences are noted at the rule they change.
 */
function migrateShortcuts<T extends MigratableShortcut>(
	saved: Record<string, T>,
	defaults: Record<string, T>,
	kind: ShortcutTableKind
): {
	shortcuts: Record<string, T>;
	migratedRaw: Record<string, T>;
	needsMigration: boolean;
} {
	const migrated: Record<string, T> = {};
	let needsMigration = false;

	for (const [id, shortcut] of Object.entries(saved)) {
		// An override entry with no `keys` says "inherit the default-mode
		// chord". There is no chord to repair, and inventing an empty array
		// here would rewrite that as "unbound in this mode". An entry whose
		// `keys` is not a usable chord is treated the same way, for the reasons
		// in `usableChordKeys`.
		const savedKeys = usableChordKeys(shortcut.keys);
		if (!savedKeys) {
			migrated[id] = withKeys(
				shortcut,
				// A base entry has to end up with a chord: its `keys` is read
				// unguarded everywhere downstream, and the shipped default is
				// the fallback that leaves the action working. An override drops
				// the field instead, which is the spelling for "inherit".
				kind === 'base' ? (defaults[id]?.keys ?? []) : undefined
			);
			continue;
		}
		const migratedKeys = savedKeys.map((key) => {
			if (MAC_ALT_CHAR_MAP[key]) {
				needsMigration = true;
				return MAC_ALT_CHAR_MAP[key];
			}
			return key;
		});
		migrated[id] = withKeys(shortcut, migratedKeys);
	}

	// Apply one-time default remaps: if the user still has the OLD default keys
	// for a remapped shortcut, bump them to the NEW default. Preserve custom bindings.
	//
	// Base tables only. Every entry in SHORTCUT_DEFAULT_REMAPS reads "this was
	// the DEFAULT-mode default once, move it to the current one", so running it
	// over an override bucket would mistake a chord the user deliberately chose
	// for this mode for a stale default and move it out from under them. It
	// would also undo the point of the separate buckets: default mode's history
	// would be rewriting Vim mode's bindings.
	if (kind === 'base') {
		for (const [id, remap] of Object.entries(SHORTCUT_DEFAULT_REMAPS)) {
			const current = migrated[id];
			const currentKeys = current?.keys;
			// `[]` is truthy, so an unbound binding still reaches the compare -
			// which the tiling family's `fromKeys: [[]]` entries depend on.
			if (
				current &&
				currentKeys &&
				remap.fromKeys.some((from) => shortcutKeysEqual(currentKeys, from))
			) {
				migrated[id] = withKeys(current, remap.toKeys);
				needsMigration = true;
			}
		}
	}

	// Drop any binding on a chord the OS owns inside a text field (see
	// RESERVED_SHORTCUT_COMBOS). The recorder refuses these now, but a chord
	// bound before that guard existed is still on disk, and it shadows the
	// native behavior every time - the user's select-to-end silently jumps
	// agents instead. Fall back to the bundled default so the action keeps
	// working rather than going unbound without explanation.
	for (const [id, shortcut] of Object.entries(migrated)) {
		if (!findReservedShortcutCombo(shortcut.keys)) continue;
		const fallback = defaults[id]?.keys;
		// Only take a default that is itself free, or the next load would strip
		// it again and re-persist forever through the settings file watcher.
		const free = fallback && !findReservedShortcutCombo(fallback) ? fallback : undefined;
		// With no free fallback a BASE binding goes unbound (`[]`), which is a
		// real state for a registered action. An OVERRIDE instead loses `keys`
		// altogether, which means "inherit the default-mode chord": a sparse
		// table usually has no entry to fall back to, and `[]` there would
		// silently unbind the action in this mode rather than leaving it
		// reachable on its default chord.
		migrated[id] = withKeys(shortcut, free ?? (kind === 'base' ? [] : undefined));
		needsMigration = true;
	}

	// Merge: use default labels (in case they changed) but preserve user's custom keys.
	//
	// A base table enumerates every registered action, so a saved id the table
	// does not know belongs to a retired action and is dropped. A sparse
	// override table enumerates nothing - the ids it draws from live in the BASE
	// table, which this function never sees - so dropping unknown ids here would
	// throw away every chord the user recorded in this mode for an action the
	// shipped overrides happen not to mention, which is almost all of them.
	// `resolveEffectiveShortcuts` is where an override id that no base map
	// declares gets ignored.
	const merged: Record<string, T> = {};
	const mergeIds =
		kind === 'base'
			? Object.keys(defaults)
			: [...new Set([...Object.keys(defaults), ...Object.keys(migrated)])];
	for (const id of mergeIds) {
		const defaultShortcut = defaults[id];
		const savedShortcut = migrated[id];
		if (!defaultShortcut) {
			// Override-only id: there is no table entry to take a label from, so
			// the saved entry stands as it is.
			merged[id] = { ...savedShortcut };
			continue;
		}
		// A saved entry is authoritative about its BINDINGS whenever it EXISTS,
		// even when a field is absent. On an override bucket that absence is
		// the spelling for "inherit the default-mode binding", so reading the
		// table's chord here would overrule the user. On a base bucket `keys`
		// is never absent, which makes this the same rule as before.
		merged[id] = savedShortcut
			? withBindings(defaultShortcut, savedShortcut)
			: { ...defaultShortcut };
	}

	// A migration is only a migration if it changed something. Each pass above
	// raises the flag when its RULE fires, but two rules can cancel out (a remap
	// onto a chord the reserved guard then reverts), leaving the map byte-for-byte
	// what was saved. Writing that back is not a no-op: it notifies every other
	// window, which reloads, re-migrates, and writes again, forever. Comparing the
	// result to the input makes that class of loop impossible for any future rule.
	const changed = Object.keys(migrated).some(
		(id) => !shortcutKeysEqualInOrder(migrated[id].keys, saved[id]?.keys)
	);

	return { shortcuts: merged, migratedRaw: migrated, needsMigration: needsMigration && changed };
}

function shortcutKeysEqualInOrder(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined
): boolean {
	// Two absent chords are equal; one absent chord never equals a present one,
	// including a present empty one. On an override bucket that distinction is
	// the difference between "inherit" and "unbound in this mode", and getting
	// it wrong would either miss a migration or write one on every load.
	if (!a || !b) return a === b;
	return a.length === b.length && a.every((key, i) => key === b[i]);
}

/** Mutates `patch` in place with any persisted shortcut fields found in `allSettings`, applying migration. */
export function hydrateShortcutsSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<ShortcutsState>
): void {
	if (allSettings['shortcuts'] !== undefined) {
		const result = migrateShortcuts(
			allSettings['shortcuts'] as Record<string, Shortcut>,
			DEFAULT_SHORTCUTS,
			'base'
		);
		patch.shortcuts = result.shortcuts;
		if (result.needsMigration) {
			window.maestro.settings.set('shortcuts', result.migratedRaw);
		}
	}

	if (allSettings['tabShortcuts'] !== undefined) {
		const result = migrateShortcuts(
			allSettings['tabShortcuts'] as Record<string, Shortcut>,
			TAB_SHORTCUTS,
			'base'
		);
		patch.tabShortcuts = result.shortcuts;
		if (result.needsMigration) {
			window.maestro.settings.set('tabShortcuts', result.migratedRaw);
		}
	}

	// Anything that is not one of the two known modes lands on 'default' rather
	// than being written through. The value is on disk, so it can predate a mode
	// being renamed, or arrive from a hand-edited settings file, and an
	// unrecognized string would read as "not default" everywhere downstream and
	// match an override table that does not exist.
	if (allSettings['keyboardMode'] !== undefined) {
		patch.keyboardMode = asKeyboardMode(allSettings['keyboardMode']) ?? 'default';
	}

	// The Vim buckets hydrate from their OWN settings keys through the same
	// migration, with `'override'` rather than `'base'`. Neither branch here
	// reads or writes the other mode's bucket.
	if (allSettings['vimShortcuts'] !== undefined) {
		const result = migrateShortcuts(
			allSettings['vimShortcuts'] as Record<string, ShortcutOverride>,
			VIM_SHORTCUTS,
			'override'
		);
		patch.vimShortcuts = result.shortcuts;
		if (result.needsMigration) {
			window.maestro.settings.set('vimShortcuts', result.migratedRaw);
		}
	}

	// Stored as typed, and read as off when it cannot work (see
	// `parseInsertEscapeSequence`). Anything that is not a string is dropped
	// rather than coerced: `String(123)` would be a working escape sequence
	// nobody asked for.
	if (typeof allSettings['vimInsertEscapeSequence'] === 'string') {
		patch.vimInsertEscapeSequence = allSettings['vimInsertEscapeSequence'];
	}

	// Booleans only. A truthy string from a hand-edited settings file would read
	// as "on" under `!!`, and the one value a user is likely to write there by
	// hand is `"false"`, which is exactly the case that would invert.
	if (typeof allSettings['vimEditorEnabled'] === 'boolean') {
		patch.vimEditorEnabled = allSettings['vimEditorEnabled'];
	}

	if (allSettings['vimTabShortcuts'] !== undefined) {
		const result = migrateShortcuts(
			allSettings['vimTabShortcuts'] as Record<string, ShortcutOverride>,
			VIM_TAB_SHORTCUTS,
			'override'
		);
		patch.vimTabShortcuts = result.shortcuts;
		if (result.needsMigration) {
			window.maestro.settings.set('vimTabShortcuts', result.migratedRaw);
		}
	}
}
