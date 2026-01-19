/**
 * Agent Sessions IPC Handlers
 *
 * This module provides generic IPC handlers for agent session management
 * that work with any agent supporting the AgentSessionStorage interface.
 *
 * This is the preferred API for new code. The window.maestro.claude.* API
 * remains for backwards compatibility but logs deprecation warnings.
 *
 * Usage:
 * - window.maestro.agentSessions.list(agentId, projectPath)
 * - window.maestro.agentSessions.read(agentId, projectPath, sessionId)
 * - window.maestro.agentSessions.search(agentId, projectPath, query, mode)
 * - window.maestro.agentSessions.getGlobalStats() - aggregates from all providers
 */

import { ipcMain, BrowserWindow } from 'electron';
import Store from 'electron-store';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import {
	getSessionStorage,
	hasSessionStorage,
	getAllSessionStorages,
} from '../../agent-session-storage';
import { calculateClaudeCost } from '../../utils/pricing';
import {
	loadGlobalStatsCache,
	saveGlobalStatsCache,
	GlobalStatsCache,
	CachedSessionStats,
	GLOBAL_STATS_CACHE_VERSION,
} from '../../utils/statsCache';
import type {
	AgentSessionInfo,
	PaginatedSessionsResult,
	SessionMessagesResult,
	SessionSearchResult,
	SessionSearchMode,
	SessionListOptions,
	SessionReadOptions,
} from '../../agent-session-storage';
import type { GlobalAgentStats, ProviderStats, SshRemoteConfig } from '../../../shared/types';
import type { MaestroSettings } from './persistence';

// Re-export for backwards compatibility
export type { GlobalAgentStats, ProviderStats };

const LOG_CONTEXT = '[AgentSessions]';

/**
 * Generic agent session origins data structure
 * Structure: { [agentId]: { [projectPath]: { [sessionId]: { origin, sessionName, starred } } } }
 */
export interface AgentSessionOriginsData {
	origins: Record<
		string,
		Record<
			string,
			Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>
		>
	>;
}

/**
 * Dependencies required for agent sessions handlers
 */
export interface AgentSessionsHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	agentSessionOriginsStore?: Store<AgentSessionOriginsData>;
	/** Settings store for SSH remote configuration lookup */
	settingsStore?: Store<MaestroSettings>;
}

// Module-level reference to settings store (set during registration)
let agentSessionsSettingsStore: Store<MaestroSettings> | undefined;

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found or store not provided.
 */
function getSshRemoteById(sshRemoteId: string): SshRemoteConfig | undefined {
	if (!agentSessionsSettingsStore) {
		logger.warn(`${LOG_CONTEXT} Settings store not available for SSH remote lookup`, LOG_CONTEXT);
		return undefined;
	}
	const sshRemotes = agentSessionsSettingsStore.get('sshRemotes', []) as SshRemoteConfig[];
	return sshRemotes.find((r) => r.id === sshRemoteId && r.enabled);
}

/**
 * Helper function to create consistent handler options
 */
function handlerOpts(operation: string) {
	return { context: LOG_CONTEXT, operation, logSuccess: false };
}

/**
 * File info for incremental scanning
 */
interface SessionFileInfo {
	filePath: string;
	sessionKey: string;
	mtimeMs: number;
}

/**
 * Parse a Claude Code session file and extract stats
 */
function parseClaudeSessionContent(
	content: string,
	sizeBytes: number
): Omit<CachedSessionStats, 'fileMtimeMs'> {
	const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
	const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;

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

	return {
		messages: userMessageCount + assistantMessageCount,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		cachedInputTokens: 0,
		sizeBytes,
	};
}

/**
 * Parse a Codex session file and extract stats
 */
function parseCodexSessionContent(
	content: string,
	sizeBytes: number
): Omit<CachedSessionStats, 'fileMtimeMs'> {
	const lines = content.split('\n').filter((l) => l.trim());

	let messageCount = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedTokens = 0;

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);

			// Count messages from response_item entries
			if (entry.type === 'response_item' && entry.payload?.type === 'message') {
				const role = entry.payload.role;
				if (role === 'user' || role === 'assistant') {
					messageCount++;
				}
			}

			// Extract token usage from event_msg with token_count payload
			if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
				const usage = entry.payload.info?.total_token_usage;
				if (usage) {
					inputTokens += usage.input_tokens || 0;
					outputTokens += usage.output_tokens || 0;
					outputTokens += usage.reasoning_output_tokens || 0;
					cachedTokens += usage.cached_input_tokens || 0;
				}
			}
		} catch {
			// Skip malformed lines
		}
	}

	return {
		messages: messageCount,
		inputTokens,
		outputTokens,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		cachedInputTokens: cachedTokens,
		sizeBytes,
	};
}

