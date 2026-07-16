import { describe, expect, it } from 'vitest';

import { parseSettingsCliValue } from '../../../cli/utils/settings-value';

describe('parseSettingsCliValue', () => {
	it.each([
		['true', true],
		['false', false],
		['null', null],
		['42', 42],
		['-1.5', -1.5],
		['["a",1]', ['a', 1]],
		['{"enabled":true}', { enabled: true }],
		['hello', 'hello'],
		['007', '007'],
		['', ''],
		['{not json}', '{not json}'],
	])('preserves the established coercion contract for %j', (input, expected) => {
		expect(parseSettingsCliValue(input)).toEqual(expected);
	});
});
