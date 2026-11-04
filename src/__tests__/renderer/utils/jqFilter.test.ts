import { describe, it, expect } from 'vitest';
import { parseJq, evaluateJq, applyJqFilter } from '../../../renderer/utils/jqFilter';

function jq(expr: string, data: unknown): unknown[] {
	return evaluateJq(parseJq(expr), data);
}

const SAMPLE = {
	type: 'queue-operation',
	operation: 'enqueue',
	timestamp: '2026-04-15T01:14:45.942Z',
	count: 42,
	active: true,
	tags: ['urgent', 'backend'],
	nested: { a: { b: 1 } },
	items: [
		{ name: 'x', val: 10 },
		{ name: 'y', val: 20 },
		{ name: 'z', val: 5 },
	],
};

// ── Identity & Literals ──────────────────────────────────────────────────────

describe('identity and literals', () => {
	it('. returns input', () => {
		expect(jq('.', SAMPLE)).toEqual([SAMPLE]);
	});

	it('string literal', () => {
		expect(jq('"hello"', null)).toEqual(['hello']);
	});

	it('number literal', () => {
		expect(jq('42', null)).toEqual([42]);
	});

	it('negative number', () => {
		expect(jq('-3', null)).toEqual([-3]);
	});

	it('boolean and null literals', () => {
		expect(jq('true', null)).toEqual([true]);
		expect(jq('false', null)).toEqual([false]);
		expect(jq('null', null)).toEqual([null]);
	});
});

// ── Field Access ─────────────────────────────────────────────────────────────

describe('field access', () => {
	it('.field extracts a field', () => {
		expect(jq('.type', SAMPLE)).toEqual(['queue-operation']);
	});

	it('.field.nested navigates nested fields', () => {
		expect(jq('.nested.a.b', SAMPLE)).toEqual([1]);
	});

	it('missing field returns null', () => {
		expect(jq('.nonexistent', SAMPLE)).toEqual([null]);
	});

	it('.field on null returns null', () => {
		expect(jq('.foo', null)).toEqual([null]);
	});

	it('quoted field with .["name"]', () => {
		expect(jq('.["type"]', SAMPLE)).toEqual(['queue-operation']);
	});
});

// ── Array Indexing ───────────────────────────────────────────────────────────

describe('array indexing', () => {
	it('.[n] returns nth element', () => {
		expect(jq('.[0]', [10, 20, 30])).toEqual([10]);
		expect(jq('.[2]', [10, 20, 30])).toEqual([30]);
	});

	it('.[-n] indexes from end', () => {
		expect(jq('.[-1]', [10, 20, 30])).toEqual([30]);
		expect(jq('.[-2]', [10, 20, 30])).toEqual([20]);
	});

	it('.field[n] chains field and index', () => {
		expect(jq('.tags[0]', SAMPLE)).toEqual(['urgent']);
	});

	it('out of bounds returns null', () => {
		expect(jq('.[99]', [1, 2, 3])).toEqual([null]);
	});
});

// ── Iteration ────────────────────────────────────────────────────────────────

describe('iteration', () => {
	it('.[] iterates array', () => {
		expect(jq('.[]', [1, 2, 3])).toEqual([1, 2, 3]);
	});

	it('.[] iterates object values', () => {
		const result = jq('.[]', { a: 1, b: 2 });
		expect(result).toEqual([1, 2]);
	});

	it('.field[] chains field and iteration', () => {
		expect(jq('.tags[]', SAMPLE)).toEqual(['urgent', 'backend']);
	});
});

// ── Pipe ─────────────────────────────────────────────────────────────────────

describe('pipe', () => {
	it('chains expressions with |', () => {
		expect(jq('.nested | .a | .b', SAMPLE)).toEqual([1]);
	});

	it('pipe feeds each left result into right', () => {
		expect(jq('.tags[] | length', SAMPLE)).toEqual([6, 7]);
	});
});

// ── Comma (multiple outputs) ─────────────────────────────────────────────────

describe('comma', () => {
	it('produces multiple outputs', () => {
		expect(jq('.type, .operation', SAMPLE)).toEqual(['queue-operation', 'enqueue']);
	});
});

// ── Comparison ───────────────────────────────────────────────────────────────