/**
 * Discover Claude Code session files from ~/.claude/projects/
 * Returns list of files with their mtime for cache comparison
 */
async function discoverClaudeSessionFiles(): Promise<SessionFileInfo[]> {
	const homeDir = os.homedir();
	const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
	const files: SessionFileInfo[] = [];

	try {
		await fs.access(claudeProjectsDir);
	} catch {
		return files;
	}

	const projectDirs = await fs.readdir(claudeProjectsDir);

	for (const projectDir of projectDirs) {
		const projectPath = path.join(claudeProjectsDir, projectDir);
		try {
			const stat = await fs.stat(projectPath);
			if (!stat.isDirectory()) continue;

			const dirFiles = await fs.readdir(projectPath);
			const sessionFiles = dirFiles.filter((f) => f.endsWith('.jsonl'));

			for (const filename of sessionFiles) {
				const filePath = path.join(projectPath, filename);
				try {
					const fileStat = await fs.stat(filePath);
					// Skip 0-byte sessions (created but abandoned before any content was written)
					if (fileStat.size === 0) continue;
					const sessionKey = `${projectDir}/${filename.replace('.jsonl', '')}`;
					files.push({ filePath, sessionKey, mtimeMs: fileStat.mtimeMs });
				} catch {
					// Skip files we can't stat
				}
			}
		} catch {
			// Skip directories we can't access
		}
	}

	return files;
}

/**
 * Discover Codex session files from ~/.codex/sessions/YYYY/MM/DD/
 * Returns list of files with their mtime for cache comparison
 */
async function discoverCodexSessionFiles(): Promise<SessionFileInfo[]> {
	const homeDir = os.homedir();
	const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');
	const files: SessionFileInfo[] = [];

	try {
		await fs.access(codexSessionsDir);
	} catch {
		return files;
	}

	const years = await fs.readdir(codexSessionsDir);
	for (const year of years) {
		if (!/^\d{4}$/.test(year)) continue;
		const yearDir = path.join(codexSessionsDir, year);

		try {
			const yearStat = await fs.stat(yearDir);
			if (!yearStat.isDirectory()) continue;

			const months = await fs.readdir(yearDir);
			for (const month of months) {
				if (!/^\d{2}$/.test(month)) continue;
				const monthDir = path.join(yearDir, month);

				try {
					const monthStat = await fs.stat(monthDir);
					if (!monthStat.isDirectory()) continue;

					const days = await fs.readdir(monthDir);
					for (const day of days) {
						if (!/^\d{2}$/.test(day)) continue;
						const dayDir = path.join(monthDir, day);

						try {
							const dayStat = await fs.stat(dayDir);
							if (!dayStat.isDirectory()) continue;

							const dirFiles = await fs.readdir(dayDir);
							for (const file of dirFiles) {
								if (!file.endsWith('.jsonl')) continue;
								const filePath = path.join(dayDir, file);

								try {
									const fileStat = await fs.stat(filePath);
									// Skip 0-byte sessions (created but abandoned before any content was written)
									if (fileStat.size === 0) continue;
									const sessionKey = `${year}/${month}/${day}/${file.replace('.jsonl', '')}`;
									files.push({ filePath, sessionKey, mtimeMs: fileStat.mtimeMs });
								} catch {
									// Skip files we can't stat
								}
							}
						} catch {
							continue;
						}
					}
				} catch {
					continue;
				}
			}
		} catch {
			continue;
		}
	}

	return files;
}

/**
 * Calculate aggregated stats from cached sessions for a provider
 */
