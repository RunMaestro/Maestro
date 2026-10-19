/**
 * The EFFECTIVE binding set for a keyboard mode.
 *
 * Exactly one mode is live at a time, and every keyboard path in the app
 * matches against one pair of maps. Default mode's pair is the `shortcuts` /
 * `tabShortcuts` buckets as they are. A non-default mode's pair is computed
 * here: its sparse override bucket, plus the default chord for every action the
 * override bucket does not mention.
 *
 * Why the inheritance rather than a second full table: a mode that only listed
 * its own chords would silently unbind every action it forgot, and an action
 * that is unreachable in one mode is indistinguishable from a bug. So the base
 * map is the floor, and an override only ever REPLACES.
 *
 * Why the displacement list rather than letting the collision stand: within a
 * mode, one chord must fire one action. When an override takes a chord some
 * other action inherits, both would answer the same keypress, and which one won
 * would come down to the order of the branches in the keyboard handler. The
 * override wins (the user chose it for this mode), the inheriting action is
 * dropped to unbound, and its id is reported so the UI can ask for a chord of
 * its own instead of leaving it dead.
 *
 * This module is DOM-free on purpose: `maestro-cli` resolves the same set so it
 * can print the hotkey the user actually has, and the renderer's selectors in
 * `settingsShortcutsSlice.ts` are the only other caller.
 */

import type { Shortcut, ShortcutOverride } from './shortcut-types';
import { shortcutKeysCollide, shortcutKeysEqual } from './shortcutKeys';

/** The default-mode buckets a mode inherits from. */
export interface ShortcutBaseMaps {
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
}

/** One mode's sparse override buckets. */
export interface ShortcutOverrideMaps {
	vimShortcuts: Record<string, ShortcutOverride>;
	vimTabShortcuts: Record<string, ShortcutOverride>;
}

/** The pair of maps a mode is matched against, plus what it cost. */
export interface EffectiveShortcuts {
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	/**
	 * Actions whose inherited chord was taken by an override, in base-map
	 * declaration order (`shortcuts` first, then `tabShortcuts`). Each one is
	 * unbound in the resolved maps and needs a chord of its own in this mode.
	 */
	displaced: string[];
}

/** Shared empty list, so a caller comparing by identity sees no change. */
const NO_DISPLACED: string[] = [];

/**
 * The chord an override assigns, by action id, across BOTH override buckets.
 *
 * The bucket an override is written in says which MATCHER reads it, not which
 * base map declares the action: `isTabShortcut` reads
 * `tabShortcuts[id] || shortcuts[id]`, so a tab action can be declared in
 * either base map, and `VIM_TAB_SHORTCUTS` carries `prevTab` / `nextTab` even
 * though `DEFAULT_SHORTCUTS` is where those two are declared. So an id is
 * looked up in both buckets, PREFERRING the one that mirrors the base map
 * declaring it, and falling back to the other.
 *
 * The preference is what keeps a user's edit from being shadowed by a shipped
 * override. Settings > Shortcuts lists an action in the section of the base map
 * that declares it and writes its edit to the matching bucket, so a re-bind of
 * Previous Tab lands in `vimShortcuts` while the shipped chord sits in
 * `vimTabShortcuts`. Without the preference the shipped chord would keep
 * winning and the recording would look accepted and do nothing. An id declared
 * in BOTH base maps prefers the tab bucket, the same precedence
 * `isTabShortcut` itself applies.
 *
 * Iterating the BASE maps rather than the buckets also implements the last of
 * the four states a persisted entry can be in: an id no base map declares is a
 * retired action the hydration deliberately kept, and it is never reached. The
 * state before it, an entry with no `keys`, means "inherit the default-mode
 * chord" and is skipped here so the fallback bucket still gets its say.
 */
function collectOverrideKeys(
	base: ShortcutBaseMaps,
	overrides: ShortcutOverrideMaps
): Map<string, string[]> {
	const byId = new Map<string, string[]>();
	const take = (
		id: string,
		preferred: Record<string, ShortcutOverride>,
		fallback: Record<string, ShortcutOverride>
	) => {
		// `keys: []` is present, and truthy, so an explicit clear in the
		// preferred bucket beats a chord in the fallback one.
		const keys = preferred[id]?.keys ?? fallback[id]?.keys;
		if (keys) byId.set(id, keys);
	};
	for (const id of Object.keys(base.shortcuts)) {
		take(id, overrides.vimShortcuts, overrides.vimTabShortcuts);
	}
	for (const id of Object.keys(base.tabShortcuts)) {
		take(id, overrides.vimTabShortcuts, overrides.vimShortcuts);
	}
	return byId;
}

