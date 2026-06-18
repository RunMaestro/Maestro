import { describe, expect, it } from 'vitest';
import {
	formatPlaygroundDuration,
	sliderToTime,
	timeToSlider,
} from '../../../../../renderer/components/PlaygroundPanel/utils/achievementTime';

describe('PlaygroundPanel achievement time helpers', () => {
	it('formats zero and sub-minute durations', () => {
		expect(formatPlaygroundDuration(0)).toBe('0s');
		expect(formatPlaygroundDuration(9000)).toBe('9s');
		expect(formatPlaygroundDuration(59000)).toBe('59s');
	});

	it('formats minute durations with remaining seconds', () => {
		expect(formatPlaygroundDuration(65000)).toBe('1m 5s');
		expect(formatPlaygroundDuration(3599000)).toBe('59m 59s');
	});

	it('formats hour durations with remaining minutes', () => {
		expect(formatPlaygroundDuration(3600000)).toBe('1h 0m');
		expect(formatPlaygroundDuration(18600000)).toBe('5h 10m');
	});

	it('formats day durations with remaining hours', () => {
		expect(formatPlaygroundDuration(86400000)).toBe('1d 0h');
		expect(formatPlaygroundDuration(183600000)).toBe('2d 3h');
	});

	it('maps zero slider value to zero time', () => {
		expect(sliderToTime(0)).toBe(0);
		expect(timeToSlider(0)).toBe(0);
		expect(timeToSlider(999)).toBe(0);
	});

	it('maps the upper slider bound near the ten year maximum', () => {
		expect(sliderToTime(100)).toBeGreaterThan(315000000000);
		expect(timeToSlider(315360000000)).toBe(100);
	});

	it('round trips logarithmic slider values within rounding tolerance', () => {
		for (const sliderValue of [1, 10, 25, 50, 75, 99]) {
			const roundTrip = timeToSlider(sliderToTime(sliderValue));
			expect(Math.abs(roundTrip - sliderValue)).toBeLessThanOrEqual(1);
		}
	});
});
