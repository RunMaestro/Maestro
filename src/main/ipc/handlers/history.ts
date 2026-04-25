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
import { HistoryEntry, SshRemoteConfig } from '../../../shared/types';
import {
	PaginationOptions,
	ORPHANED_SESSION_ID,
	sortEntriesByTimestamp,
} from '../../../shared/history';
import { getHistoryManager } from '../../history-manager';
import {
	writeEntryRemote,
	writeEntryLocal,
	readRemoteEntriesSsh,
	readRemoteEntriesLocal,
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
import { buildBucketAggregate } from '../../utils/history-bucket-builder';

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
					localEntries = historyManager.getEntries(sessionId);
					localEntries.sort((a, b) => b.timestamp - a.timestamp);
				} else if (projectPath) {
					localEntries = historyManager.getEntriesByProjectPath(projectPath);
				} else {
					localEntries = historyManager.getAllEntries();
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

				if (sharedEntries.length === 0) {
					return localEntries;
				}

				// Merge and deduplicate by entry ID, then sort
				const seenIds = new Set(localEntries.map((e) => e.id));
				const merged = [...localEntries];
				for (const entry of sharedEntries) {
					if (!seenIds.has(entry.id)) {
						seenIds.add(entry.id);
						merged.push(entry);
					}
				}

				return sortEntriesByTimestamp(merged);
			}
		)
	);

	// Get history entries with pagination support
	ipcMain.handle(
		'history:getAllPaginated',
		withIpcErrorLogging(
			handlerOpts('getAllPaginated'),
			async (options?: {
				projectPath?: string;
				sessionId?: string;
				pagination?: PaginationOptions;
			}) => {
				const { projectPath, sessionId, pagination } = options || {};

				if (sessionId) {
					// Get paginated entries for specific session
					return historyManager.getEntriesPaginated(sessionId, pagination);
				}

				if (projectPath) {
					// Get paginated entries for sessions in this project
					return historyManager.getEntriesByProjectPathPaginated(projectPath, pagination);
				}

				// Return paginated entries (for global view)
				return historyManager.getAllEntriesPaginated(pagination);
			}
		)
	);

	// Get all-time graph data (buckets + counts) for a single session.
	// Cached on disk keyed by file mtime+size; recomputed on miss.
	// Always covers the *full* session history regardless of any lookback the
	// renderer applies to the entry list.
	ipcMain.handle(
		'history:getGraphData',
		withIpcErrorLogging(
			handlerOpts('getGraphData'),
			async (
				sessionId: string,
				bucketCount: number,
				sharedContext?: SharedHistoryContext
			): Promise<HistoryGraphData> => {
				const safeBucketCount = Math.max(1, bucketCount | 0);
				const filePath = historyManager.getHistoryFilePath(sessionId);
				const hasShared = Boolean(sharedContext?.sshRemoteId && sharedContext?.remoteCwd);

				// Cache only when there is no shared history overlay — shared
				// entries come from arbitrary remote/local files we don't
				// fingerprint. Bypassing the cache keeps the simple path simple.
				if (filePath && !hasShared) {
					const cache = getHistoryBucketCache();
					const cacheKey = `single:${sessionId}:bc=${safeBucketCount}`;
					const fp = fileFingerprint(filePath);
					const hit = cache.get(cacheKey, fp);
					if (hit) {
						return cachedToGraphData(hit, true);
					}

					const entries = historyManager.getEntries(sessionId);
					const agg = buildBucketAggregate(entries, safeBucketCount);
					cache.set({
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
						computedAt: Date.now(),
					});
					return aggregateToGraphData(agg, safeBucketCount, false);
				}

				// Shared-history or missing-file path: compute inline, no cache.
				const entries: HistoryEntry[] = filePath ? historyManager.getEntries(sessionId) : [];
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
				}
				const agg = buildBucketAggregate(entries, safeBucketCount);
				return aggregateToGraphData(agg, safeBucketCount, false);
			}
		)
	);

	// Find the offset of the first entry whose timestamp is <= the given
	// timestamp, in the newest-first sorted order. Used by the activity-graph
	// click handler to jump the paginated list to a specific bucket.
	ipcMain.handle(
		'history:getOffsetForTimestamp',
		withIpcErrorLogging(
			handlerOpts('getOffsetForTimestamp'),
			async (sessionId: string, timestamp: number): Promise<number> => {
				const entries = historyManager.getEntries(sessionId);
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
				historyManager.addEntry(sessionId, entry.projectPath, entry, maxEntries);
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
				// when the source agent is flagged as "remote-controlled" — i.e. its
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

				return true;
			}
		)
	);

	// Clear history entries (all, by project, or by session)
	ipcMain.handle(
		'history:clear',
		withIpcErrorLogging(handlerOpts('clear'), async (projectPath?: string, sessionId?: string) => {
			if (sessionId) {
				historyManager.clearSession(sessionId);
				logger.info(`Cleared history for session: ${sessionId}`, LOG_CONTEXT);
				return true;
			}

			if (projectPath) {
				// Clear all sessions for this project
				historyManager.clearByProjectPath(projectPath);
				logger.info(`Cleared history for project: ${projectPath}`, LOG_CONTEXT);
				return true;
			}

			// Clear all history
			historyManager.clearAll();
			return true;
		})
	);

	// Delete a single history entry by ID
	// If sessionId is provided, search only that session; otherwise search all sessions
	ipcMain.handle(
		'history:delete',
		withIpcErrorLogging(handlerOpts('delete'), async (entryId: string, sessionId?: string) => {
			if (sessionId) {
				const deleted = historyManager.deleteEntry(sessionId, entryId);
				if (deleted) {
					logger.info(`Deleted history entry: ${entryId} from session ${sessionId}`, LOG_CONTEXT);
				} else {
					logger.warn(`History entry not found: ${entryId} in session ${sessionId}`, LOG_CONTEXT);
				}
				return deleted;
			}

			// Search all sessions for the entry (slower, but works for legacy calls without sessionId)
			const sessions = historyManager.listSessionsWithHistory();
			for (const sid of sessions) {
				if (historyManager.deleteEntry(sid, entryId)) {
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
					const updated = historyManager.updateEntry(sessionId, entryId, updates);
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
				const sessions = historyManager.listSessionsWithHistory();
				for (const sid of sessions) {
					if (historyManager.updateEntry(sid, entryId, updates)) {
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
				const count = historyManager.updateSessionNameByClaudeSessionId(
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