/**
 * Resolve one mode's effective binding set from the default buckets and that
 * mode's overrides.
 *
 * Pure, and identity-preserving where it can be: an action whose chord this
 * mode does not change is returned as the SAME object, and a map with no change
 * at all is returned as the same map. Callers memoize on identity (the store
 * selectors re-run on every settings change, and a fresh map each time would
 * re-render every keyboard consumer in the app).
 */
export function resolveEffectiveShortcuts(
	base: ShortcutBaseMaps,
	overrides: ShortcutOverrideMaps
): EffectiveShortcuts {
	const overrideKeys = collectOverrideKeys(base, overrides);

	// Only a real chord can take a keypress from another action. An override of
	// `keys: []` is the user clearing the binding in this mode, and an empty
	// chord collides with nothing.
	const winningChords = [...overrideKeys.values()].filter((keys) => keys.length > 0);

	const displaced: string[] = [];
	const seen = new Set<string>();

	const resolveMap = (map: Record<string, Shortcut>): Record<string, Shortcut> => {
		const out: Record<string, Shortcut> = {};
		let changed = false;
		for (const [id, shortcut] of Object.entries(map)) {
			// `undefined` rather than falsy: an override of `keys: []` is the
			// user clearing the binding in this mode, and it has to win over
			// the inherited chord like any other override.
			const override = overrideKeys.get(id);
			if (override !== undefined) {
				// An override applies to every base map that declares the action.
				// No id lives in two base maps today; if one ever does, writing
				// the chord to one of them would leave the other matcher firing
				// the default-mode chord in this mode.
				out[id] = { ...shortcut, keys: override };
				changed = true;
				continue;
			}
			if (winningChords.some((chord) => shortcutKeysCollide(chord, shortcut.keys))) {
				out[id] = { ...shortcut, keys: [] };
				changed = true;
				if (!seen.has(id)) {
					seen.add(id);
					displaced.push(id);
				}
				continue;
			}
			out[id] = shortcut;
		}
		return changed ? out : map;
	};

	return {
		shortcuts: resolveMap(base.shortcuts),
		tabShortcuts: resolveMap(base.tabShortcuts),
		displaced: displaced.length > 0 ? displaced : NO_DISPLACED,
	};
}

/**
 * Fold a whole-map shortcut edit into a mode's override bucket.
 *
 * The write-side mirror of {@link resolveEffectiveShortcuts}. The recorder in
 * Settings > Shortcuts edits one row and hands back the whole map it was shown
 * (`{ ...shortcuts, [id]: { ...shortcuts[id], keys } }`), so the only way to
 * learn WHICH binding the user changed is to diff that map against the one they
 * were looking at. Writing the map wholesale instead would turn the entire
 * inherited set into explicit overrides on the first edit, and a displaced
 * action's `keys: []` into a deliberate "cleared in this mode" - the mode would
 * stop inheriting anything and freeze that day's default chords.
 *
 * `before` is the EFFECTIVE map the user was shown, not the base map, which is
 * what makes re-recording a chord an action already has a no-op rather than a
 * new override.
 *
 * `current` is ONE bucket, the one that mirrors the base map the edited rows
 * are declared in - the general bucket for a `shortcuts` edit, the tab bucket
 * for a `tabShortcuts` edit. `collectOverrideKeys` prefers that same bucket
 * when it reads the chord back, so the two sides agree on where an id's
 * override lives and a shipped entry in the other bucket cannot shadow it.
 *
 * Returns `current` unchanged when nothing differs, so the caller can skip a
 * settings write (every write notifies the other windows, which reload).
 */
export function overridesWithEdits(
	current: Record<string, ShortcutOverride>,
	before: Record<string, Shortcut>,
	next: Record<string, Shortcut>
): Record<string, ShortcutOverride> {
	let edited: Record<string, ShortcutOverride> | null = null;
	for (const [id, shortcut] of Object.entries(next)) {
		const shown = before[id];
		// Order-independent: the recorder emits a canonical order, but a chord
		// read back in another order is the same chord and must not be written.
		if (shown && shortcutKeysEqual(shown.keys, shortcut.keys)) continue;
		edited ??= { ...current };
		edited[id] = { id, label: shortcut.label, keys: [...shortcut.keys] };
	}
	return edited ?? current;
}

/**
 * Whether an action takes its chord in this mode from the default buckets.
 *
 * True for an id the override bucket does not mention AND for an entry that
 * omits `keys`: an override written without a chord is the explicit spelling of
 * "inherit", so it reads as inherited rather than as a customization. An entry
 * with `keys: []` is NOT inherited - the user cleared the binding in this mode,
 * which is a choice the UI has to show as one.
 */
export function isOverrideInherited(id: string, overrides: ShortcutOverrideMaps): boolean {
	return !overrides.vimShortcuts[id]?.keys && !overrides.vimTabShortcuts[id]?.keys;
}
