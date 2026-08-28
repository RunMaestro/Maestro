import { describe, it, expect } from 'vitest';

import {
	bindFilterExpression,
	evaluateFilterNode,
	parseRelativeTime,
	suggestColumn,
	toComparable,
	toSearchText,
	tokenizeFilter,
} from '../../../shared/parquet/filterExpression';
import type { ParquetColumnInfo } from '../../../shared/parquet/types';

function column(
	name: string,
	kind: ParquetColumnInfo['kind'],
	overrides: Partial<ParquetColumnInfo> = {}
): ParquetColumnInfo {
	return {
		name,
		physicalType: 'BYTE_ARRAY',
		logicalType: null,
		kind,
		optional: true,
		nested: false,
		compression: 'SNAPPY',
		compressedBytes: 0,
		uncompressedBytes: 0,
		stats: { nullCount: 0, min: null, max: null, partial: false },
		...overrides,
	};
}

const COLUMNS: ParquetColumnInfo[] = [
	column('name', 'string'),
	column('region', 'string'),
	column('price', 'float', { physicalType: 'DOUBLE' }),
	column('id', 'integer', { physicalType: 'INT64' }),
	column('active', 'boolean', { physicalType: 'BOOLEAN' }),
	column('ts', 'timestamp', { physicalType: 'INT64', timeUnit: 'MICROS' }),
	column('day', 'date', { physicalType: 'INT32' }),
	column('order id', 'string'),
];

/** Bind an expression and evaluate it against one row object. */
function matches(
	expression: string,
	row: Record<string, unknown>,
	now = Date.UTC(2024, 5, 1)
): boolean {
	const bound = bindFilterExpression(expression, COLUMNS, now);
	expect(bound.problem).toBeUndefined();
	expect(bound.node).not.toBeNull();
	return evaluateFilterNode(
		bound.node!,
		(name) => row[name],
		COLUMNS.map((c) => c.name)
	);
}

describe('tokenizeFilter', () => {
	it('keeps a path together instead of lexing its slashes as a regex', () => {
		const tokens = tokenizeFilter('path ^= /var/log');
		expect(tokens.map((t) => t.text)).toEqual(['path', '^=', '/var/log', '']);
		expect(tokens[2].type).toBe('word');
	});

	it('lexes a regex when the slash opens the token', () => {
		const tokens = tokenizeFilter('name ~ /^acme-\\d+$/i');
		expect(tokens[2].type).toBe('regex');
		expect(tokens[2].text).toBe('^acme-\\d+$');
		expect(tokens[2].flags).toBe('i');
	});

	it('accepts both quote styles, backslash escapes, and doubled quotes', () => {
		expect(tokenizeFilter(`'it''s'`)[0].text).toBe("it's");
		expect(tokenizeFilter('"a\\"b"')[0].text).toBe('a"b');
	});

	it('reads a bracketed identifier as one word', () => {
		const tokens = tokenizeFilter('[order id] = 42');
		expect(tokens[0].text).toBe('order id');
		expect(tokens[0].identifierQuoted).toBe(true);
	});

	it('classifies numbers but leaves ISO dates as words', () => {
		expect(tokenizeFilter('1.5e3')[0].type).toBe('number');
		expect(tokenizeFilter('2024-01-15')[0].type).toBe('word');
	});
});

