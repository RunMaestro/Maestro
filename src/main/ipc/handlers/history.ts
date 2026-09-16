/**
 * History IPC Handlers
 *
 * These handlers provide history persistence operations using the per-session
 * HistoryManager for improved scalability and session isolation.
 *
 * Features:
 * - 5,000 entries per session (up from 1,000 global)
 * - Per-session file storage in history/ directory
 * - Cross-session queries for global views
 * - Pagination support for large datasets
 * - Context integration for AI agents via history:getFilePath
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import {
	CueHistoryGroup,
	HistoryEntry,
	HistoryEntryType,
	SshRemoteConfig,
} from '../../../shared/types';
import {
	PaginationOptions,
	ORPHANED_SESSION_ID,
	sortEntriesByTimestamp,
	paginateEntries,
} from '../../../shared/history';
import { getHistoryManager } from '../../history-manager';
import {
	writeEntryRemote,
	writeEntryLocal,
	readRemoteEntriesSsh,
	readRemoteEntriesLocal,
	hasLocalSharedHistory,
} from '../../shared-history-manager';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import type { SafeSendFn } from '../../utils/safe-send';
import { captureException } from '../../utils/sentry';
import {
	getHistoryBucketCache,
	fileFingerprint,
	HISTORY_BUCKET_CACHE_VERSION,
	type CachedGraphBucket,
} from '../../utils/history-bucket-cache';
import { buildBucketAggregate, LOCAL_HOST_AGG_KEY } from '../../utils/history-bucket-builder';
import type { PluginEvent } from '../../../shared/plugins/events';
import type {
	CueHistoryBucket,
	CueHistoryBucketQuery,
	CueHistoryGroupRunsQuery,
	CueHistoryQuery,
} from '../../cue/stats/cue-stats-query';
import {
	cueScopeAgentFromRecord,
	cueScopeAgentsFromRecords,
	dropCueRowsAlreadyInJsonl,
	mergeEntriesById,
	readCueEntries as readCueEntriesForAgents,
	readCueGroupedEntries as readCueGroupedEntriesForAgents,
	readCueGroupRuns as readCueGroupRunsForAgent,
	readCueGraphBuckets as readCueGraphBucketsForAgent,
	readCueGraphFingerprint as readCueGraphFingerprintForAgent,
	type CueScopeAgent,
} from '../../utils/cue-history-merge';

const LOG_CONTEXT = '[History]';

/** Context passed from the renderer for shared history operations */
export interface SharedHistoryContext {
	sshRemoteId: string;
	remoteCwd: string;
}

/**
 * Aggregated graph data returned by `history:getGraphData` and
 * `director-notes:getGraphData`. Buckets are computed over the full source
 * history (not the renderer's lookback window) so the graph view stays
 * "all-encompassing" while the entry list paginates beneath it.
 */
export interface HistoryGraphData {
	buckets: CachedGraphBucket[];
	bucketCount: number;
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	agentCount: number;
	/**
	 * Per-host entry counts in the same window the buckets cover. Key is
	 * the entry's `hostname`, or `"__local__"` for entries with no
	 * hostname. Lookback-aware via the same `lookbackMs` that bucketing
	 * uses, so flipping the renderer's lookback selector updates these
	 * numbers too.
	 */
	hostCounts: Record<string, number>;
	/** True when served from the disk cache (diagnostics only). */
	cached: boolean;
}

/** Internal: shape returned by `buildBucketAggregate`. */
interface BucketAggregateLike {
	buckets: CachedGraphBucket[];
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	agentCount: number;
	hostCounts: Record<string, number>;
}

function aggregateToGraphData(
	agg: BucketAggregateLike,
	bucketCount: number,
	cached: boolean
): HistoryGraphData {
	return {
		buckets: agg.buckets,
		bucketCount,
		earliestTimestamp: agg.earliestTimestamp,
		latestTimestamp: agg.latestTimestamp,
		totalCount: agg.totalCount,
		autoCount: agg.autoCount,
		userCount: agg.userCount,
		cueCount: agg.cueCount,
		agentCount: agg.agentCount,
		hostCounts: agg.hostCounts,
		cached,
	};
}

