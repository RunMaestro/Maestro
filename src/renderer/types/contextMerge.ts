/**
 * Context Merge Types
 *
 * Types for merging session contexts and transferring context between agents.
 * Used by the context grooming service to combine multiple sessions or tabs
 * into a unified, optimized context for a new session.
 */

import type { ToolType, UsageStats } from '../../shared/types';
import type { LogEntry } from './index';

/**
 * Represents a source of context data that can be merged.
 * Can be either an open tab within a session or a stored agent session.
 */
export interface ContextSource {
	/** Whether this is a tab within a session or a stored session */
	type: 'tab' | 'session';
	/** The Maestro session ID containing this context */
	sessionId: string;
	/** For tabs: the specific tab ID */
	tabId?: string;
	/** The agent session ID (e.g., Claude's internal session ID) */
	agentSessionId?: string;
	/** Project root path for this context */
	projectRoot: string;
	/** Display name for this context source */
	name: string;
	/** The conversation logs to be merged */
	logs: LogEntry[];
	/** Token usage statistics for this context */
	usageStats?: UsageStats;
	/** The agent type that created this context */
	agentType: ToolType;
}

/**
 * Request to merge multiple contexts into a new session.
 */
export interface MergeRequest {
	/** The contexts to be merged (minimum 1, typically 2 or more) */
	sources: ContextSource[];
	/** The agent type for the target merged session */
	targetAgent: ToolType;
	/** Project root path for the target session */
	targetProjectRoot: string;
	/** Optional custom prompt for the grooming agent */
	groomingPrompt?: string;
}

/**
 * Result of a context merge operation.
 */
export interface MergeResult {
	/** Whether the merge completed successfully */
	success: boolean;
	/** ID of the newly created Maestro session (on success with createNewSession) */
	newSessionId?: string;
	/** ID of the active tab in the new session (on success with createNewSession) */
	newTabId?: string;
	/** Error message if the merge failed */
	error?: string;
	/** Estimated tokens saved by grooming/deduplication */
	tokensSaved?: number;
	/** Merged logs when merging into existing tab (createNewSession=false) */
	mergedLogs?: LogEntry[];
	/** Target session ID when merging into existing tab */
	targetSessionId?: string;
	/** Target tab ID when merging into existing tab */
	targetTabId?: string;
	/** Source session name for display in notifications */
	sourceSessionName?: string;
	/** Target session name for display in notifications */
	targetSessionName?: string;
	/** Estimated token count of the transferred context */
	estimatedTokens?: number;
}

/**
 * Progress information during a context merge operation.
 * Used to update the UI during long-running merge operations.
 */
export interface GroomingProgress {
	/** Current stage of the grooming process */
	stage: 'collecting' | 'grooming' | 'creating' | 'complete';
	/** Progress percentage (0-100) */
	progress: number;
	/** Human-readable status message */
	message: string;
}

/**
 * Information about duplicate content found across contexts.
 * Used to estimate potential token savings from deduplication.
 */
export interface DuplicateInfo {
	/** Index of the source context containing the duplicate */
	sourceIndex: number;
	/** The duplicated content snippet */
	content: string;
}

/**
 * Result of duplicate content detection across contexts.
 */
export interface DuplicateDetectionResult {
	/** List of detected duplicates with their source indices */
	duplicates: DuplicateInfo[];
	/** Estimated token savings from removing duplicates */
	estimatedSavings: number;
}

/**
 * Request to summarize and continue a conversation in a new tab.
 */
export interface SummarizeRequest {
	/** The Maestro session ID containing the source tab */
	sourceSessionId: string;
	/** The ID of the tab to summarize */
	sourceTabId: string;
	/** Project root path for context */
	projectRoot: string;
	/** The agent type for the session */
	agentType: ToolType;
}

/**
 * Result of a summarization operation.
 */
export interface SummarizeResult {
	/** Whether the summarization completed successfully */
	success: boolean;
	/** ID of the newly created tab (on success) */
	newTabId?: string;
	/** Estimated tokens in the original context */
	originalTokens: number;
	/** Estimated tokens in the compacted context */
	compactedTokens: number;
	/** Percentage reduction in token count */
	reductionPercent: number;
	/** Error message if summarization failed */
	error?: string;
}

/**
 * Progress information during a summarization operation.
 * Used to update the UI during the summarization process.
 */
export interface SummarizeProgress {
	/** Current stage of the summarization process */
	stage: 'extracting' | 'summarizing' | 'creating' | 'complete';
	/** Progress percentage (0-100) */
	progress: number;
	/** Human-readable status message */
	message: string;
}
