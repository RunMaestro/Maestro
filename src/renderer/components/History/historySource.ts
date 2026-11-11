/**
 * Where a History panel reads from: the desktop's own History of a local agent, or a Federation
 * peer's host for a mirrored agent. `HistoryPanel` draws every entry, the graph, the filters, and
 * the paging the same way for both; only this object differs.
 *
 * The mirrored source is read-only (no `remove` or `update`): the host owns the entries, and the
 * panel draws no delete or validate control without a handler.
 */

import type { HistoryEntry, HistoryEntryType, Session } from '../../types';
import type { PaginatedPage } from '../../hooks/history/useHistoryPagination';
import type { PrecomputedGraphBucket } from './ActivityGraph';
import { buildSharedHistoryContext } from '../../utils/sessionHelpers';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { mirrorKey } from '../../../shared/maestro-lib/client/peer-mirror';

/** What one page of the entry list is narrowed to. */
export interface HistorySourceQuery {
	lookbackHours: number | null;
	types: HistoryEntryType[];
	hostKey: string | null;
	/** Collapse repeated Cue triggers (local only: a host serves no Cue runs). */
	groupCue: boolean;
	pagination: { offset: number; limit: number };
}

/** The activity graph's data, as `history:getGraphData` answers it. */
export interface HistorySourceGraph {
	buckets: PrecomputedGraphBucket[];
	earliestTimestamp: number;
	latestTimestamp: number;
	hostCounts?: Record<string, number>;
}

/** What a panel is told about its source changing. */
export interface HistorySourceListener {
	/** One new entry, to put at the top. */
	onEntry(entry: HistoryEntry): void;
	/** Anything may have changed: read again from the top. */
	onReset(): void;
}

export interface HistorySource {
	getPage(query: HistorySourceQuery): Promise<PaginatedPage<HistoryEntry>>;
	getGraphData(bucketCount: number, lookbackHours: number | null): Promise<HistorySourceGraph>;
	getOffsetForTimestamp(
		timestamp: number,
		lookbackHours: number | null,
		types: HistoryEntryType[]
	): Promise<number>;
	subscribe(listener: HistorySourceListener): () => void;
	/** Absent: entries cannot be deleted here. */
	remove?(entryId: string): Promise<boolean>;
	/** Absent: entries cannot be marked validated here. */
	update?(entryId: string, updates: { validated?: boolean }): Promise<boolean>;
}

/** The fields of a local agent its History reads. */
export type LocalHistoryAgent = Pick<
	Session,
	'id' | 'cwd' | 'projectRoot' | 'sessionSshRemoteConfig'
>;

/**
 * A local agent's History through `window.maestro.history`: its own entries, merged with the
 * shared History of its project (over SSH when it syncs History with its remote).
 */
export function localHistorySource(agent: LocalHistoryAgent): HistorySource {
	const sharedContext = buildSharedHistoryContext(agent);
	// `projectPath` is what lets the handler merge a non-SSH agent's
	// `<projectPath>/.maestro/history/*.jsonl` files (entries written by other Maestro
	// instances pointed at the same project).
	const projectPath = agent.projectRoot || agent.cwd || undefined;
	return {
		getPage: async (query) => {
			const result = await window.maestro.history.getAllPaginated({
				sessionId: agent.id,
				projectPath,
				sharedContext,
				lookbackHours: query.lookbackHours,
				types: query.types,
				hostKey: query.hostKey,
				groupCue: query.groupCue,
				pagination: query.pagination,
			});
			return {
				entries: result.entries as HistoryEntry[],
				hasMore: result.hasMore,
				total: result.total,
			};
		},
		getGraphData: (bucketCount, lookbackHours) =>
			window.maestro.history.getGraphData(
				agent.id,
				bucketCount,
				lookbackHours,
				sharedContext,
				projectPath
			),
		getOffsetForTimestamp: (timestamp, lookbackHours, types) =>
			window.maestro.history.getOffsetForTimestamp(agent.id, timestamp, lookbackHours, types),
		subscribe: (listener) =>
			window.maestro.directorNotes.onHistoryEntryAdded((entry, sourceSessionId) => {
				if (sourceSessionId === agent.id) listener.onEntry(entry as HistoryEntry);
			}),
		remove: (entryId) => window.maestro.history.delete(entryId, agent.id),
		update: (entryId, updates) => window.maestro.history.update(entryId, updates, agent.id),
	};
}

/**
 * A Federation peer's mirrored agent's History, read from its host through the main-process
 * mirror (`window.maestro.federation.history*`). Read-only. It reads again from the top when the
 * window's mirror says the agent's History moved: a turn of the agent ended, or the peer
 * reconnected or woke (`peerMirrorStore.historyVersions`).
 */
export function mirrorHistorySource(peerId: string, agentId: string): HistorySource {
	const key = mirrorKey(peerId, agentId);
	return {
		getPage: async (query) => {
			const result = await window.maestro.federation.historyPage(peerId, agentId, {
				lookbackHours: query.lookbackHours,
				types: query.types,
				hostKey: query.hostKey,
				pagination: query.pagination,
			});
			return { entries: result.entries, hasMore: result.hasMore, total: result.total };
		},
		getGraphData: (bucketCount, lookbackHours) =>
			window.maestro.federation.historyGraph(peerId, agentId, bucketCount, lookbackHours),
		getOffsetForTimestamp: (timestamp, lookbackHours, types) =>
			window.maestro.federation.historyOffset(peerId, agentId, timestamp, lookbackHours, types),
		subscribe: (listener) => {
			let version = usePeerMirrorStore.getState().historyVersions[key] ?? 0;
			return usePeerMirrorStore.subscribe((state) => {
				const next = state.historyVersions[key] ?? 0;
				if (next === version) return;
				version = next;
				listener.onReset();
			});
		},
	};
}