function cachedToGraphData(
	cached: {
		buckets: CachedGraphBucket[];
		bucketCount: number;
		earliestTimestamp: number;
		latestTimestamp: number;
		totalCount: number;
		autoCount: number;
		userCount: number;
		cueCount: number;
		agentCount: number;
		hostCounts: Record<string, number>;
	},
	fromCache: boolean
): HistoryGraphData {
	return {
		buckets: cached.buckets,
		bucketCount: cached.bucketCount,
		earliestTimestamp: cached.earliestTimestamp,
		latestTimestamp: cached.latestTimestamp,
		totalCount: cached.totalCount,
		autoCount: cached.autoCount,
		userCount: cached.userCount,
		cueCount: cached.cueCount,
		agentCount: cached.agentCount,
		hostCounts: cached.hostCounts,
		cached: fromCache,
	};
}

export interface HistoryHandlerDependencies {
	safeSend: SafeSendFn;
	/** Returns the user's maxLogBuffer setting (used as max entries per session) */
	getMaxEntries?: () => number;
	/** Resolve an SSH remote config by ID */
	getSshRemoteById?: (id: string) => SshRemoteConfig | undefined;
	/**
	 * Resolve a session record by id. Used to check the per-session
	 * `shareHistoryToProjectDir` flag when deciding whether to mirror an entry
	 * into `<project>/.maestro/history/history-<hostname>.jsonl` on the local
	 * filesystem so other Maestro instances reading the same project directory
	 * (typically via SSH) can see it.
	 */
	getSessionById?: (id: string) => Record<string, unknown> | undefined;
	/**
	 * Optional sink for the metadata-only `history.entryAdded` plugin event
	 * (ids/classification only - never `summary`/`fullResponse`). Wired to
	 * `pluginEventBus.emit` in index.ts; undefined in tests / when the plugin
	 * subsystem is absent, in which case the emit is simply skipped. Delivery
	 * is re-authorized per plugin against live grants (`events:subscribe` +
	 * `history:read`) by the bus itself.
	 */
	emitPluginEvent?: (event: PluginEvent) => void;
	/**
	 * Every session record, used only to resolve which agents a project-wide or
	 * global read covers. `cue_events` rows know their agent but not its
	 * directory, so the sessions store is the only place that mapping exists.
	 */
	getAllSessions?: () => Array<Record<string, unknown>>;
	/**
	 * Cue runs for one agent, already shaped as {@link HistoryEntry} - see
	 * `getCueHistoryEntries()` in `src/main/cue/stats/cue-stats-query.ts`.
	 *
	 * Injected rather than imported so this module keeps no static edge to the
	 * Cue SQLite layer (`better-sqlite3` is a native binding built for
	 * Electron's ABI, and History is exercised well outside that runtime).
	 * Omitted means History serves JSONL entries only.
	 */
	getCueHistoryEntries?: (query: CueHistoryQuery) => HistoryEntry[];
	/**
	 * The same runs as {@link getCueHistoryEntries}, collapsed to one row per
	 * pipeline-level trigger - see `getCueHistoryGroups()` in the same module.
	 * Used when the caller asks for grouped Cue rows; the rollup runs in SQL
	 * over the indexed columns, so a week of a chatty pipeline costs one row
	 * instead of the thousands it actually ran.
	 */
	getCueHistoryGroups?: (query: CueHistoryQuery) => CueHistoryGroup[];
	/**
	 * The individual runs behind ONE group produced by
	 * {@link getCueHistoryGroups} - what the panel's expander opens, so a
	 * collapsed row never hides a run from the user. See
	 * `getCueHistoryGroupRuns()` in the same module.
	 */
	getCueHistoryGroupRuns?: (query: CueHistoryGroupRunsQuery) => HistoryEntry[];
	/**
	 * Per-minute Cue run counts for the activity graph - see
	 * `getCueHistoryBuckets()` in `src/main/cue/stats/cue-stats-query.ts`.
	 * Counts rather than rows because a bar chart never needs the text.
	 * Injected for the same reason as {@link getCueHistoryEntries}.
	 */
	getCueHistoryBuckets?: (query: CueHistoryBucketQuery) => CueHistoryBucket[];
	/**
	 * Change-detector for one agent's Cue history, mixed into the
	 * activity-graph cache key. Without it the cache keys only off the JSONL
	 * file, which no longer moves when a Cue run lands, and the CUE bars
	 * freeze at whatever was first computed.
	 */
	getCueHistoryFingerprint?: (sessionId?: string) => string;
}

