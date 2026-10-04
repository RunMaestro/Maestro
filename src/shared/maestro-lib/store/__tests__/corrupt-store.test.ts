import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { corruptStorePath, parseStoreJson } from '../corrupt-store';

describe('parseStoreJson', () => {
	it('parses JSON, tolerating a byte order mark', () => {
		expect(parseStoreJson('\uFEFF{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
	});

	it('classifies bytes that are not JSON as corrupt instead of throwing', () => {
		const result = parseStoreJson('{"sessions": [');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBeInstanceOf(SyntaxError);
	});
});

describe('corruptStorePath', () => {
	it('names a stamped sidecar beside the store', () => {
		const store = path.join('data', 'maestro-sessions.json');
		expect(corruptStorePath(store, new Date(2026, 8, 22, 7, 15, 30))).toBe(
			path.join('data', 'maestro-sessions.corrupt-20260922-071530.json')
		);
	});
});
