import { describe, it, expect } from 'vitest';
import {
	buildSessionJumpSlotMap,
	sessionJumpShortcut,
	sessionJumpSlotDigit,
} from '../../../renderer/utils/sessionJumpSlots';

describe('sessionJumpSlots', () => {
	it('maps slot indexes 0-8 to 1-9, 9 to 0, and nothing past the tenth', () => {
		expect(sessionJumpSlotDigit(0)).toBe('1');
		expect(sessionJumpSlotDigit(8)).toBe('9');
		expect(sessionJumpSlotDigit(9)).toBe('0');
		expect(sessionJumpSlotDigit(10)).toBeNull();
		expect(sessionJumpSlotDigit(-1)).toBeNull();
	});

	it('assigns digits in draw order and stops at ten agents', () => {
		const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}` }));
		const map = buildSessionJumpSlotMap(sessions);

		expect(map.size).toBe(10);
		expect(map.get('s0')).toBe('1');
		expect(map.get('s9')).toBe('0');
		expect(map.has('s10')).toBe(false);
	});

	it('builds the Opt+Cmd chord for a digit', () => {
		expect(sessionJumpShortcut('3').keys).toEqual(['Alt', 'Meta', '3']);
	});
});
