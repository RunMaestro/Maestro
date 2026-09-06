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
