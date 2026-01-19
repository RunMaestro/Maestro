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
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import Store from 'electron-store';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { CLAUDE_SESSION_PARSE_LIMITS } from '../../constants';
import { calculateClaudeCost } from '../../utils/pricing';
import {
	encodeClaudeProjectPath,
	loadStatsCache,
	saveStatsCache,
	SessionStatsCache,
	STATS_CACHE_VERSION,
} from '../../utils/statsCache';
import { app } from 'electron';

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

const LEGACY_GLOBAL_STATS_CACHE_VERSION = 1;

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

/**
 * Claude session origin types
 */
type ClaudeSessionOrigin = 'user' | 'auto';

interface ClaudeSessionOriginInfo {
	origin: ClaudeSessionOrigin;
	sessionName?: string;
	starred?: boolean;
	contextUsage?: number;
}

interface ClaudeSessionOriginsData {
	origins: Record<string, Record<string, ClaudeSessionOrigin | ClaudeSessionOriginInfo>>;
}

/**
 * Dependencies required for Claude handlers
 */
export interface ClaudeHandlerDependencies {
	claudeSessionOriginsStore: Store<ClaudeSessionOriginsData>;
	getMainWindow: () => BrowserWindow | null;
}

/**
 * Helper: Extract semantic text from message content
 * Skips images, tool_use, and tool_result - only returns actual text content
 */
function extractTextFromContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const textParts = content
			.filter((part: { type?: string }) => part.type === 'text')
			.map((part: { type?: string; text?: string }) => part.text || '')
			.filter((text: string) => text.trim());
		return textParts.join(' ');
	}
	return '';
}

/**
 * Register all Claude-related IPC handlers.
 */