describe('bindFilterExpression', () => {
	it('treats an empty expression as no filter at all', () => {
		expect(bindFilterExpression('   ', COLUMNS).node).toBeNull();
	});

	it('reads a bare word as a search across every column', () => {
		const bound = bindFilterExpression('acme', COLUMNS);
		expect(bound.node).toEqual({ kind: 'anyColumn', needle: 'acme' });
		expect(bound.scansAllColumns).toBe(true);
		expect(bound.columns).toEqual(COLUMNS.map((c) => c.name));
	});

	it('reports only the columns a typed predicate touches', () => {
		const bound = bindFilterExpression('price > 10 and region = eu', COLUMNS);
		expect(bound.columns.sort()).toEqual(['price', 'region']);
		expect(bound.scansAllColumns).toBe(false);
	});

	it('combines juxtaposed terms with an implicit and', () => {
		expect(matches('region=eu price>900', { region: 'eu', price: 950 })).toBe(true);
		expect(matches('region=eu price>900', { region: 'eu', price: 100 })).toBe(false);
	});

	it('resolves a column name case-insensitively', () => {
		expect(matches('REGION = eu', { region: 'eu' })).toBe(true);
	});

	it('suggests the nearest column for a typo', () => {
		const bound = bindFilterExpression('regionn = eu', COLUMNS);
		expect(bound.problem?.suggestion).toBe('region');
		expect(bound.problem?.message).toContain('Did you mean');
		expect(bound.problem?.start).toBe(0);
		expect(bound.problem?.end).toBe(7);
	});

	it('never throws on malformed input, it reports a span', () => {
		for (const bad of [
			'price >',
			'(region = eu',
			'price > > 3',
			'"open',
			'region = eu and',
			'not',
		]) {
			const bound = bindFilterExpression(bad, COLUMNS);
			expect(bound.problem, bad).toBeDefined();
			expect(bound.node, bad).toBeNull();
		}
	});

	it('reads an unterminated regex as an ordinary word rather than failing', () => {
		// `/unterminated` is far more likely a path fragment than a regex, and
		// a search box that errors on a slash is a search box people stop using.
		const bound = bindFilterExpression('name ~ /unterminated', COLUMNS);
		expect(bound.problem).toBeUndefined();
		expect(matches('name ~ /unterminated', { name: 'a/unterminated/b' })).toBe(true);
	});

	it('rejects a literal that cannot be the column type', () => {
		expect(bindFilterExpression('price > abc', COLUMNS).problem?.message).toContain('not a number');
		expect(bindFilterExpression('ts > nonsense', COLUMNS).problem?.message).toContain('not a date');
		expect(bindFilterExpression('active = maybe', COLUMNS).problem?.message).toContain(
			'not true or false'
		);
	});

	it('binds an int64 literal past 2^53 as a bigint so it stays exact', () => {
		const bound = bindFilterExpression('id = 9007199254740993', COLUMNS);
		const node = bound.node as { literal: { value: unknown } };
		expect(node.literal.value).toBe(9007199254740993n);
	});
});

