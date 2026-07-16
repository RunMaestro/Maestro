/**
 * Shared history utilities for per-session storage
 *
 * This module provides common constants and types used by both the main process
 * (HistoryManager) and CLI (storage.ts) for per-session history storage.
 */

import type { HistoryEntry, HistoryEntryType } from './types';

/**
 * Current history file format version. Increment when making breaking changes
 * to HistoryFileData structure.
 */
export const HISTORY_VERSION = 1;

/**
 * Default maximum number of history entries stored per session.
 * Used as fallback when maxLogBuffer setting is not available.
 * The actual limit is controlled by the maxLogBuffer user setting.
 */
export const MAX_ENTRIES_PER_SESSION = 5000;

/**
 * Session ID used for history entries that don't have an associated session.
 * These entries are stored in a special "_orphaned.json" file.
 */
export const ORPHANED_SESSION_ID = '_orphaned';

/**
 * Per-session history file format
 */
export interface HistoryFileData {
	version: number;
	sessionId: string;
	projectPath: string;
	entries: HistoryEntry[];
}

/**
 * Migration marker file format
 */
export interface MigrationMarker {
	migratedAt: number;
	version: number;
	legacyEntryCount: number;
	sessionsMigrated: number;
}

/**
 * Pagination options for history queries
 */
export interface PaginationOptions {
	/** Number of entries to return (default: 100) */
	limit?: number;
	/** Number of entries to skip (default: 0) */
	offset?: number;
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
	entries: T[];
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
}

/** Single time slice in a history activity graph. */
export interface GraphBucket {
	auto: number;
	user: number;
	cue: number;
}

/**
 * Transport-safe activity graph payload returned by history IPC handlers.
 * Cache invalidation metadata deliberately remains main-process internal.
 */
export interface HistoryGraphData {
	buckets: GraphBucket[];
	bucketCount: number;
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	hostCounts: Record<string, number>;
	cached: boolean;
}

/** A history entry annotated with its source Maestro session. */
export interface UnifiedHistoryEntry extends HistoryEntry {
	agentName?: string;
	sourceSessionId: string;
}

/** Aggregate counts returned with unified history results. */
export interface UnifiedHistoryStats {
	agentCount: number;
	sessionCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	totalCount: number;
}

export type UnifiedHistoryFilter = HistoryEntryType | HistoryEntryType[] | null;

/** Input accepted by the unified-history IPC endpoint. */
export interface UnifiedHistoryOptions {
	lookbackDays: number;
	filter?: UnifiedHistoryFilter;
	limit?: number;
	offset?: number;
	graphBucketCount?: number;
}

/** Paginated unified history returned across the preload boundary. */
export interface PaginatedUnifiedHistoryResult extends PaginatedResult<UnifiedHistoryEntry> {
	stats: UnifiedHistoryStats;
	graphBuckets?: GraphBucket[];
}

/** Unified graph data augments the base graph transport with aggregate stats. */
export interface UnifiedHistoryGraphData extends HistoryGraphData {
	stats: UnifiedHistoryStats;
}

/**
 * Default pagination values.
 * @internal Used internally by paginateEntries; consumers should pass
 * their own PaginationOptions if different values are needed.
 */
const DEFAULT_PAGINATION: Required<PaginationOptions> = {
	limit: 100,
	offset: 0,
};

/**
 * Sanitize a session ID for safe filesystem usage.
 * Replaces any characters that are not alphanumeric, underscore, or hyphen with underscore.
 * @param sessionId - The raw session ID to sanitize
 * @returns A filesystem-safe session ID
 */
export function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Apply pagination to an array of entries.
 * @param entries - The full array of entries to paginate
 * @param options - Optional pagination parameters (limit, offset)
 * @returns A PaginatedResult containing the sliced entries and metadata
 */
export function paginateEntries<T>(entries: T[], options?: PaginationOptions): PaginatedResult<T> {
	const limit = options?.limit ?? DEFAULT_PAGINATION.limit;
	const offset = options?.offset ?? DEFAULT_PAGINATION.offset;

	const paginatedEntries = entries.slice(offset, offset + limit);

	return {
		entries: paginatedEntries,
		total: entries.length,
		limit,
		offset,
		hasMore: offset + limit < entries.length,
	};
}

/**
 * Sort entries by timestamp (most recent first).
 * Returns a new array, does not mutate the original.
 * @param entries - The entries to sort
 * @returns A new array with entries sorted by descending timestamp
 */
export function sortEntriesByTimestamp(entries: HistoryEntry[]): HistoryEntry[] {
	return [...entries].sort((a, b) => b.timestamp - a.timestamp);
}