function aggregateProviderStats(
	sessions: Record<string, CachedSessionStats>,
	hasCostData: boolean
): {
	sessions: number;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	cachedInputTokens: number;
	sizeBytes: number;
	costUsd: number;
	hasCostData: boolean;
} {
	let totalMessages = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheReadTokens = 0;
	let totalCacheCreationTokens = 0;
	let totalCachedInputTokens = 0;
	let totalSizeBytes = 0;

	for (const stats of Object.values(sessions)) {
		totalMessages += stats.messages;
		totalInputTokens += stats.inputTokens;
		totalOutputTokens += stats.outputTokens;
		totalCacheReadTokens += stats.cacheReadTokens;
		totalCacheCreationTokens += stats.cacheCreationTokens;
		totalCachedInputTokens += stats.cachedInputTokens;
		totalSizeBytes += stats.sizeBytes;
	}

	const costUsd = hasCostData
		? calculateClaudeCost(
				totalInputTokens,
				totalOutputTokens,
				totalCacheReadTokens,
				totalCacheCreationTokens
			)
		: 0;

	return {
		sessions: Object.keys(sessions).length,
		messages: totalMessages,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		cacheReadTokens: totalCacheReadTokens,
		cacheCreationTokens: totalCacheCreationTokens,
		cachedInputTokens: totalCachedInputTokens,
		sizeBytes: totalSizeBytes,
		costUsd,
		hasCostData,
	};
}

/**
 * Register all agent sessions IPC handlers.
 */