describe('evaluateFilterNode', () => {
	it('compares numbers numerically, not lexically', () => {
		expect(matches('price > 9', { price: 100 })).toBe(true);
		expect(matches('price < 9', { price: 100 })).toBe(false);
	});

	it('matches a bigint column value against a small number literal', () => {
		expect(matches('id = 42', { id: 42n })).toBe(true);
		expect(matches('id > 41', { id: 42n })).toBe(true);
	});

	it('reduces a Date to epoch milliseconds on both sides', () => {
		expect(matches('ts >= 2024-01-15', { ts: new Date('2024-01-16T00:00:00Z') })).toBe(true);
		expect(matches('ts >= 2024-01-15', { ts: new Date('2024-01-14T00:00:00Z') })).toBe(false);
	});

	it('accepts a datetime written with a space instead of a T', () => {
		expect(matches('ts >= "2024-01-15 10:30"', { ts: new Date('2024-01-15T10:31:00') })).toBe(true);
	});

	it('resolves relative time against the reference instant', () => {
		const now = Date.UTC(2024, 5, 10);
		expect(matches('ts >= now-7d', { ts: new Date(now - 86_400_000) }, now)).toBe(true);
		expect(matches('ts >= now-7d', { ts: new Date(now - 30 * 86_400_000) }, now)).toBe(false);
	});

	it('follows SQL null semantics: only an explicit null test matches a null', () => {
		expect(matches('price > 0', { price: null })).toBe(false);
		expect(matches('price != 5', { price: null })).toBe(false);
		expect(matches('price is null', { price: null })).toBe(true);
		expect(matches('price is not null', { price: null })).toBe(false);
		expect(matches('price is not null', { price: 5 })).toBe(true);
	});

	it('treats "= null" as the friendlier spelling of "is null"', () => {
		expect(matches('price = null', { price: null })).toBe(true);
		expect(matches('price != null', { price: 3 })).toBe(true);
	});

	it('handles in, not in, and between', () => {
		expect(matches('region in (us, eu)', { region: 'eu' })).toBe(true);
		expect(matches('region in (us, eu)', { region: 'apac' })).toBe(false);
		expect(matches('region not in (us, eu)', { region: 'apac' })).toBe(true);
		expect(matches('id between 10 and 20', { id: 15 })).toBe(true);
		expect(matches('id between 10 and 20', { id: 20 })).toBe(true);
		expect(matches('id between 10 and 20', { id: 21 })).toBe(false);
	});

	it('matches substrings, prefixes, and suffixes case-insensitively', () => {
		expect(matches('name ~ ACME', { name: 'the-acme-co' })).toBe(true);
		expect(matches('name !~ acme', { name: 'other' })).toBe(true);
		expect(matches('name ^= acme', { name: 'AcmeCorp' })).toBe(true);
		expect(matches('name ^= acme', { name: 'xacme' })).toBe(false);
		expect(matches('name $= corp', { name: 'AcmeCorp' })).toBe(true);
	});

	it('runs a regex literal, case-insensitive unless flags say otherwise', () => {
		expect(matches('name ~ /^acme/', { name: 'ACME Ltd' })).toBe(true);
		expect(matches('name ~ /^acme/u', { name: 'ACME Ltd' })).toBe(false);
	});

	it('searches every column for a bare term, including numbers and nested values', () => {
		expect(matches('4999', { name: 'user_4999', price: 1 })).toBe(true);
		expect(matches('4999', { name: 'x', price: 4999 })).toBe(true);
		expect(matches('nope', { name: 'x', price: 1 })).toBe(false);
	});

	it('composes and / or / not with parentheses', () => {
		const row = { region: 'eu', price: 50 };
		expect(matches('region = eu and price > 100', row)).toBe(false);
		expect(matches('region = eu or price > 100', row)).toBe(true);
		expect(matches('not (region = eu)', row)).toBe(false);
		expect(matches('(region = us or region = eu) and price < 100', row)).toBe(true);
	});

	it('accepts a bracketed column name containing a space', () => {
		expect(matches('[order id] = abc', { 'order id': 'abc' })).toBe(true);
	});
});

describe('toComparable / toSearchText', () => {
	it('renders bytes as hex and nested values as JSON', () => {
		expect(toComparable(new Uint8Array([0xde, 0xad]))).toBe('dead');
		expect(toComparable(['a', 'b'])).toBe('["a","b"]');
	});

	it('stringifies a bigint inside a nested value instead of throwing', () => {
		expect(toComparable({ n: 1n })).toBe('{"n":"1"}');
	});

	it('renders null as empty search text', () => {
		expect(toSearchText(null)).toBe('');
	});
});

describe('parseRelativeTime', () => {
	const now = Date.UTC(2024, 0, 15, 12, 0, 0);

	it('resolves now and offsets', () => {
		expect(parseRelativeTime('now', now)).toBe(now);
		expect(parseRelativeTime('now-1h', now)).toBe(now - 3_600_000);
		expect(parseRelativeTime('now+30m', now)).toBe(now + 1_800_000);
	});

	it('returns undefined for anything absolute, so date parsing takes over', () => {
		expect(parseRelativeTime('2024-01-15', now)).toBeUndefined();
	});
});

describe('suggestColumn', () => {
	const names = ['customer_id', 'region', 'created_at'];

	it('prefers a prefix hit over edit distance', () => {
		expect(suggestColumn('cust', names)).toBe('customer_id');
	});

	it('corrects a one-character typo', () => {
		expect(suggestColumn('regionn', names)).toBe('region');
	});

	it('gives up when nothing is close', () => {
		expect(suggestColumn('zzzzzzzz', names)).toBeUndefined();
	});
});
