/**
 * Director's Notes IPC Handlers
 *
 * Provides IPC handlers for the Director's Notes feature:
 * - Unified history aggregation across all sessions
 * - AI synopsis generation via batch-mode agent (groomContext)
 *
 * Synopsis generation passes history file paths to the agent rather than
 * embedding data inline, allowing the agent to read files directly and
 * drill into fullResponse details as needed.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { createSafeSend } from '../../utils/safe-send';
import { HistoryEntry, HistoryEntryType, ToolType } from '../../../shared/types';
import { MAX_ENTRIES_PER_SESSION, paginateEntries } from '../../../shared/history';
import type { PaginatedResult, GraphBucket } from '../../../shared/history';
import { getHistoryManager } from '../../history-manager';
import { getSessionsStore, getSettingsStore } from '../../stores';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { groomContext } from '../../utils/context-groomer';
import { buildDirectorNotesSynopsisPrompt } from '../../utils/director-notes-prompt';
import {
	looksLikeStructuredOutput,
	parseDirectorNotesNarrative,
	recoverDirectorNotesNarrative,
	type DirectorNotesNarrative,
} from '../../../shared/directorNotesNarrative';
import { getPrompt } from '../../prompt-manager';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type Store from 'electron-store';
import type { AgentConfigsData } from '../../stores/types';
import {
	getHistoryBucketCache,
	multiFileFingerprint,
	HISTORY_BUCKET_CACHE_VERSION,
} from '../../utils/history-bucket-cache';
import { buildBucketAggregate } from '../../utils/history-bucket-builder';
import {
	collectSharedHistoryEntries,
	hasSharedHistorySources,
	prepareSharedHistoryForSynopsis,
	sharedEntryAgentKey,
	sharedEntryAgentName,
	type SharedHistoryCollection,
} from '../../utils/director-notes-shared-history';
import type { HistoryGraphData } from './history';

/** Corpus with no foreign-host contribution - the all-local case. */
const NO_SHARED_HISTORY: SharedHistoryCollection = { entries: [], hosts: [], scopeCount: 0 };

const LOG_CONTEXT = '[DirectorNotes]';

/** Filter accepted by the unified-history IPCs: a single type, an array of
 *  types to include, or null/undefined for "all types". An empty array means
 *  "no types selected" and therefore matches nothing. */
type UnifiedHistoryFilter = HistoryEntryType | HistoryEntryType[] | null;

/** Whether an entry's type passes the given filter. */
function entryPassesFilter(type: HistoryEntry['type'], filter: UnifiedHistoryFilter): boolean {
	if (filter == null) return true;
	if (Array.isArray(filter)) return filter.includes(type);
	return type === filter;
}

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * One agent's worth of history in the aggregated corpus.
 *
 * Local agents come from `userData/history/`; foreign agents are assembled from
 * the shared JSONL files another Maestro instance mirrored into the project
 * directory. Every Director's Notes surface reads this same shape so the list,
 * the graph, Rich Mode, and the click-to-offset lookup can never disagree about
 * which runs exist.
 */
interface CorpusAgent {
	/** Key reported as `sourceSessionId`. Host-namespaced for foreign agents. */
	sourceSessionId: string;
	/** Left Bar name for local agents; host-qualified label for foreign ones. */
	agentName?: string;
	entries: HistoryEntry[];
	/**
	 * Whether a full file could have been trimmed by per-agent retention.
	 * False for foreign agents: their entries are a merged read across hosts,
	 * so entry count says nothing about any one file hitting the cap.
	 */
	canBeTruncated: boolean;
}

/**
 * Load every agent's history - local store plus foreign-host shared entries.
 *
 * `shared` is passed in rather than fetched here so callers that can prove
 * there is nothing shared (or that must not pay for an SSH round trip) can hand
 * over an empty collection.
 */
async function loadUnifiedCorpus(
	historyManager: ReturnType<typeof getHistoryManager>,
	sessionNameMap: Map<string, string>,
	shared: SharedHistoryCollection
): Promise<CorpusAgent[]> {
	const sessionIds = await historyManager.listSessionsWithHistory();
	// Parallel reads - independent files.
	const sessionEntries = await Promise.all(sessionIds.map((sid) => historyManager.getEntries(sid)));

	const corpus: CorpusAgent[] = sessionIds.map((sid, i) => ({
		sourceSessionId: sid,
		agentName: sessionNameMap.get(sid),
		entries: sessionEntries[i],
		canBeTruncated: true,
	}));

	if (shared.entries.length === 0) return corpus;

	// A run we already hold locally can also appear in a peer's mirror; entry
	// ids are stable across hosts, so they settle it.
	const localIds = new Set<string>();
	for (const entries of sessionEntries) {
		for (const entry of entries) localIds.add(entry.id);
	}

	const foreignByAgent = new Map<string, CorpusAgent>();
	for (const entry of shared.entries) {
		if (localIds.has(entry.id)) continue;
		const key = sharedEntryAgentKey(entry);
		let agent = foreignByAgent.get(key);
		if (!agent) {
			agent = {
				sourceSessionId: key,
				agentName: sharedEntryAgentName(entry),
				entries: [],
				canBeTruncated: false,
			};
			foreignByAgent.set(key, agent);
		}
		agent.entries.push(entry);
	}

	return [...corpus, ...foreignByAgent.values()];
}

