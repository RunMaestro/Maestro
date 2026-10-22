/**
 * Claude Usage Snapshot Store
 *
 * Singleton wrapper around an electron-store namespace that caches the latest
 * `maestro-p --status` snapshot per canonical `CLAUDE_CONFIG_DIR` account. The
 * mode selector consults these snapshots whenever the per-agent Batch Mode
 * toggle is on to decide whether to fall back from interactive (Time Limits)
 * to API (API Limits) when the Max plan quota is exhausted.
 *
 * Snapshots expire 24 hours after `sampledAt`: past that they are no longer
 * returned by `getSnapshot` / `getAllSnapshots`, so no stale reading can decide
 * a fallback. They are still KEPT on disk for `SNAPSHOT_RETENTION_MS` and
 * returned by `getRetainedSnapshots()`, which is what the Usage Dashboard reads
 * - an account whose agents all moved away keeps its row and its last known
 * bars (flagged stale in the UI) instead of vanishing a day later.
 *
 * Pruning (beyond retention) is opportunistic - on read AND write, no
 * background timer - so the on-disk file stays clean even after long-quiet
 * periods, and corrupted records self-heal because an unparseable `sampledAt`
 * reads as beyond retention.
 *
 * The `Store` instance is created lazily on first method call so tests can
 * `vi.mock('electron-store')` before the module is touched.
 */

import Store from 'electron-store';

import type { UsageSnapshot } from '../agents/claude-mode-selector';
import { resolveConfigDirKeyFromEnv } from '../agents/claudeSpawnCore';
import { partitionSnapshotsByAge, SNAPSHOT_RETENTION_MS } from './usageSnapshotRetention';

// Re-export so consumers can grab the type from either module.
export type { UsageSnapshot } from '../agents/claude-mode-selector';
export { SNAPSHOT_RETENTION_MS } from './usageSnapshotRetention';

/** TTL after which a snapshot is no longer trusted (but is still retained). */
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
 * Split the stored map by the two clocks and write back when anything aged out
 * of retention. `live` holds what may be acted on, `retained` what may be
 * displayed.
 */
function readPartitioned(now: number) {
	const store = getStore();
	const current = store.get('snapshots', {});
	const partitioned = partitionSnapshotsByAge(current, now, SNAPSHOT_TTL_MS, SNAPSHOT_RETENTION_MS);
	if (partitioned.prunedAny) {
		store.set('snapshots', partitioned.retained);
	}
	return partitioned;
}

/**
 * Write a snapshot, keyed by its `configDirKey`. Concurrently prunes neighbors
 * that aged past retention so the on-disk file doesn't accumulate dead keys
 * after long-quiet periods. Merely-expired neighbors are kept: the dashboard
 * still draws their last known bars.
 */
export function setSnapshot(snapshot: UsageSnapshot): void {
	const store = getStore();
	const { retained } = readPartitioned(Date.now());
	store.set('snapshots', { ...retained, [snapshot.configDirKey]: snapshot });
}

/**
 * Read a snapshot by canonical config-dir key. Returns null if missing,
 * expired (older than `SNAPSHOT_TTL_MS`), or carrying an unparseable
 * `sampledAt`. Entries past retention are pruned from disk on read.
 */
export function getSnapshot(configDirKey: string): UsageSnapshot | null {
	return readPartitioned(Date.now()).live[configDirKey] ?? null;
}

/**
 * Return every non-expired snapshot in the store, keyed by `configDirKey`.
 * This is the decision-grade map - the mode selector and the spawner read it.
 */
export function getAllSnapshots(): Record<string, UsageSnapshot> {
	return readPartitioned(Date.now()).live;
}

/**
 * Return every snapshot still within retention, including expired ones. This is
 * the display-grade map: the Usage Dashboard keeps an account's row and its
 * last known bars (badged "stale") after the TTL, so an account nobody is
 * running agents on right now does not disappear from the panel.
 */
export function getRetainedSnapshots(): Record<string, UsageSnapshot> {
	return readPartitioned(Date.now()).retained;
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
 * when the env var is unset or blank, expands a leading `~/`, and
 * `path.resolve()`s the result so two spellings of the same path collapse to
 * one key.
 *
 * `env` is a REQUIRED arg (not defaulted to `process.env`) so callers are
 * forced to pass the env they actually injected into the spawn. This guards
 * against silently keying snapshots against `process.env` when the spawn
 * used a divergent env.
 */
export function resolveConfigDirKey(env: NodeJS.ProcessEnv): string {
	// One rule for the desktop and the CLI; see resolveConfigDirKeyFromEnv for
	// why a blank or `~/` value needs normalizing before it can be a key.
	return resolveConfigDirKeyFromEnv(env);
}

/**
 * Test-only hook: reset the cached singleton so the next call constructs a
 * fresh `Store`. Not exported from the module's public API.
 */
export function __resetForTests(): void {
	_store = null;
}
