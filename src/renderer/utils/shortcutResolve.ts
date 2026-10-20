/**
 * The binding a surface DISPLAYS for an action, in the LIVE keyboard mode.
 *
 * A chord in Maestro is drawn in dozens of places at once - the help modal,
 * every Quick Actions row, the tooltip on a tab close button, the hint chip in
 * an overlay menu, the wizard tour, the Settings search results - and many of
 * them used to spell the combo into a string literal. That was already wrong
 * for a user who rebound the action, and it became a lie for a whole mode: in
 * Vim mode `goToHistory` sits on `Ctrl+Alt+Shift+H`, so every hard-coded
 * "Cmd+Shift+H" names a chord that does something else.
 *
 * So display reads from the same place behavior does. This module is the
 * LOOKUP half of that: given an action id and the live mode's maps, it answers
 * with the two triggers the user can actually press. The maps come from
 * `useActiveShortcuts()` (or `selectActiveShortcuts()` outside React), never
 * from the `shortcuts` / `tabShortcuts` settings buckets - see
 * `src/shared/effectiveShortcuts.ts` for why pairing a bucket with a mode by
 * hand is silent in both directions.
 *
 * Deliberately DOM-free and React-free: `maestro-cli` prints the hotkey for a
 * surface it can open (`maestro-cli open --list`), and it resolves the same set
 * from persisted settings. The hook wrapper lives next door in
 * `src/renderer/hooks/keyboard/useShortcutKeys.ts`.
 */

import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import type { Shortcut } from '../../shared/shortcut-types';

/**
 * The three tables an action id can be declared in, in one bag.
 *
 * `shortcuts` and `tabShortcuts` are the live mode's EFFECTIVE maps.
 * `fixedShortcuts` defaults to the shared `FIXED_SHORTCUTS` table, which no
 * mode overrides and no user rebinds; it is a field only so a test can resolve
 * against a fixture without reaching into the module.
 */
export interface ShortcutDisplayMaps {
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	fixedShortcuts?: Record<string, Shortcut>;
}

/**
 * What an action can be fired by, right now.
 *
 * Both triggers, because an action may carry a chord, a key sequence, or both,
 * and when it has both BOTH fire (see {@link Shortcut.sequence}). A surface
 * that drew only the chord would hide the `g g` a Vim user is meant to learn.
 *
 * `keys` is an empty array and `sequence` is absent when the action has no
 * binding in this mode - an action can ship unbound, and a mode override can
 * displace one. Callers render NOTHING in that case rather than an empty key
 * cap, which would advertise a combo that does nothing. The canonical "can this
 * be fired at all" test is `isShortcutBound` in
 * `src/renderer/constants/keyboardMastery.ts` (private to that module today);
 * reach for it rather than writing a second copy of the two-field check.
 */
export interface ResolvedShortcut {
	keys: string[];
	sequence?: string[][];
}

/** Shared unbound answer, so a caller comparing by identity sees no change. */
export const UNBOUND_SHORTCUT: ResolvedShortcut = { keys: [] };

/**
 * The binding for `actionId`, or {@link UNBOUND_SHORTCUT} when the id is
 * unknown, absent, or unbound in this mode.
 *
 * The fallback order mirrors the merge `ShortcutsHelpModal` has always done
 * (`{ ...shortcuts, ...tabShortcuts, ...FIXED_SHORTCUTS }`, where the later
 * spread wins): fixed table, then tab table, then global table. Tab before
 * global is also what `isTabShortcut` matches on, so display and behavior agree
 * on which of two declarations fires. The fixed table's place in the order
 * cannot matter in practice - a structural test in
 * `src/__tests__/renderer/constants/shortcuts.test.ts` asserts the three id
 * sets are mutually disjoint - and it is first here only so that reading
 * through this function is indistinguishable from reading the merged map.
 *
 * An id that IS present with `keys: []` resolves to that entry rather than
 * falling through to the next table: an action the user cleared, or one a mode
 * override displaced, is genuinely unbound and must not be shown wearing
 * another table's chord.
 *
 * `actionId` is optional so a component with an optional `actionId` prop can
 * call the hook wrapper unconditionally.
 */
export function resolveShortcutKeys(
	actionId: string | undefined,
	maps: ShortcutDisplayMaps
): ResolvedShortcut {
	if (!actionId) return UNBOUND_SHORTCUT;
	const fixed = maps.fixedShortcuts ?? FIXED_SHORTCUTS;
	const entry = fixed[actionId] ?? maps.tabShortcuts[actionId] ?? maps.shortcuts[actionId];
	if (!entry) return UNBOUND_SHORTCUT;
	// The inner arrays are passed through by reference: `resolveEffectiveShortcuts`
	// is identity-preserving, so a consumer memoizing on `keys` keeps its memo
	// across unrelated settings writes.
	const keys = entry.keys ?? [];
	const sequence = entry.sequence?.length ? entry.sequence : undefined;
	if (keys.length === 0 && !sequence) return UNBOUND_SHORTCUT;
	return sequence ? { keys, sequence } : { keys };
}