/**
 * Count distinct agents and provider sessions across the corpus.
 * Cheap (no bucketing) but unavoidable on a bucket-cache hit, because the
 * cache schema only stores per-type counts.
 */
function countAgentsAndSessions(corpus: CorpusAgent[]): {
	agentCount: number;
	sessionCount: number;
} {
	let agentCount = 0;
	const providerSessionSet = new Set<string>();
	for (const agent of corpus) {
		if (agent.entries.length === 0) continue;
		agentCount++;
		for (const e of agent.entries) {
			if (e.agentSessionId) providerSessionSet.add(e.agentSessionId);
		}
	}
	return { agentCount, sessionCount: providerSessionSet.size };
}

/**
 * Build a map of Maestro session ID -> session name from the sessions store.
 * Used to resolve the display name shown in the left bar for each session.
 */
function buildSessionNameMap(): Map<string, string> {
	const sessionsStore = getSessionsStore();
	const storedSessions = sessionsStore.get('sessions', []);
	const map = new Map<string, string>();
	for (const s of storedSessions) {
		if (s.id && s.name) {
			map.set(s.id, s.name);
		}
	}
	return map;
}

/**
 * Read the conductor's Ideal End State from settings, or '' when unset.
 *
 * Read at generation time rather than passed in from the renderer so the
 * web/CLI synopsis paths - which have no renderer to read settings for them -
 * get the same behavior from the same source.
 */
function getConfiguredIdealEndState(): string {
	const settingsStore = getSettingsStore();
	const dn = (settingsStore.get('directorNotesSettings') ?? {}) as Record<string, unknown>;
	return typeof dn.idealEndState === 'string' ? dn.idealEndState : '';
}

/**
 * Dependencies required for Director's Notes handler registration
 */
export interface DirectorNotesHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	/**
	 * Returns the current main window (or null). Used to route synopsis
	 * progress events through safeSend so web-desktop bridge clients receive
	 * them alongside the desktop renderer.
	 */
	getMainWindow: () => BrowserWindow | null;
}

export interface UnifiedHistoryOptions {
	lookbackDays: number;
	// A single type, an array of types to include, or null for "all".
	// An empty array selects nothing.
	filter?: UnifiedHistoryFilter;
	/** Number of entries to return per page (default: 100) */
	limit?: number;
	/** Number of entries to skip for pagination (default: 0) */
	offset?: number;
	/** Number of buckets for the activity graph (passed from frontend lookback config) */
	graphBucketCount?: number;
}

export interface UnifiedHistoryEntry extends HistoryEntry {
	agentName?: string; // The Maestro session name for display
	sourceSessionId: string; // Which session this entry came from
}

/** Aggregate stats returned alongside unified history (computed from the full unfiltered set) */
export interface UnifiedHistoryStats {
	agentCount: number; // Distinct Maestro agents with history
	sessionCount: number; // Distinct provider sessions across all agents
	autoCount: number; // Total AUTO entries
	userCount: number; // Total USER entries
	cueCount: number; // Total CUE entries
	/**
	 * Total AGENT entries (messages proxied in from another agent). Named
	 * `agentEntryCount`, not `agentCount`, because `agentCount` above already
	 * means "distinct Maestro agents" on this interface.
	 */
	agentEntryCount: number;
	totalCount: number; // Total entries (sum of the four type counts)
}

/** Options for the deterministic Rich Overview stats IPC */
export interface RichOverviewStatsOptions {
	/** Lookback window in days; <= 0 means "all time" (mirrors getUnifiedHistory). */
	lookbackDays: number;
	/** Number of timeline buckets to compute (default 24). */
	bucketCount?: number;
}

/** One activity time-slice in the Rich Overview timeline, with its start time. */
export interface RichTimelineBucket {
	startTime: number;
	auto: number;
	user: number;
	cue: number;
	agent: number;
}

/** Per-agent activity rollup for the Rich Overview, sorted by entryCount desc. */
export interface RichAgentStat {
	sessionId: string;
	agentName: string;
	entryCount: number;
	successCount: number;
	failureCount: number;
}

