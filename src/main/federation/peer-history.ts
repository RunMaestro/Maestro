/**
 * The History panel of a Federation peer's mirrored agent, computed the way the desktop computes
 * a local agent's (`src/main/ipc/handlers/history.ts`).
 *
 * The host sends the agent's History whole, newest first (`MaestroClient.history.list`): its own
 * entries and the shared History of the agent's project, each stamped with the machine it came
 * from. The page, the lookback, the type and host filters, the activity graph, and the jump to a
 * graph bar then run here, through the same pure functions a local agent's History runs through
 * (`filterHistoryEntries`, `paginateEntries`, `historyOffsetForTimestamp`, `buildBucketAggregate`),
 * so the two panels cannot disagree.
 *
 * Pure: no I/O. `PeerMirrorService.history()` reads and caches the entries.
 */

import {
	filterHistoryEntries,
	historyLookbackCutoff,
	historyOffsetForTimestamp,
	paginateEntries,
	type PaginatedResult,
	type PaginationOptions,
} from '../../shared/history';
import type { HistoryEntry, HistoryEntryType } from '../../shared/types';
import {
	aggregateToGraphData,
	buildBucketAggregate,
	type HistoryGraphData,
} from '../utils/history-bucket-builder';

/** What the History panel asks for one page of a mirrored agent's History. */
export interface PeerHistoryPageQuery {
	lookbackHours?: number | null;
	types?: HistoryEntryType[];
	hostKey?: string | null;
	pagination?: PaginationOptions;
}

/** One page of the entries, newest first, after the lookback and the filters. */
export function pagePeerHistory(
	entries: HistoryEntry[],
	query: PeerHistoryPageQuery,
	now: number = Date.now()
): PaginatedResult<HistoryEntry> {
	const filtered = filterHistoryEntries(entries, {
		cutoffTime: historyLookbackCutoff(query.lookbackHours, now),
		types: query.types,
		hostKey: query.hostKey,
	});
	return paginateEntries(filtered, query.pagination);
}

/** The activity graph over every entry: a host serves no Cue runs, so there is no Cue series. */
export function peerHistoryGraph(
	entries: HistoryEntry[],
	bucketCount: number,
	lookbackHours: number | null,
	now: number = Date.now()
): HistoryGraphData {
	const safeBucketCount = Math.max(1, bucketCount | 0);
	const lookbackMs = lookbackHours !== null && lookbackHours > 0 ? lookbackHours * 3_600_000 : null;
	const aggregate = buildBucketAggregate(entries, safeBucketCount, { lookbackMs, endTime: now });
	return aggregateToGraphData(aggregate, safeBucketCount, false);
}

/** The page offset a graph bar jumps to, on the same lookback and type filter as the list. */
export function peerHistoryOffset(
	entries: HistoryEntry[],
	timestamp: number,
	lookbackHours: number | null | undefined,
	types: HistoryEntryType[] | undefined,
	now: number = Date.now()
): number {
	return historyOffsetForTimestamp(
		filterHistoryEntries(entries, { cutoffTime: historyLookbackCutoff(lookbackHours, now), types }),
		timestamp
	);
}
