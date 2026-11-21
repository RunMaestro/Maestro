// Source: src/__tests__/renderer/utils/sessionJumpSlots.test.ts
// Source: src/__tests__/renderer/utils/sessionVisibility.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { buildSessionJumpSlotMap } from '../../../renderer/utils/sessionJumpSlots';
import { sessionJumpShortcut } from '../../../renderer/utils/sessionJumpSlots';
import { sessionJumpSlotDigit } from '../../../renderer/utils/sessionJumpSlots';
import { filterSessionsVisibleInSidebar } from '../../../renderer/utils/sessionVisibility';
import { isSessionVisibleInSidebar } from '../../../renderer/utils/sessionVisibility';
import type { VisibilityScopableSession } from '../../../renderer/utils/sessionVisibility';
describeSourceSuite('sessionJumpSlots', () => {
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
});
describeSourceSuite('sessionVisibility', () => {
	/** Sessions carry ids in production; the predicate only reads `isPianola`. */
	type TestSession = VisibilityScopableSession & { id: string };

	describe('isSessionVisibleInSidebar', () => {
		it('keeps an ordinary agent regardless of the pianola flag', () => {
			expect(isSessionVisibleInSidebar({}, { pianolaEnabled: false })).toBe(true);
			expect(isSessionVisibleInSidebar({}, { pianolaEnabled: true })).toBe(true);
		});

		it('hides the Pianola agent while its Encore flag is off', () => {
			expect(isSessionVisibleInSidebar({ isPianola: true }, { pianolaEnabled: false })).toBe(false);
			expect(isSessionVisibleInSidebar({ isPianola: true }, {})).toBe(false);
		});

		it('shows the Pianola agent once its Encore flag is on', () => {
			expect(isSessionVisibleInSidebar({ isPianola: true }, { pianolaEnabled: true })).toBe(true);
		});
	});

	describe('filterSessionsVisibleInSidebar', () => {
		const alpha: TestSession = { id: 'a' };
		const pianola: TestSession = { id: 'p', isPianola: true };

		it('drops the Pianola agent while the flag is off', () => {
			expect(filterSessionsVisibleInSidebar([alpha, pianola], { pianolaEnabled: false })).toEqual([
				alpha,
			]);
		});

		it('returns the same array identity when nothing is hidden', () => {
			const sessions = [alpha, pianola];
			// Flag on: no filtering, so memoized consumers keep a stable reference.
			expect(filterSessionsVisibleInSidebar(sessions, { pianolaEnabled: true })).toBe(sessions);
			// Flag off but no Pianola present: still no new array.
			const ordinary: TestSession[] = [alpha];
			expect(filterSessionsVisibleInSidebar(ordinary, { pianolaEnabled: false })).toBe(ordinary);
		});
	});
});