describe('comparison', () => {
	it('== compares values', () => {
		expect(jq('.count == 42', SAMPLE)).toEqual([true]);
		expect(jq('.count == 99', SAMPLE)).toEqual([false]);
	});

	it('!= compares inequality', () => {
		expect(jq('.type != "error"', SAMPLE)).toEqual([true]);
	});

	it('numeric comparisons', () => {
		expect(jq('.count > 10', SAMPLE)).toEqual([true]);
		expect(jq('.count < 10', SAMPLE)).toEqual([false]);
		expect(jq('.count >= 42', SAMPLE)).toEqual([true]);
		expect(jq('.count <= 42', SAMPLE)).toEqual([true]);
	});

	it('string equality', () => {
		expect(jq('.type == "queue-operation"', SAMPLE)).toEqual([true]);
	});
});

// ── Boolean Logic ────────────────────────────────────────────────────────────

describe('boolean logic', () => {
	it('and combines conditions', () => {
		expect(jq('.active and .count == 42', SAMPLE)).toEqual([true]);
		expect(jq('.active and .count == 99', SAMPLE)).toEqual([false]);
	});

	it('or combines conditions', () => {
		expect(jq('.count == 99 or .active', SAMPLE)).toEqual([true]);
	});

	it('not negates', () => {
		expect(jq('false | not', null)).toEqual([true]);
		expect(jq('true | not', null)).toEqual([false]);
	});
});

// ── Select ───────────────────────────────────────────────────────────────────

describe('select', () => {
	it('select passes matching input through', () => {
		expect(jq('select(.type == "queue-operation")', SAMPLE)).toEqual([SAMPLE]);
	});

	it('select filters non-matching input', () => {
		expect(jq('select(.type == "error")', SAMPLE)).toEqual([]);
	});

	it('select with contains', () => {
		expect(jq('select(.type | contains("queue"))', SAMPLE)).toEqual([SAMPLE]);
	});

	it('select with and', () => {
		expect(jq('select(.active and .count > 10)', SAMPLE)).toEqual([SAMPLE]);
	});

	it('select with not', () => {
		expect(jq('select(.type == "error" | not)', SAMPLE)).toEqual([SAMPLE]);
	});
});

// ── Built-in Functions ───────────────────────────────────────────────────────

describe('built-in functions', () => {
	it('keys returns sorted keys', () => {
		expect(jq('keys', { b: 2, a: 1 })).toEqual([['a', 'b']]);
	});

	it('values returns values', () => {
		expect(jq('values', { a: 1, b: 2 })).toEqual([[1, 2]]);
	});

	it('length on string', () => {
		expect(jq('.type | length', SAMPLE)).toEqual([15]);
	});

	it('length on array', () => {
		expect(jq('.tags | length', SAMPLE)).toEqual([2]);
	});

	it('length on object', () => {
		expect(jq('length', { a: 1, b: 2 })).toEqual([2]);
	});

	it('type returns type name', () => {
		expect(jq('type', 'hello')).toEqual(['string']);
		expect(jq('type', 42)).toEqual(['number']);
		expect(jq('type', null)).toEqual(['null']);
		expect(jq('type', [1])).toEqual(['array']);
		expect(jq('type', {})).toEqual(['object']);
	});

	it('has checks key existence', () => {
		expect(jq('has("type")', SAMPLE)).toEqual([true]);
		expect(jq('has("nope")', SAMPLE)).toEqual([false]);
	});

	it('contains checks string containment (case-insensitive)', () => {
		expect(jq('. | contains("QUEUE")', 'queue-operation')).toEqual([true]);
		expect(jq('. | contains("nope")', 'queue-operation')).toEqual([false]);
	});

	it('startswith / endswith', () => {
		expect(jq('.type | startswith("queue")', SAMPLE)).toEqual([true]);
		expect(jq('.type | endswith("tion")', SAMPLE)).toEqual([true]);
	});

	it('test with regex', () => {
		expect(jq('.type | test("queue.*")', SAMPLE)).toEqual([true]);
		expect(jq('.type | test("^error")', SAMPLE)).toEqual([false]);
	});

	it('map transforms array elements', () => {
		expect(jq('.items | map(.name)', SAMPLE)).toEqual([['x', 'y', 'z']]);
	});

	it('sort sorts array', () => {
		expect(jq('sort', [3, 1, 2])).toEqual([[1, 2, 3]]);
	});

	it('sort_by sorts by key', () => {
		expect(jq('.items | sort_by(.val) | map(.name)', SAMPLE)).toEqual([['z', 'x', 'y']]);
	});

	it('unique deduplicates', () => {
		expect(jq('unique', [1, 2, 1, 3, 2])).toEqual([[1, 2, 3]]);
	});

	it('reverse reverses array', () => {
		expect(jq('reverse', [1, 2, 3])).toEqual([[3, 2, 1]]);
	});

	it('flatten flattens nested arrays', () => {
		expect(
			jq('flatten', [
				[1, 2],
				[3, [4]],
			])
		).toEqual([[1, 2, 3, 4]]);
	});

	it('add sums numbers', () => {
		expect(jq('add', [1, 2, 3])).toEqual([6]);
	});

	it('add concatenates strings', () => {
		expect(jq('add', ['a', 'b', 'c'])).toEqual(['abc']);
	});

	it('min / max', () => {
		expect(jq('min', [3, 1, 2])).toEqual([1]);
		expect(jq('max', [3, 1, 2])).toEqual([3]);
	});

	it('first / last', () => {
		expect(jq('first', [10, 20, 30])).toEqual([10]);
		expect(jq('last', [10, 20, 30])).toEqual([30]);
	});

	it('to_entries', () => {
		expect(jq('to_entries', { a: 1, b: 2 })).toEqual([
			[
				{ key: 'a', value: 1 },
				{ key: 'b', value: 2 },
			],
		]);
	});

	it('ascii_downcase / ascii_upcase', () => {
		expect(jq('ascii_downcase', 'Hello')).toEqual(['hello']);
		expect(jq('ascii_upcase', 'Hello')).toEqual(['HELLO']);
	});

	it('split / join', () => {
		expect(jq('split(",")', 'a,b,c')).toEqual([['a', 'b', 'c']]);
		expect(jq('join("-")', ['a', 'b', 'c'])).toEqual(['a-b-c']);
	});

	it('tonumber / tostring', () => {
		expect(jq('tonumber', '42')).toEqual([42]);
		expect(jq('tostring', 42)).toEqual(['42']);
	});

	it('empty produces no output', () => {
		expect(jq('empty', 'anything')).toEqual([]);
	});
});

