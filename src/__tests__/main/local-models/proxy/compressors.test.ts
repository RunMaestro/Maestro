/**
 * @file compressors.test.ts
 *
 * The token proxy's heuristic compressors. Each is a pure function, and each
 * must name what it left out in the text it returns.
 */

import { describe, it, expect } from 'vitest';
import {
	compressJson,
	compressLogs,
	compressWithHeuristics,
	JSON_ARRAY_HEAD_ITEMS,
	JSON_ARRAY_TAIL_ITEMS,
	LONG_LINE_KEEP_CHARS,
	LONG_LINE_MAX_CHARS,
	truncateLongLines,
} from '../../../../main/local-models/proxy/compressors';

/** `count` rows, each long enough that a sampled array leaves out real text. */
function rows(count: number): Array<{ id: number; name: string }> {
	return Array.from({ length: count }, (_, id) => ({ id, name: `record number ${id} of many` }));
}

describe('compressJson', () => {
	it('minifies a document and reports the json compressor', () => {
		const pretty = JSON.stringify({ a: 1, b: { c: [1, 2, 3] } }, null, 2);
		expect(compressJson(pretty)).toEqual({ text: '{"a":1,"b":{"c":[1,2,3]}}', applied: ['json'] });
	});

	it('returns the text itself, with nothing applied, when it is already minimal', () => {
		const text = '{"a":1,"b":[1,2,3]}';
		expect(compressJson(text)).toEqual({ text, applied: [] });
	});

	it('samples a long array: head, a count of what was left out, tail', () => {
		const data = rows(100);
		const result = compressJson(JSON.stringify(data));
		const out = JSON.parse(result?.text ?? 'null') as unknown[];

		expect(out).toHaveLength(JSON_ARRAY_HEAD_ITEMS + 1 + JSON_ARRAY_TAIL_ITEMS);
		expect(out.slice(0, JSON_ARRAY_HEAD_ITEMS)).toEqual(data.slice(0, JSON_ARRAY_HEAD_ITEMS));
		expect(out[JSON_ARRAY_HEAD_ITEMS]).toBe('[maestro: 85 of 100 items omitted]');
		expect(out.slice(-JSON_ARRAY_TAIL_ITEMS)).toEqual(data.slice(-JSON_ARRAY_TAIL_ITEMS));
		expect(result?.applied).toEqual(['json']);
	});

	it('samples arrays wherever they sit, and leaves short ones whole', () => {
		const doc = { meta: { tags: ['a', 'b', 'c'] }, pages: [{ items: rows(60) }] };
		const out = JSON.parse(compressJson(JSON.stringify(doc))?.text ?? 'null') as typeof doc;
		expect(out.meta.tags).toEqual(['a', 'b', 'c']);
		expect(out.pages[0].items).toHaveLength(JSON_ARRAY_HEAD_ITEMS + 1 + JSON_ARRAY_TAIL_ITEMS);
		expect(out.pages[0].items[JSON_ARRAY_HEAD_ITEMS]).toBe('[maestro: 45 of 60 items omitted]');
	});

	it('does not sample a long array of small items: the note would save nothing', () => {
		const numbers = Array.from({ length: 30 }, (_, n) => n);
		const text = JSON.stringify(numbers);
		expect(compressJson(text)).toEqual({ text, applied: [] });
	});

	it('copies numbers and strings as the text they were', () => {
		// 2^53 is where a parsed number starts to round; the escapes must not be
		// re-spelled either.
		const text = String.raw`{ "id": 12345678901234567890, "big": 1.0e400, "s": "tab\there \/ slash" }`;
		expect(compressJson(text)?.text).toBe(
			String.raw`{"id":12345678901234567890,"big":1.0e400,"s":"tab\there \/ slash"}`
		);
	});

	it('is not JSON for anything but one object or array', () => {
		expect(compressJson('plain text')).toBeNull();
		expect(compressJson('{"a":1} trailing')).toBeNull();
		expect(compressJson('{not json}')).toBeNull();
		expect(compressJson('"a string"')).toBeNull();
		expect(compressJson('42')).toBeNull();
		expect(compressJson('')).toBeNull();
	});

	it('runs the line compressors over a long string value and stays valid JSON', () => {
		// The shape of a shell tool result: one large field holding the output.
		const output = Array.from({ length: 200 }, () => 'retrying connection to db').join('\n');
		const text = JSON.stringify({ output, metadata: { exit_code: 1 } });
		const result = compressJson(text);
		const out = JSON.parse(result?.text ?? 'null') as { output: string; metadata: unknown };

		expect(out.output).toBe(
			'retrying connection to db\n[maestro: previous line repeated 199 more times]'
		);
		expect(out.metadata).toEqual({ exit_code: 1 });
		expect(result?.applied).toEqual(['json', 'logs']);
	});

	it('never truncates the document itself as one long line', () => {
		const text = JSON.stringify(
			Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`key_${n}`, `value ${n}`]))
		);
		expect(text.length).toBeGreaterThan(LONG_LINE_MAX_CHARS);
		// Already minimal, nothing to sample, no long value: it comes back whole.
		expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
	});
});

