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
import { HistoryEntry, ToolType } from '../../../shared/types';
import { paginateEntries } from '../../../shared/history';
import type { PaginatedResult } from '../../../shared/history';
import { getHistoryManager } from '../../history-manager';
import { getSessionsStore } from '../../stores';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { groomContext } from '../../utils/context-groomer';
import { buildDirectorNotesSynopsisPrompt } from '../../utils/director-notes-prompt';
import {
	parseDirectorNotesNarrative,
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
import type { HistoryGraphData } from './history';

const LOG_CONTEXT = '[DirectorNotes]';

/** Filter accepted by the unified-history IPCs: a single type, an array of
 *  types to include, or null/undefined for "all types". An empty array means
 *  "no types selected" and therefore matches nothing. */
type UnifiedHistoryFilter = 'AUTO' | 'USER' | 'CUE' | Array<'AUTO' | 'USER' | 'CUE'> | null;

/** Whether an entry's type passes the given filter. */
function entryPassesFilter(type: HistoryEntry['type'], filter: UnifiedHistoryFilter): boolean {
	if (filter == null) return true;
	if (Array.isArray(filter)) return filter.includes(type as 'AUTO' | 'USER' | 'CUE');
	return type === filter;
}

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Re-walk session entries to count distinct agents and provider sessions.
 * Cheap (no bucketing) but unavoidable on cache hit because the bucket
 * cache schema only stores per-type counts.
 */
async function countAgentsAndSessions(
	historyManager: ReturnType<typeof getHistoryManager>,
	sessionIds: string[]
): Promise<{ agentCount: number; sessionCount: number }> {
	const agentSet = new Set<string>();
	const providerSessionSet = new Set<string>();
	// Parallel reads - independent files. Falls through to flat() so we can
	// associate each result with its sessionId in the loop below.
	const allEntriesArrays = await Promise.all(
		sessionIds.map((sid) => historyManager.getEntries(sid))
	);
	sessionIds.forEach((sid, i) => {
		const entries = allEntriesArrays[i];
		if (entries.length === 0) return;
		agentSet.add(sid);
		for (const e of entries) {
			if (e.agentSessionId) providerSessionSet.add(e.agentSessionId);
		}
	});
	return { agentCount: agentSet.size, sessionCount: providerSessionSet.size };
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

/** Pre-computed activity graph bucket for a time slice */
export interface GraphBucket {
	auto: number;
	user: number;
	cue: number;
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
	totalCount: number; // Total entries (autoCount + userCount + cueCount)
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

export interface SynopsisResult {
	success: boolean;
	synopsis: string;
	generatedAt?: number; // Unix ms timestamp of when the synopsis was generated
	stats?: SynopsisStats;
	error?: string;
	/**
	 * Parsed structured narrative for Rich Mode. Present only when the raw
	 * `synopsis` parsed cleanly. Plain Mode and copy/save never read this - they
	 * use `synopsis` verbatim.
	 */
	narrative?: DirectorNotesNarrative;
	/**
	 * Set when the raw `synopsis` could NOT be parsed into a structured
	 * narrative. The synopsis call still succeeds (raw output is preserved) so
	 * the renderer can show an overt failure banner while keeping the raw text
	 * reachable. Never a reason to fail the whole call.
	 */
	narrativeError?: string;
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

				// Get all session IDs from history manager
				const sessionIds = await historyManager.listSessionsWithHistory();

				// Resolve Maestro session names (the names shown in the left bar)
				const sessionNameMap = buildSessionNameMap();

				// Collect all entries within time range (unfiltered by type for stats)
				const allEntries: UnifiedHistoryEntry[] = [];
				const agentsWithEntries = new Set<string>(); // track agents that have qualifying entries
				const uniqueAgentSessions = new Set<string>(); // track unique provider sessions
				let autoCount = 0;
				let userCount = 0;
				let cueCount = 0;

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
					graphBuckets = Array.from({ length: bucketCount }, () => ({ auto: 0, user: 0, cue: 0 }));
				}

				for (const sessionId of sessionIds) {
					const entries = await historyManager.getEntries(sessionId);
					const maestroSessionName = sessionNameMap.get(sessionId);

					for (const entry of entries) {
						if (cutoffTime > 0 && entry.timestamp < cutoffTime) continue;

						// Track stats from all entries (before type filter)
						agentsWithEntries.add(sessionId);
						if (entry.type === 'AUTO') autoCount++;
						else if (entry.type === 'USER') userCount++;
						else if (entry.type === 'CUE') cueCount++;
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
							}
						}

						// Apply type filter for the result set
						if (!entryPassesFilter(entry.type, filter ?? null)) continue;

						allEntries.push({
							...entry,
							sourceSessionId: sessionId,
							agentName: maestroSessionName,
						});
					}
				}

				// For "all time" mode, do a second pass to bucket now that we know the earliest timestamp
				if (bucketCount > 0 && cutoffTime === 0) {
					if (earliestTimestamp === Infinity) earliestTimestamp = now - 24 * 60 * 60 * 1000;
					bucketStartTime = earliestTimestamp;
					msPerBucket = (bucketEndTime - bucketStartTime) / bucketCount;
					graphBuckets = Array.from({ length: bucketCount }, () => ({ auto: 0, user: 0, cue: 0 }));

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
					totalCount: autoCount + userCount + cueCount,
				};

				logger.debug(
					`Unified history: ${result.entries.length}/${result.total} entries from ${sessionIds.length} sessions (offset=${result.offset}, hasMore=${result.hasMore})`,
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

				// Stats need session/agent counts that aren't part of the bucket
				// aggregate. Compute them once per cache miss; on hit, derive
				// what we can from the cached aggregate and re-walk only when
				// stats are stale (rare - they invalidate with the buckets).
				const hit = await cache.get(cacheKey, fp);
				if (hit) {
					// agent/session counts aren't in the cache schema - re-walk
					// once. Cheap relative to bucketing.
					const { agentCount, sessionCount } = await countAgentsAndSessions(
						historyManager,
						sessionIds
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
						hostCounts: hit.hostCounts,
						cached: true,
						stats: {
							agentCount,
							sessionCount,
							autoCount: hit.autoCount,
							userCount: hit.userCount,
							cueCount: hit.cueCount,
							totalCount: hit.autoCount + hit.userCount + hit.cueCount,
						},
					};
				}

				const allEntries: HistoryEntry[] = [];
				const agentSet = new Set<string>();
				const providerSessionSet = new Set<string>();
				const sessionEntries = await Promise.all(
					sessionIds.map((sid) => historyManager.getEntries(sid))
				);
				for (let i = 0; i < sessionIds.length; i++) {
					const sid = sessionIds[i];
					const entries = sessionEntries[i];
					if (entries.length === 0) continue;
					agentSet.add(sid);
					for (const e of entries) {
						allEntries.push(e);
						if (e.agentSessionId) providerSessionSet.add(e.agentSessionId);
					}
				}

				const agg = buildBucketAggregate(allEntries, safeBucketCount, { lookbackMs });
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
					hostCounts: agg.hostCounts,
					computedAt: Date.now(),
				});

				return {
					buckets: agg.buckets,
					bucketCount: safeBucketCount,
					earliestTimestamp: agg.earliestTimestamp,
					latestTimestamp: agg.latestTimestamp,
					totalCount: agg.totalCount,
					autoCount: agg.autoCount,
					userCount: agg.userCount,
					cueCount: agg.cueCount,
					hostCounts: agg.hostCounts,
					cached: false,
					stats: {
						agentCount: agentSet.size,
						sessionCount: providerSessionSet.size,
						autoCount: agg.autoCount,
						userCount: agg.userCount,
						cueCount: agg.cueCount,
						totalCount: agg.autoCount + agg.userCount + agg.cueCount,
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
				const sessionIds = await historyManager.listSessionsWithHistory();
				const lookback = options?.lookbackDays ?? 0;
				const filter = options?.filter ?? null;
				const cutoff = lookback > 0 ? Date.now() - lookback * 24 * 60 * 60 * 1000 : 0;

				const all: HistoryEntry[] = [];
				const entriesArrays = await Promise.all(
					sessionIds.map((sid) => historyManager.getEntries(sid))
				);
				for (const entries of entriesArrays) {
					for (const e of entries) {
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

				const sessionIds = await historyManager.listSessionsWithHistory();
				const sessionNameMap = buildSessionNameMap();

				// Parallel reads - independent files.
				const sessionEntries = await Promise.all(
					sessionIds.map((sid) => historyManager.getEntries(sid))
				);

				const windowEntries: HistoryEntry[] = [];
				const agentSet = new Set<string>();
				const providerSessionSet = new Set<string>();
				let autoCount = 0;
				let userCount = 0;
				let cueCount = 0;
				let successCount = 0;
				let failureCount = 0;
				let totalElapsedMs = 0;
				let elapsedSampleCount = 0;
				const perAgentMap = new Map<string, RichAgentStat>();

				for (let i = 0; i < sessionIds.length; i++) {
					const sid = sessionIds[i];
					const entries = sessionEntries[i];
					for (const entry of entries) {
						if (cutoffTime > 0 && entry.timestamp < cutoffTime) continue;

						windowEntries.push(entry);
						agentSet.add(sid);
						if (entry.agentSessionId) providerSessionSet.add(entry.agentSessionId);

						if (entry.type === 'AUTO') autoCount++;
						else if (entry.type === 'USER') userCount++;
						else if (entry.type === 'CUE') cueCount++;

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
								agentName: sessionNameMap.get(sid) ?? sid,
								entryCount: 0,
								successCount: 0,
								failureCount: 0,
							};
							perAgentMap.set(sid, agentStat);
						}
						agentStat.entryCount++;
						if (entry.success === true) agentStat.successCount++;
						else if (entry.success === false) agentStat.failureCount++;
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
				const { prompt, agentCount, entryCount } = await buildDirectorNotesSynopsisPrompt({
					historyManager,
					sessionNameMap: buildSessionNameMap(),
					lookbackDays: options.lookbackDays,
					basePrompt: getPrompt('director-notes'),
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

					// Parse the raw output into the structured narrative for Rich Mode.
					// `synopsis` stays the verbatim raw string (Plain Mode + copy/save
					// depend on that). A parse failure is NOT a synopsis failure: we
					// still return success with the raw text and a populated
					// `narrativeError` so the renderer can show an overt error while
					// keeping the raw output reachable.
					const parsed = parseDirectorNotesNarrative(synopsis);
					if (!parsed.ok) {
						logger.warn('Synopsis narrative parse failed', LOG_CONTEXT, {
							narrativeError: parsed.error,
						});
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
						...(parsed.ok ? { narrative: parsed.narrative } : { narrativeError: parsed.error }),
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
