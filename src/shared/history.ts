/**
 * Shared history utilities for per-session storage
 *
 * This module provides common constants and types used by both the main process
 * (HistoryManager) and CLI (storage.ts) for per-session history storage.
 */

import type { HistoryEntry, HistoryEntryType } from './types';

/**
 * Every history entry type, in the order filter UIs display them.
 *
 * This is the ONE list. Filter toggles, persistence validators, IPC payload
 * guards, and the CLI's `--filter` validation all iterate it rather than
 * re-declaring `['USER', 'AUTO', ...]` locally, so adding a member can't leave
 * a surface silently dropping entries it doesn't recognize.
 */
export const ALL_HISTORY_ENTRY_TYPES: readonly HistoryEntryType[] = [
	'USER',
	'AGENT',
	'AUTO',
	'CUE',
] as const;

/** Type guard: is `value` a known history entry type? */
export function isHistoryEntryType(value: unknown): value is HistoryEntryType {
	return typeof value === 'string' && ALL_HISTORY_ENTRY_TYPES.includes(value as HistoryEntryType);
}

/**
 * The entry types a history view should offer as filters. `CUE` only exists as
 * a concept when the Cue Encore Feature is on, so it's dropped otherwise.
 */
export function visibleHistoryEntryTypes(maestroCueEnabled: boolean): HistoryEntryType[] {
	return ALL_HISTORY_ENTRY_TYPES.filter((t) => maestroCueEnabled || t !== 'CUE');
}

/**
 * Resolve an entry's effective type, re-mapping legacy cross-agent consults.
 *
 * Consults (cross-agent `@mention` proxied messages) were originally written
 * with `type: 'AUTO'` because no better member existed, which made them render
 * as Auto Run tasks and inflated every Auto Run count. They are now written as
 * `AGENT`; this coerces the entries already on disk so no history file has to be
 * rewritten.
 *
 * `sourceAgentName` is the discriminator: it is set ONLY by the consult writer
 * (`recordConsultHistory`), so an `AUTO` entry carrying one is unambiguously a
 * consult. Applied at both read chokepoints - `HistoryManager.getEntries` (app)
 * and `readSessionHistory` (CLI) - so every consumer sees the corrected type.
 */
export function normalizeHistoryEntryType(entry: HistoryEntry): HistoryEntryType {
	if (entry.type === 'AUTO' && entry.sourceAgentName) return 'AGENT';
	return entry.type;
}

/**
 * Apply {@link normalizeHistoryEntryType} across a freshly-read entry list.
 * Returns the SAME array when nothing needed re-mapping so the common path
 * allocates nothing.
 */
export function normalizeHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
	let changed = false;
	const next = entries.map((entry) => {
		const type = normalizeHistoryEntryType(entry);
		if (type === entry.type) return entry;
		changed = true;
		return { ...entry, type };
	});
	return changed ? next : entries;
}

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
