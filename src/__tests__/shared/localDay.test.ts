import { describe, it, expect } from 'vitest';
import { addLocalDays, parseLocalYmd, toLocalYmd } from '../../shared/localDay';

describe('localDay', () => {
	it('keys a timestamp or Date by the LOCAL calendar day', () => {
		const lateEvening = new Date(2026, 9, 16, 23, 30);
		expect(toLocalYmd(lateEvening)).toBe('2026-10-16');
		expect(toLocalYmd(lateEvening.getTime())).toBe('2026-10-16');
	});

	it('parses to local midnight and rejects malformed input', () => {
		expect(parseLocalYmd('2026-10-16')?.getTime()).toBe(new Date(2026, 9, 16).getTime());
		expect(parseLocalYmd('nope')).toBeNull();
	});

	it('shifts across month and year boundaries', () => {
		expect(addLocalDays('2026-10-31', 1)).toBe('2026-11-01');
		expect(addLocalDays('2027-01-01', -1)).toBe('2026-12-31');
		expect(addLocalDays('bad', 3)).toBe('bad');
	});
});
