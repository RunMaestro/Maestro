import { describe, it, expect } from 'vitest';
import {
	compileSearchRegex,
	parseLineQuery,
	SEARCH_KIND_CYCLE,
} from '../../../../../renderer/components/FilePreview/search/queryMatch';
import { escapeRegExp } from '../../../../../shared/stringUtils';

describe('escapeRegExp', () => {
	it('escapes regex metacharacters so they match literally', () => {
		const escaped = escapeRegExp('a.b*c?');
		expect(new RegExp(escaped).test('a.b*c?')).toBe(true);
		expect(new RegExp(escaped).test('axbxc')).toBe(false);
	});

	it('leaves plain text untouched', () => {
		expect(escapeRegExp('hello')).toBe('hello');
	});
});

describe('compileSearchRegex', () => {
	it('returns null regex and no error for an empty query', () => {
		expect(compileSearchRegex('')).toEqual({ regex: null, error: null });
	});

	it('escapes the query in literal mode (default)', () => {
		const { regex } = compileSearchRegex('a.b');
		expect(regex).not.toBeNull();
		expect(regex!.test('a.b')).toBe(true);
		expect(regex!.test('axb')).toBe(false);
	});

	it('passes the query through verbatim in regex mode', () => {
		const { regex } = compileSearchRegex('a.b', { regex: true });
		expect(regex!.test('axb')).toBe(true);
	});

	it('is case-insensitive by default and case-sensitive on request', () => {
		expect(compileSearchRegex('abc').regex!.flags).toBe('gi');
		expect(compileSearchRegex('abc', { caseSensitive: true }).regex!.flags).toBe('g');
	});

	it('reports an error for an invalid regex pattern', () => {
		const { regex, error } = compileSearchRegex('(', { regex: true });
		expect(regex).toBeNull();
		expect(error).toBeTruthy();
	});

	it('never errors in literal mode even for metacharacter-heavy input', () => {
		const { regex, error } = compileSearchRegex('([{');
		expect(error).toBeNull();
		expect(regex!.test('([{')).toBe(true);
	});
});

describe('parseLineQuery', () => {
	it('parses a positive integer', () => {
		expect(parseLineQuery('42')).toBe(42);
		expect(parseLineQuery('  7 ')).toBe(7);
	});

	it('rejects non-positive, non-integer, and non-numeric input', () => {
		expect(parseLineQuery('0')).toBeNull();
		expect(parseLineQuery('-3')).toBeNull();
		expect(parseLineQuery('1.5')).toBeNull();
		expect(parseLineQuery('abc')).toBeNull();
		expect(parseLineQuery('')).toBeNull();
		expect(parseLineQuery('12x')).toBeNull();
	});
});

describe('SEARCH_KIND_CYCLE', () => {
	it('cycles text → regex → line', () => {
		expect([...SEARCH_KIND_CYCLE]).toEqual(['text', 'regex', 'line']);
	});
});
