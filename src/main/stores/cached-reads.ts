/**
 * Stat-validated read cache for a conf/electron-store instance.
 *
 * conf's `get(key)` reads the WHOLE backing file from disk and parses it on
 * every call (`get store()` is readFileSync + deserialize + validate). For the
 * settings store (a 275 KB file on a real install) that cost lands on hot
 * paths that only want one key: Cue's `getStatus` asks `getLiveSessions()`,
 * which reads `encoreFeatures`; every plugin `isEnabled` check reads settings;
 * and each `onDidChange` subscription re-reads the file inside the `change`
 * event that every `set()` emits, so one `settings:set` with ten subscribers
 * parsed the file eleven times. A Nov 2026 field trace attributed 688 CPU
 * samples of main-process time to that parse alone, across 27 separate bursts
 * in 45 seconds.
 *
 * This patches `get` on ONE instance to serve values from the last parse while
 * the file is unchanged on disk, and leaves every other conf code path alone:
 * `set`, `store`, `has`, iteration and migrations still go through conf.
 *
 * Why a stat and not an in-memory document (as deferStoreWrites does for the
 * sessions store): this file has outside writers. maestro-cli writes settings,
 * and a synced Storage Location can be rewritten by another machine. conf
 * writes atomically (temp file + rename), so any write, ours or theirs, gives
 * the path a new inode and mtime, which invalidates the cache on the next read.
 * A `statSync` is microseconds; the read and parse it replaces is milliseconds.
 *
 * Values are handed out as `structuredClone`s. conf returns a fresh parse every
 * time, so callers are free to mutate what `get` returns, and some do; a shared
 * cached object would let one caller's mutation leak into the next read.
 */

import fs from 'fs';
import type Store from 'electron-store';

interface FileStamp {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
}

function stampOf(filePath: string): FileStamp | null {
	try {
		const { mtimeMs, ctimeMs, size, ino } = fs.statSync(filePath);
		return { mtimeMs, ctimeMs, size, ino };
	} catch {
		// Missing file: conf's own getter handles that (it returns an empty store).
		return null;
	}
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
	return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;
}

const DISALLOWED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Resolve a dotted key the way conf does (dot-prop 6 `get`, which conf 10 uses
 * with `accessPropertiesByDotNotation`, the default every Maestro store keeps):
 * `a.b` walks nested objects, `a\.b` is a literal dot, and a path naming a
 * prototype key resolves to nothing.
 */
export function readDotPath(document: unknown, key: string): unknown {
	const raw = key.split('.');
	const segments: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		let segment = raw[i];
		while (segment.endsWith('\\') && raw[i + 1] !== undefined) {
			segment = `${segment.slice(0, -1)}.${raw[++i]}`;
		}
		segments.push(segment);
	}
	if (segments.some((segment) => DISALLOWED_SEGMENTS.has(segment))) return undefined;

	let current: unknown = document;
	for (let i = 0; i < segments.length; i++) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[segments[i]];
		if (current === undefined || current === null) {
			return i === segments.length - 1 ? current : undefined;
		}
	}
	return current;
}

/**
 * Serve `store.get(key)` from a cached parse while the backing file is
 * unchanged. Returns the same instance.
 */
export function cacheStoreReads<T extends Record<string, any>>(store: Store<T>): Store<T> {
	const target = store as unknown as Record<string, unknown>;
	const originalGet = store.get.bind(store) as (key: unknown, defaultValue?: unknown) => unknown;
	let cached: { stamp: FileStamp; document: Record<string, unknown> } | null = null;

	const currentDocument = (): Record<string, unknown> => {
		// Stamped BEFORE the read: a write that lands in between leaves a newer
		// file under an older stamp, so the next call re-reads. The reverse order
		// could pin a stale parse under a fresh stamp.
		const stamp = stampOf(store.path);
		if (stamp && cached && sameStamp(stamp, cached.stamp)) return cached.document;
		// conf's full read: keeps its validation and the corrupt-store recovery
		// installed through the `deserialize` option.
		const document = store.store as Record<string, unknown>;
		cached = stamp ? { stamp, document } : null;
		return document;
	};

	Object.defineProperty(target, 'get', {
		value: (key: unknown, defaultValue?: unknown) => {
			if (typeof key !== 'string') return originalGet(key, defaultValue);
			const value = readDotPath(currentDocument(), key);
			return value === undefined ? defaultValue : structuredClone(value);
		},
		writable: true,
		configurable: true,
	});
	return store;
}
