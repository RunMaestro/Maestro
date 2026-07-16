/**
 * Preload API for Director's Notes operations
 *
 * Provides the window.maestro.directorNotes namespace for:
 * - Unified history aggregation across all sessions
 * - AI synopsis generation
 */

import { ipcRenderer } from 'electron';
import { subscribeIpc } from './ipcSubscription';
import type { ToolType, HistoryEntry } from '../../shared/types';
import type { DirectorNotesNarrative } from '../../shared/directorNotesNarrative';
import type {
	PaginatedUnifiedHistoryResult,
	UnifiedHistoryGraphData,
	UnifiedHistoryOptions,
} from '../../shared/history';

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
	/** Parsed structured narrative for Rich Mode (present only on clean parse). */
	narrative?: DirectorNotesNarrative;
	/** Set when the raw synopsis could not be parsed into a structured narrative. */
	narrativeError?: string;
}

/** Options for the deterministic Rich Overview stats IPC */
export interface RichOverviewStatsOptions {
	lookbackDays: number;
	bucketCount?: number;
}

/** One activity time-slice in the Rich Overview timeline, with its start time. */
export interface RichTimelineBucket {
	startTime: number;
	auto: number;
	user: number;
	cue: number;
}

/** Per-agent activity rollup for the Rich Overview, sorted by entryCount desc. */
export interface RichAgentStat {
	sessionId: string;
	agentName: string;
	entryCount: number;
	successCount: number;
	failureCount: number;
}

/**
 * Fully deterministic stats for Director's Notes Rich Mode, computed in the
 * main process over history entries (never inferred by the AI synopsis).
 */
export interface RichOverviewStats {
	totalEntries: number;
	agentCount: number;
	sessionCount: number;
	autoCount: number;
	userCount: number;
	cueCount: number;
	successCount: number;
	failureCount: number;
	successRate: number;
	totalElapsedMs: number;
	avgElapsedMs: number;
	timelineBuckets: RichTimelineBucket[];
	perAgent: RichAgentStat[];
	lookbackDays: number;
	generatedAt: number;
}

/**
 * Creates the Director's Notes API object for preload exposure
 */
export function createDirectorNotesApi() {
	return {
		// Get unified history across all sessions with pagination
		getUnifiedHistory: (options: UnifiedHistoryOptions): Promise<PaginatedUnifiedHistoryResult> =>
			ipcRenderer.invoke('director-notes:getUnifiedHistory', options),

		// Cached graph buckets aggregated across every session. The
		// lookback parameter controls the window - `null` for "all time",
		// or hours back from "now". Each (bucketCount, lookback) pair gets
		// its own cached aggregate keyed by composite source fingerprint.
		getGraphData: (
			bucketCount: number,
			lookbackHours: number | null
		): Promise<UnifiedHistoryGraphData> =>
			ipcRenderer.invoke('director-notes:getGraphData', bucketCount, lookbackHours),

		// Deterministic Rich Mode stats computed in the main process over history
		// entries: success/failure ratios, per-agent activity, timeline buckets,
		// time-spent. The single source of quantitative truth for Rich Mode.
		getRichOverviewStats: (options: RichOverviewStatsOptions): Promise<RichOverviewStats> =>
			ipcRenderer.invoke('director-notes:getRichOverviewStats', options),

		// Resolve the offset (newest-first sorted across all sessions) of
		// the first entry whose timestamp is <= the given timestamp. Powers
		// the activity graph's click-to-jump behavior in the unified view.
		getOffsetForTimestamp: (
			timestamp: number,
			options?: {
				lookbackDays?: number;
				filter?: 'AUTO' | 'USER' | 'CUE' | Array<'AUTO' | 'USER' | 'CUE'> | null;
			}
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
		): (() => void) => subscribeIpc('director-notes:synopsisProgress', callback),

		/**
		 * Subscribe to new history entries as they are added in real-time.
		 * Returns a cleanup function to unsubscribe.
		 */
		onHistoryEntryAdded: (
			callback: (entry: HistoryEntry, sourceSessionId: string) => void
		): (() => void) => subscribeIpc('history:entryAdded', callback),
	};
}

export type DirectorNotesApi = ReturnType<typeof createDirectorNotesApi>;
