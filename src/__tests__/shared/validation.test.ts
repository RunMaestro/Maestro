import { describe, expect, it } from 'vitest';
import { hasInvalidOptionalStrings } from '../../shared/validation';

describe('hasInvalidOptionalStrings', () => {
	it.each([
		['absent', {}, false],
		['undefined', { optional: undefined }, false],
		['empty', { optional: '' }, false],
		['whitespace', { optional: '   ' }, false],
		['string', { optional: 'value' }, false],
		['array', { optional: [] }, true],
		['number', { optional: 1 }, true],
		['null', { optional: null }, true],
	])('treats %s values according to the optional string contract', (_name, raw, expected) => {
		expect(hasInvalidOptionalStrings(raw, ['optional'])).toBe(expected);
	});
});
