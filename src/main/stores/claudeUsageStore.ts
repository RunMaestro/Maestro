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
import { createUsageSnapshotEnvelope } from './usageSnapshotEnvelope';

// Re-export so consumers can grab the type from either module.
export type { UsageSnapshot } from '../agents/claude-mode-selector';

/** TTL after which a snapshot is treated as expired and pruned. */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_STORE_VERSION = 1;

interface ClaudeUsageStoreData {
	version?: number;
	snapshots: Record<string, UsageSnapshot>;
}

const STORE_NAME = 'claude-usage-snapshots';
const STORE_DEFAULTS: ClaudeUsageStoreData = { version: SNAPSHOT_STORE_VERSION, snapshots: {} };

const snapshotEnvelope = createUsageSnapshotEnvelope<UsageSnapshot>({
	version: SNAPSHOT_STORE_VERSION,
	ttlMs: SNAPSHOT_TTL_MS,
	getKey: (snapshot) => snapshot.configDirKey,
});

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
 * Write a snapshot, keyed by its `configDirKey`. Concurrently prunes any
 * expired neighbors so the on-disk file doesn't accumulate dead keys after
 * long-quiet periods.
 */
export function setSnapshot(snapshot: UsageSnapshot): void {
	snapshotEnvelope.set(getStore(), snapshot);
}

/**
 * Read a snapshot by canonical config-dir key. Returns null if missing,
 * corrupt, incompatible with the current persistence version, expired, or
 * carrying an unparseable `sampledAt`. Expired entries are pruned on read.
 */
export function getSnapshot(configDirKey: string): UsageSnapshot | null {
	return snapshotEnvelope.get(getStore(), configDirKey);
}

/**
 * Return every non-expired snapshot in the store, keyed by `configDirKey`.
 * Prunes expired entries on read so the on-disk file stays clean.
 */
export function getAllSnapshots(): Record<string, UsageSnapshot> {
	return snapshotEnvelope.getAll(getStore());
}

/**
 * Drop every snapshot. Intended for tests; production code should rely on
 * TTL-based pruning.
 */
export function clear(): void {
	snapshotEnvelope.clear(getStore());
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
