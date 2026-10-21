/**
 * Claude Session IPC Handlers
 *
 * This module handles IPC calls for Claude Code session management:
 * - List sessions (regular and paginated)
 * - Read session messages
 * - Delete message pairs
 * - Search sessions
 * - Get project and global stats
 * - Session timestamps for activity graphs
 * - Session origins tracking (Maestro vs CLI)
 * - Get available slash commands
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, BrowserWindow } from 'electron';
import type { ClaudeSessionOrigin, ClaudeSessionOriginsData } from '../../stores/types';
import { setClaudeSessionOrigin } from '../../storage/claude-session-origins';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { createSafeSend } from '../../utils/safe-send';
import { CLAUDE_SESSION_PARSE_LIMITS } from '../../constants';
import { calculateModelCost } from '../../utils/pricing';
import { computeClaudeSessionUsage } from '../../../shared/claudeSessionUsage';
import {
	accumulateUpgradeBaseline,
	encodeClaudeProjectPath,
	finishDerivationUpgrade,
	isDerivationStale,
	loadStatsCache,
	saveStatsCache,
	statsCacheScope,
	type DerivationUpgrade,
	type PerProjectSessionStats,
	type ProjectTokenSplit,
	SessionStatsCache,
	STATS_CACHE_VERSION,
} from '../../utils/statsCache';
import { createCacheCheckpointer } from '../../utils/cache-checkpointer';
import { mapWithConcurrency, LOCAL_SESSION_PARSE_CONCURRENCY } from '../../utils/concurrency';
import { runTranscriptParse } from '../../transcript-parse/transcript-parse-pool';
import { extractClaudeTextFromContent } from '../../transcript-parse/transcript-parse-tasks';
import { withStatsIndexing } from '../../stats/stats-indexing';
import { app } from 'electron';
import { captureException } from '../../utils/sentry';
import { isExpectedSessionReadError } from '../../utils/session-read-errors';
import {
	snapshotStarredTranscript,
	releaseTranscriptMirror,
} from '../../storage/starred-transcript-mirror';
import { countClaudeTranscriptMessages } from '../../../shared/claudeTranscriptMessages';
import { resolveAgentAccountDir } from '../../agents/provider-account-dirs';

/**
 * Legacy global stats cache structure for deprecated claude:getGlobalStats handler.
 * NOTE: This is kept for backwards compatibility. New code should use agentSessions:getGlobalStats.
 */
interface LegacyGlobalStatsCache {
	sessions: Record<
		string,
		{
			messages: number;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheCreationTokens: number;
			sizeBytes: number;
			fileMtimeMs: number;
			/** Per-model cost (USD) at parse time; absent for pre-existing cache entries. */
			costUsd?: number;
		}
	>;
	totals: {
		totalSessions: number;
		totalMessages: number;
		totalInputTokens: number;
		totalOutputTokens: number;
		totalCacheReadTokens: number;
		totalCacheCreationTokens: number;
		totalCostUsd: number;
		totalSizeBytes: number;
	};
	lastUpdated: number;
	version: number;
}

// v2: Claude usage counted once per API response, not once per JSONL line.
// v3: subagent transcripts priced into their parent session.
// v4: messages counted as prompts and responses, not transcript lines.
const LEGACY_GLOBAL_STATS_CACHE_VERSION = 4;

function getLegacyGlobalStatsCachePath(): string {
	return path.join(app.getPath('userData'), 'stats-cache', 'legacy-global-stats.json');
}

async function loadLegacyGlobalStatsCache(): Promise<LegacyGlobalStatsCache | null> {
	try {
		const cachePath = getLegacyGlobalStatsCachePath();
		const content = await fs.readFile(cachePath, 'utf-8');
		const cache = JSON.parse(content) as LegacyGlobalStatsCache;
		if (cache.version !== LEGACY_GLOBAL_STATS_CACHE_VERSION) {
			return null;
		}
		return cache;
	} catch {
		return null;
	}
}

async function saveLegacyGlobalStatsCache(cache: LegacyGlobalStatsCache): Promise<void> {
	try {
		const cachePath = getLegacyGlobalStatsCachePath();
		const cacheDir = path.dirname(cachePath);
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(cache), 'utf-8');
	} catch (error) {
		void captureException(error);
		logger.warn('Failed to save legacy global stats cache', LOG_CONTEXT, { error });
	}
}

const LOG_CONTEXT = '[ClaudeSessions]';
const ORIGINS_LOG_CONTEXT = '[ClaudeSessionOrigins]';
const COMMANDS_LOG_CONTEXT = '[ClaudeCommands]';

/**
 * Helper function to create consistent handler options
 */
function handlerOpts(operation: string, context: string = LOG_CONTEXT) {
	return { context, operation, logSuccess: false };
}

// ClaudeSessionOriginInfo and ClaudeSessionOriginsData imported from stores/types

/**
 * Dependencies required for Claude handlers
 */
export interface ClaudeHandlerDependencies {
	claudeSessionOriginsStore: Store<ClaudeSessionOriginsData>;
	getMainWindow: () => BrowserWindow | null;
}

/**
 * Per-project fields a derivation upgrade rescales on archived sessions, whose
 * transcripts are gone and cannot be re-parsed.
 */
const PROJECT_STATS_UPGRADE_FIELDS = ['costUsd', 'tokens', 'messages'] as const;

/** Minimum gap between streamed project-stats updates while a scan runs. */
const PROJECT_STATS_UPDATE_INTERVAL_MS = 250;

/**
 * Register all Claude-related IPC handlers.
 */
