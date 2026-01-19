import type { KeyboardMasteryLevel } from '../types';

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
