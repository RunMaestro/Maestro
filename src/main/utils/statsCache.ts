/**
 * statsCache.ts - Claude session statistics caching utilities
 *
 * Provides caching for Claude Code session statistics to improve performance
 * when browsing session history. Supports both per-project and global stats.
 *
 * Cache invalidation is handled via version numbers - bump the version constants
 * to force cache refresh when the data structure changes.
 */

import { app } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { logger } from './logger';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';
import { captureException } from './sentry';
import { readVersionedJsonCache } from './json-file-readers';

// Re-export so existing consumers don't need import changes
export { encodeClaudeProjectPath };

// ============================================================================
// Per-Project Stats Cache
// ============================================================================

/**
 * Per-session stats stored in the per-project cache.
 *
 * IMPORTANT: Archive Preservation Pattern
 * ----------------------------------------
 * When a JSONL session file is deleted from disk (e.g., by Claude Code cleanup),
 * the session is marked as `archived: true` rather than being removed from cache.
 * This ensures lifetime statistics (costs, messages, tokens, oldest timestamp)
 * survive file cleanup.
 *
 * This pattern mirrors the global stats cache behavior in agentSessions.ts.
 * Both caches MUST use the same archive-preservation approach to maintain
 * consistency between the Sessions Browser and About modal statistics.
 *
 * If you modify this behavior, you MUST also update:
 * - agentSessions.ts: getGlobalStats handler (global cache archive logic)
 * - claude.ts: getProjectStats handler (per-project cache archive logic)
 * - statsCache.test.ts: Archive preservation test cases
 */
export interface PerProjectSessionStats {
	messages: number;
	costUsd: number;
	sizeBytes: number;
	tokens: number;
	oldestTimestamp: string | null;
	/** File modification time to detect external changes */
	fileMtimeMs: number;
	/**
	 * Whether the source JSONL file has been deleted.
	 * Archived sessions are preserved in cache so lifetime stats survive file cleanup.
	 * If the file reappears, this flag is set back to false and the session is re-parsed.
	 */
	archived?: boolean;
}

/**
 * Per-project session statistics cache structure.
 * Stores stats for all Claude Code sessions within a specific project directory.
 *
 * IMPORTANT: This cache preserves session metadata even after JSONL files are deleted.
 * See PerProjectSessionStats for the archive preservation pattern documentation.
 */
export interface SessionStatsCache {
	/** Per-session stats keyed by session ID */
	sessions: Record<string, PerProjectSessionStats>;
	/** Aggregate totals computed from all sessions */
	totals: {
		totalSessions: number;
		totalMessages: number;
		totalCostUsd: number;
		totalSizeBytes: number;
		totalTokens: number;
		oldestTimestamp: string | null;
	};
	/** Unix timestamp when cache was last updated */
	lastUpdated: number;
	/** Cache version - bump to invalidate old caches */
	version: number;
}

/**
 * Current per-project stats cache version. Bump to force cache invalidation.
 *
 * Version history:
 * - v1: Initial version (sessions dropped when JSONL files deleted - BUG)
 * - v2: Added archived flag to preserve session stats when JSONL files are deleted
 */
export const STATS_CACHE_VERSION = 2;

function isCacheRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isSessionStatsCache(value: unknown): value is SessionStatsCache {
	if (!isCacheRecord(value) || !isCacheRecord(value.sessions) || !isCacheRecord(value.totals)) {
		return false;
	}
	if (
		!isNumber(value.version) ||
		!isNumber(value.lastUpdated) ||
		!isNumber(value.totals.totalSessions) ||
		!isNumber(value.totals.totalMessages) ||
		!isNumber(value.totals.totalCostUsd) ||
		!isNumber(value.totals.totalSizeBytes) ||
		!isNumber(value.totals.totalTokens) ||
		!(typeof value.totals.oldestTimestamp === 'string' || value.totals.oldestTimestamp === null)
	) {
		return false;
	}

	return Object.values(value.sessions).every((session) => {
		if (!isCacheRecord(session)) return false;
		return (
			isNumber(session.messages) &&
			isNumber(session.costUsd) &&
			isNumber(session.sizeBytes) &&
			isNumber(session.tokens) &&
			isNumber(session.fileMtimeMs) &&
			(typeof session.oldestTimestamp === 'string' || session.oldestTimestamp === null) &&
			(session.archived === undefined || typeof session.archived === 'boolean')
		);
	});
}

/**
 * Get the cache file path for a project's stats.
 * @param projectPath - The project directory path
 * @returns Absolute path to the cache JSON file
 */