describe('compressLogs', () => {
	it('folds a repeated line into one copy and a count', () => {
		const text = ['start', ...Array.from({ length: 40 }, () => 'INFO heartbeat ok'), 'end'].join(
			'\n'
		);
		expect(compressLogs(text)).toBe(
			'start\nINFO heartbeat ok\n[maestro: previous line repeated 39 more times]\nend'
		);
	});

	it('folds a repeated block of lines', () => {
		const frame = ['  at handler (server.js:10:5)', '  at next (router.js:44:9)'];
		const text = ['Error: boom', ...frame, ...frame, ...frame, ...frame, 'done'].join('\n');
		expect(compressLogs(text)).toBe(
			['Error: boom', ...frame, '[maestro: previous 2 lines repeated 3 more times]', 'done'].join(
				'\n'
			)
		);
	});

	it('leaves a repeat alone when the note would be longer than what it replaces', () => {
		const text = 'ok\nok\nok\n\n\n\nend';
		expect(compressLogs(text)).toBe(text);
	});

	it('strips terminal escapes', () => {
		expect(compressLogs('\x1b[31merror:\x1b[0m build failed\x1b[K')).toBe('error: build failed');
	});

	it('keeps the last frame of a carriage-return progress line', () => {
		expect(compressLogs('fetch 10%\rfetch 55%\rfetch 100%\ndone')).toBe('fetch 100%\ndone');
	});

	it('returns the same text when there is nothing to do', () => {
		const text = 'one\ntwo\nthree';
		expect(compressLogs(text)).toBe(text);
	});
});

describe('truncateLongLines', () => {
	it('cuts a long line and says how much was cut', () => {
		const long = 'x'.repeat(LONG_LINE_MAX_CHARS + 500);
		const out = truncateLongLines(`short\n${long}\nalso short`);
		expect(out).toBe(
			`short\n${'x'.repeat(LONG_LINE_KEEP_CHARS)} [maestro: ${
				LONG_LINE_MAX_CHARS + 500 - LONG_LINE_KEEP_CHARS
			} more characters on this line]\nalso short`
		);
	});

	it('leaves a line at the limit alone', () => {
		const text = `${'y'.repeat(LONG_LINE_MAX_CHARS)}\n${'z'.repeat(10)}`;
		expect(truncateLongLines(text)).toBe(text);
	});

	it('never cuts between the halves of a surrogate pair', () => {
		const emoji = String.fromCodePoint(0x1f600);
		// The pair straddles the cut point.
		const line = 'a'.repeat(LONG_LINE_KEEP_CHARS - 1) + emoji + 'b'.repeat(LONG_LINE_MAX_CHARS);
		const kept = truncateLongLines(line).split(' [maestro:')[0];
		expect(kept).toBe('a'.repeat(LONG_LINE_KEEP_CHARS - 1));
	});
});

describe('compressWithHeuristics', () => {
	it('runs logs, then long lines, over a text that is not JSON', () => {
		const text = [
			...Array.from({ length: 50 }, () => 'WARN slow query'),
			'q'.repeat(LONG_LINE_MAX_CHARS * 2),
		].join('\n');
		const result = compressWithHeuristics(text);
		expect(result.applied).toEqual(['logs', 'long-lines']);
		expect(result.text.split('\n')).toHaveLength(3);
	});

	it('applies nothing to ordinary source text', () => {
		const text = Array.from({ length: 80 }, (_, n) => `const value${n} = compute(${n});`).join(
			'\n'
		);
		expect(compressWithHeuristics(text)).toEqual({ text, applied: [] });
	});

	it('gives the same bytes for the same input, every time', () => {
		const inputs = [
			JSON.stringify({ rows: rows(500), log: 'retry\n'.repeat(300) }, null, 2),
			`${'\x1b[2K'}${'building...\n'.repeat(400)}${'z'.repeat(5000)}`,
		];
		for (const input of inputs) {
			const first = compressWithHeuristics(input);
			const second = compressWithHeuristics(input);
			expect(second).toEqual(first);
			expect(first.text.length).toBeLessThan(input.length);
		}
	});
});