/**
 * Which agents' Cue runs belong in a given read.
 *
 * The single-session scope is the one the History panel uses; the project and
 * global scopes walk the sessions store because an agent's directory lives
 * there, not on the `cue_events` row.
 */
function cueScopeAgents(
	deps: HistoryHandlerDependencies,
	sessionId?: string,
	projectPath?: string
): CueScopeAgent[] {
	if (!deps.getCueHistoryEntries && !deps.getCueHistoryGroups) return [];
	if (sessionId) {
		return [cueScopeAgentFromRecord(sessionId, deps.getSessionById?.(sessionId), projectPath)];
	}
	return cueScopeAgentsFromRecords(deps.getAllSessions?.() ?? [], projectPath);
}

/** Cue rows for the agents in scope, capped by the user's history limit. */
function readCueEntries(
	deps: HistoryHandlerDependencies,
	agents: CueScopeAgent[],
	options: { since?: number } = {}
): HistoryEntry[] {
	return readCueEntriesForAgents(deps.getCueHistoryEntries, agents, {
		since: options.since,
		limit: deps.getMaxEntries?.(),
	});
}

/** Cue rows for the agents in scope, collapsed to one row per trigger. */
function readCueGroupedEntries(
	deps: HistoryHandlerDependencies,
	agents: CueScopeAgent[],
	options: { since?: number } = {}
): HistoryEntry[] {
	return readCueGroupedEntriesForAgents(deps.getCueHistoryGroups, agents, {
		since: options.since,
		limit: deps.getMaxEntries?.(),
	});
}

/** The individual runs behind one collapsed group, newest first. */
function readCueGroupRuns(
	deps: HistoryHandlerDependencies,
	agent: CueScopeAgent,
	options: { groupKey: string; since?: number; limit?: number }
): HistoryEntry[] {
	return readCueGroupRunsForAgent(deps.getCueHistoryGroupRuns, agent, options);
}

/** The Cue half of one agent's activity-graph cache key. */
function readCueGraphFingerprint(deps: HistoryHandlerDependencies, sessionId: string): string {
	return readCueGraphFingerprintForAgent(deps.getCueHistoryFingerprint, sessionId);
}

/** Per-minute Cue run counts for one agent's activity graph. */
function readCueGraphBuckets(
	deps: HistoryHandlerDependencies,
	sessionId: string,
	options: { since?: number } = {}
): CueHistoryBucket[] {
	return readCueGraphBucketsForAgent(deps.getCueHistoryBuckets, {
		sessionId,
		since: options.since,
	});
}

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all History-related IPC handlers.
 *
 * These handlers provide history persistence operations:
 * - Get all history entries (with optional project/session filtering and pagination)
 * - Add new history entry
 * - Clear history (all, by project, or by session)
 * - Delete individual history entry
 * - Update history entry (e.g., setting validated flag)
 * - Get history file path (for AI context integration)
 * - List sessions with history
 */
