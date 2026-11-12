/**
 * @file plugin-kv-store.test.ts
 * @description The per-plugin KV store confines each plugin to its OWN directory,
 * bounds value bytes / key bytes / key count, persists atomically, and purges.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';

describe('PluginKvStore', () => {
	let base: string;
	let store: PluginKvStore;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-kv-'));
		store = new PluginKvStore({
			baseDir: base,
			limits: { maxValueBytes: 32, maxKeys: 3, maxKeyBytes: 16 },
		});
	});
	afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

	it('roundtrips get/set/keys/delete', () => {
		expect(store.get('p', 'a')).toBeNull();
		store.set('p', 'a', 'hello');
		expect(store.get('p', 'a')).toBe('hello');
		expect(store.keys('p')).toEqual(['a']);
		expect(store.delete('p', 'a')).toBe(true);
		expect(store.delete('p', 'a')).toBe(false);
		expect(store.get('p', 'a')).toBeNull();
	});

	it('confines each plugin to its OWN store (no cross-plugin read)', () => {
		store.set('alpha', 'k', 'A');
		store.set('beta', 'k', 'B');
		expect(store.get('alpha', 'k')).toBe('A');
		expect(store.get('beta', 'k')).toBe('B');
		expect(fs.existsSync(path.join(base, 'alpha', 'store.json'))).toBe(true);
		expect(fs.existsSync(path.join(base, 'beta', 'store.json'))).toBe(true);
	});

	it('rejects a plugin id that would escape the base dir', () => {
		expect(() => store.set('../evil', 'k', 'v')).toThrow();
		expect(() => store.set('a/b', 'k', 'v')).toThrow();
		expect(() => store.get('..', 'k')).toThrow();
		expect(fs.existsSync(path.join(base, '..', 'evil'))).toBe(false);
	});

	it('enforces the value byte cap (exact cap allowed, one over rejected)', () => {
		expect(() => store.set('p', 'k', 'x'.repeat(33))).toThrow(/value exceeds/);
		store.set('p', 'k', 'x'.repeat(32));
		expect(store.get('p', 'k')).toHaveLength(32);
	});

	it('enforces the key byte cap', () => {
		expect(() => store.set('p', 'x'.repeat(17), 'v')).toThrow(/key exceeds/);
	});

	it('enforces the key-count cap for NEW keys but allows overwrites', () => {
		store.set('p', 'a', '1');
		store.set('p', 'b', '2');
		store.set('p', 'c', '3');
		expect(() => store.set('p', 'd', '4')).toThrow(/key limit/);
		store.set('p', 'a', '11'); // overwrite at the cap is fine
		expect(store.get('p', 'a')).toBe('11');
	});

	it('persists across instances and leaves no temp file behind', () => {
		store.set('p', 'a', 'persisted');
		const fresh = new PluginKvStore({ baseDir: base });
		expect(fresh.get('p', 'a')).toBe('persisted');
		expect(fs.readdirSync(path.join(base, 'p'))).toEqual(['store.json']);
	});

	it('purge removes the plugin store entirely', () => {
		store.set('p', 'a', 'v');
		store.purge('p');
		expect(fs.existsSync(path.join(base, 'p'))).toBe(false);
		expect(store.get('p', 'a')).toBeNull();
	});

	it('rejects empty keys and non-string values', () => {
		expect(() => store.set('p', '', 'v')).toThrow();
		// @ts-expect-error runtime guard against a non-string value
		expect(() => store.set('p', 'k', 123)).toThrow();
	});

	it('rejects prototype-polluting keys without polluting Object.prototype', () => {
		expect(() => store.set('p', '__proto__', 'v')).toThrow(/invalid storage key/);
		expect(() => store.get('p', '__proto__')).toThrow(/invalid storage key/);
		expect(() => store.delete('p', '__proto__')).toThrow(/invalid storage key/);
		expect(() => store.set('p', 'a.constructor.b', 'v')).toThrow(/invalid storage key/);
		expect(() => store.set('p', 'prototype', 'v')).toThrow(/invalid storage key/);
		// A normal key still round-trips after the rejections.
		store.set('p', 'normal', 'ok');
		expect(store.get('p', 'normal')).toBe('ok');
		// The rejected '__proto__' write must never reach Object.prototype.
		expect(({} as unknown as Record<string, unknown>).polluted).toBeUndefined();
	});
});
