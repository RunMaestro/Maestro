import { describe, expect, it } from 'vitest';
import {
	NOTIFICATION_VARIANT_COLORS,
	isNotificationTimeoutWithinLimit,
	parseNotificationTimeout,
	resolveNotificationColor,
} from '../../shared/notification';

describe('resolveNotificationColor', () => {
	it.each([
		['defaults to theme', undefined, undefined, { ok: true, color: 'theme' }],
		['accepts explicit color', 'green', undefined, { ok: true, color: 'green' }],
		[
			'prefers explicit color over legacy alias',
			'orange',
			'success',
			{ ok: true, color: 'orange' },
		],
		['resolves legacy alias', undefined, 'warning', { ok: true, color: 'yellow' }],
		['rejects unknown explicit color', 'blue', 'success', { ok: false, source: 'color' }],
		['rejects unknown alias', undefined, 'notice', { ok: false, source: 'alias' }],
	])('%s', (_name, color, alias, expected) => {
		expect(resolveNotificationColor(color, alias, NOTIFICATION_VARIANT_COLORS)).toEqual(expected);
	});
});

describe('parseNotificationTimeout', () => {
	it.each([
		['undefined', undefined, undefined],
		['positive numeric string', '1.25', 1.25],
		['positive number', 5, 5],
		['zero', 0, null],
		['negative', -1, null],
		['non-finite', Number.POSITIVE_INFINITY, null],
		['non-numeric', 'one', null],
	])('%s', (_name, value, expected) => {
		expect(parseNotificationTimeout(value)).toBe(expected);
	});

	it.each([
		['at maximum', 60, 60, true],
		['above maximum', 60.01, 60, false],
	])('%s', (_name, timeout, maximum, expected) => {
		expect(isNotificationTimeoutWithinLimit(timeout, maximum)).toBe(expected);
	});
});
