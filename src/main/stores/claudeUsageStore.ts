/**
 * Claude Usage Snapshot Store
 *
 * Singleton wrapper around an electron-store namespace that caches the latest
 * `maestro-p --status` snapshot per canonical `CLAUDE_CONFIG_DIR` account. The
 * mode selector consults these snapshots whenever the per-agent Batch Mode
 * toggle is on to decide whether to fall back from interactive (Time Limits)
 * to API (API Limits) when the Max plan quota is exhausted.
 *
 * Snapshots auto-expire 24 hours after `sampledAt`. Pruning is opportunistic
 * (on read AND write) - no background timer - so the on-disk file stays clean
 * even after long-quiet periods, and corrupted records self-heal because an
 * unparseable `sampledAt` reads as expired.
 *
 * The `Store` instance is created lazily on first method call so tests can
 * `vi.mock('electron-store')` before the module is touched.
 */

import os from 'os';
import path from 'path';
import Store from 'electron-store';

import type { UsageSnapshot } from '../agents/claude-mode-selector';

// Re-export so consumers can grab the type from either module.
export type { UsageSnapshot } from '../agents/claude-mode-selector';

/** TTL after which a snapshot is treated as expired and pruned. */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

interface ClaudeUsageStoreData {
	snapshots: Record<string, UsageSnapshot>;
}

const STORE_NAME = 'claude-usage-snapshots';
const STORE_DEFAULTS: ClaudeUsageStoreData = { snapshots: {} };

let _store: Store<ClaudeUsageStoreData> | null = null;

/**
 * Lazily create (or return) the backing electron-store instance. Tests that
 * `vi.mock('electron-store')` before importing this module rely on this
 * lazy init - constructing eagerly at module-load would capture the real
 * Store class before the mock is installed.
 */
function getStore(): Store<ClaudeUsageStoreData> {
	if (_store === null) {
		_store = new Store<ClaudeUsageStoreData>({
			name: STORE_NAME,
			defaults: STORE_DEFAULTS,
		});
	}
	return _store;
}

/**
 * Return true when a snapshot is older than the TTL or its `sampledAt` is
 * unparseable. Both cases are treated identically so a corrupted record
 * self-heals on the next read or write.
 */
function isExpired(snapshot: UsageSnapshot, now: number): boolean {
	const sampledAtMs = new Date(snapshot.sampledAt).getTime();
	if (Number.isNaN(sampledAtMs)) {
		return true;
	}
	return now - sampledAtMs > SNAPSHOT_TTL_MS;
}

/**
 * Write a snapshot, keyed by its `configDirKey`. Concurrently prunes any
 * expired neighbors so the on-disk file doesn't accumulate dead keys after
 * long-quiet periods.
 */
export function setSnapshot(snapshot: UsageSnapshot): void {
	const store = getStore();
	const now = Date.now();
	const current = store.get('snapshots', {});
	const next: Record<string, UsageSnapshot> = {};
	for (const [key, entry] of Object.entries(current)) {
		if (!isExpired(entry, now)) {
			next[key] = entry;
		}
	}
	next[snapshot.configDirKey] = snapshot;
	store.set('snapshots', next);
}

/**
 * Read a snapshot by canonical config-dir key. Returns null if missing,
 * expired (older than `SNAPSHOT_TTL_MS`), or carrying an unparseable
 * `sampledAt`. Side-effect: expired entries are pruned from disk on read.
 */
export function getSnapshot(configDirKey: string): UsageSnapshot | null {
	const store = getStore();
	const now = Date.now();
	const current = store.get('snapshots', {});
	const entry = current[configDirKey];
	if (!entry) {
		return null;
	}
	if (isExpired(entry, now)) {
		const next: Record<string, UsageSnapshot> = {};
		for (const [key, value] of Object.entries(current)) {
			if (key === configDirKey) continue;
			if (!isExpired(value, now)) {
				next[key] = value;
			}
		}
		store.set('snapshots', next);
		return null;
	}
	return entry;
}

/**
 * Return every non-expired snapshot in the store, keyed by `configDirKey`.
 * Prunes expired entries on read so the on-disk file stays clean.
 */
export function getAllSnapshots(): Record<string, UsageSnapshot> {
	const store = getStore();
	const now = Date.now();
	const current = store.get('snapshots', {});
	const live: Record<string, UsageSnapshot> = {};
	let prunedAny = false;
	for (const [key, entry] of Object.entries(current)) {
		if (isExpired(entry, now)) {
			prunedAny = true;
		} else {
			live[key] = entry;
		}
	}
	if (prunedAny) {
		store.set('snapshots', live);
	}
	return live;
}

/**
 * Drop every snapshot. Intended for tests; production code should rely on
 * TTL-based pruning.
 */
export function clear(): void {
	getStore().set('snapshots', {});
}

/**
 * Canonical key for a `CLAUDE_CONFIG_DIR` account. Falls back to `~/.claude`
 * when the env var isn't set, and `path.resolve()`s the result so two
 * spellings of the same path collapse to one key.
 *
 * `env` is a REQUIRED arg (not defaulted to `process.env`) so callers are
 * forced to pass the env they actually injected into the spawn. This guards
 * against silently keying snapshots against `process.env` when the spawn
 * used a divergent env.
 */
export function resolveConfigDirKey(env: NodeJS.ProcessEnv): string {
	const raw = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
	return path.resolve(raw);
}

/**
 * Test-only hook: reset the cached singleton so the next call constructs a
 * fresh `Store`. Not exported from the module's public API.
 */
export function __resetForTests(): void {
	_store = null;
}
