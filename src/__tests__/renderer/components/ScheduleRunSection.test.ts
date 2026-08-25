/**
 * Tests for the Auto Run "Start" control's date/time helpers.
 *
 * The timezone round-trip is the point. A `datetime-local` value is LOCAL wall
 * clock, so reading it as UTC shifts every scheduled run by the machine's
 * offset - "start at 6am" quietly becomes 1am, and the failure is invisible on
 * a UTC dev box.
 */

import { describe, it, expect } from 'vitest';
import {
	toDateTimeLocalValue,
	fromDateTimeLocalValue,
	validateScheduledStart,
} from '../../../renderer/components/ScheduleRunSection';

describe('ScheduleRunSection date helpers', () => {
	it('round-trips a local date through the picker value', () => {
		const original = new Date(2030, 5, 14, 6, 30, 0, 0);
		const value = toDateTimeLocalValue(original);

		expect(value).toBe('2030-06-14T06:30');
		expect(fromDateTimeLocalValue(value)?.getTime()).toBe(original.getTime());
	});

	it('reads the picker value as local wall clock, not UTC', () => {
		const parsed = fromDateTimeLocalValue('2030-06-14T06:30');

		// The whole point: 06:30 in the picker means 06:30 where the user is.
		expect(parsed?.getHours()).toBe(6);
		expect(parsed?.getMinutes()).toBe(30);
	});

	it('zero-pads single-digit months, days, hours, and minutes', () => {
		expect(toDateTimeLocalValue(new Date(2030, 0, 5, 9, 7))).toBe('2030-01-05T09:07');
	});

	it('returns null for an empty or unparseable value', () => {
		expect(fromDateTimeLocalValue('')).toBeNull();
		expect(fromDateTimeLocalValue('not-a-date')).toBeNull();
	});
});

describe('validateScheduledStart', () => {
	const now = new Date(2030, 5, 14, 6, 0, 0, 0);

	it('treats an empty value as "now" and accepts it', () => {
		expect(validateScheduledStart('', now)).toBeNull();
	});

	it('accepts a time comfortably in the future', () => {
		expect(validateScheduledStart('2030-06-14T08:00', now)).toBeNull();
	});

	it('rejects a time in the past', () => {
		expect(validateScheduledStart('2030-06-14T05:00', now)).toMatch(/at least a minute/);
	});

	it('rejects a time inside the minimum lead window', () => {
		// 30s out - the run would fire before the user finished setting it up.
		expect(validateScheduledStart('2030-06-14T06:00', now)).toMatch(/at least a minute/);
	});

	it('rejects an unparseable value', () => {
		expect(validateScheduledStart('garbage', now)).toMatch(/valid date and time/);
	});
});