// ── Complex Expressions ──────────────────────────────────────────────────────

describe('complex expressions', () => {
	it('select + projection', () => {
		const result = jq('select(.count > 10) | .type', SAMPLE);
		expect(result).toEqual(['queue-operation']);
	});

	it('iterate + select', () => {
		const result = jq('.items[] | select(.val > 10)', SAMPLE);
		expect(result).toEqual([{ name: 'y', val: 20 }]);
	});

	it('iterate + field + collect', () => {
		const result = jq('.items | map(select(.val >= 10) | .name)', SAMPLE);
		expect(result).toEqual([['x', 'y']]);
	});

	it('nested pipe chain', () => {
		expect(jq('.items | sort_by(.val) | first | .name', SAMPLE)).toEqual(['z']);
	});

	it('group_by', () => {
		const data = [
			{ t: 'a', v: 1 },
			{ t: 'b', v: 2 },
			{ t: 'a', v: 3 },
		];
		const result = jq('group_by(.t)', data);
		expect(result).toEqual([
			[
				[
					{ t: 'a', v: 1 },
					{ t: 'a', v: 3 },
				],
				[{ t: 'b', v: 2 }],
			],
		]);
	});

	it('min_by / max_by', () => {
		expect(jq('.items | min_by(.val) | .name', SAMPLE)).toEqual(['z']);
		expect(jq('.items | max_by(.val) | .name', SAMPLE)).toEqual(['y']);
	});

	it('try suppresses errors', () => {
		expect(jq('.foo.bar?', 42)).toEqual([null]);
		expect(() => jq('keys', 42)).toThrow();
		expect(jq('keys?', 42)).toEqual([]);
	});
});

// ── Error Handling ───────────────────────────────────────────────────────────

describe('error handling', () => {
	it('unknown function throws', () => {
		expect(() => jq('bogus', null)).toThrow(/Unknown function/);
	});

	it('unterminated string throws', () => {
		expect(() => parseJq('"oops')).toThrow(/Unterminated string/);
	});

	it('unexpected token throws', () => {
		expect(() => parseJq(']')).toThrow();
	});

	it('applyJqFilter returns error for invalid expression', () => {
		const result = applyJqFilter('}}}', null);
		expect(result.error).toBeTruthy();
		expect(result.results).toEqual([]);
	});

	it('applyJqFilter works for valid expression', () => {
		const result = applyJqFilter('.type', SAMPLE);
		expect(result.error).toBeUndefined();
		expect(result.results).toEqual(['queue-operation']);
	});
});

// ── Grouped expression ──────────────────────────────────────────────────────

describe('grouped expressions', () => {
	it('parentheses group subexpressions', () => {
		expect(jq('(.type)', SAMPLE)).toEqual(['queue-operation']);
	});
});
