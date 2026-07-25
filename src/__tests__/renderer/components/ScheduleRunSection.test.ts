/**
 * Tests for the `datetime-local` <-> epoch-ms helpers behind the Auto Run
 * "Start" control (issue #716).
 *
 * The critical property is local-timezone round-tripping: `toISOString()` would
 * shift the value by the UTC offset and silently schedule the run at the wrong
 * wall-clock time.
 */

import { describe, it, expect } from 'vitest';
import {
	toDateTimeLocalValue,
	parseDateTimeLocalValue,
} from '../../../renderer/components/ScheduleRunSection';

describe('toDateTimeLocalValue', () => {
	it('formats a Date as YYYY-MM-DDTHH:mm in local time', () => {
		expect(toDateTimeLocalValue(new Date(2026, 4, 22, 14, 30))).toBe('2026-05-22T14:30');
	});

	it('zero-pads single-digit month, day, hour, and minute', () => {
		expect(toDateTimeLocalValue(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05T09:07');
	});
});

describe('parseDateTimeLocalValue', () => {
	it('parses a value as local wall-clock time', () => {
		expect(parseDateTimeLocalValue('2026-05-22T14:30')).toBe(
			new Date(2026, 4, 22, 14, 30, 0, 0).getTime()
		);
	});

	it('round-trips through toDateTimeLocalValue without a timezone shift', () => {
		const original = new Date(2026, 10, 1, 23, 59, 0, 0);
		const parsed = parseDateTimeLocalValue(toDateTimeLocalValue(original));
		expect(parsed).toBe(original.getTime());
	});

	it('tolerates surrounding whitespace', () => {
		expect(parseDateTimeLocalValue('  2026-05-22T14:30  ')).toBe(
			new Date(2026, 4, 22, 14, 30, 0, 0).getTime()
		);
	});

	it('returns null for empty or malformed values', () => {
		expect(parseDateTimeLocalValue('')).toBeNull();
		expect(parseDateTimeLocalValue('2026-05-22')).toBeNull();
		expect(parseDateTimeLocalValue('tomorrow at 3')).toBeNull();
		// Seconds are not part of the datetime-local format the input emits.
		expect(parseDateTimeLocalValue('2026-05-22T14:30:00')).toBeNull();
	});
});