export function registerClaudeHandlers(deps: ClaudeHandlerDependencies): void {
	const { claudeSessionOriginsStore, getMainWindow } = deps;

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

						// Fast regex-based extraction
						const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
						const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
						const messageCount = userMessageCount + assistantMessageCount;

						// Extract first meaningful message content
						for (
							let i = 0;
							i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES);
							i++
						) {
							try {
								const entry = JSON.parse(lines[i]);
								if (entry.type === 'user' && entry.message?.content) {
									const textContent = extractTextFromContent(entry.message.content);
									if (textContent.trim()) {
										firstUserMessage = textContent;
										timestamp = entry.timestamp || timestamp;
										break;
									}
								}
								if (!firstUserMessage && entry.type === 'assistant' && entry.message?.content) {
									const textContent = extractTextFromContent(entry.message.content);
									if (textContent.trim()) {
										firstUserMessage = textContent;
										timestamp = entry.timestamp || timestamp;
									}
								}
							} catch {
								// Skip malformed lines
							}
						}

						// Fast regex-based token extraction
						let totalInputTokens = 0;
						let totalOutputTokens = 0;
						let totalCacheReadTokens = 0;
						let totalCacheCreationTokens = 0;

						const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
						for (const m of inputMatches) totalInputTokens += parseInt(m[1], 10);

						const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
						for (const m of outputMatches) totalOutputTokens += parseInt(m[1], 10);

						const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
						for (const m of cacheReadMatches) totalCacheReadTokens += parseInt(m[1], 10);

						const cacheCreationMatches = content.matchAll(
							/"cache_creation_input_tokens"\s*:\s*(\d+)/g
						);
						for (const m of cacheCreationMatches) totalCacheCreationTokens += parseInt(m[1], 10);

						// Calculate cost estimate
						const costUsd = calculateClaudeCost(
							totalInputTokens,
							totalOutputTokens,
							totalCacheReadTokens,
							totalCacheCreationTokens
						);

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

							const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
							const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || [])
								.length;
							const messageCount = userMessageCount + assistantMessageCount;

							// Extract first meaningful message
							for (
								let i = 0;
								i < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES);
								i++
							) {
								try {
									const entry = JSON.parse(lines[i]);
									if (entry.type === 'user' && entry.message?.content) {
										const textContent = extractTextFromContent(entry.message.content);
										if (textContent.trim()) {
											firstUserMessage = textContent;
											timestamp = entry.timestamp || timestamp;
											break;
										}
									}
									if (!firstUserMessage && entry.type === 'assistant' && entry.message?.content) {
										const textContent = extractTextFromContent(entry.message.content);
										if (textContent.trim()) {
											firstUserMessage = textContent;
											timestamp = entry.timestamp || timestamp;
										}
									}
								} catch {
									// Skip malformed lines
								}
							}

							// Token extraction
							let totalInputTokens = 0;
							let totalOutputTokens = 0;
							let totalCacheReadTokens = 0;
							let totalCacheCreationTokens = 0;

							const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
							for (const m of inputMatches) totalInputTokens += parseInt(m[1], 10);

							const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
							for (const m of outputMatches) totalOutputTokens += parseInt(m[1], 10);

							const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
							for (const m of cacheReadMatches) totalCacheReadTokens += parseInt(m[1], 10);

							const cacheCreationMatches = content.matchAll(
								/"cache_creation_input_tokens"\s*:\s*(\d+)/g
							);
							for (const m of cacheCreationMatches) totalCacheCreationTokens += parseInt(m[1], 10);

							// Calculate cost
							const costUsd = calculateClaudeCost(
								totalInputTokens,
								totalOutputTokens,
								totalCacheReadTokens,
								totalCacheCreationTokens
							);

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
		withIpcErrorLogging(handlerOpts('getProjectStats'), async (projectPath: string) => {
			const mainWindow = getMainWindow();

			// Helper to send progressive updates to renderer
			const sendUpdate = (stats: {
				totalSessions: number;
				totalMessages: number;
				totalCostUsd: number;
				totalSizeBytes: number;
				totalTokens: number;
				oldestTimestamp: string | null;
				processedCount?: number;
				isComplete: boolean;
			}) => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send('claude:projectStatsUpdate', { projectPath, ...stats });
				}
			};

			// Helper to parse a single session file
			const parseSessionFile = async (content: string, fileStat: { size: number }) => {
				const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
				const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
				const messages = userMessageCount + assistantMessageCount;

				let inputTokens = 0;
				let outputTokens = 0;
				let cacheReadTokens = 0;
				let cacheCreationTokens = 0;

				const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
				for (const m of inputMatches) inputTokens += parseInt(m[1], 10);

				const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
				for (const m of outputMatches) outputTokens += parseInt(m[1], 10);

				const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
				for (const m of cacheReadMatches) cacheReadTokens += parseInt(m[1], 10);

				const cacheCreationMatches = content.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g);
				for (const m of cacheCreationMatches) cacheCreationTokens += parseInt(m[1], 10);

				const costUsd = calculateClaudeCost(
					inputTokens,
					outputTokens,
					cacheReadTokens,
					cacheCreationTokens
				);

				let oldestTimestamp: string | null = null;
				const lines = content.split('\n').filter((l) => l.trim());
				for (
					let j = 0;
					j < Math.min(lines.length, CLAUDE_SESSION_PARSE_LIMITS.OLDEST_TIMESTAMP_SCAN_LINES);
					j++
				) {
					try {
						const entry = JSON.parse(lines[j]);
						if (entry.timestamp) {
							oldestTimestamp = entry.timestamp;
							break;
						}
					} catch {
						// Skip malformed lines
					}
				}

				return {
					messages,
					costUsd,
					sizeBytes: fileStat.size,
					tokens: inputTokens + outputTokens,
					oldestTimestamp,
				};
			};

			const homeDir = os.homedir();
			const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
			const encodedPath = encodeClaudeProjectPath(projectPath);
			const projectDir = path.join(claudeProjectsDir, encodedPath);

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

			// Load existing cache
			const cache = await loadStatsCache(projectPath);

			// List all .jsonl files
			const files = await fs.readdir(projectDir);
			const sessionFiles = files.filter((f) => f.endsWith('.jsonl'));

			// Track which sessions need processing
			const sessionsToProcess: { filename: string; filePath: string; mtimeMs: number }[] = [];
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

					if (!cachedSession || cachedSession.fileMtimeMs < fileStat.mtimeMs) {
						sessionsToProcess.push({ filename, filePath, mtimeMs: fileStat.mtimeMs });
					}
				} catch {
					// Skip files we can't stat
				}
			}

			// Build new cache
			const newCache: SessionStatsCache = {
				version: STATS_CACHE_VERSION,
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

			// Copy still-valid cached sessions
			if (cache) {
				for (const [sessionId, sessionStats] of Object.entries(cache.sessions)) {
					if (
						currentSessionIds.has(sessionId) &&
						!sessionsToProcess.some((s) => s.filename.replace('.jsonl', '') === sessionId)
					) {
						newCache.sessions[sessionId] = sessionStats;
					}
				}
			}

			// Send immediate update with cached data (so UI shows something right away)
			if (Object.keys(newCache.sessions).length > 0) {
				const cachedTotals = calculateTotals(newCache);
				sendUpdate({ ...cachedTotals, isComplete: sessionsToProcess.length === 0 });
			}

			// Process new/modified sessions
			let processedCount = 0;
			for (const { filename, filePath, mtimeMs } of sessionsToProcess) {
				const sessionId = filename.replace('.jsonl', '');
				try {
					const content = await fs.readFile(filePath, 'utf-8');
					const fileStat = await fs.stat(filePath);
					const stats = await parseSessionFile(content, { size: fileStat.size });

					newCache.sessions[sessionId] = {
						fileMtimeMs: mtimeMs,
						...stats,
					};

					processedCount++;

					// Send progress update
					const totals = calculateTotals(newCache);
					sendUpdate({
						...totals,
						processedCount,
						isComplete: processedCount >= sessionsToProcess.length,
					});
				} catch (error) {
					logger.error(`Error parsing session file: ${filename}`, LOG_CONTEXT, error);
				}
			}

			// Calculate final totals
			const finalTotals = calculateTotals(newCache);

			// Save cache
			await saveStatsCache(projectPath, newCache);

			const cachedCount = Object.keys(newCache.sessions).length - sessionsToProcess.length;
			logger.info(
				`Project stats: ${sessionsToProcess.length} new/modified, ${cachedCount} cached, $${finalTotals.totalCostUsd.toFixed(2)}`,
				LOG_CONTEXT
			);

			return { ...finalTotals, isComplete: true };
		})
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
			const mainWindow = getMainWindow();

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
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send('claude:globalStatsUpdate', stats);
				}
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

				const totalCostUsd = calculateClaudeCost(
					totalInputTokens,
					totalOutputTokens,
					totalCacheReadTokens,
					totalCacheCreationTokens
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

					const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
					const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
					const messages = userMessageCount + assistantMessageCount;

					let inputTokens = 0;
					let outputTokens = 0;
					let cacheReadTokens = 0;
					let cacheCreationTokens = 0;

					const inputMatches = content.matchAll(/"input_tokens"\s*:\s*(\d+)/g);
					for (const m of inputMatches) inputTokens += parseInt(m[1], 10);

					const outputMatches = content.matchAll(/"output_tokens"\s*:\s*(\d+)/g);
					for (const m of outputMatches) outputTokens += parseInt(m[1], 10);

					const cacheReadMatches = content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g);
					for (const m of cacheReadMatches) cacheReadTokens += parseInt(m[1], 10);

					const cacheCreationMatches = content.matchAll(
						/"cache_creation_input_tokens"\s*:\s*(\d+)/g
					);
					for (const m of cacheCreationMatches) cacheCreationTokens += parseInt(m[1], 10);

					newCache.sessions[sessionKey] = {
						fileMtimeMs: mtimeMs,
						messages,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheCreationTokens,
						sizeBytes: fileStat.size,
					};

					processedCount++;

					// Send progress update
					const currentTotals = calculateGlobalTotals(newCache);
					sendUpdate({ ...currentTotals, isComplete: processedCount >= sessionsToProcess.length });
				} catch (error) {
					logger.error(`Error parsing global session file: ${sessionKey}`, LOG_CONTEXT, error);
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
				const origins = claudeSessionOriginsStore.get('origins', {});
				if (!origins[projectPath]) {
					origins[projectPath] = {};
				}
				origins[projectPath][agentSessionId] = sessionName ? { origin, sessionName } : origin;
				claudeSessionOriginsStore.set('origins', origins);
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
				const origins = claudeSessionOriginsStore.get('origins', {});
				if (!origins[projectPath]) {
					origins[projectPath] = {};
				}
				const existing = origins[projectPath][agentSessionId];
				if (typeof existing === 'string') {
					origins[projectPath][agentSessionId] = { origin: existing, sessionName };
				} else if (existing) {
					origins[projectPath][agentSessionId] = { ...existing, sessionName };
				} else {
					origins[projectPath][agentSessionId] = { origin: 'user', sessionName };
				}
				claudeSessionOriginsStore.set('origins', origins);
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
				const origins = claudeSessionOriginsStore.get('origins', {});
				if (!origins[projectPath]) {
					origins[projectPath] = {};
				}
				const existing = origins[projectPath][agentSessionId];
				if (typeof existing === 'string') {
					origins[projectPath][agentSessionId] = { origin: existing, starred };
				} else if (existing) {
					origins[projectPath][agentSessionId] = { ...existing, starred };
				} else {
					origins[projectPath][agentSessionId] = { origin: 'user', starred };
				}
				claudeSessionOriginsStore.set('origins', origins);
				logger.debug(
					`Updated Claude session starred: ${agentSessionId} = ${starred}`,
					ORIGINS_LOG_CONTEXT,
					{ projectPath }
				);
				return true;
			}
		)
	);

	ipcMain.handle(
		'claude:updateSessionContextUsage',
		withIpcErrorLogging(
			handlerOpts('updateSessionContextUsage', ORIGINS_LOG_CONTEXT),
			async (projectPath: string, agentSessionId: string, contextUsage: number) => {
				const origins = claudeSessionOriginsStore.get('origins', {});
				if (!origins[projectPath]) {
					origins[projectPath] = {};
				}
				const existing = origins[projectPath][agentSessionId];
				if (typeof existing === 'string') {
					origins[projectPath][agentSessionId] = { origin: existing, contextUsage };
				} else if (existing) {
					origins[projectPath][agentSessionId] = { ...existing, contextUsage };
				} else {
					origins[projectPath][agentSessionId] = { origin: 'user', contextUsage };
				}
				claudeSessionOriginsStore.set('origins', origins);
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
 * Helper to calculate totals from session stats cache
 */
function calculateTotals(cache: SessionStatsCache) {
	let totalSessions = 0;
	let totalMessages = 0;
	let totalCostUsd = 0;
	let totalSizeBytes = 0;
	let totalTokens = 0;
	let oldestTimestamp: string | null = null;

	for (const stats of Object.values(cache.sessions)) {
		totalSessions++;
		totalMessages += stats.messages;
		totalCostUsd += stats.costUsd;
		totalSizeBytes += stats.sizeBytes;
		totalTokens += stats.tokens;

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
		oldestTimestamp,
	};
}