function getStatsCachePath(projectPath: string): string {
	const encodedPath = encodeClaudeProjectPath(projectPath);
	return path.join(app.getPath('userData'), 'stats-cache', `${encodedPath}.json`);
}

/**
 * Load stats cache for a project.
 * Returns null if cache doesn't exist, is corrupted, or has version mismatch.
 * @param projectPath - The project directory path
 */
export async function loadStatsCache(projectPath: string): Promise<SessionStatsCache | null> {
	return readVersionedJsonCache(
		getStatsCachePath(projectPath),
		STATS_CACHE_VERSION,
		isSessionStatsCache
	);
}

/**
 * Save stats cache for a project.
 * Creates the cache directory if it doesn't exist.
 * @param projectPath - The project directory path
 * @param cache - The cache object to save
 */
export async function saveStatsCache(projectPath: string, cache: SessionStatsCache): Promise<void> {
	try {
		const cachePath = getStatsCachePath(projectPath);
		const cacheDir = path.dirname(cachePath);
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(cache), 'utf-8');
	} catch (error) {
		void captureException(error);
		logger.warn('Failed to save stats cache', 'ClaudeSessions', { projectPath, error });
	}
}

// ============================================================================
// Global Stats Cache
// ============================================================================

/**
 * Per-session cached stats
 */
export interface CachedSessionStats {
	messages: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	cachedInputTokens: number;
	sizeBytes: number;
	/**
	 * Per-model cost (USD) computed at parse time. Optional for backward
	 * compatibility with cache entries written before per-model pricing; absent
	 * entries fall back to flat-rate pricing derived from the token counts.
	 */
	costUsd?: number;
	/** File modification time to detect external changes */
	fileMtimeMs: number;
	/**
	 * Whether the source JSONL file has been deleted.
	 * Archived sessions are preserved in cache so lifetime costs survive file cleanup.
	 */
	archived?: boolean;
}

/**
 * Global statistics cache structure (for About modal).
 * Aggregates stats across all agent sessions from all projects.
 */
export interface GlobalStatsCache {
	/** Per-provider session stats, keyed by provider then "projectDir/sessionId" or "date/sessionId" */
	providers: Record<
		string,
		{
			sessions: Record<string, CachedSessionStats>;
		}
	>;
	/** Unix timestamp when cache was last updated */
	lastUpdated: number;
	/** Cache version - bump to invalidate old caches */
	version: number;
}

/** Current global stats cache version. Bump to force cache invalidation. */
export const GLOBAL_STATS_CACHE_VERSION = 3;

function isGlobalStatsCache(value: unknown): value is GlobalStatsCache {
	if (!isCacheRecord(value) || !isCacheRecord(value.providers)) return false;
	if (!isNumber(value.version) || !isNumber(value.lastUpdated)) return false;

	return Object.values(value.providers).every((provider) => {
		if (!isCacheRecord(provider) || !isCacheRecord(provider.sessions)) return false;
		return Object.values(provider.sessions).every((session) => {
			if (!isCacheRecord(session)) return false;
			return (
				isNumber(session.messages) &&
				isNumber(session.inputTokens) &&
				isNumber(session.outputTokens) &&
				isNumber(session.cacheReadTokens) &&
				isNumber(session.cacheCreationTokens) &&
				isNumber(session.cachedInputTokens) &&
				isNumber(session.sizeBytes) &&
				isNumber(session.fileMtimeMs) &&
				(session.costUsd === undefined || isNumber(session.costUsd)) &&
				(session.archived === undefined || typeof session.archived === 'boolean')
			);
		});
	});
}

/**
 * Get the cache file path for global stats.
 * @returns Absolute path to the global stats cache JSON file
 */
function getGlobalStatsCachePath(): string {
	return path.join(app.getPath('userData'), 'stats-cache', 'global-stats.json');
}

/**
 * Load global stats cache.
 * Returns null if cache doesn't exist, is corrupted, or has version mismatch.
 */
export async function loadGlobalStatsCache(): Promise<GlobalStatsCache | null> {
	return readVersionedJsonCache(
		getGlobalStatsCachePath(),
		GLOBAL_STATS_CACHE_VERSION,
		isGlobalStatsCache
	);
}

/**
 * Save global stats cache.
 * Creates the cache directory if it doesn't exist.
 * @param cache - The cache object to save
 */
export async function saveGlobalStatsCache(cache: GlobalStatsCache): Promise<void> {
	try {
		const cachePath = getGlobalStatsCachePath();
		const cacheDir = path.dirname(cachePath);
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(cachePath, JSON.stringify(cache), 'utf-8');
	} catch (error) {
		void captureException(error);
		logger.warn('Failed to save global stats cache', 'ClaudeSessions', { error });
	}
}
