/**
 * Usage Snapshot Retention
 *
 * One implementation of the two-clock rule both plan-usage snapshot stores
 * follow, so Claude and Codex cannot drift apart on it:
 *
 *   - TTL (hours): how long a snapshot may be TRUSTED. Past it the snapshot is
 *     no longer returned to the mode selector or the spawner - a day-old quota
 *     reading must never decide a fallback.
 *   - Retention (weeks): how long it is KEPT on disk. Between the two clocks a
 *     snapshot is display-only: the Usage Dashboard still draws the account's
 *     last known bars (with its "stale" badge) instead of dropping the row.
 *
 * Deleting at the TTL is what used to make an account vanish from the dashboard
 * the day after its agents moved away, which is precisely when the user wants
 * to watch it for a reset.
 */

/** Snapshots are display-only past their TTL and pruned past this age. */
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface AgedSnapshot {
	/** ISO timestamp of the sample. Unparseable values count as beyond retention. */
	sampledAt: string;
}

export interface PartitionedSnapshots<T> {
	/** Within TTL: safe to act on. */
	live: Record<string, T>;
	/** Within retention (includes everything in `live`): safe to display. */
	retained: Record<string, T>;
	/** True when at least one entry aged out of retention and should be written back. */
	prunedAny: boolean;
}

/**
 * Split a snapshot map by the two clocks. A snapshot whose `sampledAt` does not
 * parse is treated as beyond retention so corrupted records self-heal.
 */
export function partitionSnapshotsByAge<T extends AgedSnapshot>(
	current: Record<string, T>,
	now: number,
	ttlMs: number,
	retentionMs: number = SNAPSHOT_RETENTION_MS
): PartitionedSnapshots<T> {
	const live: Record<string, T> = {};
	const retained: Record<string, T> = {};
	let prunedAny = false;

	for (const [key, entry] of Object.entries(current)) {
		const sampledAtMs = new Date(entry.sampledAt).getTime();
		if (Number.isNaN(sampledAtMs)) {
			prunedAny = true;
			continue;
		}
		const age = now - sampledAtMs;
		if (age > retentionMs) {
			prunedAny = true;
			continue;
		}
		retained[key] = entry;
		if (age <= ttlMs) {
			live[key] = entry;
		}
	}

	return { live, retained, prunedAny };
}
