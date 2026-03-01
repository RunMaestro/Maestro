/**
 * Preload API for Director's Notes operations
 *
 * Provides the window.maestro.directorNotes namespace for:
 * - Unified history aggregation across all sessions
 * - AI synopsis generation
 */

import { ipcRenderer } from 'electron';
import type { ToolType } from '../../shared/types';

/** Aggregate stats returned alongside unified history */
export interface UnifiedHistoryStats {
	agentCount: number; // Distinct Maestro agents with history
	sessionCount: number; // Distinct provider sessions across all agents
	autoCount: number; // Total AUTO entries
	userCount: number; // Total USER entries
	totalCount: number; // Total entries (autoCount + userCount)
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
 * Creates the Director's Notes API object for preload exposure
 */
export function createDirectorNotesApi() {
	return {
		// Get unified history across all sessions with pagination
		getUnifiedHistory: (options: UnifiedHistoryOptions): Promise<PaginatedUnifiedHistoryResult> =>
			ipcRenderer.invoke('director-notes:getUnifiedHistory', options),

		// Generate AI synopsis
		generateSynopsis: (options: SynopsisOptions): Promise<SynopsisResult> =>
			ipcRenderer.invoke('director-notes:generateSynopsis', options),
	};
}

export type DirectorNotesApi = ReturnType<typeof createDirectorNotesApi>;
