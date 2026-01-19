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

// ============================================================================
// Per-Project Stats Cache
// ============================================================================

/**
 * Per-project session statistics cache structure.
 * Stores stats for all Claude Code sessions within a specific project directory.
 */
export interface SessionStatsCache {
	/** Per-session stats keyed by session ID */
	sessions: Record<
		string,
		{
			messages: number;
			costUsd: number;
			sizeBytes: number;
			tokens: number;
			oldestTimestamp: string | null;
			/** File modification time to detect external changes */
			fileMtimeMs: number;
		}
	>;
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

/** Current per-project stats cache version. Bump to force cache invalidation. */
export const STATS_CACHE_VERSION = 1;

/**
 * Encode a project path the same way Claude Code does.
 * Claude replaces both '/' and '.' with '-' in the path encoding.
 */
export function encodeClaudeProjectPath(projectPath: string): string {
	return projectPath.replace(/[/.]/g, '-');
}

/**
 * Get the cache file path for a project's stats.
 * @param projectPath - The project directory path
 * @returns Absolute path to the cache JSON file
 */
export function getStatsCachePath(projectPath: string): string {
	const encodedPath = encodeClaudeProjectPath(projectPath);
	return path.join(app.getPath('userData'), 'stats-cache', `${encodedPath}.json`);
}

/**
 * Load stats cache for a project.
 * Returns null if cache doesn't exist, is corrupted, or has version mismatch.
 * @param projectPath - The project directory path
 */
export async function loadStatsCache(projectPath: string): Promise<SessionStatsCache | null> {
	try {
		const cachePath = getStatsCachePath(projectPath);
		const content = await fs.readFile(cachePath, 'utf-8');
		const cache = JSON.parse(content) as SessionStatsCache;
		// Invalidate cache if version mismatch
		if (cache.version !== STATS_CACHE_VERSION) {
			return null;
		}
		return cache;
	} catch {
		return null;
	}
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

/**
 * Get the cache file path for global stats.
 * @returns Absolute path to the global stats cache JSON file
 */
export function getGlobalStatsCachePath(): string {
	return path.join(app.getPath('userData'), 'stats-cache', 'global-stats.json');
}

/**
 * Load global stats cache.
 * Returns null if cache doesn't exist, is corrupted, or has version mismatch.
 */
export async function loadGlobalStatsCache(): Promise<GlobalStatsCache | null> {
	try {
		const cachePath = getGlobalStatsCachePath();
		const content = await fs.readFile(cachePath, 'utf-8');
		const cache = JSON.parse(content) as GlobalStatsCache;
		if (cache.version !== GLOBAL_STATS_CACHE_VERSION) {
			return null;
		}
		return cache;
	} catch {
		return null;
	}
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
		logger.warn('Failed to save global stats cache', 'ClaudeSessions', { error });
	}
}
