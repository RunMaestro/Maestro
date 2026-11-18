/**
 * Tests for the History panel of a Federation peer's mirrored agent: one page after the lookback
 * and the filters, the activity graph, and the offset a graph bar jumps to. Pure functions over
 * the entries the host sent; `now` is passed in so nothing depends on the clock.
 */

import { describe, expect, it } from 'vitest';
import {
	pagePeerHistory,
	peerHistoryGraph,
	peerHistoryOffset,
} from '../../../main/federation/peer-history';
import type { HistoryEntry } from '../../../shared/types';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const entry = (
	id: string,
	hoursAgo: number,
	overrides: Partial<HistoryEntry> = {}
): HistoryEntry => ({
	id,
	type: 'USER',
	timestamp: NOW - hoursAgo * HOUR,
	summary: id,
	projectPath: '/p',
	...overrides,
});

const entries: HistoryEntry[] = [
	entry('e1', 1, { hostname: 'laptop' }),
	entry('e2', 2, { type: 'AUTO' }),
	entry('e3', 5, { hostname: 'box.host' }),
	entry('e4', 48, { type: 'AUTO', hostname: 'laptop' }),
];

const ids = (list: HistoryEntry[]) => list.map((e) => e.id);

describe('pagePeerHistory', () => {
	it('returns every entry when nothing narrows it', () => {
		const page = pagePeerHistory(entries, {}, NOW);
		expect(ids(page.entries)).toEqual(['e1', 'e2', 'e3', 'e4']);
		expect(page.total).toBe(4);
		expect(page.hasMore).toBe(false);
	});

	it('applies the lookback, the types and the host before paging', () => {
		expect(ids(pagePeerHistory(entries, { lookbackHours: 24 }, NOW).entries)).toEqual([
			'e1',
			'e2',
			'e3',
		]);
		expect(ids(pagePeerHistory(entries, { types: ['AUTO'] }, NOW).entries)).toEqual(['e2', 'e4']);
		expect(ids(pagePeerHistory(entries, { hostKey: 'laptop' }, NOW).entries)).toEqual(['e1', 'e4']);
		expect(ids(pagePeerHistory(entries, { hostKey: '__local__' }, NOW).entries)).toEqual(['e2']);
	});

	it('pages the filtered list, so a page holds the newest N of the filter', () => {
		const page = pagePeerHistory(
			entries,
			{ types: ['USER'], pagination: { offset: 0, limit: 1 } },
			NOW
		);
		expect(ids(page.entries)).toEqual(['e1']);
		expect(page.total).toBe(2);
		expect(page.hasMore).toBe(true);
		const next = pagePeerHistory(
			entries,
			{ types: ['USER'], pagination: { offset: 1, limit: 1 } },
			NOW
		);
		expect(ids(next.entries)).toEqual(['e3']);
		expect(next.hasMore).toBe(false);
	});
});

describe('peerHistoryGraph', () => {
	it('counts every entry by type and host, with no Cue series and never cached', () => {
		const graph = peerHistoryGraph(entries, 6, null, NOW);
		expect(graph.bucketCount).toBe(6);
		expect(graph.buckets).toHaveLength(6);
		expect(graph).toMatchObject({
			totalCount: 4,
			userCount: 2,
			autoCount: 2,
			cueCount: 0,
			cached: false,
		});
		expect(graph.hostCounts).toEqual({ laptop: 2, 'box.host': 1, __local__: 1 });
	});

	it('narrows the counts to the lookback', () => {
		const graph = peerHistoryGraph(entries, 4, 24, NOW);
		expect(graph.totalCount).toBe(3);
		expect(graph.hostCounts).toEqual({ laptop: 1, 'box.host': 1, __local__: 1 });
	});

	it('keeps at least one bucket for a bad bucket count', () => {
		expect(peerHistoryGraph(entries, 0, null, NOW).bucketCount).toBe(1);
		expect(peerHistoryGraph(entries, -3, null, NOW).bucketCount).toBe(1);
	});

	it('graphs an empty History', () => {
		const graph = peerHistoryGraph([], 3, 24, NOW);
		expect(graph.totalCount).toBe(0);
		expect(graph.bucketCount).toBe(3);
	});
});

describe('peerHistoryOffset', () => {
	it('answers the index of the first entry at or before the time', () => {
		expect(peerHistoryOffset(entries, NOW, null, undefined, NOW)).toBe(0);
		expect(peerHistoryOffset(entries, NOW - 3 * HOUR, null, undefined, NOW)).toBe(2);
	});

	it('runs on the same lookback and types as the list', () => {
		expect(peerHistoryOffset(entries, NOW - 3 * HOUR, null, ['USER'], NOW)).toBe(1);
		// Older than every entry the lookback keeps: the last offset of the filtered list.
		expect(peerHistoryOffset(entries, NOW - 100 * HOUR, 24, undefined, NOW)).toBe(2);
	});

	it('answers 0 when nothing is left', () => {
		expect(peerHistoryOffset([], NOW, null, undefined, NOW)).toBe(0);
		expect(peerHistoryOffset(entries, NOW, null, [], NOW)).toBe(0);
	});
});
