/**
 * Tests for shared object utility functions
 *
 * @file src/shared/objectUtils.ts
 */

import { describe, it, expect } from 'vitest';
import { definedOnly } from '../../shared/objectUtils';

describe('definedOnly', () => {
	it('drops the keys whose value is undefined', () => {
		const result = definedOnly({ a: 1, b: undefined, c: 'x' });

		expect(result).toEqual({ a: 1, c: 'x' });
		expect('b' in result).toBe(false);
	});

	it('keeps every other falsy value, because each is a choice', () => {
		expect(definedOnly({ off: false, zero: 0, blank: '', none: null })).toEqual({
			off: false,
			zero: 0,
			blank: '',
			none: null,
		});
	});

	it('returns a new object and leaves the input untouched', () => {
		const input = { a: 1, b: undefined };
		const result = definedOnly(input);

		expect(result).not.toBe(input);
		expect('b' in input).toBe(true);
	});

	it('keeps nested values by reference without filtering inside them', () => {
		const nested = { inner: undefined };
		const list = [undefined];
		const result = definedOnly({ nested, list });

		expect(result.nested).toBe(nested);
		expect(result.list).toBe(list);
	});

	it('returns an empty object when nothing is set', () => {
		expect(definedOnly({ a: undefined, b: undefined })).toEqual({});
		expect(Object.keys(definedOnly({ a: undefined }))).toEqual([]);
	});
});
