/**
 * Per-plugin key-value store (main process).
 *
 * Backs the `storage:read` / `storage:write` capabilities. Each plugin gets its
 * OWN directory under an injected base dir (the integrator passes the real
 * `<userData>/plugin-data` path; injection keeps this unit-testable without
 * Electron). A plugin can only ever touch its own store: every op keys off the
 * authenticated pluginId the sandbox host supplies, never a plugin-controlled
 * id, and the resolved per-plugin path is asserted to stay inside the base dir.
 *
 * Bounded by construction (a hostile-but-permitted plugin must not be able to
 * fill the disk): value byte cap, key byte cap, and key-count cap. Writes are
 * atomic (temp file + rename) so a crash mid-write never leaves a torn store and
 * a concurrent reader never observes a partial file.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PluginKvLimits {
	/** Max bytes (UTF-8) for a single stored value. */
	maxValueBytes: number;
	/** Max bytes (UTF-8) for a single key. */
	maxKeyBytes: number;
	/** Max number of keys a single plugin may hold. */
	maxKeys: number;
}

export const DEFAULT_KV_LIMITS: PluginKvLimits = {
	maxValueBytes: 64 * 1024,
	maxKeyBytes: 512,
	maxKeys: 512,
};

export interface PluginKvStoreDeps {
	/** Base directory under which each plugin gets its own subdir. INJECTED so
	 * tests can use a tmp dir and the integrator passes the real userData path. */
	baseDir: string;
	limits?: Partial<PluginKvLimits>;
}

const STORE_FILENAME = 'store.json';

/**
 * A plugin folder/id is used as a path segment, so it must be a single safe
 * segment: no separators, no traversal, no absolute/drive prefixes, no Windows
 * reserved device names. This mirrors the installer's folder-name guard but is
 * inlined so this module stays free of any Electron import (testability).
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function isSafeKvId(id: string): boolean {
	if (typeof id !== 'string' || id.length === 0 || id.length > 128) return false;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return false;
	if (id === '.' || id === '..' || id.includes('..')) return false;
	if (WINDOWS_RESERVED.test(id)) return false;
	return true;
}

/** A bounded, atomic, per-plugin key-value store. */
export class PluginKvStore {
	private readonly baseDir: string;
	private readonly limits: PluginKvLimits;
	/** Loaded-store cache. This process is the only writer, so the cache is
	 * authoritative once loaded; purge() drops it. */
	private readonly cache = new Map<string, Record<string, string>>();

	constructor(deps: PluginKvStoreDeps) {
		this.baseDir = path.resolve(deps.baseDir);
		this.limits = {
			maxValueBytes: deps.limits?.maxValueBytes ?? DEFAULT_KV_LIMITS.maxValueBytes,
			maxKeyBytes: deps.limits?.maxKeyBytes ?? DEFAULT_KV_LIMITS.maxKeyBytes,
			maxKeys: deps.limits?.maxKeys ?? DEFAULT_KV_LIMITS.maxKeys,
		};
	}

	/** Read one value, or null when the key is absent. */
	get(pluginId: string, key: string): string | null {
		this.assertKey(key);
		const store = this.load(pluginId);
		return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
	}

	/** All keys currently stored for a plugin. */
	keys(pluginId: string): string[] {
		return Object.keys(this.load(pluginId));
	}

	/**
	 * Write one value. Throws when a cap is exceeded (key bytes, value bytes, or
	 * key count for a NEW key) so a permitted-but-hostile plugin cannot exhaust
	 * disk. Persisted atomically.
	 */
	set(pluginId: string, key: string, value: string): void {
		this.assertKey(key);
		if (typeof value !== 'string') throw new Error('storage value must be a string');
		if (Buffer.byteLength(value, 'utf8') > this.limits.maxValueBytes) {
			throw new Error(`storage value exceeds ${this.limits.maxValueBytes} bytes`);
		}
		const store = this.load(pluginId);
		const isNew = !Object.prototype.hasOwnProperty.call(store, key);
		if (isNew && Object.keys(store).length >= this.limits.maxKeys) {
			throw new Error(`storage key limit reached (${this.limits.maxKeys})`);
		}
		store[key] = value;
		this.persist(pluginId, store);
	}

	/** Delete one key. Returns whether it existed. */
	delete(pluginId: string, key: string): boolean {
		this.assertKey(key);
		const store = this.load(pluginId);
		if (!Object.prototype.hasOwnProperty.call(store, key)) return false;
		delete store[key];
		this.persist(pluginId, store);
		return true;
	}

	/** Remove a plugin's entire store (uninstall purge). */
	purge(pluginId: string): void {
		this.cache.delete(pluginId);
		const dir = this.dirFor(pluginId);
		fs.rmSync(dir, { recursive: true, force: true });
	}

	private assertKey(key: string): void {
		if (typeof key !== 'string' || key.length === 0) throw new Error('storage key is required');
		if (/(^|\.)(__proto__|prototype|constructor)(\.|$)/.test(key)) {
			throw new Error('invalid storage key');
		}
		if (Buffer.byteLength(key, 'utf8') > this.limits.maxKeyBytes) {
			throw new Error(`storage key exceeds ${this.limits.maxKeyBytes} bytes`);
		}
	}

	/** Resolve a plugin's directory, refusing any id that would escape baseDir. */
	private dirFor(pluginId: string): string {
		if (!isSafeKvId(pluginId)) throw new Error(`invalid plugin id for storage: ${pluginId}`);
		const dir = path.resolve(this.baseDir, pluginId);
		if (dir !== path.join(this.baseDir, pluginId)) {
			throw new Error('plugin storage path escapes the base directory');
		}
		if (dir !== this.baseDir && !dir.startsWith(this.baseDir + path.sep)) {
			throw new Error('plugin storage path escapes the base directory');
		}
		return dir;
	}

	private fileFor(pluginId: string): string {
		return path.join(this.dirFor(pluginId), STORE_FILENAME);
	}

	private load(pluginId: string): Record<string, string> {
		const cached = this.cache.get(pluginId);
		if (cached) return cached;
		// Resolve (and validate) the path BEFORE the try, so an invalid/escaping
		// plugin id throws rather than being swallowed as "missing store".
		const file = this.fileFor(pluginId);
		let store: Record<string, string> = Object.create(null);
		try {
			const raw = fs.readFileSync(file, 'utf8');
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				// Only keep string-valued entries; ignore any tampered shape.
				for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof v === 'string') store[k] = v;
				}
			}
		} catch {
			// Missing or unparseable store reads as empty (never throws on bad data).
			store = Object.create(null);
		}
		this.cache.set(pluginId, store);
		return store;
	}

	private persist(pluginId: string, store: Record<string, string>): void {
		const dir = this.dirFor(pluginId);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, STORE_FILENAME);
		const tmp = path.join(dir, `${STORE_FILENAME}.tmp-${process.pid}-${Date.now()}`);
		fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
		fs.renameSync(tmp, file);
		this.cache.set(pluginId, store);
	}
}
