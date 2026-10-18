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
import { createHash } from 'crypto';
import { logger } from './logger';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';
import { captureException } from './sentry';

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
	/** Every token the session was billed for: input, output, cache reads and cache writes. */
	tokens: number;
	/**
	 * `tokens` by kind. Absent on sessions archived before the split was stored:
	 * their transcript is gone, so only the rescaled total survives.
	 */
	tokenSplit?: ProjectTokenSplit;
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

/** A token total by kind, as the session browser's hover breakdown shows it. */
export interface ProjectTokenSplit {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
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
 * - v3: Claude usage counted once per API response instead of once per JSONL line
 *       (each content block repeats the response's usage). Derivation-only, so a
 *       v2 cache is upgraded in place rather than dropped - see
 *       `rescaleArchivedEntries`.
 * - v4: Subagent transcripts (`<sessionId>/subagents/*.jsonl`) priced into their
 *       session. Derivation-only, upgraded in place like v3.
 * - v5: Messages counted as prompts and model responses
 *       (`countClaudeTranscriptMessages`), not transcript lines. Upgraded in place.
 * - v6: `tokens` counts cache reads and writes too (it was input + output only,
 *       about 1% of what a session is billed for), and `tokenSplit` is stored.
 *       Upgraded in place; archived sessions keep a rescaled total, no split.
 */
export const STATS_CACHE_VERSION = 6;

/**
 * Oldest per-project cache version with the CURRENT shape. Anything from here up
 * to `STATS_CACHE_VERSION` differs only in how its numbers were derived, so it is
 * loaded and upgraded instead of discarded: discarding it would erase every
 * archived session, whose transcript no longer exists to rebuild it from.
 */
export const STATS_CACHE_MIN_UPGRADABLE_VERSION = 2;

/**
 * Get the cache file path for a project's stats.
 * @param projectPath - The project directory path
 * @returns Absolute path to the cache JSON file
 */
function getStatsCachePath(projectPath: string, scope?: string): string {
	const encodedPath = encodeClaudeProjectPath(projectPath);
	const suffix = scope ? `--${createHash('sha1').update(scope).digest('hex').slice(0, 12)}` : '';
	return path.join(app.getPath('userData'), 'stats-cache', `${encodedPath}${suffix}.json`);
}

/**
 * The cache scope for a project read from `projectDir`, or `undefined` when it
 * is the default account's pool.
 *
 * Two accounts with separate transcript pools must not share one cache file, or
 * each would archive the other's sessions as deleted. Accounts that share a pool
 * through a symlinked `projects/` resolve to the same directory and keep the
 * unscoped file, so moving an agent to an explicit `CLAUDE_CONFIG_DIR` over the
 * same pool never orphans the archived sessions already cached for it.
 */
export async function statsCacheScope(
	projectDir: string,
	defaultProjectDir: string
): Promise<string | undefined> {
	const real = (dir: string) => fs.realpath(dir).catch(() => path.resolve(dir));
	const [actual, fallback] = await Promise.all([real(projectDir), real(defaultProjectDir)]);
	return actual === fallback ? undefined : actual;
}

/**
 * Load stats cache for a project.
 * Returns null if cache doesn't exist, is corrupted, or has an unusable version.
 * A cache older than `STATS_CACHE_VERSION` but at least
 * `STATS_CACHE_MIN_UPGRADABLE_VERSION` is returned as-is; the caller must
 * re-parse every live session and `rescaleArchivedEntries` the rest.
 * @param projectPath - The project directory path
 */
export async function loadStatsCache(
	projectPath: string,
	scope?: string
): Promise<SessionStatsCache | null> {
	try {
		const cachePath = getStatsCachePath(projectPath, scope);
		const content = await fs.readFile(cachePath, 'utf-8');
		const cache = JSON.parse(content) as SessionStatsCache;
		if (cache.version < STATS_CACHE_MIN_UPGRADABLE_VERSION || cache.version > STATS_CACHE_VERSION) {
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
export async function saveStatsCache(
	projectPath: string,
	cache: SessionStatsCache,
	scope?: string
): Promise<void> {
	try {
		const cachePath = getStatsCachePath(projectPath, scope);
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

/**
 * Current global stats cache version. Bump to force cache invalidation, including
 * when only the DERIVATION changes - entries are fingerprinted on a transcript's
 * mtime, so a parsing fix (v4: Codex's cumulative `total_token_usage` was being
 * summed) is invisible to the fingerprint and would keep serving old numbers.
 * v5: Claude usage counted once per API response instead of once per JSONL line.
 * v6: Claude subagent transcripts priced into their parent session.
 * v7: Claude messages counted as prompts and responses, not transcript lines.
 */
export const GLOBAL_STATS_CACHE_VERSION = 7;

/**
 * Oldest global cache version with the current shape whose CLAUDE entries can be
 * upgraded in place (see `STATS_CACHE_MIN_UPGRADABLE_VERSION`). Codex entries in
 * such a cache were derived by the current Codex parser and are kept as they are.
 */
export const GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION = 4;

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
	try {
		const cachePath = getGlobalStatsCachePath();
		const content = await fs.readFile(cachePath, 'utf-8');
		const cache = JSON.parse(content) as GlobalStatsCache;
		if (
			cache.version < GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION ||
			cache.version > GLOBAL_STATS_CACHE_VERSION
		) {
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
		void captureException(error);
		logger.warn('Failed to save global stats cache', 'ClaudeSessions', { error });
	}
}

// ============================================================================
// Derivation Upgrades
// ============================================================================

type NumericKeys<T> = {
	[K in keyof T]-?: T[K] extends number | undefined ? K : never;
}[keyof T];

/**
 * Carry ARCHIVED sessions across a fix to how their numbers are derived.
 *
 * Live sessions are simply re-parsed. Archived ones cannot be: their transcript
 * is gone, and that is the whole reason they are kept. So each listed field is
 * scaled by how much the fix moved that same field on the sessions that WERE
 * re-parsed (old cached value vs new parse, summed across the set). It is an
 * estimate, but far closer than the stale number, and the only alternative is
 * erasing those sessions from lifetime totals.
 *
 * `entries` is the upgraded map (re-parsed live entries already in it) and is
 * mutated in place; `before` is the map as loaded from the stale cache. A field
 * with no re-parsed baseline is left unscaled rather than guessed. Scaled values
 * are rounded, since they are counts (tokens, messages); list money fields in
 * `fractional` to keep their cents.
 */
export function rescaleArchivedEntries<T extends { archived?: boolean }>(
	entries: Record<string, T>,
	before: Record<string, T>,
	fields: readonly NumericKeys<T>[],
	fractional: readonly NumericKeys<T>[] = []
): void {
	for (const field of fields) {
		let oldSum = 0;
		let newSum = 0;
		for (const [key, entry] of Object.entries(entries)) {
			const previous = before[key];
			if (entry.archived || !previous || previous === entry) continue;
			oldSum += (previous[field] as number | undefined) ?? 0;
			newSum += (entry[field] as number | undefined) ?? 0;
		}
		if (oldSum <= 0) continue;
		const ratio = newSum / oldSum;
		for (const entry of Object.values(entries)) {
			const value = entry[field] as number | undefined;
			if (!entry.archived || typeof value !== 'number') continue;
			const scaled = value * ratio;
			entry[field] = (
				fractional.includes(field) ? scaled : Math.round(scaled)
			) as T[NumericKeys<T>];
		}
	}
}
