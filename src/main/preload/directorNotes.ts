/**
 * Preload API for Director's Notes operations
 *
 * Provides the window.maestro.directorNotes namespace for:
 * - Unified history aggregation across all sessions
 * - AI synopsis generation
 */

import { ipcRenderer } from 'electron';
import type { ToolType, HistoryEntry } from '../../shared/types';

/** Aggregate stats returned alongside unified history */
export interface UnifiedHistoryStats {
	agentCount: number; // Distinct Maestro agents with history
	sessionCount: number; // Distinct provider sessions across all agents
	autoCount: number; // Total AUTO entries
	userCount: number; // Total USER entries
	totalCount: number; // Total entries (autoCount + userCount)
}

/** Pre-computed activity graph bucket for a time slice */
export interface GraphBucket {
	auto: number;
	user: number;
	cue: number;
}

/**
 * Paginated result wrapper (mirrors shared/history.ts PaginatedResult)
 */
export interface PaginatedUnifiedHistoryResult {
	entries: UnifiedHistoryEntry[];
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
	stats: UnifiedHistoryStats;
	graphBuckets?: GraphBucket[];
}

/**
 * Options for fetching unified history
 */
export interface UnifiedHistoryOptions {
	lookbackDays: number;
	filter?: 'AUTO' | 'USER' | 'CUE' | null; // null = both
	/** Number of entries to return per page (default: 100) */
	limit?: number;
	/** Number of entries to skip for pagination (default: 0) */
	offset?: number;
	/** Number of buckets for the activity graph (passed from frontend lookback config) */
	graphBucketCount?: number;
}

/**
 * A history entry augmented with source session info
 */
export interface UnifiedHistoryEntry {
	id: string;
	type: 'AUTO' | 'USER' | 'CUE';
	timestamp: number;
	summary: string;
	fullResponse?: string;
	agentSessionId?: string;
	sessionName?: string;
	projectPath: string;
	sessionId?: string;
	contextUsage?: number;
	success?: boolean;
	elapsedTimeMs?: number;
	validated?: boolean;
	agentName?: string;
	sourceSessionId: string;
}

/**
 * Options for synopsis generation
 */
export interface SynopsisOptions {
	lookbackDays: number;
	provider: ToolType;
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
}

/**
 * Stats about the synopsis generation
 */
export interface SynopsisStats {
	agentCount: number; // Maestro agents with history in the lookback window
	entryCount: number; // Total history entries in the lookback window
	durationMs: number; // Time taken for AI generation
}

/**
 * Result of synopsis generation
 */
export interface SynopsisResult {
	success: boolean;
	synopsis: string;
	generatedAt?: number; // Unix ms timestamp of when the synopsis was generated
	stats?: SynopsisStats;
	error?: string;
}

/**
 * All-time activity graph data aggregated across every session.
 */
export interface UnifiedGraphData {
	buckets: GraphBucket[];
	bucketCount: number;
	earliestTimestamp: number;
	latestTimestamp: number;
	totalCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	cached: boolean;
	stats: UnifiedHistoryStats;
}

/**
 * Creates the Director's Notes API object for preload exposure
 */
export function createDirectorNotesApi() {
	return {
		// Get unified history across all sessions with pagination
		getUnifiedHistory: (options: UnifiedHistoryOptions): Promise<PaginatedUnifiedHistoryResult> =>
			ipcRenderer.invoke('director-notes:getUnifiedHistory', options),

		// Cached, all-time graph buckets aggregated across every session.
		// Used by the unified history activity graph so it stays consistent
		// regardless of how the entry list paginates beneath it.
		getGraphData: (bucketCount: number): Promise<UnifiedGraphData> =>
			ipcRenderer.invoke('director-notes:getGraphData', bucketCount),

		// Resolve the offset (newest-first sorted across all sessions) of
		// the first entry whose timestamp is <= the given timestamp. Powers
		// the activity graph's click-to-jump behavior in the unified view.
		getOffsetForTimestamp: (
			timestamp: number,
			options?: { lookbackDays?: number; filter?: 'AUTO' | 'USER' | 'CUE' | null }
		): Promise<number> =>
			ipcRenderer.invoke('director-notes:getOffsetForTimestamp', timestamp, options),

		// Generate AI synopsis
		generateSynopsis: (options: SynopsisOptions): Promise<SynopsisResult> =>
			ipcRenderer.invoke('director-notes:generateSynopsis', options),

		/**
		 * Subscribe to synopsis generation progress updates.
		 * Returns a cleanup function to unsubscribe.
		 */
		onSynopsisProgress: (
			callback: (update: { chunkCount: number; bytesReceived: number; elapsedMs: number }) => void
		): (() => void) => {
			const handler = (
				_event: unknown,
				update: { chunkCount: number; bytesReceived: number; elapsedMs: number }
			) => {
				callback(update);
			};
			ipcRenderer.on('director-notes:synopsisProgress', handler);
			return () => {
				ipcRenderer.removeListener('director-notes:synopsisProgress', handler);
			};
		},

		/**
		 * Subscribe to new history entries as they are added in real-time.
		 * Returns a cleanup function to unsubscribe.
		 */
		onHistoryEntryAdded: (
			callback: (entry: HistoryEntry, sourceSessionId: string) => void
		): (() => void) => {
			const handler = (_event: unknown, entry: HistoryEntry, sessionId: string) => {
				callback(entry, sessionId);
			};
			ipcRenderer.on('history:entryAdded', handler);
			return () => {
				ipcRenderer.removeListener('history:entryAdded', handler);
			};
		},
	};
}

export type DirectorNotesApi = ReturnType<typeof createDirectorNotesApi>;
