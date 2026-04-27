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
	paginateEntries,
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

	// Get history entries with pagination support.
	//
	// Accepts an optional `lookbackHours` to filter entries to the last N
	// hours before pagination — keeps page boundaries meaningful when the
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
			}) => {
				const { projectPath, sessionId, pagination, lookbackHours, sharedContext } = options || {};
				const cutoffTime =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: 0;

				const applyLookback = (entries: HistoryEntry[]): HistoryEntry[] =>
					cutoffTime > 0 ? entries.filter((e) => e.timestamp >= cutoffTime) : entries;

				// Single-session path: optionally merge shared (SSH or local
				// project-mirrored) entries before applying lookback + pagination.
				if (sessionId) {
					let local = historyManager.getEntries(sessionId);
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

						if (sharedEntries.length > 0) {
							const seen = new Set(local.map((e) => e.id));
							for (const e of sharedEntries) {
								if (!seen.has(e.id)) {
									local.push(e);
									seen.add(e.id);
								}
							}
							local = sortEntriesByTimestamp(local);
						}
					}

					return paginateEntries(applyLookback(local), pagination);
				}

				if (projectPath) {
					const entries = historyManager.getEntriesByProjectPathPaginated(
						projectPath,
						undefined
					).entries;
					return paginateEntries(applyLookback(entries), pagination);
				}

				const entries = historyManager.getAllEntriesPaginated(undefined).entries;
				return paginateEntries(applyLookback(entries), pagination);
			}
		)
	);

	// Get graph data (buckets + counts) for a single session.
	// Cached on disk keyed by (sessionId, bucketCount, lookbackHours,
	// file mtime+size). The lookback is part of the cache key so each
	// window the user picks gets its own cached aggregate; mtime
	// invalidates them all at once when the file changes.
	ipcMain.handle(
		'history:getGraphData',
		withIpcErrorLogging(
			handlerOpts('getGraphData'),
			async (
				sessionId: string,
				bucketCount: number,
				lookbackHours: number | null,
				sharedContext?: SharedHistoryContext
			): Promise<HistoryGraphData> => {
				const safeBucketCount = Math.max(1, bucketCount | 0);
				const lookbackMs =
					lookbackHours !== null && lookbackHours > 0 ? lookbackHours * 60 * 60 * 1000 : null;
				const filePath = historyManager.getHistoryFilePath(sessionId);
				const hasShared = Boolean(sharedContext?.sshRemoteId && sharedContext?.remoteCwd);

				// Cache only when there is no shared history overlay — shared
				// entries come from arbitrary remote/local files we don't
				// fingerprint. Bypassing the cache keeps the simple path simple.
				if (filePath && !hasShared) {
					const cache = getHistoryBucketCache();
					const lookbackKey = lookbackHours === null ? 'all' : String(lookbackHours);
					const cacheKey = `single:${sessionId}:bc=${safeBucketCount}:lb=${lookbackKey}`;
					const fp = fileFingerprint(filePath);
					const hit = cache.get(cacheKey, fp);
					if (hit) {
						return cachedToGraphData(hit, true);
					}

					const entries = historyManager.getEntries(sessionId);
					const agg = buildBucketAggregate(entries, safeBucketCount, { lookbackMs });
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
				const agg = buildBucketAggregate(entries, safeBucketCount, { lookbackMs });
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
				lookbackHours?: number | null
			): Promise<number> => {
				const cutoffTime =
					lookbackHours !== null && lookbackHours !== undefined && lookbackHours > 0
						? Date.now() - lookbackHours * 60 * 60 * 1000
						: 0;
				let entries = historyManager.getEntries(sessionId);
				if (cutoffTime > 0) entries = entries.filter((e) => e.timestamp >= cutoffTime);
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