export function registerAgentSessionsHandlers(deps?: AgentSessionsHandlerDependencies): void {
	const getMainWindow = deps?.getMainWindow;

	// Store settings reference for SSH remote lookups
	agentSessionsSettingsStore = deps?.settingsStore;

	// ============ List Sessions ============

	ipcMain.handle(
		'agentSessions:list',
		withIpcErrorLogging(
			handlerOpts('list'),
			async (
				agentId: string,
				projectPath: string,
				sshRemoteId?: string
			): Promise<AgentSessionInfo[]> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return [];
				}

				// Get SSH config if provided
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;

				const sessions = await storage.listSessions(projectPath, sshConfig);
				logger.info(
					`Listed ${sessions.length} sessions for agent ${agentId} at ${projectPath}${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return sessions;
			}
		)
	);

	// ============ List Sessions Paginated ============

	ipcMain.handle(
		'agentSessions:listPaginated',
		withIpcErrorLogging(
			handlerOpts('listPaginated'),
			async (
				agentId: string,
				projectPath: string,
				options?: SessionListOptions,
				sshRemoteId?: string
			): Promise<PaginatedSessionsResult> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return { sessions: [], hasMore: false, totalCount: 0, nextCursor: null };
				}

				// Get SSH config if provided
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;

				const result = await storage.listSessionsPaginated(projectPath, options, sshConfig);
				logger.info(
					`Listed paginated sessions for agent ${agentId}: ${result.sessions.length} of ${result.totalCount}${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return result;
			}
		)
	);

	// ============ Read Session Messages ============

	ipcMain.handle(
		'agentSessions:read',
		withIpcErrorLogging(
			handlerOpts('read'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				options?: SessionReadOptions,
				sshRemoteId?: string
			): Promise<SessionMessagesResult> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return { messages: [], total: 0, hasMore: false };
				}

				// Get SSH config if provided
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;

				const result = await storage.readSessionMessages(
					projectPath,
					sessionId,
					options,
					sshConfig
				);
				logger.info(
					`Read ${result.messages.length} messages for session ${sessionId} (agent: ${agentId})${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return result;
			}
		)
	);

	// ============ Search Sessions ============

	ipcMain.handle(
		'agentSessions:search',
		withIpcErrorLogging(
			handlerOpts('search'),
			async (
				agentId: string,
				projectPath: string,
				query: string,
				searchMode: SessionSearchMode,
				sshRemoteId?: string
			): Promise<SessionSearchResult[]> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return [];
				}

				// Get SSH config if provided
				const sshConfig = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;

				const results = await storage.searchSessions(projectPath, query, searchMode, sshConfig);
				logger.info(
					`Found ${results.length} matching sessions for query "${query}" (agent: ${agentId})${sshRemoteId ? ' (remote via SSH)' : ''}`,
					LOG_CONTEXT
				);
				return results;
			}
		)
	);

	// ============ Get Session Path ============

	ipcMain.handle(
		'agentSessions:getPath',
		withIpcErrorLogging(
			handlerOpts('getPath'),
			async (agentId: string, projectPath: string, sessionId: string): Promise<string | null> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return null;
				}

				return storage.getSessionPath(projectPath, sessionId);
			}
		)
	);

	// ============ Delete Message Pair ============

	ipcMain.handle(
		'agentSessions:deleteMessagePair',
		withIpcErrorLogging(
			handlerOpts('deleteMessagePair'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				userMessageUuid: string,
				fallbackContent?: string
			): Promise<{ success: boolean; error?: string; linesRemoved?: number }> => {
				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return { success: false, error: `No session storage available for agent: ${agentId}` };
				}

				return storage.deleteMessagePair(projectPath, sessionId, userMessageUuid, fallbackContent);
			}
		)
	);

	// ============ Check Storage Availability ============

	ipcMain.handle(
		'agentSessions:hasStorage',
		withIpcErrorLogging(handlerOpts('hasStorage'), async (agentId: string): Promise<boolean> => {
			return hasSessionStorage(agentId);
		})
	);

	// ============ Get Available Storages ============

	ipcMain.handle(
		'agentSessions:getAvailableStorages',
		withIpcErrorLogging(handlerOpts('getAvailableStorages'), async (): Promise<string[]> => {
			const storages = getAllSessionStorages();
			return storages.map((s) => s.agentId);
		})
	);

	// ============ Get All Named Sessions ============

	ipcMain.handle(
		'agentSessions:getAllNamedSessions',
		withIpcErrorLogging(
			handlerOpts('getAllNamedSessions'),
			async (): Promise<
				Array<{
					agentId: string;
					agentSessionId: string;
					projectPath: string;
					sessionName: string;
					starred?: boolean;
					lastActivityAt?: number;
				}>
			> => {
				// Aggregate named sessions from all providers that support it
				const allNamedSessions: Array<{
					agentId: string;
					agentSessionId: string;
					projectPath: string;
					sessionName: string;
					starred?: boolean;
					lastActivityAt?: number;
				}> = [];

				const storages = getAllSessionStorages();
				for (const storage of storages) {
					if (
						'getAllNamedSessions' in storage &&
						typeof storage.getAllNamedSessions === 'function'
					) {
						try {
							const sessions = await storage.getAllNamedSessions();
							allNamedSessions.push(
								...sessions.map(
									(session: {
										agentSessionId: string;
										projectPath: string;
										sessionName: string;
										starred?: boolean;
										lastActivityAt?: number;
									}) => ({
										agentId: storage.agentId,
										...session,
									})
								)
							);
						} catch (error) {
							logger.warn(
								`Failed to get named sessions from ${storage.agentId}: ${error}`,
								LOG_CONTEXT
							);
						}
					}
				}

				logger.info(
					`Found ${allNamedSessions.length} named sessions across all providers`,
					LOG_CONTEXT
				);
				return allNamedSessions;
			}
		)
	);

	// ============ Session Origins (Generic - for non-Claude agents) ============
	// These handlers manage session metadata like names and starred status for all agents

	const originsStore = deps?.agentSessionOriginsStore;

	ipcMain.handle(
		'agentSessions:getOrigins',
		withIpcErrorLogging(
			handlerOpts('getOrigins'),
			async (
				agentId: string,
				projectPath: string
			): Promise<
				Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>
			> => {
				if (!originsStore) {
					logger.warn('Origins store not available for getOrigins', LOG_CONTEXT);
					return {};
				}
				const allOrigins = originsStore.get('origins', {});
				const agentOrigins = allOrigins[agentId] || {};
				const result = agentOrigins[projectPath] || {};
				logger.info(
					`getOrigins(${agentId}, ${projectPath}): found ${Object.keys(result).length} entries`,
					LOG_CONTEXT
				);
				return result;
			}
		)
	);

	ipcMain.handle(
		'agentSessions:setSessionName',
		withIpcErrorLogging(
			handlerOpts('setSessionName'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				sessionName: string | null
			): Promise<void> => {
				if (!originsStore) {
					logger.warn('Origins store not available', LOG_CONTEXT);
					return;
				}
				const allOrigins = originsStore.get('origins', {});
				if (!allOrigins[agentId]) allOrigins[agentId] = {};
				if (!allOrigins[agentId][projectPath]) allOrigins[agentId][projectPath] = {};

				if (sessionName) {
					allOrigins[agentId][projectPath][sessionId] = {
						...allOrigins[agentId][projectPath][sessionId],
						sessionName,
					};
				} else {
					// Remove sessionName
					const existing = allOrigins[agentId][projectPath][sessionId];
					if (existing) {
						delete existing.sessionName;
						// Clean up if empty
						if (!existing.starred && !existing.origin) {
							delete allOrigins[agentId][projectPath][sessionId];
						}
					}
				}
				originsStore.set('origins', allOrigins);
				logger.info(`Set session name for ${agentId}/${sessionId}: ${sessionName}`, LOG_CONTEXT);
			}
		)
	);

	ipcMain.handle(
		'agentSessions:setSessionStarred',
		withIpcErrorLogging(
			handlerOpts('setSessionStarred'),
			async (
				agentId: string,
				projectPath: string,
				sessionId: string,
				starred: boolean
			): Promise<void> => {
				if (!originsStore) {
					logger.warn('Origins store not available', LOG_CONTEXT);
					return;
				}
				const allOrigins = originsStore.get('origins', {});
				if (!allOrigins[agentId]) allOrigins[agentId] = {};
				if (!allOrigins[agentId][projectPath]) allOrigins[agentId][projectPath] = {};

				if (starred) {
					allOrigins[agentId][projectPath][sessionId] = {
						...allOrigins[agentId][projectPath][sessionId],
						starred: true,
					};
				} else {
					// Remove starred
					const existing = allOrigins[agentId][projectPath][sessionId];
					if (existing) {
						delete existing.starred;
						// Clean up if empty
						if (!existing.sessionName && !existing.origin) {
							delete allOrigins[agentId][projectPath][sessionId];
						}
					}
				}
				originsStore.set('origins', allOrigins);
				logger.info(`Set session starred for ${agentId}/${sessionId}: ${starred}`, LOG_CONTEXT);
			}
		)
	);

	// ============ Get Global Stats (All Providers) ============

	ipcMain.handle(
		'agentSessions:getGlobalStats',
		withIpcErrorLogging(handlerOpts('getGlobalStats'), async (): Promise<GlobalAgentStats> => {
			const mainWindow = getMainWindow?.();

			// Helper to build result from cache
			const buildResultFromCache = (
				cache: GlobalStatsCache,
				isComplete: boolean
			): GlobalAgentStats => {
				const result: GlobalAgentStats = {
					totalSessions: 0,
					totalMessages: 0,
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCacheReadTokens: 0,
					totalCacheCreationTokens: 0,
					totalCostUsd: 0,
					hasCostData: false,
					totalSizeBytes: 0,
					isComplete,
					byProvider: {},
				};

				// Aggregate Claude Code stats
				const claudeSessions = cache.providers['claude-code']?.sessions || {};
				const claudeAgg = aggregateProviderStats(claudeSessions, true);
				if (claudeAgg.sessions > 0) {
					result.byProvider['claude-code'] = {
						sessions: claudeAgg.sessions,
						messages: claudeAgg.messages,
						inputTokens: claudeAgg.inputTokens,
						outputTokens: claudeAgg.outputTokens,
						costUsd: claudeAgg.costUsd,
						hasCostData: true,
					};
					result.totalSessions += claudeAgg.sessions;
					result.totalMessages += claudeAgg.messages;
					result.totalInputTokens += claudeAgg.inputTokens;
					result.totalOutputTokens += claudeAgg.outputTokens;
					result.totalCacheReadTokens += claudeAgg.cacheReadTokens;
					result.totalCacheCreationTokens += claudeAgg.cacheCreationTokens;
					result.totalCostUsd += claudeAgg.costUsd;
					result.totalSizeBytes += claudeAgg.sizeBytes;
					result.hasCostData = true;
				}

				// Aggregate Codex stats
				const codexSessions = cache.providers['codex']?.sessions || {};
				const codexAgg = aggregateProviderStats(codexSessions, false);
				if (codexAgg.sessions > 0) {
					result.byProvider['codex'] = {
						sessions: codexAgg.sessions,
						messages: codexAgg.messages,
						inputTokens: codexAgg.inputTokens,
						outputTokens: codexAgg.outputTokens,
						costUsd: 0,
						hasCostData: false,
					};
					result.totalSessions += codexAgg.sessions;
					result.totalMessages += codexAgg.messages;
					result.totalInputTokens += codexAgg.inputTokens;
					result.totalOutputTokens += codexAgg.outputTokens;
					result.totalCacheReadTokens += codexAgg.cachedInputTokens;
					result.totalSizeBytes += codexAgg.sizeBytes;
				}

				return result;
			};

			// Helper to send progressive updates
			const sendUpdate = (cache: GlobalStatsCache, isComplete: boolean) => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					const stats = buildResultFromCache(cache, isComplete);
					mainWindow.webContents.send('agentSessions:globalStatsUpdate', stats);
				}
			};

			// Load existing cache or create new one
			let cache = await loadGlobalStatsCache();
			if (!cache) {
				cache = {
					version: GLOBAL_STATS_CACHE_VERSION,
					lastUpdated: Date.now(),
					providers: {},
				};
			}

			// Ensure provider entries exist
			if (!cache.providers['claude-code']) {
				cache.providers['claude-code'] = { sessions: {} };
			}
			if (!cache.providers['codex']) {
				cache.providers['codex'] = { sessions: {} };
			}

			// Discover all session files
			logger.info('Discovering session files for global stats', LOG_CONTEXT);
			const [claudeFiles, codexFiles] = await Promise.all([
				discoverClaudeSessionFiles(),
				discoverCodexSessionFiles(),
			]);

			// Build sets of current session keys for archive detection
			const currentClaudeKeys = new Set(claudeFiles.map((f) => f.sessionKey));
			const currentCodexKeys = new Set(codexFiles.map((f) => f.sessionKey));

			// Mark deleted sessions as archived (preserve stats for lifetime cost tracking)
			for (const key of Object.keys(cache.providers['claude-code'].sessions)) {
				const session = cache.providers['claude-code'].sessions[key];
				if (!currentClaudeKeys.has(key)) {
					// Source file deleted - mark as archived to preserve stats
					session.archived = true;
				} else if (session.archived) {
					// Source file reappeared - mark as active (will be re-parsed below)
					session.archived = false;
				}
			}
			for (const key of Object.keys(cache.providers['codex'].sessions)) {
				const session = cache.providers['codex'].sessions[key];
				if (!currentCodexKeys.has(key)) {
					// Source file deleted - mark as archived to preserve stats
					session.archived = true;
				} else if (session.archived) {
					// Source file reappeared - mark as active (will be re-parsed below)
					session.archived = false;
				}
			}

			// Find sessions that need processing (new or modified)
			const claudeToProcess = claudeFiles.filter((f) => {
				const cached = cache!.providers['claude-code'].sessions[f.sessionKey];
				return !cached || cached.fileMtimeMs < f.mtimeMs;
			});
			const codexToProcess = codexFiles.filter((f) => {
				const cached = cache!.providers['codex'].sessions[f.sessionKey];
				return !cached || cached.fileMtimeMs < f.mtimeMs;
			});

			const totalToProcess = claudeToProcess.length + codexToProcess.length;
			const cachedCount = claudeFiles.length + codexFiles.length - totalToProcess;

			logger.info(
				`Global stats: ${totalToProcess} to process (${claudeToProcess.length} Claude, ${codexToProcess.length} Codex), ${cachedCount} cached`,
				LOG_CONTEXT
			);

			// Send initial update with cached data
			sendUpdate(cache, totalToProcess === 0);

			// Process Claude sessions incrementally
			let processedCount = 0;
			for (const file of claudeToProcess) {
				try {
					const content = await fs.readFile(file.filePath, 'utf-8');
					const fileStat = await fs.stat(file.filePath);
					const stats = parseClaudeSessionContent(content, fileStat.size);

					cache.providers['claude-code'].sessions[file.sessionKey] = {
						...stats,
						fileMtimeMs: file.mtimeMs,
						archived: false,
					};

					processedCount++;

					// Send streaming update every 10 sessions or at end
					if (processedCount % 10 === 0 || processedCount === claudeToProcess.length) {
						sendUpdate(cache, false);
					}
				} catch (error) {
					logger.warn(`Failed to parse Claude session: ${file.sessionKey}`, LOG_CONTEXT, { error });
				}
			}

			// Process Codex sessions incrementally
			for (const file of codexToProcess) {
				try {
					const content = await fs.readFile(file.filePath, 'utf-8');
					const fileStat = await fs.stat(file.filePath);
					const stats = parseCodexSessionContent(content, fileStat.size);

					cache.providers['codex'].sessions[file.sessionKey] = {
						...stats,
						fileMtimeMs: file.mtimeMs,
						archived: false,
					};

					processedCount++;

					// Send streaming update every 10 sessions or at end
					if (processedCount % 10 === 0 || processedCount === totalToProcess) {
						sendUpdate(cache, false);
					}
				} catch (error) {
					logger.warn(`Failed to parse Codex session: ${file.sessionKey}`, LOG_CONTEXT, { error });
				}
			}

			// Update cache timestamp and save
			cache.lastUpdated = Date.now();
			await saveGlobalStatsCache(cache);

			// Build final result
			const result = buildResultFromCache(cache, true);

			logger.info(
				`Global stats complete: ${result.totalSessions} sessions, ${result.totalMessages} messages, $${result.totalCostUsd.toFixed(2)} (${totalToProcess} processed, ${cachedCount} cached)`,
				LOG_CONTEXT
			);

			// Send final update
			sendUpdate(cache, true);

			return result;
		})
	);
}