/**
 * Fully deterministic stats for Director's Notes Rich Mode. Every field is
 * computed in the main process from history entries so the Rich widgets never
 * depend on the AI synopsis for a number. Additive: separate from SynopsisStats
 * and UnifiedHistoryStats, which keep their existing shapes.
 */
export interface RichOverviewStats {
	totalEntries: number;
	agentCount: number; // Distinct Maestro agents with entries in the window
	sessionCount: number; // Distinct provider sessions across all agents
	autoCount: number;
	userCount: number;
	cueCount: number;
	/** Total AGENT entries; `agentCount` above already means "distinct agents". */
	agentEntryCount: number;
	successCount: number; // Entries with success === true
	failureCount: number; // Entries with success === false (missing success is neither)
	successRate: number; // successCount / (successCount + failureCount); 0 when no outcomes
	totalElapsedMs: number; // Summed entry elapsedTimeMs across the window
	avgElapsedMs: number; // totalElapsedMs / entries-with-timing; 0 when none
	timelineBuckets: RichTimelineBucket[];
	perAgent: RichAgentStat[];
	lookbackDays: number;
	generatedAt: number; // Unix ms timestamp of computation
}

export interface SynopsisOptions {
	lookbackDays: number;
	provider: ToolType;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
}

export interface SynopsisStats {
	agentCount: number; // Maestro agents with history in the lookback window
	entryCount: number; // Total history entries in the lookback window
	durationMs: number; // Time taken for AI generation
}

/** Options for the deterministic Rich Overview stats IPC */
export interface RichOverviewStatsOptions {
	/** Lookback window in days; <= 0 means "all time" (mirrors getUnifiedHistory). */
	lookbackDays: number;
	/** Number of timeline buckets to compute (default 24). */
	bucketCount?: number;
}

/** One activity time-slice in the Rich Overview timeline, with its start time. */
export interface RichTimelineBucket {
	startTime: number;
	auto: number;
	user: number;
	cue: number;
	agent: number;
}

/** Per-agent activity rollup for the Rich Overview, sorted by entryCount desc. */
export interface RichAgentStat {
	sessionId: string;
	agentName: string;
	entryCount: number;
	successCount: number;
	failureCount: number;
	/**
	 * True when RETENTION, not the lookback window, is what bounded this count:
	 * the agent's history file sits at `MAX_ENTRIES_PER_SESSION` and its oldest
	 * surviving entry is still inside the window, so older runs were already
	 * evicted and the real total is unknown and larger. Without this, a busy
	 * agent's bar silently pins to the cap and reads as an exact figure - two
	 * agents at wildly different volumes both render "5.0K" and tie for top.
	 */
	truncated: boolean;
}

/**
 * Fully deterministic stats for Director's Notes Rich Mode. Every field is
 * computed in the main process from history entries so the Rich widgets never
 * depend on the AI synopsis for a number. Additive: separate from SynopsisStats
 * and UnifiedHistoryStats, which keep their existing shapes.
 */
export interface RichOverviewStats {
	totalEntries: number;
	agentCount: number; // Distinct Maestro agents with entries in the window
	sessionCount: number; // Distinct provider sessions across all agents
	autoCount: number;
	userCount: number;
	cueCount: number;
	/** Total AGENT entries; `agentCount` above already means "distinct agents". */
	agentEntryCount: number;
	successCount: number; // Entries with success === true
	failureCount: number; // Entries with success === false (missing success is neither)
	successRate: number; // successCount / (successCount + failureCount); 0 when no outcomes
	totalElapsedMs: number; // Summed entry elapsedTimeMs across the window
	avgElapsedMs: number; // totalElapsedMs / entries-with-timing; 0 when none
	timelineBuckets: RichTimelineBucket[];
	perAgent: RichAgentStat[];
	lookbackDays: number;
	generatedAt: number; // Unix ms timestamp of computation
}

export interface SynopsisResult {
	success: boolean;
	synopsis: string;
	generatedAt?: number; // Unix ms timestamp of when the synopsis was generated
	stats?: SynopsisStats;
	error?: string;
	/**
	 * Parsed structured narrative. Rich Mode renders it as section cards and
	 * Plain Mode renders it as markdown prose, so this is what every reading
	 * surface consumes; `synopsis` stays the verbatim raw output. Present on a
	 * clean parse AND on a successful salvage (see `narrativeRecovery`).
	 */
	narrative?: DirectorNotesNarrative;
	/**
	 * Set when the output was JSON-shaped but yielded no usable narrative. The
	 * synopsis call still succeeds (raw output is preserved) so the renderer can
	 * show an overt failure banner while keeping the raw text reachable. Never a
	 * reason to fail the whole call.
	 *
	 * Deliberately unset for prose output: the prompt is a user-editable
	 * setting, so a profile holding a markdown-contract prompt makes the agent
	 * return a report rather than a narrative. That is not a parse failure.
	 */
	narrativeError?: string;
	/**
	 * Set when `narrative` came from a salvage of output the strict parser
	 * rejected (a cut-off response, stray control characters, malformed bullets).
	 * Explains what was recovered so the UI can say so rather than passing a
	 * partial report off as a complete one.
	 */
	narrativeRecovery?: string;
}

