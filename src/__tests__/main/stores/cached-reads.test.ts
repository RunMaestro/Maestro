/**
 * cacheStoreReads - conf's get() re-reads and re-parses the whole store file on
 * every call. The cache must serve repeat reads from one parse, and must never
 * serve a value the file no longer holds.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Conf from 'conf';
import type Store from 'electron-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheStoreReads, readDotPath } from '../../../main/stores/cached-reads';

type Doc = Record<string, unknown>;

describe('readDotPath', () => {
	const doc = { a: { b: { c: 1 } }, 'x.y': 2, n: null, list: [1, 2] };

	it('walks dotted keys like conf does', () => {
		expect(readDotPath(doc, 'a.b.c')).toBe(1);
		expect(readDotPath(doc, 'a.b')).toEqual({ c: 1 });
		expect(readDotPath(doc, 'list')).toEqual([1, 2]);
	});

	it('treats an escaped dot as part of the key', () => {
		expect(readDotPath(doc, 'x\\.y')).toBe(2);
	});

	it('returns null for a stored null and undefined past it', () => {
		expect(readDotPath(doc, 'n')).toBeNull();
		expect(readDotPath(doc, 'n.deeper')).toBeUndefined();
		expect(readDotPath(doc, 'missing.deeper')).toBeUndefined();
	});

	it('refuses prototype keys', () => {
		expect(readDotPath(doc, '__proto__')).toBeUndefined();
		expect(readDotPath(doc, 'a.constructor')).toBeUndefined();
	});
});

describe('cacheStoreReads', () => {
	let dir: string;
	let deserialize: ReturnType<typeof vi.fn<(text: string) => Doc>>;
	let store: Store<Doc>;

	const filePath = () => path.join(dir, 'settings.json');
	/** Replace the file the way conf and maestro-cli do: write a temp file, rename it over. */
	const writeExternally = (doc: Doc) => {
		const tmp = `${filePath()}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(doc));
		fs.renameSync(tmp, filePath());
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cached-reads-'));
		deserialize = vi.fn((text: string): Doc => JSON.parse(text));
		const conf = new Conf<Doc>({
			cwd: dir,
			configName: 'settings',
			defaults: { theme: 'dark', nested: { count: 1 }, list: ['a'] },
			deserialize,
		});
		store = cacheStoreReads(conf as unknown as Store<Doc>);
		deserialize.mockClear();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('answers like conf, including dotted keys and defaults', () => {
		expect(store.get('theme')).toBe('dark');
		expect(store.get('nested.count')).toBe(1);
		expect(store.get('missing', 'fallback')).toBe('fallback');
		expect(store.get('missing')).toBeUndefined();
	});

	it('parses the file once for repeated reads of an unchanged file', () => {
		for (let i = 0; i < 20; i++) store.get('theme');
		store.get('nested');
		expect(deserialize).toHaveBeenCalledTimes(1);
	});

	it('hands out copies, so a caller mutating a value cannot change the next read', () => {
		const list = store.get('list') as string[];
		list.push('mutated');
		(store.get('nested') as { count: number }).count = 99;
		expect(store.get('list')).toEqual(['a']);
		expect(store.get('nested.count')).toBe(1);
	});

	it('sees a write made through the store, including inside its change event', () => {
		store.get('theme');
		const seen: unknown[] = [];
		store.onDidChange('theme', (value) => seen.push(value));
		store.set('theme', 'light');
		expect(store.get('theme')).toBe('light');
		expect(seen).toEqual(['light']);
	});

	it('sees a write made by another process (maestro-cli, a synced folder)', () => {
		expect(store.get('theme')).toBe('dark');
		writeExternally({ theme: 'external', nested: { count: 2 }, list: [] });
		expect(store.get('theme')).toBe('external');
		expect(store.get('nested.count')).toBe(2);
	});
});