export function registerHistoryHandlers(deps: HistoryHandlerDependencies): void {
	const historyManager = getHistoryManager();

	// Get all history entries, optionally filtered by project and/or session
	// Legacy handler - returns all entries (use history:getAllPaginated for large datasets)
	ipcMain.handle(
		'history:getAll',
		withIpcErrorLogging(
			handlerOpts('getAll'),
			async (projectPath?: string, sessionId?: string, sharedContext?: SharedHistoryContext) => {
				const maxEntries = deps.getMaxEntries?.();
				let localEntries: HistoryEntry[];

				if (sessionId) {
					// Get entries for specific session only - don't include orphaned entries
					// to prevent history bleeding across different agent sessions in the same directory
					localEntries = await historyManager.getEntries(sessionId);
					localEntries.sort((a, b) => b.timestamp - a.timestamp);
				} else if (projectPath) {
					localEntries = await historyManager.getEntriesByProjectPath(projectPath);
				} else {
					localEntries = await historyManager.getAllEntries();
				}

				// Merge shared history entries from other hosts
				let sharedEntries: HistoryEntry[] = [];
				try {
					if (sharedContext?.sshRemoteId && sharedContext?.remoteCwd) {
						// SSH session with syncHistory enabled: read shared files from remote host
						const sshRemote = deps.getSshRemoteById?.(sharedContext.sshRemoteId);
						if (sshRemote) {
							sharedEntries = await readRemoteEntriesSsh(
								sharedContext.remoteCwd,
								sshRemote,
								maxEntries
							);
						}
					} else if (projectPath) {
						// Local session: read .maestro/history/ from project dir
						// to see entries written by remote SSH operators
						sharedEntries = readRemoteEntriesLocal(projectPath, maxEntries);
					}
				} catch (error) {
					void captureException(error);
					logger.warn(`Failed to read shared history: ${error}`, LOG_CONTEXT);
				}

				// Merge and deduplicate by entry ID, then sort
				const jsonlEntries = mergeEntriesById(localEntries, sharedEntries);

				// Cue runs live in `cue_events`, not in the JSONL file, so they
				// are merged in here rather than read off disk.
				const cueEntries = dropCueRowsAlreadyInJsonl(
					jsonlEntries,
					readCueEntries(deps, cueScopeAgents(deps, sessionId, projectPath))
				);

				return mergeEntriesById(jsonlEntries, cueEntries);
			}
		)
	);

	// Get history entries with pagination support.
	//
	// Accepts an optional `lookbackHours` to filter entries to the last N
	// hours before pagination - keeps page boundaries meaningful when the
	// renderer's lookback is tighter than the on-disk window. Also accepts
	// `sharedContext` so SSH-shared history is merged in before paging,
	// matching `history:getAll`'s behavior.
	ipcMain.handle(
		'history:getAllPaginated',
		withIpcErrorLogging(
			handlerOpts('getAllPaginated'),
			async (options?: {
				projectPath?: string;
				sessionId?: string;
				pagination?: PaginationOptions;
				lookbackHours?: number | null;
				sharedContext?: SharedHistoryContext;
				types?: HistoryEntryType[];
				hostKey?: string | null;
				groupCue?: boolean;
			}) => {
				const {
					projectPath,
					sessionId,
					pagination,
					lookbackHours,
					sharedContext,
					types,
					hostKey,
					groupCue,
				} = options || {};
				const cutoffTime =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: 0;

				// Type filter runs server-side (before pagination) so the loaded
				// window holds the newest N entries OF THE SELECTED TYPES rather
				// than the newest N of all types. Without this, a Cue-heavy agent
				// (heartbeats + agent.completed firing constantly) fills the whole
				// window with CUE entries and toggling CUE off shows nothing even
				// though USER/AUTO history exists further back. `undefined` means
				// "no type filter" (backward compatible); an empty array correctly
				// yields no entries.
				const typeSet = types ? new Set(types) : null;
				// Host filter also runs server-side (mirroring the type filter)
				// so the loaded window holds the newest N entries OF THE SELECTED
				// HOST. Without it the host filter was applied client-side over
				// only the loaded page, so picking a host whose entries fell
				// outside that page showed nothing despite the picker count
				// (which comes from the full-source graph aggregate). The key
				// must match the aggregate / renderer: `hostname` or the
				// synthetic `LOCAL_HOST_AGG_KEY` for entries with no hostname.
				const applyFilters = (entries: HistoryEntry[]): HistoryEntry[] => {
					let out = cutoffTime > 0 ? entries.filter((e) => e.timestamp >= cutoffTime) : entries;
					if (typeSet) out = out.filter((e) => typeSet.has(e.type));
					if (hostKey) {
						out = out.filter((e) => (e.hostname ?? LOCAL_HOST_AGG_KEY) === hostKey);
					}
					return out;
				};

				// Cue runs come from `cue_events`, so they are merged in before
				// the filters and pagination run - a page must hold the newest N
				// entries of BOTH sources, not the newest N of the JSONL file
				// with Cue rows sprinkled on afterwards.
				//
				// The query is skipped when the request has already filtered Cue
				// rows out: the CUE pill being off, or a host filter naming a
				// foreign host (Cue rows carry no hostname, so they only ever
				// belong to the local bucket).
				const wantsCue =
					(!typeSet || typeSet.has('CUE')) && (!hostKey || hostKey === LOCAL_HOST_AGG_KEY);
				//
				// `groupCue` (the user's `groupCueEntries` setting) picks the
				// collapsed read instead: one row per pipeline-level trigger,
				// rolled up in SQL. The rollup has to happen HERE rather than in
				// the renderer because the renderer only ever holds a page of
				// 100 entries - grouping that would report "100 runs" for a
				// trigger that actually ran 1,382 times, which is the exact
				// number the row exists to tell the user.
				const mergeCueEntries = (jsonlEntries: HistoryEntry[]): HistoryEntry[] => {
					if (!wantsCue) return jsonlEntries;
					const since = cutoffTime > 0 ? cutoffTime : undefined;
					const agents = cueScopeAgents(deps, sessionId, projectPath);
					const cueEntries = groupCue
						? readCueGroupedEntries(deps, agents, { since })
						: dropCueRowsAlreadyInJsonl(jsonlEntries, readCueEntries(deps, agents, { since }));
					return mergeEntriesById(jsonlEntries, cueEntries);
				};

				// Single-session path: optionally merge shared (SSH or local
				// project-mirrored) entries before applying lookback + pagination.
				if (sessionId) {
					let local = await historyManager.getEntries(sessionId);
					local = sortEntriesByTimestamp(local);

					const hasShared = Boolean(sharedContext?.sshRemoteId && sharedContext?.remoteCwd);
					if (hasShared || projectPath) {
						const maxEntries = deps.getMaxEntries?.();
						let sharedEntries: HistoryEntry[] = [];
						try {
							if (hasShared) {
								const sshRemote = deps.getSshRemoteById?.(sharedContext!.sshRemoteId);
								if (sshRemote) {
									sharedEntries = await readRemoteEntriesSsh(
										sharedContext!.remoteCwd,
										sshRemote,
										maxEntries
									);
								}
							} else if (projectPath) {
								sharedEntries = readRemoteEntriesLocal(projectPath, maxEntries);
							}
						} catch (error) {
							void captureException(error);
							logger.warn(`Failed to read shared history (paginated): ${error}`, LOG_CONTEXT);
						}

						local = mergeEntriesById(local, sharedEntries);
					}

					return paginateEntries(applyFilters(mergeCueEntries(local)), pagination);
				}

				if (projectPath) {
					const result = await historyManager.getEntriesByProjectPathPaginated(
						projectPath,
						undefined
					);
					return paginateEntries(applyFilters(mergeCueEntries(result.entries)), pagination);
				}

				const result = await historyManager.getAllEntriesPaginated(undefined);
				return paginateEntries(applyFilters(mergeCueEntries(result.entries)), pagination);
			}
		)
	);

	// The individual runs behind ONE collapsed Cue row, for the History
	// panel's expander. Scoped to the agent that ran them (the row carries
	// its `sessionId`) and to the same lookback the grouped read used, so the
	// runs returned are exactly the ones the group counted.
	ipcMain.handle(
		'history:getCueGroupRuns',
		withIpcErrorLogging(
			handlerOpts('getCueGroupRuns'),
			async (options?: {
				sessionId?: string;
				projectPath?: string;
				groupKey?: string;
				lookbackHours?: number | null;
				limit?: number;
			}) => {
				const { sessionId, projectPath, groupKey, lookbackHours, limit } = options || {};
				if (!sessionId || !groupKey) return [];

				const since =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: undefined;
				const agent = cueScopeAgentFromRecord(
					sessionId,
					deps.getSessionById?.(sessionId),
					projectPath
				);
				return readCueGroupRuns(deps, agent, {
					groupKey,
					since,
					limit: limit ?? deps.getMaxEntries?.(),
				});
			}
		)
	);

	// Get graph data (buckets + counts) for a single session.
	// Cached on disk keyed by (sessionId, bucketCount, lookbackHours,
	// file mtime+size + Cue fingerprint). The lookback is part of the cache
	// key so each window the user picks gets its own cached aggregate; the
	// fingerprint invalidates them all at once when either source moves -
	// the JSONL file for USER/AUTO, `cue_events` for CUE.
	ipcMain.handle(
		'history:getGraphData',
		withIpcErrorLogging(
			handlerOpts('getGraphData'),
			async (
				sessionId: string,
				bucketCount: number,
				lookbackHours: number | null,
				sharedContext?: SharedHistoryContext,
				projectPath?: string
			): Promise<HistoryGraphData> => {
				const safeBucketCount = Math.max(1, bucketCount | 0);
				const lookbackMs =
					lookbackHours !== null && lookbackHours > 0 ? lookbackHours * 60 * 60 * 1000 : null;
				// One clock for the whole handler: the window the Cue query is
				// asked for has to be the window the aggregate buckets, or the
				// oldest bar loses runs to the gap between the two reads.
				const endTime = Date.now();
				const filePath = await historyManager.getHistoryFilePath(sessionId);
				const hasShared = Boolean(sharedContext?.sshRemoteId && sharedContext?.remoteCwd);
				// Local-shared overlay: a non-SSH session whose project dir
				// has foreign-host JSONL files in `.maestro/history/`.
				// Typical of an agent running directly on the remote machine
				// with `shareHistoryToProjectDir` on so a paired Maestro
				// (SSH'd in from elsewhere) can observe its work.
				const hasLocalShared = Boolean(
					!hasShared && projectPath && hasLocalSharedHistory(projectPath)
				);

				// Cache only when there is no shared-history overlay (SSH or
				// local-mirror). Shared entries come from arbitrary files we
				// don't fingerprint, so the simple cached path can't see them.
				// Cue runs are no longer in the JSONL file, so the CUE series comes
				// from `cue_events` as per-minute counts. Read lazily - a cache
				// hit only needs the fingerprint.
				const cueSince = lookbackMs !== null ? endTime - lookbackMs : undefined;
				const aggregateOptions = () => ({
					lookbackMs,
					endTime,
					cueCounts: readCueGraphBuckets(deps, sessionId, { since: cueSince }),
				});

				if (filePath && !hasShared && !hasLocalShared) {
					const cache = getHistoryBucketCache();
					const lookbackKey = lookbackHours === null ? 'all' : String(lookbackHours);
					const cacheKey = `single:${sessionId}:bc=${safeBucketCount}:lb=${lookbackKey}`;
					const fp = `${fileFingerprint(filePath)}|cue=${readCueGraphFingerprint(deps, sessionId)}`;
					const hit = await cache.get(cacheKey, fp);
					if (hit) {
						return cachedToGraphData(hit, true);
					}

					const entries = await historyManager.getEntries(sessionId);
					const agg = buildBucketAggregate(entries, safeBucketCount, aggregateOptions());
					// Fire-and-forget the disk write - the renderer doesn't need to
					// wait for it; the in-memory cache layer was already updated.
					void cache.set({
						version: HISTORY_BUCKET_CACHE_VERSION,
						cacheKey,
						sourceFingerprint: fp,
						bucketCount: safeBucketCount,
						buckets: agg.buckets,
						earliestTimestamp: agg.earliestTimestamp,
						latestTimestamp: agg.latestTimestamp,
						totalCount: agg.totalCount,
						autoCount: agg.autoCount,
						userCount: agg.userCount,
						cueCount: agg.cueCount,
						agentCount: agg.agentCount,
						hostCounts: agg.hostCounts,
						computedAt: Date.now(),
					});
					return aggregateToGraphData(agg, safeBucketCount, false);
				}

				// Shared-history or missing-file path: compute inline, no cache.
				const entries: HistoryEntry[] = filePath ? await historyManager.getEntries(sessionId) : [];
				const maxEntries = deps.getMaxEntries?.();
				if (hasShared) {
					try {
						const sshRemote = deps.getSshRemoteById?.(sharedContext!.sshRemoteId);
						if (sshRemote) {
							const sharedEntries = await readRemoteEntriesSsh(
								sharedContext!.remoteCwd,
								sshRemote,
								maxEntries
							);
							const seen = new Set(entries.map((e) => e.id));
							for (const e of sharedEntries) {
								if (!seen.has(e.id)) {
									entries.push(e);
									seen.add(e.id);
								}
							}
						}
					} catch (err) {
						logger.warn(`Failed to read shared history for graph: ${err}`, LOG_CONTEXT);
					}
				} else if (hasLocalShared) {
					try {
						const sharedEntries = readRemoteEntriesLocal(projectPath!, maxEntries);
						const seen = new Set(entries.map((e) => e.id));
						for (const e of sharedEntries) {
							if (!seen.has(e.id)) {
								entries.push(e);
								seen.add(e.id);
							}
						}
					} catch (err) {
						logger.warn(`Failed to read local shared history for graph: ${err}`, LOG_CONTEXT);
					}
				}
				const agg = buildBucketAggregate(entries, safeBucketCount, aggregateOptions());
				return aggregateToGraphData(agg, safeBucketCount, false);
			}
		)
	);

	// Find the offset of the first entry whose timestamp is <= the given
	// timestamp, in the newest-first sorted order (with the same lookback
	// filter the paginated list uses, so the offset lines up with the
	// rendered indices). Used by the activity-graph click handler to jump
	// the paginated list to a specific bucket.
	ipcMain.handle(
		'history:getOffsetForTimestamp',
		withIpcErrorLogging(
			handlerOpts('getOffsetForTimestamp'),
			async (
				sessionId: string,
				timestamp: number,
				lookbackHours?: number | null,
				types?: HistoryEntryType[]
			): Promise<number> => {
				const cutoffTime =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: 0;
				let entries = await historyManager.getEntries(sessionId);
				// Cue rows are part of the rendered list but not of the JSONL
				// file, so they have to be merged here too or every offset past
				// the first Cue run lands on the wrong entry.
				entries = mergeEntriesById(
					entries,
					dropCueRowsAlreadyInJsonl(
						entries,
						readCueEntries(deps, cueScopeAgents(deps, sessionId), {
							since: cutoffTime > 0 ? cutoffTime : undefined,
						})
					)
				);
				if (cutoffTime > 0) entries = entries.filter((e) => e.timestamp >= cutoffTime);
				// Mirror the paginated list's type filter so the resolved offset
				// lines up with the rendered (type-filtered) indices.
				if (types) {
					const typeSet = new Set(types);
					entries = entries.filter((e) => typeSet.has(e.type));
				}
				if (entries.length === 0) return 0;
				const sorted = sortEntriesByTimestamp(entries);
				let offset = 0;
				for (const entry of sorted) {
					if (entry.timestamp <= timestamp) return offset;
					offset++;
				}
				return Math.max(0, sorted.length - 1);
			}
		)
	);

	// Force reload history from disk (no-op for new format since we read fresh each time)
	// Kept for API compatibility
	ipcMain.handle(
		'history:reload',
		withIpcErrorLogging(handlerOpts('reload'), async () => {
			logger.debug('history:reload called (no-op for per-session storage)', LOG_CONTEXT);
			return true;
		})
	);

	// Add a new history entry
	ipcMain.handle(
		'history:add',
		withIpcErrorLogging(
			handlerOpts('add'),
			async (entry: HistoryEntry, sharedContext?: SharedHistoryContext) => {
				const sessionId = entry.sessionId || ORPHANED_SESSION_ID;
				const maxEntries = deps.getMaxEntries?.();
				await historyManager.addEntry(sessionId, entry.projectPath, entry, maxEntries);
				logger.info(`Added history entry: ${entry.type}`, LOG_CONTEXT, {
					summary: entry.summary,
				});

				// Shared history: write to remote .maestro/history/ (only for SSH sessions with syncHistory enabled)
				if (sharedContext?.sshRemoteId && sharedContext?.remoteCwd) {
					const sshRemote = deps.getSshRemoteById?.(sharedContext.sshRemoteId);
					if (sshRemote) {
						writeEntryRemote(sharedContext.remoteCwd, entry, sshRemote).catch((err) =>
							logger.warn(`Shared history remote write failed: ${err}`, LOG_CONTEXT)
						);
					}
				}

				// Shared history: also mirror to the local project's .maestro/history/
				// when the source agent is flagged as "remote-controlled" - i.e. its
				// `sessionSshRemoteConfig.shareHistoryToProjectDir` is on. This is the
				// signal that another Maestro instance (typically SSH'd into this
				// machine) wants visibility into entries generated by *this* local
				// instance.
				const targetSession = deps.getSessionById?.(sessionId);
				const sshCfg =
					targetSession &&
					(targetSession as { sessionSshRemoteConfig?: { shareHistoryToProjectDir?: boolean } })
						.sessionSshRemoteConfig;
				if (sshCfg?.shareHistoryToProjectDir && entry.projectPath) {
					writeEntryLocal(entry.projectPath, entry, maxEntries);
				}

				// Broadcast to renderer for real-time Director's Notes streaming
				deps.safeSend('history:entryAdded', entry, sessionId);

				// Surface a metadata-only history.entryAdded to subscribed plugins.
				// ids/classification ONLY per events.ts - never summary/fullResponse
				// or any other free-form content. The bus re-authorizes each delivery
				// against live grants (events:subscribe + history:read).
				deps.emitPluginEvent?.({
					topic: 'history.entryAdded',
					at: new Date().toISOString(),
					payload: {
						entryId: entry.id,
						...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
						...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
						kind: entry.type,
						createdAt: entry.timestamp,
					},
				});

				return true;
			}
		)
	);

	// Clear history entries (all, by project, or by session)
	ipcMain.handle(
		'history:clear',
		withIpcErrorLogging(handlerOpts('clear'), async (projectPath?: string, sessionId?: string) => {
			if (sessionId) {
				await historyManager.clearSession(sessionId);
				logger.info(`Cleared history for session: ${sessionId}`, LOG_CONTEXT);
				return true;
			}

			if (projectPath) {
				// Clear all sessions for this project
				await historyManager.clearByProjectPath(projectPath);
				logger.info(`Cleared history for project: ${projectPath}`, LOG_CONTEXT);
				return true;
			}

			// Clear all history
			await historyManager.clearAll();
			return true;
		})
	);

	// Delete a single history entry by ID
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:delete',
		withIpcErrorLogging(handlerOpts('delete'), async (entryId: string, sessionId?: string) => {
			if (sessionId) {
				const deleted = await historyManager.deleteEntry(sessionId, entryId);
				if (deleted) {
					logger.info(`Deleted history entry: ${entryId} from session ${sessionId}`, LOG_CONTEXT);
				} else {
					logger.warn(`History entry not found: ${entryId} in session ${sessionId}`, LOG_CONTEXT);
				}
				return deleted;
			}

			// Search all sessions for the entry (slower, but works for legacy calls without sessionId)
			const sessions = await historyManager.listSessionsWithHistory();
			for (const sid of sessions) {
				if (await historyManager.deleteEntry(sid, entryId)) {
					logger.info(`Deleted history entry: ${entryId} from session ${sid}`, LOG_CONTEXT);
					return true;
				}
			}

			logger.warn(`History entry not found: ${entryId}`, LOG_CONTEXT);
			return false;
		})
	);

	// Update a history entry (for setting validated flag, etc.)
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:update',
		withIpcErrorLogging(
			handlerOpts('update'),
			async (entryId: string, updates: Partial<HistoryEntry>, sessionId?: string) => {
				if (sessionId) {
					const updated = await historyManager.updateEntry(sessionId, entryId, updates);
					if (updated) {
						logger.info(`Updated history entry: ${entryId} in session ${sessionId}`, LOG_CONTEXT, {
							updates,
						});
					} else {
						logger.warn(
							`History entry not found for update: ${entryId} in session ${sessionId}`,
							LOG_CONTEXT
						);
					}
					return updated;
				}

				// Search all sessions for the entry
				const sessions = await historyManager.listSessionsWithHistory();
				for (const sid of sessions) {
					if (await historyManager.updateEntry(sid, entryId, updates)) {
						logger.info(`Updated history entry: ${entryId} in session ${sid}`, LOG_CONTEXT, {
							updates,
						});
						return true;
					}
				}

				logger.warn(`History entry not found for update: ${entryId}`, LOG_CONTEXT);
				return false;
			}
		)
	);

	// Update sessionName for all entries matching a agentSessionId (used when renaming tabs)
	ipcMain.handle(
		'history:updateSessionName',
		withIpcErrorLogging(
			handlerOpts('updateSessionName'),
			async (agentSessionId: string, sessionName: string) => {
				const count = await historyManager.updateSessionNameByClaudeSessionId(
					agentSessionId,
					sessionName
				);
				logger.info(
					`Updated sessionName for ${count} history entries with agentSessionId ${agentSessionId}`,
					LOG_CONTEXT
				);
				return count;
			}
		)
	);

	// NEW: Get history file path for AI context integration
	ipcMain.handle(
		'history:getFilePath',
		withIpcErrorLogging(handlerOpts('getFilePath'), async (sessionId: string) => {
			return historyManager.getHistoryFilePath(sessionId);
		})
	);

	// NEW: List sessions with history
	ipcMain.handle(
		'history:listSessions',
		withIpcErrorLogging(handlerOpts('listSessions'), async () => {
			return historyManager.listSessionsWithHistory();
		})
	);
}
