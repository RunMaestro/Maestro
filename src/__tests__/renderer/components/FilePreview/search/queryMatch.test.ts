import { describe, it, expect } from 'vitest';
import {
	escapeRegExp,
	compileSearchRegex,
	parseLineQuery,
	SEARCH_KIND_CYCLE,
	findMatchRanges,
	expandReplacement,
	buildReplacements,
} from '../../../../../renderer/components/FilePreview/search/queryMatch';

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

/** Apply edits the way one CodeMirror transaction does: offsets refer to the original. */
function apply(content: string, edits: { from: number; to: number; insert: string }[]): string {
	return [...edits]
		.sort((a, b) => b.from - a.from)
		.reduce((text, e) => text.slice(0, e.from) + e.insert + text.slice(e.to), content);
}

describe('findMatchRanges', () => {
	it('finds every match, case-insensitively like the search bar', () => {
		expect(findMatchRanges('Foo foo FOO', 'foo')).toEqual([
			{ from: 0, to: 3 },
			{ from: 4, to: 7 },
			{ from: 8, to: 11 },
		]);
	});

	it('terminates on zero-length matches', () => {
		expect(findMatchRanges('a\nb', '^')).toHaveLength(1);
		expect(findMatchRanges('ab', '(?:)')).toHaveLength(3);
	});
});

describe('expandReplacement', () => {
	const exec = (pattern: string, input: string) => new RegExp(pattern).exec(input)!;

	it('expands numbered and named groups', () => {
		expect(expandReplacement('$2-$1', exec('(\\w+) (\\w+)', 'hello world'))).toBe('world-hello');
		expect(expandReplacement('<$<word>>', exec('(?<word>\\w+)', 'hi'))).toBe('<hi>');
	});

	it('expands the whole match, the text around it, and an escaped dollar', () => {
		const m = exec('b', 'abc');
		expect(expandReplacement('[$&]', m)).toBe('[b]');
		expect(expandReplacement("$`|$'", m)).toBe('a|c');
		expect(expandReplacement('$$5', m)).toBe('$5');
	});

	it('leaves a reference to a missing group literal, as String.replace does', () => {
		const m = exec('(a)', 'a');
		expect(expandReplacement('$2', m)).toBe('$2');
		expect(expandReplacement('$0', m)).toBe('$0');
		// One group: `$10` is group 1 followed by a literal 0.
		expect(expandReplacement('$10', m)).toBe('a0');
		expect(expandReplacement('$<name>', m)).toBe('$<name>');
	});

	it('agrees with String.prototype.replace on a mixed template', () => {
		const pattern = '(\\d+)-(?<tail>\\w+)';
		const input = 'id 42-abc end';
		const template = '$<tail>:$1 ($&) $$';
		expect(expandReplacement(template, exec(pattern, input))).toBe(
			'42-abc'.replace(new RegExp(pattern), template)
		);
	});
});

describe('buildReplacements', () => {
	it('replaces every match as edits against the original text (Replace All)', () => {
		const content = 'cat Cat cAt';
		const edits = buildReplacements(content, 'cat', 'dog', { regex: false });
		expect(edits).toHaveLength(3);
		expect(apply(content, edits)).toBe('dog dog dog');
	});

	it('replaces only the requested match (Replace)', () => {
		const content = 'a1 a2 a3';
		const edits = buildReplacements(content, 'a\\d', 'X', { regex: true, onlyIndex: 1 });
		expect(edits).toEqual([{ from: 3, to: 5, insert: 'X' }]);
		expect(apply(content, edits)).toBe('a1 X a3');
	});

	it('returns nothing for an index past the last match', () => {
		expect(buildReplacements('a', 'a', 'b', { regex: false, onlyIndex: 5 })).toEqual([]);
	});

	it('expands group references in regex mode only', () => {
		const content = 'x=1';
		const pattern = '(\\w)=(\\d)';
		expect(apply(content, buildReplacements(content, pattern, '$2=$1', { regex: true }))).toBe(
			'1=x'
		);
		// Text mode inserts the replacement verbatim, `$` and all.
		expect(apply('a+b', buildReplacements('a+b', escapeRegExp('+'), '$1', { regex: false }))).toBe(
			'a$1b'
		);
	});
});
