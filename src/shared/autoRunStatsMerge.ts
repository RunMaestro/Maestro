/**
 * Conductor achievement totals (`autoRunStats`) only ever grow.
 *
 * Every field is a lifetime counter or a high-water mark: cumulative time, the
 * Cue share of it, completed runs, the longest run, the badge levels reached,
 * and the badge unlock history. Nothing in Maestro lowers them on purpose.
 *
 * They were still lost, the same way `usageStats` peaks were lost (see
 * `src/shared/usagePeaks.ts`): every crediting path does a read-modify-write of
 * the WHOLE object from the renderer's in-memory copy. A renderer whose copy
 * is still the zeroed default - one still hydrating, one whose settings load
 * failed, a second window, a web-desktop client - turns a one-minute Cue credit
 * into `{ cumulativeTimeMs: 60000, totalRuns: 0, ... }` and persists it over
 * the real total. Observed: 1,352 hours and level 6 replaced by 10 hours and
 * level 3, with the badges "unlocked" again the same afternoon.
 *
 * So the merge belongs at the persistence layer, against what is on disk:
 * `settings:set` runs `mergeAutoRunStats` for the `autoRunStats` key, and no
 * caller, in whatever state, can write a total lower than the stored one.
 *
 * Import-free so the main process and the renderer share it.
 */

export interface BadgeUnlock {
	level: number;
	unlockedAt: number;
}

/** Structurally identical to `AutoRunStats` in renderer types. */
export interface MergeableAutoRunStats {
	cumulativeTimeMs: number;
	cueTimeMs?: number;
	longestRunMs: number;
	longestRunTimestamp: number;
	totalRuns: number;
	currentBadgeLevel: number;
	lastBadgeUnlockLevel: number;
	lastAcknowledgedBadgeLevel: number;
	badgeHistory: BadgeUnlock[];
}

/** A stored or incoming counter as a usable non-negative number. */
function toCount(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return 0;
	return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Union by level, keeping the EARLIEST unlock of each level, in level order. */
function mergeBadgeHistory(stored: unknown, incoming: unknown): BadgeUnlock[] {
	const byLevel = new Map<number, number>();
	for (const list of [stored, incoming]) {
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (!isRecord(entry)) continue;
			const level = toCount(entry.level);
			const unlockedAt = toCount(entry.unlockedAt);
			if (level <= 0) continue;
			const known = byLevel.get(level);
			if (known === undefined || (unlockedAt > 0 && unlockedAt < known)) {
				byLevel.set(level, unlockedAt);
			}
		}
	}
	return [...byLevel.entries()]
		.sort(([a], [b]) => a - b)
		.map(([level, unlockedAt]) => ({ level, unlockedAt }));
}

/**
 * Merge an incoming `autoRunStats` write into the stored one, keeping the
 * larger value of every counter. Never lowers a stored value. A stored value
 * that is missing or malformed (a fresh install) lets the incoming one through
 * unchanged in effect, since every field maxes against zero.
 */
export function mergeAutoRunStats(stored: unknown, incoming: unknown): MergeableAutoRunStats {
	const a = isRecord(stored) ? stored : {};
	const b = isRecord(incoming) ? incoming : {};

	const cumulativeTimeMs = Math.max(toCount(a.cumulativeTimeMs), toCount(b.cumulativeTimeMs));
	// The Cue share is a subset of the total, so it can never exceed it.
	const cueTimeMs = Math.min(
		Math.max(toCount(a.cueTimeMs), toCount(b.cueTimeMs)),
		cumulativeTimeMs
	);

	// The longest run carries its own timestamp; take the pair from the winner.
	const storedLongest = toCount(a.longestRunMs);
	const incomingLongest = toCount(b.longestRunMs);
	const longestFromIncoming = incomingLongest > storedLongest;

	return {
		cumulativeTimeMs,
		cueTimeMs,
		longestRunMs: Math.max(storedLongest, incomingLongest),
		longestRunTimestamp: toCount(
			longestFromIncoming ? b.longestRunTimestamp : (a.longestRunTimestamp ?? b.longestRunTimestamp)
		),
		totalRuns: Math.max(toCount(a.totalRuns), toCount(b.totalRuns)),
		currentBadgeLevel: Math.max(toCount(a.currentBadgeLevel), toCount(b.currentBadgeLevel)),
		lastBadgeUnlockLevel: Math.max(
			toCount(a.lastBadgeUnlockLevel),
			toCount(b.lastBadgeUnlockLevel)
		),
		lastAcknowledgedBadgeLevel: Math.max(
			toCount(a.lastAcknowledgedBadgeLevel),
			toCount(b.lastAcknowledgedBadgeLevel)
		),
		badgeHistory: mergeBadgeHistory(a.badgeHistory, b.badgeHistory),
	};
}
