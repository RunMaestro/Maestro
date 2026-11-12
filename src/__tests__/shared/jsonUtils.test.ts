import { describe, expect, it } from 'vitest';
import { assertSerializedJsonIsSafe, parseJsonWithBom, stripJsonBom } from '../../shared/jsonUtils';

describe('jsonUtils', () => {
	it('strips a leading UTF-8 BOM', () => {
		expect(stripJsonBom('\uFEFF{"ok":true}')).toBe('{"ok":true}');
	});

	it('does not strip non-leading BOM characters', () => {
		expect(stripJsonBom('{"value":"\uFEFF"}')).toBe('{"value":"\uFEFF"}');
	});

	it('parses BOM-prefixed JSON', () => {
		expect(parseJsonWithBom<{ ok: boolean }>('\uFEFF{"ok":true}')).toEqual({ ok: true });
	});
});

describe('assertSerializedJsonIsSafe', () => {
	// Payloads over 1MB skip the round-trip parse; anything at or under it keeps
	// the full check. Both sides of that threshold need covering.
	const big = (inner: string): string => `{"pad":"${'x'.repeat(1_200_000)}"${inner}`;

	it('accepts well-formed small payloads', () => {
		expect(() => assertSerializedJsonIsSafe('{"ok":true}', 'store')).not.toThrow();
		expect(() => assertSerializedJsonIsSafe('[]', 'store')).not.toThrow();
	});

	it('rejects the undefined that JSON.stringify returns for undefined input', () => {
		expect(() => assertSerializedJsonIsSafe(JSON.stringify(undefined), 'store')).toThrow(
			'empty/undefined'
		);
	});

	it('rejects an empty payload', () => {
		expect(() => assertSerializedJsonIsSafe('', 'store')).toThrow('empty/undefined');
	});

	it('names the target in the error so a bad write is traceable', () => {
		expect(() => assertSerializedJsonIsSafe(undefined, '/data/runs.json')).toThrow(
			'/data/runs.json'
		);
	});

	it('still parses small payloads, catching malformed text', () => {
		expect(() => assertSerializedJsonIsSafe('{not json', 'store')).toThrow('unparseable');
	});

	it('accepts a large well-formed payload without parsing it', () => {
		expect(() => assertSerializedJsonIsSafe(big('}'), 'store')).not.toThrow();
	});

	it('tolerates trailing whitespace on a large payload', () => {
		// The agent-run store appends a newline to every file it writes.
		expect(() => assertSerializedJsonIsSafe(`${big('}')}\n`, 'store')).not.toThrow();
	});

	it('rejects a large payload whose delimiters do not balance', () => {
		expect(() => assertSerializedJsonIsSafe(big(''), 'store')).toThrow('malformed');
		expect(() => assertSerializedJsonIsSafe(`${'y'.repeat(1_200_000)}`, 'store')).toThrow(
			'malformed'
		);
	});

	it('accepts a large top-level array', () => {
		expect(() => assertSerializedJsonIsSafe(`["${'z'.repeat(1_200_000)}"]`, 'store')).not.toThrow();
	});
});