export function registerClaudeHandlers(deps: ClaudeHandlerDependencies): void {
	const { claudeSessionOriginsStore, getMainWindow } = deps;
	const safeSend = createSafeSend(getMainWindow);
	// In-flight `claude:getProjectStats` scans, by transcript folder.
	const projectStatsScans = new Map<string, Promise<Record<string, unknown>>>();

	// ============ List Sessions ============

	ipcMain.handle(
		'claude:listSessions',
		withIpcErrorLogging(handlerOpts('listSessions'), async (projectPath: string) => {
			const homeDir = os.homedir();
			const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

			const encodedPath = encodeClaudeProjectPath(projectPath);
			const projectDir = path.join(claudeProjectsDir, encodedPath);

			logger.info(
				`Claude sessions lookup - projectPath: ${projectPath}, encodedPath: ${encodedPath}, projectDir: ${projectDir}`,
				LOG_CONTEXT
			);

			// Check if the directory exists
			try {
				await fs.access(projectDir);
				logger.info(`Claude sessions directory exists: ${projectDir}`, LOG_CONTEXT);
			} catch (err) {
				// Expected first-run state: project has no Claude history yet.
				// Don't send to Sentry - the other fs.access catches in this file also omit it.
				logger.info(
					`No Claude sessions directory found for project: ${projectPath} (tried: ${projectDir}), error: ${err}`,
					LOG_CONTEXT
				);
				return [];
			}

			// List all .jsonl files in the directory
			const files = await fs.readdir(projectDir);
			const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));
			logger.info(
				`Found ${files.length} files, ${sessionFiles.length} .jsonl sessions`,
				LOG_CONTEXT
			);

			// Get metadata for each session
			const sessions = await Promise.all(
				sessionFiles.map(async (filename) => {
					const sessionId = filename.replace('.jsonl', '');
					const filePath = path.join(projectDir, filename);

					try {
						const stats = await fs.stat(filePath);
						const content = await fs.readFile(filePath, 'utf-8');
						const lines = content.split('\n').filter((l) => l.trim());

						let firstUserMessage = '';
						let timestamp = stats.mtime.toISOString();

						const messageCount = countClaudeTranscriptMessages(content);

						// Extract first meaningful message content
						for (
							let i = 0;
							i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES);
							i++
						) {
							try {
								const entry = JSON.parse(lines[i]);
								if (entry.type === 'user' && entry.message?.content) {
									const textContent = extractClaudeTextFromContent(entry.message.content);
									if (textContent.trim()) {
										firstUserMessage = textContent;
										timestamp = entry.timestamp || timestamp;
										break;
									}
								}
								if (!firstUserMessage && entry.type === 'assistant' && entry.message?.content) {
									const textContent = extractClaudeTextFromContent(entry.message.content);
									if (textContent.trim()) {
										firstUserMessage = textContent;
										timestamp = entry.timestamp || timestamp;
									}
								}
							} catch {
								// Skip malformed lines
							}
						}

						// Per-model token + cost extraction (a session may mix models).
						const {
							inputTokens: totalInputTokens,
							outputTokens: totalOutputTokens,
							cacheReadTokens: totalCacheReadTokens,
							cacheCreationTokens: totalCacheCreationTokens,
							costUsd,
						} = await computeClaudeSessionUsage(filePath, content);

						// Extract last timestamp for duration
						let lastTimestamp = timestamp;
						for (
							let i = lines.length - 1;
							i >=
							Math.max(0, lines.length - CLAUDE_SESSION_PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES);
							i--
						) {
							try {
								const entry = JSON.parse(lines[i]);
								if (entry.timestamp) {
									lastTimestamp = entry.timestamp;
									break;
								}
							} catch {
								// Skip malformed lines
							}
						}

						const startTime = new Date(timestamp).getTime();
						const endTime = new Date(lastTimestamp).getTime();
						const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

						return {
							sessionId,
							projectPath,
							timestamp,
							modifiedAt: stats.mtime.toISOString(),
							firstMessage: firstUserMessage.slice(
								0,
								CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH
							),
							messageCount,
							sizeBytes: stats.size,
							costUsd,
							inputTokens: totalInputTokens,
							outputTokens: totalOutputTokens,
							cacheReadTokens: totalCacheReadTokens,
							cacheCreationTokens: totalCacheCreationTokens,
							durationSeconds,
						};
					} catch (error) {
						void captureException(error);
						logger.error(`Error reading session file: ${filename}`, LOG_CONTEXT, error);
						return null;
					}
				})
			);

			// Filter out nulls, 0-byte sessions, and sort by modified date
			const validSessions = sessions
				.filter((s): s is NonNullable<typeof s> => s !== null)
				// Filter out 0-byte sessions (created but abandoned before any content was written)
				.filter((s) => s.sizeBytes > 0)
				.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

			// Get Maestro session origins
			const origins = claudeSessionOriginsStore.get('origins', {});
			const projectOrigins = origins[projectPath] || {};

			// Add origin info to each session
			const sessionsWithOrigins = validSessions.map((session) => {
				const originData = projectOrigins[session.sessionId];
				const origin = typeof originData === 'string' ? originData : originData?.origin;
				const sessionName = typeof originData === 'object' ? originData?.sessionName : undefined;
				return {
					...session,
					origin: origin as ClaudeSessionOrigin | undefined,
					sessionName,
				};
			});

			logger.info(`Found ${validSessions.length} Claude sessions for project`, LOG_CONTEXT, {
				projectPath,
			});
			return sessionsWithOrigins;
		})
	);

	// ============ Paginated List Sessions ============

	ipcMain.handle(
		'claude:listSessionsPaginated',
		withIpcErrorLogging(
			handlerOpts('listSessionsPaginated'),
			async (projectPath: string, options?: { cursor?: string; limit?: number }) => {
				const { cursor, limit = 100 } = options || {};
				const homeDir = os.homedir();
				const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

				const encodedPath = encodeClaudeProjectPath(projectPath);
				const projectDir = path.join(claudeProjectsDir, encodedPath);

				// Check if the directory exists
				try {
					await fs.access(projectDir);
				} catch {
					return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
				}

				// List all .jsonl files and get their stats
				const files = await fs.readdir(projectDir);
				const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));

				const fileStats = await Promise.all(
					sessionFiles.map(async (filename) => {
						const sessionId = filename.replace('.jsonl', '');
						const filePath = path.join(projectDir, filename);
						try {
							const stats = await fs.stat(filePath);
							return {
								sessionId,
								filename,
								filePath,
								modifiedAt: stats.mtime.getTime(),
								sizeBytes: stats.size,
							};
						} catch {
							return null;
						}
					})
				);

				const sortedFiles = fileStats
					.filter((s): s is NonNullable<typeof s> => s !== null)
					// Filter out 0-byte sessions (created but abandoned before any content was written)
					.filter((s) => s.sizeBytes > 0)
					.sort((a, b) => b.modifiedAt - a.modifiedAt);

				const totalCount = sortedFiles.length;

				// Find cursor position
				let startIndex = 0;
				if (cursor) {
					const cursorIndex = sortedFiles.findIndex((f) => f.sessionId === cursor);
					startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
				}

				const pageFiles = sortedFiles.slice(startIndex, startIndex + limit);
				const hasMore = startIndex + limit < totalCount;
				const nextCursor = hasMore ? pageFiles[pageFiles.length - 1]?.sessionId : null;

				// Get Maestro session origins
				const origins = claudeSessionOriginsStore.get('origins', {});
				const projectOrigins = origins[projectPath] || {};

				// Read full content for sessions in this page
				const sessions = await Promise.all(
					pageFiles.map(async (fileInfo) => {
						try {
							const content = await fs.readFile(fileInfo.filePath, 'utf-8');
							const lines = content.split('\n').filter((l) => l.trim());

							let firstUserMessage = '';
							let timestamp = new Date(fileInfo.modifiedAt).toISOString();

							const messageCount = countClaudeTranscriptMessages(content);

							// Extract first meaningful message
							for (
								let i = 0;
								i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES);
								i++
							) {
								try {
									const entry = JSON.parse(lines[i]);
									if (entry.type === 'user' && entry.message?.content) {
										const textContent = extractClaudeTextFromContent(entry.message.content);
										if (textContent.trim()) {
											firstUserMessage = textContent;
											timestamp = entry.timestamp || timestamp;
											break;
										}
									}
									if (!firstUserMessage && entry.type === 'assistant' && entry.message?.content) {
										const textContent = extractClaudeTextFromContent(entry.message.content);
										if (textContent.trim()) {
											firstUserMessage = textContent;
											timestamp = entry.timestamp || timestamp;
										}
									}
								} catch {
									// Skip malformed lines
								}
							}

							// Per-model token + cost extraction (a session may mix models).
							const {
								inputTokens: totalInputTokens,
								outputTokens: totalOutputTokens,
								cacheReadTokens: totalCacheReadTokens,
								cacheCreationTokens: totalCacheCreationTokens,
								costUsd,
							} = await computeClaudeSessionUsage(fileInfo.filePath, content);

							// Extract last timestamp for duration
							let lastTimestamp = timestamp;
							for (
								let i = lines.length - 1;
								i >=
								Math.max(0, lines.length - CLAUDE_SESSION_PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES);
								i--
							) {
								try {
									const entry = JSON.parse(lines[i]);
									if (entry.timestamp) {
										lastTimestamp = entry.timestamp;
										break;
									}
								} catch {
									// Skip malformed lines
								}
							}

							const startTime = new Date(timestamp).getTime();
							const endTime = new Date(lastTimestamp).getTime();
							const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

							// Get origin info
							const originData = projectOrigins[fileInfo.sessionId];
							const origin = typeof originData === 'string' ? originData : originData?.origin;
							const sessionName =
								typeof originData === 'object' ? originData?.sessionName : undefined;

							return {
								sessionId: fileInfo.sessionId,
								projectPath,
								timestamp,
								modifiedAt: new Date(fileInfo.modifiedAt).toISOString(),
								firstMessage: firstUserMessage.slice(
									0,
									CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH
								),
								messageCount,
								sizeBytes: fileInfo.sizeBytes,
								costUsd,
								inputTokens: totalInputTokens,
								outputTokens: totalOutputTokens,
								cacheReadTokens: totalCacheReadTokens,
								cacheCreationTokens: totalCacheCreationTokens,
								durationSeconds,
								origin: origin as ClaudeSessionOrigin | undefined,
								sessionName,
							};
						} catch (error) {
							void captureException(error);
							logger.error(`Error reading session file: ${fileInfo.filename}`, LOG_CONTEXT, error);
							return null;
						}
					})
				);

				const validSessions = sessions.filter((s): s is NonNullable<typeof s> => s !== null);

				logger.info(
					`Paginated Claude sessions - returned ${validSessions.length} of ${totalCount} total`,
					LOG_CONTEXT,
					{ projectPath, cursor, limit }
				);

				return {
					sessions: validSessions,
					hasMore,
					totalCount,
					nextCursor,
				};
			}
		)
	);

	// ============ Get Project Stats ============

	ipcMain.handle(
		'claude:getProjectStats',
		withIpcErrorLogging(
			handlerOpts('getProjectStats'),
			async (projectPath: string, ownerAgentId?: string) => {
				// Helper to send progressive updates to renderer
				const sendUpdate = (stats: {
					totalSessions: number;
					totalMessages: number;
					totalCostUsd: number;
					totalSizeBytes: number;
					totalTokens: number;
					tokenSplit?: ProjectTokenSplit;
					unsplitTokens?: number;
					oldestTimestamp: string | null;
					processedCount?: number;
					isComplete: boolean;
				}) => {
					safeSend('claude:projectStatsUpdate', { projectPath, ...stats });
				};

				// Total the pool of the account the browsing agent runs under; without
				// an owner (older callers) this is the default account, as before.
				const encodedPath = encodeClaudeProjectPath(projectPath);
				const defaultProjectDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);
				const configDir = ownerAgentId ? resolveAgentAccountDir(ownerAgentId) : undefined;
				const projectDir = configDir
					? path.join(configDir, 'projects', encodedPath)
					: defaultProjectDir;
				const cacheScope = await statsCacheScope(projectDir, defaultProjectDir);

				// Check if the directory exists
				try {
					await fs.access(projectDir);
				} catch {
					return {
						totalSessions: 0,
						totalMessages: 0,
						totalCostUsd: 0,
						totalSizeBytes: 0,
						totalTokens: 0,
						oldestTimestamp: null,
					};
				}

				// One scan per project folder: the browser re-requests on every reopen,
				// and a second scan would parse every transcript again and race the
				// first writing the same cache file.
				const existingScan = projectStatsScans.get(projectDir);
				if (existingScan) return existingScan;
				const scan = (async () => {
					// Load existing cache. An older-but-compatible cache was derived by an
					// earlier parser, so every live session is re-parsed and the archived
					// ones are rescaled once the re-parse is done. Staleness is per entry
					// so the upgrade can be checkpointed and resumed (`DerivationUpgrade`).
					const cache = await loadStatsCache(projectPath, cacheScope);
					const loadedVersion = cache?.version ?? STATS_CACHE_VERSION;
					const isStale = (entry: { derivedVersion?: number }) =>
						isDerivationStale(entry, loadedVersion, STATS_CACHE_VERSION);
					const upgrade: DerivationUpgrade | undefined =
						cache && loadedVersion < STATS_CACHE_VERSION
							? cache.upgrade?.toVersion === STATS_CACHE_VERSION
								? cache.upgrade
								: { toVersion: STATS_CACHE_VERSION, baseline: {} }
							: undefined;

					// List all .jsonl files
					const files = await fs.readdir(projectDir);
					const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));

					// Track which sessions need processing
					const sessionsToProcess: {
						sessionId: string;
						filename: string;
						filePath: string;
						mtimeMs: number;
						sizeBytes: number;
					}[] = [];
					const currentSessionIds = new Set<string>();

					for (const filename of sessionFiles) {
						const sessionId = filename.replace('.jsonl', '');
						const filePath = path.join(projectDir, filename);

						try {
							const fileStat = await fs.stat(filePath);
							// Skip 0-byte sessions (created but abandoned before any content was written)
							if (fileStat.size === 0) continue;

							currentSessionIds.add(sessionId);
							const cachedSession = cache?.sessions[sessionId];

							if (
								!cachedSession ||
								cachedSession.fileMtimeMs < fileStat.mtimeMs ||
								isStale(cachedSession)
							) {
								sessionsToProcess.push({
									sessionId,
									filename,
									filePath,
									mtimeMs: fileStat.mtimeMs,
									sizeBytes: fileStat.size,
								});
							}
						} catch {
							// Skip files we can't stat
						}
					}

					// Build new cache. It keeps the loaded version until the upgrade is
					// done, so a checkpoint saved part way never claims to be upgraded.
					const newCache: SessionStatsCache = {
						version: loadedVersion,
						upgrade,
						sessions: {},
						totals: {
							totalSessions: 0,
							totalMessages: 0,
							totalCostUsd: 0,
							totalSizeBytes: 0,
							totalTokens: 0,
							oldestTimestamp: null,
						},
						lastUpdated: Date.now(),
					};

					// ============================================================================
					// Archive Preservation Pattern
					// ============================================================================
					// IMPORTANT: When JSONL files are deleted, we MUST preserve session stats by
					// marking them as archived (not by dropping them). This ensures lifetime stats
					// (costs, messages, tokens, oldest timestamp) survive file cleanup.
					//
					// This pattern MUST match the global stats cache behavior in agentSessions.ts.
					// If you modify this logic, update both files and the corresponding tests.
					// ============================================================================

					if (cache) {
						for (const [sessionId, sessionStats] of Object.entries(cache.sessions)) {
							// Every cached session is carried over, including the ones about to
							// be re-parsed: a checkpoint saved before the re-parse reaches them
							// must still hold them, and a re-parse that fails keeps the old
							// numbers rather than dropping the session.
							newCache.sessions[sessionId] = {
								...sessionStats,
								// A file still on disk is live (and un-archived if it reappeared);
								// a DELETED one keeps its stats with the archived flag, so it still
								// counts toward lifetime totals. We must NOT drop deleted sessions.
								archived: !currentSessionIds.has(sessionId),
							};
						}
					}

					// Send immediate update with cached data (so UI shows something right away)
					if (Object.keys(newCache.sessions).length > 0) {
						const cachedTotals = calculateTotals(newCache);
						sendUpdate({ ...cachedTotals, isComplete: sessionsToProcess.length === 0 });
					}

					// Process new/modified sessions on the worker pool, checkpointing as it goes
					const checkpoint = createCacheCheckpointer(() => {
						newCache.lastUpdated = Date.now();
						return saveStatsCache(projectPath, newCache, cacheScope);
					});
					let processedCount = 0;
					let lastUpdateAt = 0;
					await withStatsIndexing(
						{
							id: 'project-stats',
							label: 'Session browser totals',
							reason: upgrade ? 'upgrade' : 'index',
						},
						async (progress) => {
							progress.addWork(
								sessionsToProcess.length,
								sessionsToProcess.reduce((sum, s) => sum + s.sizeBytes, 0)
							);
							await mapWithConcurrency(
								sessionsToProcess,
								LOCAL_SESSION_PARSE_CONCURRENCY,
								async ({ sessionId, filename, filePath, mtimeMs, sizeBytes }) => {
									try {
										const stats = await runTranscriptParse({
											kind: 'claude-project-stats',
											filePath,
											sizeBytes,
										});
										const previous = newCache.sessions[sessionId];
										const next: PerProjectSessionStats = {
											fileMtimeMs: mtimeMs,
											...stats,
											archived: false, // Explicitly mark as active (file exists)
											derivedVersion: STATS_CACHE_VERSION,
										};
										if (upgrade && previous && isStale(previous)) {
											accumulateUpgradeBaseline(
												upgrade.baseline,
												previous,
												next,
												PROJECT_STATS_UPGRADE_FIELDS
											);
										}
										newCache.sessions[sessionId] = next;
										processedCount++;

										// Totals walk every session, so stream them at a bounded rate
										// rather than once per file (quadratic on a large project).
										const now = Date.now();
										if (now - lastUpdateAt >= PROJECT_STATS_UPDATE_INTERVAL_MS) {
											lastUpdateAt = now;
											sendUpdate({
												...calculateTotals(newCache),
												processedCount,
												isComplete: false,
											});
										}
									} catch (error) {
										// A transcript we merely discovered under `~/.claude/projects` can be
										// unreadable or gone by the time we read it - environmental, not a
										// Maestro fault, so warn locally and keep it out of Sentry
										// (MAESTRO-YJ). Everything else still reports.
										if (isExpectedSessionReadError(error)) {
											logger.warn(`Session file not readable: ${filename}`, LOG_CONTEXT, { error });
										} else {
											void captureException(error);
											logger.error(`Error parsing session file: ${filename}`, LOG_CONTEXT, error);
										}
									} finally {
										progress.advance(1, sizeBytes);
										checkpoint.maybe();
									}
								}
							);
						}
					);
					await checkpoint.settle();

					if (upgrade) {
						// Live sessions that failed to parse keep their old stamp, so the next
						// scan retries them rather than treating them as upgraded.
						for (const entry of Object.values(newCache.sessions)) {
							if (!entry.archived && isStale(entry)) entry.derivedVersion = loadedVersion;
						}
						finishDerivationUpgrade(
							newCache.sessions,
							loadedVersion,
							STATS_CACHE_VERSION,
							upgrade.baseline,
							PROJECT_STATS_UPGRADE_FIELDS,
							['costUsd']
						);
						delete newCache.upgrade;
					}
					newCache.version = STATS_CACHE_VERSION;
					newCache.lastUpdated = Date.now();

					// Calculate final totals
					const finalTotals = calculateTotals(newCache);

					// Save cache
					await saveStatsCache(projectPath, newCache, cacheScope);

					const cachedCount = Object.keys(newCache.sessions).length - sessionsToProcess.length;
					logger.info(
						`Project stats: ${sessionsToProcess.length} new/modified, ${cachedCount} cached, $${finalTotals.totalCostUsd.toFixed(2)}`,
						LOG_CONTEXT
					);

					sendUpdate({ ...finalTotals, processedCount, isComplete: true });
					return { ...finalTotals, isComplete: true };
				})().finally(() => {
					projectStatsScans.delete(projectDir);
				});
				projectStatsScans.set(projectDir, scan);
				return scan;
			}
		)
	);

	// ============ Get Session Timestamps ============

	ipcMain.handle(
		'claude:getSessionTimestamps',
		withIpcErrorLogging(handlerOpts('getSessionTimestamps'), async (projectPath: string) => {
			// First try to get from cache
			const cache = await loadStatsCache(projectPath);
			if (cache && Object.keys(cache.sessions).length > 0) {
				const timestamps = Object.entries(cache.sessions)
					.map(([sessionId, stats]) => ({
						sessionId,
						timestamp: stats.oldestTimestamp,
					}))
					.filter((t) => t.timestamp !== null);
				return timestamps;
			}

			// Fall back to quick scan
			const homeDir = os.homedir();
			const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
			const encodedPath = encodeClaudeProjectPath(projectPath);
			const projectDir = path.join(claudeProjectsDir, encodedPath);

			try {
				await fs.access(projectDir);
			} catch {
				return [];
			}

			const files = await fs.readdir(projectDir);
			const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));

			const timestamps = await Promise.all(
				sessionFiles.map(async (filename) => {
					const sessionId = filename.replace('.jsonl', '');
					const filePath = path.join(projectDir, filename);

					try {
						const stats = await fs.stat(filePath);
						return {
							sessionId,
							timestamp: stats.mtime.toISOString(),
						};
					} catch {
						return null;
					}
				})
			);

			return timestamps.filter((t): t is NonNullable<typeof t> => t !== null);
		})
	);

	// ============ Get Global Stats ============

	ipcMain.handle(
		'claude:getGlobalStats',
		withIpcErrorLogging(handlerOpts('getGlobalStats'), async () => {
			// Helper to send progressive updates
			const sendUpdate = (stats: {
				totalSessions: number;
				totalMessages: number;
				totalInputTokens: number;
				totalOutputTokens: number;
				totalCacheReadTokens: number;
				totalCacheCreationTokens: number;
				totalCostUsd: number;
				totalSizeBytes: number;
				isComplete: boolean;
			}) => {
				safeSend('claude:globalStatsUpdate', stats);
			};

			const homeDir = os.homedir();
			const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

			try {
				await fs.access(claudeProjectsDir);
			} catch {
				return {
					totalSessions: 0,
					totalMessages: 0,
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheReadTokens: 0,
					totalCacheCreationTokens: 0,
					totalCostUsd: 0,
					totalSizeBytes: 0,
					isComplete: true,
				};
			}

			// Load existing global cache
			const cache = await loadLegacyGlobalStatsCache();

			// List all project directories
			const projectDirs = await fs.readdir(claudeProjectsDir);

			// Build new cache
			const newCache: LegacyGlobalStatsCache = {
				version: LEGACY_GLOBAL_STATS_CACHE_VERSION,
				lastUpdated: Date.now(),
				sessions: {},
				totals: {
					totalSessions: 0,
					totalMessages: 0,
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheReadTokens: 0,
					totalCacheCreationTokens: 0,
					totalCostUsd: 0,
					totalSizeBytes: 0,
				},
			};

			const sessionsToProcess: { filePath: string; sessionKey: string; mtimeMs: number }[] = [];
			const currentSessionKeys = new Set<string>();

			// Scan all project directories
			for (const projectDir of projectDirs) {
				const projectPath = path.join(claudeProjectsDir, projectDir);
				try {
					const stat = await fs.stat(projectPath);
					if (!stat.isDirectory()) continue;

					const files = await fs.readdir(projectPath);
					const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));

					for (const filename of sessionFiles) {
						const sessionKey = `${projectDir}/${filename.replace('.jsonl', '')}`;
						const filePath = path.join(projectPath, filename);

						try {
							const fileStat = await fs.stat(filePath);
							// Skip 0-byte sessions (created but abandoned before any content was written)
							if (fileStat.size === 0) continue;

							currentSessionKeys.add(sessionKey);
							const cachedSession = cache?.sessions[sessionKey];

							if (!cachedSession || cachedSession.fileMtimeMs < fileStat.mtimeMs) {
								sessionsToProcess.push({ filePath, sessionKey, mtimeMs: fileStat.mtimeMs });
							}
						} catch {
							// Skip files we can't stat
						}
					}
				} catch {
					// Skip directories we can't access
				}
			}

			// Copy still-valid cached sessions
			if (cache) {
				for (const [sessionKey, sessionStats] of Object.entries(cache.sessions)) {
					if (
						currentSessionKeys.has(sessionKey) &&
						!sessionsToProcess.some((s) => s.sessionKey === sessionKey)
					) {
						newCache.sessions[sessionKey] = sessionStats;
					}
				}
			}

			// Helper to calculate totals
			const calculateGlobalTotals = (c: LegacyGlobalStatsCache) => {
				let totalSessions = 0;
				let totalMessages = 0;
				let totalInputTokens = 0;
				let totalOutputTokens = 0;
				let totalCacheReadTokens = 0;
				let totalCacheCreationTokens = 0;
				let totalSizeBytes = 0;

				for (const stats of Object.values(c.sessions)) {
					totalSessions++;
					totalMessages += stats.messages;
					totalInputTokens += stats.inputTokens;
					totalOutputTokens += stats.outputTokens;
					totalCacheReadTokens += stats.cacheReadTokens;
					totalCacheCreationTokens += stats.cacheCreationTokens;
					totalSizeBytes += stats.sizeBytes;
				}

				// Prefer the per-model cost stored at parse time; fall back to flat-rate
				// pricing for cache entries written before per-model cost was tracked.
				const totalCostUsd = Object.values(c.sessions).reduce(
					(sum, stats) =>
						sum +
						(stats.costUsd ??
							calculateModelCost({
								inputTokens: stats.inputTokens,
								outputTokens: stats.outputTokens,
								cacheReadTokens: stats.cacheReadTokens,
								cacheCreationTokens: stats.cacheCreationTokens,
							})),
					0
				);

				return {
					totalSessions,
					totalMessages,
					totalInputTokens,
					totalOutputTokens,
					totalCacheReadTokens,
					totalCacheCreationTokens,
					totalCostUsd,
					totalSizeBytes,
				};
			};

			// Process new/modified sessions
			let processedCount = 0;
			for (const { filePath, sessionKey, mtimeMs } of sessionsToProcess) {
				try {
					const content = await fs.readFile(filePath, 'utf-8');
					const fileStat = await fs.stat(filePath);

					const messages = countClaudeTranscriptMessages(content);

					// Per-model token + cost extraction (a session may mix models).
					const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } =
						await computeClaudeSessionUsage(filePath, content);

					newCache.sessions[sessionKey] = {
						fileMtimeMs: mtimeMs,
						messages,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheCreationTokens,
						sizeBytes: fileStat.size,
						costUsd,
					};

					processedCount++;

					// Send progress update
					const currentTotals = calculateGlobalTotals(newCache);
					sendUpdate({ ...currentTotals, isComplete: processedCount >= sessionsToProcess.length });
				} catch (error) {
					// See the per-project loop above (MAESTRO-YJ).
					if (isExpectedSessionReadError(error)) {
						logger.warn(`Global session file not readable: ${sessionKey}`, LOG_CONTEXT, { error });
					} else {
						void captureException(error);
						logger.error(`Error parsing global session file: ${sessionKey}`, LOG_CONTEXT, error);
					}
				}
			}

			// Calculate final totals
			const finalTotals = calculateGlobalTotals(newCache);
			newCache.totals = finalTotals;

			// Save cache
			await saveLegacyGlobalStatsCache(newCache);

			const cachedCount = Object.keys(newCache.sessions).length - sessionsToProcess.length;
			logger.info(
				`Global stats: ${sessionsToProcess.length} new/modified, ${cachedCount} cached, $${finalTotals.totalCostUsd.toFixed(2)}`,
				LOG_CONTEXT
			);

			return { ...finalTotals, isComplete: true };
		})
	);

	// ============ Read Session Messages ============

	ipcMain.handle(
		'claude:readSessionMessages',
		withIpcErrorLogging(
			handlerOpts('readSessionMessages'),
			async (
				projectPath: string,
				sessionId: string,
				options?: { offset?: number; limit?: number }
			) => {
				const homeDir = os.homedir();
				const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

				const encodedPath = encodeClaudeProjectPath(projectPath);
				const sessionFile = path.join(claudeProjectsDir, encodedPath, `${sessionId}.jsonl`);

				const content = await fs.readFile(sessionFile, 'utf-8');
				const lines = content.split('\n').filter((l) => l.trim());

				const messages: Array<{
					type: string;
					role?: string;
					content: string;
					timestamp: string;
					uuid: string;
					toolUse?: unknown;
				}> = [];

				for (const line of lines) {
					try {
						const entry = JSON.parse(line);
						if (entry.type === 'user' || entry.type === 'assistant') {
							let msgContent = '';
							let toolUse = undefined;

							if (entry.message?.content) {
								if (typeof entry.message.content === 'string') {
									msgContent = entry.message.content;
								} else if (Array.isArray(entry.message.content)) {
									const textBlocks = entry.message.content.filter(
										(b: { type?: string }) => b.type === 'text'
									);
									const toolBlocks = entry.message.content.filter(
										(b: { type?: string }) => b.type === 'tool_use'
									);

									msgContent = textBlocks.map((b: { text?: string }) => b.text).join('\n');
									if (toolBlocks.length > 0) {
										toolUse = toolBlocks;
									}
								}
							}

							if (msgContent && msgContent.trim()) {
								messages.push({
									type: entry.type,
									role: entry.message?.role,
									content: msgContent,
									timestamp: entry.timestamp,
									uuid: entry.uuid,
									toolUse,
								});
							}
						}
					} catch {
						// Skip malformed lines
					}
				}

				// Apply offset and limit for lazy loading
				const offset = options?.offset ?? 0;
				const limit = options?.limit ?? 20;

				const startIndex = Math.max(0, messages.length - offset - limit);
				const endIndex = messages.length - offset;
				const slice = messages.slice(startIndex, endIndex);

				return {
					messages: slice,
					total: messages.length,
					hasMore: startIndex > 0,
				};
			}
		)
	);

	// ============ Delete Message Pair ============

	ipcMain.handle(
		'claude:deleteMessagePair',
		withIpcErrorLogging(
			handlerOpts('deleteMessagePair'),
			async (
				projectPath: string,
				sessionId: string,
				userMessageUuid: string,
				fallbackContent?: string
			) => {
				const homeDir = os.homedir();
				const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

				const encodedPath = encodeClaudeProjectPath(projectPath);
				const sessionFile = path.join(claudeProjectsDir, encodedPath, `${sessionId}.jsonl`);

				const content = await fs.readFile(sessionFile, 'utf-8');
				const lines = content.split('\n').filter((l) => l.trim());

				const parsedLines: Array<{ line: string; entry: unknown }> = [];
				let userMessageIndex = -1;

				for (let i = 0; i < lines.length; i++) {
					try {
						const entry = JSON.parse(lines[i]);
						parsedLines.push({ line: lines[i], entry });

						if (entry.uuid === userMessageUuid && entry.type === 'user') {
							userMessageIndex = parsedLines.length - 1;
						}
					} catch {
						parsedLines.push({ line: lines[i], entry: null });
					}
				}

				// If UUID match failed, try content match
				if (userMessageIndex === -1 && fallbackContent) {
					const normalizedFallback = fallbackContent.trim();

					for (let i = parsedLines.length - 1; i >= 0; i--) {
						const entry = parsedLines[i].entry as {
							type?: string;
							message?: { content?: unknown };
						} | null;
						if (entry?.type === 'user') {
							let messageText = '';
							if (entry.message?.content) {
								if (typeof entry.message.content === 'string') {
									messageText = entry.message.content;
								} else if (Array.isArray(entry.message.content)) {
									const textBlocks = (
										entry.message.content as Array<{ type?: string; text?: string }>
									).filter((b) => b.type === 'text');
									messageText = textBlocks.map((b) => b.text).join('\n');
								}
							}

							if (messageText.trim() === normalizedFallback) {
								userMessageIndex = i;
								logger.info('Found message by content match', LOG_CONTEXT, { sessionId, index: i });
								break;
							}
						}
					}
				}

				if (userMessageIndex === -1) {
					logger.warn('User message not found for deletion', LOG_CONTEXT, {
						sessionId,
						userMessageUuid,
						hasFallback: !!fallbackContent,
					});
					return { success: false, error: 'User message not found' };
				}

				// Find the end of the response and collect tool_use IDs being deleted
				let endIndex = parsedLines.length;
				const deletedToolUseIds = new Set<string>();

				for (let i = userMessageIndex + 1; i < parsedLines.length; i++) {
					const entry = parsedLines[i].entry as {
						type?: string;
						message?: { content?: unknown };
					} | null;

					if (entry?.type === 'user') {
						endIndex = i;
						break;
					}

					// Collect tool_use IDs from assistant messages being deleted
					if (entry?.type === 'assistant' && entry.message?.content) {
						const content = entry.message.content;
						if (Array.isArray(content)) {
							for (const block of content as Array<{ type?: string; id?: string }>) {
								if (block.type === 'tool_use' && block.id) {
									deletedToolUseIds.add(block.id);
								}
							}
						}
					}
				}

				// Remove the message pair
				let linesToKeep = [
					...parsedLines.slice(0, userMessageIndex),
					...parsedLines.slice(endIndex),
				];

				// If we deleted any tool_use blocks, clean up orphaned tool_result blocks
				if (deletedToolUseIds.size > 0) {
					linesToKeep = linesToKeep
						.map((item) => {
							const entry = item.entry as {
								type?: string;
								message?: { content?: unknown };
							} | null;

							// Only process user messages (tool_result blocks are in user messages)
							if (entry?.type !== 'user' || !entry.message?.content) {
								return item;
							}

							const content = entry.message.content;
							if (!Array.isArray(content)) {
								return item;
							}

							// Filter out tool_result blocks that reference deleted tool_use IDs
							const filteredContent = (
								content as Array<{ type?: string; tool_use_id?: string }>
							).filter((block) => {
								if (block.type === 'tool_result' && block.tool_use_id) {
									return !deletedToolUseIds.has(block.tool_use_id);
								}
								return true;
							});

							// If we removed all content blocks, mark this line for removal
							if (filteredContent.length === 0) {
								return { line: '', entry: null, remove: true };
							}

							// If content changed, update the line
							if (filteredContent.length !== content.length) {
								const updatedEntry = {
									...entry,
									message: {
										...entry.message,
										content: filteredContent,
									},
								};
								return { line: JSON.stringify(updatedEntry), entry: updatedEntry };
							}

							return item;
						})
						.filter((item) => !(item as { remove?: boolean }).remove);

					logger.info(`Cleaned up orphaned tool_result blocks`, LOG_CONTEXT, {
						sessionId,
						deletedToolUseIds: Array.from(deletedToolUseIds),
					});
				}

				const newContent = linesToKeep.map((p) => p.line).join('\n') + '\n';
				await fs.writeFile(sessionFile, newContent, 'utf-8');

				logger.info(`Deleted message pair from Claude session`, LOG_CONTEXT, {
					sessionId,
					userMessageUuid,
					linesRemoved: endIndex - userMessageIndex,
				});

				return { success: true, linesRemoved: endIndex - userMessageIndex };
			}
		)
	);

	// ============ Search Sessions ============

	ipcMain.handle(
		'claude:searchSessions',
		withIpcErrorLogging(
			handlerOpts('searchSessions'),
			async (
				projectPath: string,
				query: string,
				searchMode: 'title' | 'user' | 'assistant' | 'all'
			) => {
				if (!query.trim()) {
					return [];
				}

				const homeDir = os.homedir();
				const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

				const encodedPath = encodeClaudeProjectPath(projectPath);
				const projectDir = path.join(claudeProjectsDir, encodedPath);

				try {
					await fs.access(projectDir);
				} catch {
					return [];
				}

				const files = await fs.readdir(projectDir);
				const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));

				const searchLower = query.toLowerCase();
				const matchingSessions: Array<{
					sessionId: string;
					matchType: 'title' | 'user' | 'assistant';
					matchPreview: string;
					matchCount: number;
				}> = [];

				for (const filename of sessionFiles) {
					const sessionId = filename.replace('.jsonl', '');
					const filePath = path.join(projectDir, filename);

					try {
						const content = await fs.readFile(filePath, 'utf-8');
						const lines = content.split('\n').filter((l) => l.trim());

						let titleMatch = false;
						let userMatches = 0;
						let assistantMatches = 0;
						let matchPreview = '';

						for (const line of lines) {
							try {
								const entry = JSON.parse(line);

								let textContent = '';
								if (entry.message?.content) {
									if (typeof entry.message.content === 'string') {
										textContent = entry.message.content;
									} else if (Array.isArray(entry.message.content)) {
										textContent = entry.message.content
											.filter((b: { type?: string }) => b.type === 'text')
											.map((b: { text?: string }) => b.text)
											.join('\n');
									}
								}

								const textLower = textContent.toLowerCase();

								if (entry.type === 'user' && !titleMatch && textLower.includes(searchLower)) {
									titleMatch = true;
									if (!matchPreview) {
										const idx = textLower.indexOf(searchLower);
										const start = Math.max(0, idx - 60);
										const end = Math.min(textContent.length, idx + query.length + 60);
										matchPreview =
											(start > 0 ? '...' : '') +
											textContent.slice(start, end) +
											(end < textContent.length ? '...' : '');
									}
								}

								if (entry.type === 'user' && textLower.includes(searchLower)) {
									userMatches++;
									if (!matchPreview && (searchMode === 'user' || searchMode === 'all')) {
										const idx = textLower.indexOf(searchLower);
										const start = Math.max(0, idx - 60);
										const end = Math.min(textContent.length, idx + query.length + 60);
										matchPreview =
											(start > 0 ? '...' : '') +
											textContent.slice(start, end) +
											(end < textContent.length ? '...' : '');
									}
								}

								if (entry.type === 'assistant' && textLower.includes(searchLower)) {
									assistantMatches++;
									if (!matchPreview && (searchMode === 'assistant' || searchMode === 'all')) {
										const idx = textLower.indexOf(searchLower);
										const start = Math.max(0, idx - 60);
										const end = Math.min(textContent.length, idx + query.length + 60);
										matchPreview =
											(start > 0 ? '...' : '') +
											textContent.slice(start, end) +
											(end < textContent.length ? '...' : '');
									}
								}
							} catch {
								// Skip malformed lines
							}
						}

						let matches = false;
						let matchType: 'title' | 'user' | 'assistant' = 'title';
						let matchCount = 0;

						switch (searchMode) {
							case 'title':
								matches = titleMatch;
								matchType = 'title';
								matchCount = titleMatch ? 1 : 0;
								break;
							case 'user':
								matches = userMatches > 0;
								matchType = 'user';
								matchCount = userMatches;
								break;
							case 'assistant':
								matches = assistantMatches > 0;
								matchType = 'assistant';
								matchCount = assistantMatches;
								break;
							case 'all':
								matches = titleMatch || userMatches > 0 || assistantMatches > 0;
								matchType = titleMatch ? 'title' : userMatches > 0 ? 'user' : 'assistant';
								matchCount = userMatches + assistantMatches;
								break;
						}

						if (matches) {
							matchingSessions.push({
								sessionId,
								matchType,
								matchPreview,
								matchCount,
							});
						}
					} catch {
						// Skip files that can't be read
					}
				}

				return matchingSessions;
			}
		)
	);

	// ============ Get Commands ============

	ipcMain.handle(
		'claude:getCommands',
		withIpcErrorLogging(
			handlerOpts('getCommands', COMMANDS_LOG_CONTEXT),
			async (projectPath: string) => {
				const homeDir = os.homedir();
				const commands: Array<{ command: string; description: string }> = [];

				const extractDescription = async (filePath: string): Promise<string> => {
					try {
						const content = await fs.readFile(filePath, 'utf-8');
						const lines = content.split('\n');
						let inFrontmatter = false;
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed === '---') {
								inFrontmatter = !inFrontmatter;
								continue;
							}
							if (inFrontmatter) continue;
							if (trimmed.length > 0) {
								return trimmed.replace(/^#+\s*/, '').slice(0, 100);
							}
						}
						return 'No description';
					} catch {
						return 'No description';
					}
				};

				const scanCommandsDir = async (dir: string, prefix: string = '') => {
					try {
						const entries = await fs.readdir(dir, { withFileTypes: true });
						for (const entry of entries) {
							if (entry.isFile() && entry.name.endsWith('.md')) {
								const cmdName = entry.name.replace('.md', '');
								const cmdPath = path.join(dir, entry.name);
								const description = await extractDescription(cmdPath);
								const command = prefix ? `/${prefix}:${cmdName}` : `/${cmdName}`;
								commands.push({ command, description });
							}
						}
					} catch {
						// Directory doesn't exist or isn't readable
					}
				};

				// 1. User-defined commands
				const userCommandsDir = path.join(homeDir, '.claude', 'commands');
				await scanCommandsDir(userCommandsDir);

				// 2. Project-level commands
				const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
				await scanCommandsDir(projectCommandsDir);

				// 3. Enabled plugins' commands
				const settingsPath = path.join(homeDir, '.claude', 'settings.json');
				try {
					const settingsContent = await fs.readFile(settingsPath, 'utf-8');
					const settings = JSON.parse(settingsContent);
					const enabledPlugins = settings.enabledPlugins || {};

					const installedPluginsPath = path.join(
						homeDir,
						'.claude',
						'plugins',
						'installed_plugins.json'
					);
					const installedContent = await fs.readFile(installedPluginsPath, 'utf-8');
					const installedPlugins = JSON.parse(installedContent);

					for (const pluginId of Object.keys(enabledPlugins)) {
						if (!enabledPlugins[pluginId]) continue;

						const pluginInfo = installedPlugins.plugins?.[pluginId];
						if (!pluginInfo?.installPath) continue;

						const pluginCommandsDir = path.join(pluginInfo.installPath, 'commands');
						const pluginName = pluginId.split('@')[0];
						await scanCommandsDir(pluginCommandsDir, pluginName);
					}
				} catch {
					// Settings or installed plugins not readable
				}

				logger.info(
					`Found ${commands.length} Claude commands for project: ${projectPath}`,
					COMMANDS_LOG_CONTEXT
				);
				return commands;
			}
		)
	);

	// ============ Get Skills ============

	const SKILLS_LOG_CONTEXT = '[ClaudeSkills]';

	ipcMain.handle(
		'claude:getSkills',
		withIpcErrorLogging(
			handlerOpts('getSkills', SKILLS_LOG_CONTEXT),
			async (projectPath: string) => {
				const homeDir = os.homedir();
				const skills: Array<{
					name: string;
					description: string;
					tokenCount: number;
					source: 'project' | 'user';
				}> = [];

				// Only treat "missing entry" filesystem errors as "no skill here";
				// propagate permission/IO errors to the outer IPC handler so
				// Sentry captures them instead of silently dropping skills.
				const isMissingEntryError = (error: unknown): boolean => {
					const code = (error as NodeJS.ErrnoException | undefined)?.code;
					return code === 'ENOENT' || code === 'ENOTDIR';
				};

				/**
				 * Parses a skill.md file to extract name, description, and token count.
				 * Skills use YAML frontmatter with 'name' and 'description' fields.
				 */
				const parseSkillFile = async (
					filePath: string,
					skillDirName: string,
					source: 'project' | 'user'
				): Promise<{
					name: string;
					description: string;
					tokenCount: number;
					source: 'project' | 'user';
				} | null> => {
					try {
						const content = await fs.readFile(filePath, 'utf-8');
						const lines = content.split('\n');

						let name = skillDirName; // Default to directory name
						let description = 'No description';
						let inFrontmatter = false;
						let frontmatterContent = '';

						// Parse YAML frontmatter
						for (const line of lines) {
							const trimmed = line.trim();
							if (trimmed === '---') {
								if (!inFrontmatter) {
									inFrontmatter = true;
									continue;
								} else {
									// End of frontmatter
									break;
								}
							}
							if (inFrontmatter) {
								frontmatterContent += line + '\n';
							}
						}

						// Extract name and description from frontmatter (simple YAML parsing)
						const nameMatch = frontmatterContent.match(/^name:\s*(.+)$/m);
						const descMatch = frontmatterContent.match(/^description:\s*(.+)$/m);

						if (nameMatch) {
							name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
						}
						if (descMatch) {
							description = descMatch[1].trim().replace(/^["']|["']$/g, '');
						}

						// Approximate token count: ~4 characters per token
						const tokenCount = Math.round(content.length / 4);

						return { name, description, tokenCount, source };
					} catch (error) {
						if (isMissingEntryError(error)) return null;
						throw error;
					}
				};

				/**
				 * Scans a skills directory for SKILL.md files. Claude Code writes the
				 * canonical uppercase name; on case-insensitive filesystems
				 * (Windows NTFS, default macOS APFS) `skill.md` happens to match,
				 * but on case-sensitive filesystems (Linux, WSL) it does not - so
				 * try the canonical name first and fall back to lowercase.
				 */
				const scanSkillsDir = async (dir: string, source: 'project' | 'user') => {
					let entries;
					try {
						entries = await fs.readdir(dir, { withFileTypes: true });
					} catch (error) {
						if (isMissingEntryError(error)) return;
						throw error;
					}
					for (const entry of entries) {
						if (!entry.isDirectory()) continue;
						for (const candidate of ['SKILL.md', 'skill.md']) {
							const skillPath = path.join(dir, entry.name, candidate);
							const skill = await parseSkillFile(skillPath, entry.name, source);
							if (skill) {
								skills.push(skill);
								break;
							}
						}
					}
				};

				// 1. Project-level skills
				const projectSkillsDir = path.join(projectPath, '.claude', 'skills');
				await scanSkillsDir(projectSkillsDir, 'project');

				// 2. User-level skills (if Claude supports this location)
				const userSkillsDir = path.join(homeDir, '.claude', 'skills');
				await scanSkillsDir(userSkillsDir, 'user');

				logger.info(
					`Found ${skills.length} Claude skills for project: ${projectPath}`,
					SKILLS_LOG_CONTEXT
				);
				return skills;
			}
		)
	);

	// ============ Session Origins ============

	ipcMain.handle(
		'claude:registerSessionOrigin',
		withIpcErrorLogging(
			handlerOpts('registerSessionOrigin', ORIGINS_LOG_CONTEXT),
			async (
				projectPath: string,
				agentSessionId: string,
				origin: 'user' | 'auto',
				sessionName?: string
			) => {
				// Called on every turn, so it must merge: replacing the record wipes
				// the tab name and star other paths wrote.
				setClaudeSessionOrigin(
					claudeSessionOriginsStore,
					projectPath,
					agentSessionId,
					sessionName ? { origin, sessionName } : { origin }
				);
				logger.debug(
					`Registered Claude session origin: ${agentSessionId} = ${origin}${sessionName ? ` (name: ${sessionName})` : ''}`,
					ORIGINS_LOG_CONTEXT,
					{ projectPath }
				);
				return true;
			}
		)
	);

	ipcMain.handle(
		'claude:updateSessionName',
		withIpcErrorLogging(
			handlerOpts('updateSessionName', ORIGINS_LOG_CONTEXT),
			async (projectPath: string, agentSessionId: string, sessionName: string) => {
				setClaudeSessionOrigin(claudeSessionOriginsStore, projectPath, agentSessionId, {
					sessionName,
				});
				logger.debug(
					`Updated Claude session name: ${agentSessionId} = ${sessionName}`,
					ORIGINS_LOG_CONTEXT,
					{ projectPath }
				);
				return true;
			}
		)
	);

	ipcMain.handle(
		'claude:updateSessionStarred',
		withIpcErrorLogging(
			handlerOpts('updateSessionStarred', ORIGINS_LOG_CONTEXT),
			async (projectPath: string, agentSessionId: string, starred: boolean) => {
				const starEntry = setClaudeSessionOrigin(
					claudeSessionOriginsStore,
					projectPath,
					agentSessionId,
					{ starred }
				);
				logger.debug(
					`Updated Claude session starred: ${agentSessionId} = ${starred}`,
					ORIGINS_LOG_CONTEXT,
					{ projectPath }
				);

				// Mirror the transcript on star / drop it on unstar so the conversation
				// survives provider-side deletion. Fire-and-forget - see the generic
				// agentSessions:setSessionStarred handler for the rationale.
				const starSessionName = typeof starEntry === 'object' ? starEntry.sessionName : undefined;
				if (starred) {
					void snapshotStarredTranscript({
						agentId: 'claude-code',
						projectPath,
						sessionId: agentSessionId,
						sessionName: starSessionName,
					});
				} else {
					void releaseTranscriptMirror({ agentId: 'claude-code', sessionId: agentSessionId });
				}
				return true;
			}
		)
	);

	ipcMain.handle(
		'claude:updateSessionContextUsage',
		withIpcErrorLogging(
			handlerOpts('updateSessionContextUsage', ORIGINS_LOG_CONTEXT),
			async (projectPath: string, agentSessionId: string, contextUsage: number) => {
				setClaudeSessionOrigin(claudeSessionOriginsStore, projectPath, agentSessionId, {
					contextUsage,
				});
				// Don't log - this updates frequently and would spam logs
				return true;
			}
		)
	);

	ipcMain.handle(
		'claude:getSessionOrigins',
		withIpcErrorLogging(
			handlerOpts('getSessionOrigins', ORIGINS_LOG_CONTEXT),
			async (projectPath: string) => {
				const origins = claudeSessionOriginsStore.get('origins', {});
				return origins[projectPath] || {};
			}
		)
	);

	ipcMain.handle(
		'claude:getAllNamedSessions',
		withIpcErrorLogging(handlerOpts('getAllNamedSessions', ORIGINS_LOG_CONTEXT), async () => {
			const homeDir = os.homedir();
			const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

			const allOrigins = claudeSessionOriginsStore.get('origins', {});
			const namedSessions: Array<{
				agentSessionId: string;
				projectPath: string;
				sessionName: string;
				starred?: boolean;
				lastActivityAt?: number;
			}> = [];

			for (const [projectPath, sessions] of Object.entries(allOrigins)) {
				for (const [agentSessionId, info] of Object.entries(sessions)) {
					if (typeof info === 'object' && info.sessionName) {
						let lastActivityAt: number | undefined;
						try {
							const encodedPath = encodeClaudeProjectPath(projectPath);
							const sessionFile = path.join(
								claudeProjectsDir,
								encodedPath,
								`${agentSessionId}.jsonl`
							);
							const stats = await fs.stat(sessionFile);
							lastActivityAt = stats.mtime.getTime();
						} catch {
							// Session file may not exist or be inaccessible
						}

						namedSessions.push({
							agentSessionId,
							projectPath,
							sessionName: info.sessionName,
							starred: info.starred,
							lastActivityAt,
						});
					}
				}
			}

			return namedSessions;
		})
	);
}

/**
 * Helper to calculate totals from session stats cache.
 *
 * IMPORTANT: This function intentionally includes ALL sessions (both active and archived)
 * in the totals. Archived sessions (where JSONL files have been deleted) MUST still count
 * toward lifetime statistics. This preserves historical cost tracking and session counts.
 *
 * Do NOT add filtering for `archived` flag here - that would break lifetime stats.
 */
function calculateTotals(cache: SessionStatsCache) {
	let totalSessions = 0;
	let totalMessages = 0;
	let totalCostUsd = 0;
	let totalSizeBytes = 0;
	let totalTokens = 0;
	const tokenSplit: ProjectTokenSplit = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};
	// Tokens of archived sessions cached before the split existed: counted in the
	// total, but nothing says which kind they were.
	let unsplitTokens = 0;
	let oldestTimestamp: string | null = null;

	// Include ALL sessions (active + archived) for lifetime totals
	for (const stats of Object.values(cache.sessions)) {
		totalSessions++;
		totalMessages += stats.messages;
		totalCostUsd += stats.costUsd;
		totalSizeBytes += stats.sizeBytes;
		totalTokens += stats.tokens;
		if (stats.tokenSplit) {
			tokenSplit.inputTokens += stats.tokenSplit.inputTokens;
			tokenSplit.outputTokens += stats.tokenSplit.outputTokens;
			tokenSplit.cacheReadTokens += stats.tokenSplit.cacheReadTokens;
			tokenSplit.cacheCreationTokens += stats.tokenSplit.cacheCreationTokens;
		} else {
			unsplitTokens += stats.tokens;
		}

		if (stats.oldestTimestamp) {
			if (!oldestTimestamp || new Date(stats.oldestTimestamp) < new Date(oldestTimestamp)) {
				oldestTimestamp = stats.oldestTimestamp;
			}
		}
	}

	return {
		totalSessions,
		totalMessages,
		totalCostUsd,
		totalSizeBytes,
		totalTokens,
		tokenSplit,
		unsplitTokens,
		oldestTimestamp,
	};
}
