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
import { asKeyboardMode } from '../../shared/shortcut-types';
import type { KeyboardMode } from '../../shared/shortcut-types';
import type { Shortcut } from '../types';
import { DEFAULT_SHORTCUTS, TAB_SHORTCUTS } from '../constants/shortcuts';
import type { SettingsStore } from './settingsStore';

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
}

export interface ShortcutsActions {
	setShortcuts: (value: Record<string, Shortcut>) => void;
	setTabShortcuts: (value: Record<string, Shortcut>) => void;
	setKeyboardMode: (value: KeyboardMode) => void;
}

export type ShortcutsSlice = ShortcutsState & ShortcutsActions;

export const createShortcutsSlice: StateCreator<SettingsStore, [], [], ShortcutsSlice> = (set) => ({
	shortcuts: DEFAULT_SHORTCUTS,
	tabShortcuts: TAB_SHORTCUTS,
	keyboardMode: 'default',

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
	},
});

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
 * Migrate shortcuts: fix macOS Alt+key special characters, apply one-time
 * default remaps, and merge with current defaults. Returns the merged shortcuts
 * (for store state), the raw migrated map (for persistence write-back), and
 * whether a migration write is needed.
 *
 * `migratedRaw` applies BOTH migrations so writing it back makes `needsMigration`
 * false on the next load. Writing only a partially-migrated map caused an
 * infinite re-persist loop via the settings file watcher.
 */
function migrateShortcuts(
	saved: Record<string, Shortcut>,
	defaults: Record<string, Shortcut>
): {
	shortcuts: Record<string, Shortcut>;
	migratedRaw: Record<string, Shortcut>;
	needsMigration: boolean;
} {
	const migrated: Record<string, Shortcut> = {};
	let needsMigration = false;

	for (const [id, shortcut] of Object.entries(saved)) {
		const migratedKeys = shortcut.keys.map((key) => {
			if (MAC_ALT_CHAR_MAP[key]) {
				needsMigration = true;
				return MAC_ALT_CHAR_MAP[key];
			}
			return key;
		});
		migrated[id] = { ...shortcut, keys: migratedKeys };
	}

	// Apply one-time default remaps: if the user still has the OLD default keys
	// for a remapped shortcut, bump them to the NEW default. Preserve custom bindings.
	for (const [id, remap] of Object.entries(SHORTCUT_DEFAULT_REMAPS)) {
		const current = migrated[id];
		if (current && remap.fromKeys.some((from) => shortcutKeysEqual(current.keys, from))) {
			migrated[id] = { ...current, keys: remap.toKeys };
			needsMigration = true;
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
		migrated[id] = {
			...shortcut,
			keys: fallback && !findReservedShortcutCombo(fallback) ? fallback : [],
		};
		needsMigration = true;
	}

	// Merge: use default labels (in case they changed) but preserve user's custom keys
	const merged: Record<string, Shortcut> = {};
	for (const [id, defaultShortcut] of Object.entries(defaults)) {
		const savedShortcut = migrated[id];
		merged[id] = {
			...defaultShortcut,
			keys: savedShortcut?.keys ?? defaultShortcut.keys,
		};
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

function shortcutKeysEqualInOrder(a: readonly string[], b: readonly string[] | undefined): boolean {
	return !!b && a.length === b.length && a.every((key, i) => key === b[i]);
}

/** Mutates `patch` in place with any persisted shortcut fields found in `allSettings`, applying migration. */
export function hydrateShortcutsSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<ShortcutsState>
): void {
	if (allSettings['shortcuts'] !== undefined) {
		const result = migrateShortcuts(
			allSettings['shortcuts'] as Record<string, Shortcut>,
			DEFAULT_SHORTCUTS
		);
		patch.shortcuts = result.shortcuts;
		if (result.needsMigration) {
			window.maestro.settings.set('shortcuts', result.migratedRaw);
		}
	}

	if (allSettings['tabShortcuts'] !== undefined) {
		const result = migrateShortcuts(
			allSettings['tabShortcuts'] as Record<string, Shortcut>,
			TAB_SHORTCUTS
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
}
