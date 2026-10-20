import type { KeyboardMasteryLevel, Shortcut } from '../types';

export interface KeyboardMasteryLevelDef {
	id: KeyboardMasteryLevel;
	name: string;
	threshold: number;
	description: string;
}

export const KEYBOARD_MASTERY_LEVELS: readonly KeyboardMasteryLevelDef[] = [
	{ id: 'beginner', name: 'Beginner', threshold: 0, description: 'Just starting out' },
	{ id: 'student', name: 'Student', threshold: 25, description: 'Learning the basics' },
	{ id: 'performer', name: 'Performer', threshold: 50, description: 'Getting comfortable' },
	{ id: 'virtuoso', name: 'Virtuoso', threshold: 75, description: 'Almost there' },
	{ id: 'maestro', name: 'Keyboard Maestro', threshold: 100, description: 'Complete mastery' },
] as const;

/**
 * Returns the highest level where threshold <= percentage
 */
export function getLevelForPercentage(percentage: number): KeyboardMasteryLevelDef {
	let level = KEYBOARD_MASTERY_LEVELS[0];
	for (const lvl of KEYBOARD_MASTERY_LEVELS) {
		if (percentage >= lvl.threshold) {
			level = lvl;
		} else {
			break;
		}
	}
	return level;
}

/**
 * Returns the level index (0-4) based on percentage
 */
export function getLevelIndex(percentage: number): number {
	let index = 0;
	for (let i = 0; i < KEYBOARD_MASTERY_LEVELS.length; i++) {
		if (percentage >= KEYBOARD_MASTERY_LEVELS[i].threshold) {
			index = i;
		} else {
			break;
		}
	}
	return index;
}

/**
 * Merge shortcut maps and keep only the shortcuts that actually have a chord
 * bound to them.
 *
 * A shortcut with no keys cannot be fired, so it can never be "used": counting
 * one in the mastery denominator caps the user below 100% forever, and listing
 * it under "Unused Shortcuts" tells them to go press a chord that does not
 * exist. Every mastery figure runs its maps through here first.
 *
 * Later maps win on id, matching the spread order the call sites already used.
 * Bindings are read from the LIVE maps rather than the defaults, so clearing a
 * binding in Settings -> Shortcuts drops it from the denominator too.
 *
 * SINGLE-mode and chord-only, which is why no mastery surface calls it any
 * more: mastery is one count across keyboard modes, so every denominator goes
 * through `selectMasteryBoundShortcuts` and {@link collectBoundShortcutsAcrossModes}
 * instead. Kept as the one-mode primitive, and as the thing the rule above is
 * pinned against.
 */
export function collectBoundShortcuts(
	...maps: (Record<string, Shortcut> | undefined)[]
): Shortcut[] {
	const merged = new Map<string, Shortcut>();
	for (const map of maps) {
		if (!map) continue;
		for (const [id, shortcut] of Object.entries(map)) {
			merged.set(id, shortcut);
		}
	}
	return Array.from(merged.values()).filter((shortcut) => shortcut.keys.length > 0);
}

/**
 * How many of the bound shortcuts the user has fired.
 *
 * Not the same as `usedShortcuts.length`: that list keeps ids whose binding was
 * later cleared or removed from the app, which would push the numerator past
 * the denominator and report more than 100%.
 */
export function countUsedBoundShortcuts(
	bound: readonly Shortcut[],
	usedShortcutIds: Iterable<string>
): number {
	const used = usedShortcutIds instanceof Set ? usedShortcutIds : new Set(usedShortcutIds);
	return bound.filter((shortcut) => used.has(shortcut.id)).length;
}

/**
 * Whether an action can be fired at all.
 *
 * Two triggers count, and either one on its own is enough: a chord in `keys`,
 * and a key sequence in `sequence`. An action that only has a sequence is as
 * reachable as one that only has a chord, so leaving it out of the denominator
 * would pin the user below 100% exactly as an unbound one does.
 */
function isShortcutBound(shortcut: Shortcut): boolean {
	return shortcut.keys.length > 0 || (shortcut.sequence?.length ?? 0) > 0;
}

/**
 * Every action bound in AT LEAST ONE of the given maps, by action id.
 *
 * The cross-mode denominator. Mastery is counted per ACTION, never per mode,
 * per chord, or per sequence, so an action the user can fire in either mode
 * belongs in the total exactly once and switching modes must not move the
 * figure. Pass every mode's maps: the default buckets plus `FIXED_SHORTCUTS`,
 * then the resolved maps of each non-default mode.
 *
 * Two things separate this from {@link collectBoundShortcuts}, and both matter
 * for a denominator spanning modes:
 *
 *  - A later map never REMOVES an id an earlier map bound. `collectBoundShortcuts`
 *    merges first and filters second, so a mode that leaves an action unbound
 *    would delete it from a total another mode binds it in. Here each map can
 *    only ever add.
 *  - "Bound" is a chord OR a sequence (see {@link isShortcutBound}), where
 *    `collectBoundShortcuts` predates sequences and asks about the chord alone.
 *
 * The FIRST map that binds an id supplies the entry returned for it, so a
 * caller that also renders these (the Usage Dashboard lists the unbound ones)
 * can put the live mode's maps first and show the chord the user would press
 * right now. Membership does not depend on that order.
 */
export function collectBoundShortcutsAcrossModes(
	...maps: (Record<string, Shortcut> | undefined)[]
): Shortcut[] {
	const bound = new Map<string, Shortcut>();
	for (const map of maps) {
		if (!map) continue;
		for (const [id, shortcut] of Object.entries(map)) {
			if (bound.has(id) || !isShortcutBound(shortcut)) continue;
			bound.set(id, shortcut);
		}
	}
	return Array.from(bound.values());
}
