/**
 * Tests for src/main/stores/usageSnapshotRetention.ts
 *
 * `partitionSnapshotsByAge` is the single implementation of the two-clock rule
 * that both plan-usage stores follow, so the boundaries live here rather than
 * being re-asserted per provider: TTL decides what may be ACTED on, retention
 * decides what may be DISPLAYED, and only the retention clock deletes.
 */

import { describe, it, expect } from 'vitest';

import {
	partitionSnapshotsByAge,
	SNAPSHOT_RETENTION_MS,
} from '../../../main/stores/usageSnapshotRetention';

const NOW = new Date('2026-05-15T12:00:00.000Z').getTime();
const TTL_MS = 24 * 60 * 60 * 1000;

function at(ageMs: number) {
	return { sampledAt: new Date(NOW - ageMs).toISOString() };
}

describe('partitionSnapshotsByAge', () => {
	it('keeps a fresh snapshot in both maps', () => {
		const fresh = at(60_000);
		const result = partitionSnapshotsByAge({ fresh }, NOW, TTL_MS);

		expect(result.live).toEqual({ fresh });
		expect(result.retained).toEqual({ fresh });
		expect(result.prunedAny).toBe(false);
	});

	it('drops an expired snapshot from live but keeps it retained', () => {
		const expired = at(25 * 60 * 60 * 1000);
		const result = partitionSnapshotsByAge({ expired }, NOW, TTL_MS);

		expect(result.live).toEqual({});
		expect(result.retained).toEqual({ expired });
		// Expiry alone must not trigger a write-back: nothing left the file.
		expect(result.prunedAny).toBe(false);
	});

	it('treats a snapshot exactly at the TTL as still live', () => {
		const onTtl = at(TTL_MS);
		const result = partitionSnapshotsByAge({ onTtl }, NOW, TTL_MS);

		expect(result.live).toEqual({ onTtl });
	});

	it('treats a snapshot exactly at the retention edge as still retained', () => {
		const onEdge = at(SNAPSHOT_RETENTION_MS);
		const result = partitionSnapshotsByAge({ onEdge }, NOW, TTL_MS);

		expect(result.retained).toEqual({ onEdge });
		expect(result.prunedAny).toBe(false);
	});

	it('drops a snapshot past retention and flags the write-back', () => {
		const ancient = at(SNAPSHOT_RETENTION_MS + 1);
		const result = partitionSnapshotsByAge({ ancient }, NOW, TTL_MS);

		expect(result.live).toEqual({});
		expect(result.retained).toEqual({});
		expect(result.prunedAny).toBe(true);
	});

	it('drops an unparseable sampledAt so a corrupted record self-heals', () => {
		const result = partitionSnapshotsByAge({ bad: { sampledAt: 'not-a-date' } }, NOW, TTL_MS);

		expect(result.retained).toEqual({});
		expect(result.prunedAny).toBe(true);
	});

	it('partitions a mixed map without cross-contaminating the buckets', () => {
		const fresh = at(60_000);
		const expired = at(30 * 60 * 60 * 1000);
		const ancient = at(SNAPSHOT_RETENTION_MS + 60_000);
		const result = partitionSnapshotsByAge({ fresh, expired, ancient }, NOW, TTL_MS);

		expect(result.live).toEqual({ fresh });
		expect(result.retained).toEqual({ fresh, expired });
		expect(result.prunedAny).toBe(true);
	});

	it('honors an explicit retention override', () => {
		const old = at(2 * TTL_MS);
		const result = partitionSnapshotsByAge({ old }, NOW, TTL_MS, 3 * TTL_MS);

		expect(result.retained).toEqual({ old });
		expect(partitionSnapshotsByAge({ old }, NOW, TTL_MS, TTL_MS).retained).toEqual({});
	});

	it('defaults retention to 30 days', () => {
		expect(SNAPSHOT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
	});
});
