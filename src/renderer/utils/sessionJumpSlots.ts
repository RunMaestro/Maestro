import type { Shortcut } from '../types';

/**
 * Opt+Cmd+1..9 and Opt+Cmd+0 reach the first ten agents the Left Bar draws,
 * in the order it draws them (`visibleSessions` from useSortedSessions). The
 * tenth slot is bound to `0`.
 */
export const SESSION_JUMP_SLOT_COUNT = 10;

/** The digit key bound to a slot index, or null past the tenth slot. */
export function sessionJumpSlotDigit(index: number): string | null {
	if (index < 0 || index >= SESSION_JUMP_SLOT_COUNT) return null;
	return index === SESSION_JUMP_SLOT_COUNT - 1 ? '0' : String(index + 1);
}

/** Agent ID -> slot digit for every agent that has an Opt+Cmd+# slot. */
export function buildSessionJumpSlotMap(visibleSessions: { id: string }[]): Map<string, string> {
	const map = new Map<string, string>();
	const count = Math.min(visibleSessions.length, SESSION_JUMP_SLOT_COUNT);
	for (let i = 0; i < count; i++) {
		map.set(visibleSessions[i].id, sessionJumpSlotDigit(i)!);
	}
	return map;
}

/** The Opt+Cmd+# chord for a slot digit, shaped for shortcut display. */
export function sessionJumpShortcut(digit: string): Shortcut {
	return { id: 'jumpToSession', label: `Jump to Agent ${digit}`, keys: ['Alt', 'Meta', digit] };
}