/**
 * Register all Director's Notes IPC handlers.
 *
 * These handlers provide:
 * - Unified history aggregation across all sessions
 * - AI synopsis generation via batch-mode agent
 */
export function registerDirectorNotesHandlers(deps: DirectorNotesHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, getMainWindow } = deps;
	const safeSend = createSafeSend(getMainWindow);
	const historyManager = getHistoryManager();

	// Aggregate history from all sessions with pagination support
	ipcMain.handle(
		'director-notes:getUnifiedHistory',
		withIpcErrorLogging(
			handlerOpts('getUnifiedHistory'),
			async (
				options: UnifiedHistoryOptions
			): Promise<
				PaginatedResult<UnifiedHistoryEntry> & {
					stats: UnifiedHistoryStats;
					graphBuckets?: GraphBucket[];
				}
			> => {
				const { lookbackDays, filter, limit, offset, graphBucketCount } = options;
				const now = Date.now();
				// lookbackDays <= 0 means "all time" - no cutoff
				const cutoffTime = lookbackDays > 0 ? now - lookbackDays * 24 * 60 * 60 * 1000 : 0;

				// Local history plus anything a peer Maestro mirrored into the
				// shared project files. Names come from the left bar for local
				// agents, host-qualified for foreign ones.
				const corpus = await loadUnifiedCorpus(
					historyManager,
					buildSessionNameMap(),
					await collectSharedHistoryEntries()
				);

				// Collect all entries within time range (unfiltered by type for stats)
				const allEntries: UnifiedHistoryEntry[] = [];
				const agentsWithEntries = new Set<string>(); // track agents that have qualifying entries
				const uniqueAgentSessions = new Set<string>(); // track unique provider sessions
				let autoCount = 0;
				let userCount = 0;
				let cueCount = 0;
				let agentEntryCount = 0;

				// Pre-compute graph bucketing parameters if requested
				// For "all time" (cutoffTime=0), we do a two-pass: first find earliest, then bucket
				let graphBuckets: GraphBucket[] | undefined;
				let bucketStartTime = cutoffTime > 0 ? cutoffTime : 0;
				const bucketEndTime = now;
				const bucketCount = graphBucketCount || 0;
				let msPerBucket = 0;
				let earliestTimestamp = Infinity;

				if (bucketCount > 0 && cutoffTime > 0) {
					msPerBucket = (bucketEndTime - bucketStartTime) / bucketCount;
					graphBuckets = Array.from({ length: bucketCount }, () => ({
						auto: 0,
						user: 0,
						cue: 0,
						agent: 0,
					}));
				}

				for (const agent of corpus) {
					for (const entry of agent.entries) {
						if (cutoffTime > 0 && entry.timestamp < cutoffTime) continue;

						// Track stats from all entries (before type filter)
						agentsWithEntries.add(agent.sourceSessionId);
						if (entry.type === 'AUTO') autoCount++;
						else if (entry.type === 'USER') userCount++;
						else if (entry.type === 'CUE') cueCount++;
						else if (entry.type === 'AGENT') agentEntryCount++;
						if (entry.agentSessionId) uniqueAgentSessions.add(entry.agentSessionId);

						// Track earliest for "all time" bucketing
						if (bucketCount > 0 && cutoffTime === 0 && entry.timestamp < earliestTimestamp) {
							earliestTimestamp = entry.timestamp;
						}

						// Bucket for graph (fixed-window mode, not "all time")
						if (graphBuckets && msPerBucket > 0) {
							const idx = Math.min(
								bucketCount - 1,
								Math.floor((entry.timestamp - bucketStartTime) / msPerBucket)
							);
							if (idx >= 0 && idx < bucketCount) {
								if (entry.type === 'AUTO') graphBuckets[idx].auto++;
								else if (entry.type === 'USER') graphBuckets[idx].user++;
								else if (entry.type === 'CUE') graphBuckets[idx].cue++;
								else if (entry.type === 'AGENT') graphBuckets[idx].agent++;
							}
						}

						// Apply type filter for the result set
						if (!entryPassesFilter(entry.type, filter ?? null)) continue;

						allEntries.push({
							...entry,
							sourceSessionId: agent.sourceSessionId,
							agentName: agent.agentName,
						});
					}
				}

				// For "all time" mode, do a second pass to bucket now that we know the earliest timestamp
				if (bucketCount > 0 && cutoffTime === 0) {
					if (earliestTimestamp === Infinity) earliestTimestamp = now - 24 * 60 * 60 * 1000;
					bucketStartTime = earliestTimestamp;
					msPerBucket = (bucketEndTime - bucketStartTime) / bucketCount;
					graphBuckets = Array.from({ length: bucketCount }, () => ({
						auto: 0,
						user: 0,
						cue: 0,
						agent: 0,
					}));

					if (msPerBucket > 0) {
						for (const entry of allEntries) {
							const idx = Math.min(
								bucketCount - 1,
								Math.floor((entry.timestamp - bucketStartTime) / msPerBucket)
							);
							if (idx >= 0 && idx < bucketCount) {
								if (entry.type === 'AUTO') graphBuckets[idx].auto++;
								else if (entry.type === 'USER') graphBuckets[idx].user++;
								else if (entry.type === 'CUE') graphBuckets[idx].cue++;
								else if (entry.type === 'AGENT') graphBuckets[idx].agent++;
							}
						}
					}
				}

				// Sort by timestamp (newest first)
				allEntries.sort((a, b) => b.timestamp - a.timestamp);

				// Apply pagination
				const result = paginateEntries(allEntries, { limit, offset });

				// Build stats from unfiltered data
				const stats: UnifiedHistoryStats = {
					agentCount: agentsWithEntries.size,
					sessionCount: uniqueAgentSessions.size,
					autoCount,
					userCount,
					cueCount,
					agentEntryCount,
					totalCount: autoCount + userCount + cueCount + agentEntryCount,
				};

				logger.debug(
					`Unified history: ${result.entries.length}/${result.total} entries from ${corpus.length} sessions (offset=${result.offset}, hasMore=${result.hasMore})`,
					LOG_CONTEXT
				);

				return { ...result, stats, graphBuckets };
			}
		)
	);

	// Graph data aggregated across every session with history. Cached on
	// disk keyed by (bucketCount, lookbackHours, composite mtime+size of
	// all source files). Each lookback window the user picks gets its own
	// cached aggregate; any source-file change invalidates them all.
	ipcMain.handle(
		'director-notes:getGraphData',
		withIpcErrorLogging(
			handlerOpts('getGraphData'),
			async (
				bucketCount: number,
				lookbackHours: number | null
			): Promise<HistoryGraphData & { stats: UnifiedHistoryStats }> => {
				const safeBucketCount = Math.max(1, bucketCount | 0);
				const lookbackMs =
					lookbackHours !== null && lookbackHours > 0 ? lookbackHours * 60 * 60 * 1000 : null;
				const sessionIds = await historyManager.listSessionsWithHistory();
				const filePathsRaw = await Promise.all(
					sessionIds.map((sid) => historyManager.getHistoryFilePath(sid))
				);
				const filePaths = filePathsRaw.filter((p): p is string => Boolean(p));

				const cache = getHistoryBucketCache();
				const lookbackKey = lookbackHours === null ? 'all' : String(lookbackHours);
				const cacheKey = `unified:bc=${safeBucketCount}:lb=${lookbackKey}`;
				const fp = multiFileFingerprint(filePaths);

				// The fingerprint covers LOCAL history files only, so a cached
				// aggregate cannot see foreign-host entries. Skip the cache
				// whenever shared history could contribute - the probe is a
				// directory listing, not a network call, so an all-local setup
				// still takes the cached path. Mirrors `history:getGraphData`.
				const mayHaveSharedHistory = hasSharedHistorySources();

				// Stats need session/agent counts that aren't part of the bucket
				// aggregate. Compute them once per cache miss; on hit, derive
				// what we can from the cached aggregate and re-walk only when
				// stats are stale (rare - they invalidate with the buckets).
				const hit = mayHaveSharedHistory ? null : await cache.get(cacheKey, fp);
				if (hit) {
					// agent/session counts aren't in the cache schema - re-walk
					// once. Cheap relative to bucketing.
					const { agentCount, sessionCount } = countAgentsAndSessions(
						await loadUnifiedCorpus(historyManager, buildSessionNameMap(), NO_SHARED_HISTORY)
					);
					return {
						buckets: hit.buckets,
						bucketCount: hit.bucketCount,
						earliestTimestamp: hit.earliestTimestamp,
						latestTimestamp: hit.latestTimestamp,
						totalCount: hit.totalCount,
						autoCount: hit.autoCount,
						userCount: hit.userCount,
						cueCount: hit.cueCount,
						agentCount: hit.agentCount,
						hostCounts: hit.hostCounts,
						cached: true,
						stats: {
							agentCount,
							sessionCount,
							autoCount: hit.autoCount,
							userCount: hit.userCount,
							cueCount: hit.cueCount,
							agentEntryCount: hit.agentCount,
							totalCount: hit.autoCount + hit.userCount + hit.cueCount + hit.agentCount,
						},
					};
				}

				const corpus = await loadUnifiedCorpus(
					historyManager,
					buildSessionNameMap(),
					mayHaveSharedHistory ? await collectSharedHistoryEntries() : NO_SHARED_HISTORY
				);
				const allEntries = corpus.flatMap((agent) => agent.entries);
				const { agentCount, sessionCount } = countAgentsAndSessions(corpus);

				const agg = buildBucketAggregate(allEntries, safeBucketCount, { lookbackMs });
				// Fire-and-forget the disk write - the renderer doesn't need to
				// wait for it; the in-memory cache layer was already updated.
				// Skipped when shared history is in play: the fingerprint would
				// claim local files alone produced this aggregate, poisoning the
				// cache for the next all-local read.
				if (!mayHaveSharedHistory) {
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
				}

				return {
					buckets: agg.buckets,
					bucketCount: safeBucketCount,
					earliestTimestamp: agg.earliestTimestamp,
					latestTimestamp: agg.latestTimestamp,
					totalCount: agg.totalCount,
					autoCount: agg.autoCount,
					userCount: agg.userCount,
					cueCount: agg.cueCount,
					agentCount: agg.agentCount,
					hostCounts: agg.hostCounts,
					cached: false,
					stats: {
						agentCount,
						sessionCount,
						autoCount: agg.autoCount,
						userCount: agg.userCount,
						cueCount: agg.cueCount,
						agentEntryCount: agg.agentCount,
						totalCount: agg.autoCount + agg.userCount + agg.cueCount + agg.agentCount,
					},
				};
			}
		)
	);

	// Find the offset (in newest-first sorted order) of the first unified
	// entry whose timestamp is <= the given timestamp. Used by the activity
	// graph's click handler to jump the paginated list to a bucket the user
	// hasn't scrolled into yet.
	ipcMain.handle(
		'director-notes:getOffsetForTimestamp',
		withIpcErrorLogging(
			handlerOpts('getOffsetForTimestamp'),
			async (
				timestamp: number,
				options?: { lookbackDays?: number; filter?: UnifiedHistoryFilter }
			): Promise<number> => {
				const lookback = options?.lookbackDays ?? 0;
				const filter = options?.filter ?? null;
				const cutoff = lookback > 0 ? Date.now() - lookback * 24 * 60 * 60 * 1000 : 0;

				// Must aggregate exactly what `getUnifiedHistory` does, shared
				// entries included - this offset indexes into that list, so a
				// narrower corpus here scrolls the user to the wrong row.
				const corpus = await loadUnifiedCorpus(
					historyManager,
					buildSessionNameMap(),
					await collectSharedHistoryEntries()
				);

				const all: HistoryEntry[] = [];
				for (const agent of corpus) {
					for (const e of agent.entries) {
						if (cutoff > 0 && e.timestamp < cutoff) continue;
						if (!entryPassesFilter(e.type, filter)) continue;
						all.push(e);
					}
				}
				all.sort((a, b) => b.timestamp - a.timestamp);

				let offset = 0;
				for (const entry of all) {
					if (entry.timestamp <= timestamp) return offset;
					offset++;
				}
				return Math.max(0, all.length - 1);
			}
		)
	);

	// Deterministic Rich Mode stats: every number the Rich widgets render is
	// computed here over the raw history entries, never inferred by the AI
	// synopsis. Mirrors getUnifiedHistory's lookback cutoff and reuses
	// buildBucketAggregate for the timeline so there is a single bucketer.
	ipcMain.handle(
		'director-notes:getRichOverviewStats',
		withIpcErrorLogging(
			handlerOpts('getRichOverviewStats'),
			async (options: RichOverviewStatsOptions): Promise<RichOverviewStats> => {
				const { lookbackDays } = options;
				const bucketCount = Math.max(1, (options.bucketCount ?? 24) | 0);
				const now = Date.now();
				// lookbackDays <= 0 means "all time" - no cutoff (matches getUnifiedHistory).
				const cutoffTime = lookbackDays > 0 ? now - lookbackDays * 24 * 60 * 60 * 1000 : 0;
				const lookbackMs = lookbackDays > 0 ? lookbackDays * 24 * 60 * 60 * 1000 : null;

				const corpus = await loadUnifiedCorpus(
					historyManager,
					buildSessionNameMap(),
					await collectSharedHistoryEntries()
				);

				const windowEntries: HistoryEntry[] = [];
				const agentSet = new Set<string>();
				const providerSessionSet = new Set<string>();
				let autoCount = 0;
				let userCount = 0;
				let cueCount = 0;
				let agentEntryCount = 0;
				let successCount = 0;
				let failureCount = 0;
				let totalElapsedMs = 0;
				let elapsedSampleCount = 0;
				const perAgentMap = new Map<string, RichAgentStat>();

				for (const agent of corpus) {
					const sid = agent.sourceSessionId;
					const entries = agent.entries;
					for (const entry of entries) {
						if (cutoffTime > 0 && entry.timestamp < cutoffTime) continue;

						windowEntries.push(entry);
						agentSet.add(sid);
						if (entry.agentSessionId) providerSessionSet.add(entry.agentSessionId);

						if (entry.type === 'AUTO') autoCount++;
						else if (entry.type === 'USER') userCount++;
						else if (entry.type === 'CUE') cueCount++;
						else if (entry.type === 'AGENT') agentEntryCount++;

						// Only explicit booleans count; a missing success is neither.
						if (entry.success === true) successCount++;
						else if (entry.success === false) failureCount++;

						if (typeof entry.elapsedTimeMs === 'number') {
							totalElapsedMs += entry.elapsedTimeMs;
							elapsedSampleCount++;
						}

						let agentStat = perAgentMap.get(sid);
						if (!agentStat) {
							agentStat = {
								sessionId: sid,
								agentName: agent.agentName ?? sid,
								entryCount: 0,
								successCount: 0,
								failureCount: 0,
								truncated: false,
							};
							perAgentMap.set(sid, agentStat);
						}
						agentStat.entryCount++;
						if (entry.success === true) agentStat.successCount++;
						else if (entry.success === false) agentStat.failureCount++;
					}

					// Retention already evicted this agent's older runs if the file is
					// full AND its oldest survivor is still inside the window - nothing
					// was dropped by the cutoff, so the cap is what bounded the count.
					// A file at the cap whose tail predates the window is fine: the
					// window did the trimming and the number is exact.
					const agentStat = agent.canBeTruncated ? perAgentMap.get(sid) : undefined;
					if (agentStat && entries.length >= MAX_ENTRIES_PER_SESSION) {
						const oldest = entries.reduce(
							(min, e) => Math.min(min, e.timestamp),
							Number.POSITIVE_INFINITY
						);
						if (oldest >= cutoffTime) agentStat.truncated = true;
					}
				}

				// Reuse the shared bucketer for the timeline; derive each bucket's
				// startTime from the aggregate window endpoints. With lookbackMs set,
				// the window is [now - lookbackMs, now]; for "all time" it spans the
				// entries' [earliest, latest].
				const agg = buildBucketAggregate(windowEntries, bucketCount, {
					lookbackMs,
					endTime: now,
				});
				const bucketSpan = (agg.latestTimestamp - agg.earliestTimestamp) / bucketCount;
				const timelineBuckets: RichTimelineBucket[] = agg.buckets.map((b, i) => ({
					startTime: Math.round(agg.earliestTimestamp + i * bucketSpan),
					auto: b.auto,
					user: b.user,
					cue: b.cue,
					agent: b.agent,
				}));

				const perAgent = Array.from(perAgentMap.values()).sort(
					(a, b) => b.entryCount - a.entryCount
				);

				const outcomeTotal = successCount + failureCount;
				const successRate = outcomeTotal > 0 ? successCount / outcomeTotal : 0;
				const avgElapsedMs = elapsedSampleCount > 0 ? totalElapsedMs / elapsedSampleCount : 0;

				logger.debug(
					`Rich overview stats: ${windowEntries.length} entries across ${agentSet.size} agents (lookback=${lookbackDays}d)`,
					LOG_CONTEXT
				);

				return {
					totalEntries: windowEntries.length,
					agentCount: agentSet.size,
					sessionCount: providerSessionSet.size,
					autoCount,
					userCount,
					cueCount,
					agentEntryCount,
					successCount,
					failureCount,
					successRate,
					totalElapsedMs,
					avgElapsedMs,
					timelineBuckets,
					perAgent,
					lookbackDays,
					generatedAt: now,
				};
			}
		)
	);

	// Generate AI synopsis via batch-mode agent
	ipcMain.handle(
		'director-notes:generateSynopsis',
		withIpcErrorLogging(
			handlerOpts('generateSynopsis'),
			async (options: SynopsisOptions): Promise<SynopsisResult> => {
				logger.info(
					`Synopsis generation requested for ${options.lookbackDays} days via ${options.provider}`,
					LOG_CONTEXT
				);

				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				// Verify the requested agent is available
				const agent = await agentDetector.getAgent(options.provider);
				if (!agent || !agent.available) {
					return {
						success: false,
						synopsis: '',
						error: `Agent "${options.provider}" is not available. Please install it or select a different provider in Settings > Director's Notes.`,
					};
				}

				// Build the synopsis prompt: a manifest of history file paths scoped
				// to the lookback window so the agent only reads files it needs.
				const cutoffTime =
					options.lookbackDays > 0 ? Date.now() - options.lookbackDays * 24 * 60 * 60 * 1000 : 0;
				const { prompt, agentCount, entryCount } = await buildDirectorNotesSynopsisPrompt({
					historyManager,
					sessionNameMap: buildSessionNameMap(),
					lookbackDays: options.lookbackDays,
					basePrompt: getPrompt('director-notes'),
					idealEndState: getConfiguredIdealEndState(),
					sharedHistoryFile: await prepareSharedHistoryForSynopsis(cutoffTime),
				});

				if (!prompt) {
					return {
						success: true,
						synopsis: `# Director's Notes\n\n*Generated for the past ${options.lookbackDays} days*\n\nNo history files found.`,
						generatedAt: Date.now(),
						stats: { agentCount: 0, entryCount: 0, durationMs: 0 },
					};
				}

				logger.info(`Generating synopsis from ${agentCount} session files`, LOG_CONTEXT, {
					promptLength: prompt.length,
					sessionCount: agentCount,
				});

				try {
					// Look up agent-level config values for override resolution
					const allConfigs = agentConfigsStore.get('configs', {});
					const dnAgentConfigValues = allConfigs[options.provider] || {};

					// Send progress updates to the renderer and web-desktop bridge clients
					const sendProgress = (update: {
						chunkCount: number;
						bytesReceived: number;
						elapsedMs: number;
					}) => {
						safeSend('director-notes:synopsisProgress', update);
					};

					const result = await groomContext(
						{
							projectRoot: process.cwd(),
							agentType: options.provider,
							prompt,
							readOnlyMode: true,
							sessionCustomPath: options.customPath,
							sessionCustomArgs: options.customArgs,
							sessionCustomEnvVars: options.customEnvVars,
							agentConfigValues: dnAgentConfigValues,
							onProgress: sendProgress,
						},
						processManager,
						agentDetector
					);

					const synopsis = result.response.trim();
					if (!synopsis) {
						return {
							success: false,
							synopsis: '',
							error: 'Agent returned an empty response. Try again or use a different provider.',
						};
					}

					logger.info('Synopsis generation complete', LOG_CONTEXT, {
						responseLength: synopsis.length,
						durationMs: result.durationMs,
						completionReason: result.completionReason,
					});

					// Parse the raw output into the structured narrative every reading
					// surface renders. `synopsis` stays the verbatim raw string.
					//
					// Shape decides what a failed parse MEANS. The Director's Notes prompt
					// is a user-editable setting persisted to userData, so a profile can
					// hold a prompt written against the markdown contract while this build
					// expects JSON. Prose is not a broken narrative - the agent obeyed the
					// prompt it was given - so it ships with neither field and the reading
					// surfaces render it as markdown. Only JSON-shaped output that yields
					// nothing usable is reported as an error, and even then a best-effort
					// salvage runs first: a run costs minutes, so a cut-off response should
					// still be readable.
					const parsed = parseDirectorNotesNarrative(synopsis);
					let narrativeFields: Partial<SynopsisResult>;
					if (parsed.ok) {
						narrativeFields = { narrative: parsed.narrative };
					} else if (!looksLikeStructuredOutput(synopsis)) {
						// Not a broken narrative - prose. See the shape note above.
						logger.info('Synopsis is prose, not a structured narrative', LOG_CONTEXT, {
							responseLength: synopsis.length,
						});
						narrativeFields = {};
					} else {
						const recovered = recoverDirectorNotesNarrative(synopsis);
						logger.warn('Synopsis narrative parse failed', LOG_CONTEXT, {
							narrativeError: parsed.error,
							recovered: recovered.ok,
							lossless: recovered.ok ? recovered.lossless : undefined,
							recoveryReason: recovered.ok ? recovered.reason : undefined,
						});
						// A lossless repair (an agent that stopped one brace short of
						// finishing, a stray line break inside a string) produced the whole
						// report. Shipping the error fields anyway put a red banner over a
						// complete document and told the user it might be missing parts.
						if (recovered.ok && recovered.lossless) {
							narrativeFields = { narrative: recovered.narrative };
						} else if (recovered.ok) {
							narrativeFields = {
								narrative: recovered.narrative,
								narrativeError: parsed.error,
								narrativeRecovery: recovered.reason,
							};
						} else {
							narrativeFields = { narrativeError: parsed.error };
						}
					}

					return {
						success: true,
						synopsis,
						generatedAt: Date.now(),
						stats: {
							agentCount,
							entryCount,
							durationMs: result.durationMs,
						},
						...narrativeFields,
					};
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					logger.error('Synopsis generation failed', LOG_CONTEXT, { error: errorMsg });
					return {
						success: false,
						synopsis: '',
						error: `Synopsis generation failed: ${errorMsg}`,
					};
				}
			}
		)
	);
}
