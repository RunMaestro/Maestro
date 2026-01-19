import { createContext, useContext, useMemo, ReactNode, useCallback } from 'react';
import {
	useGitStatusPolling,
	type GitStatusData,
	type GitFileChange,
	type UseGitStatusPollingOptions,
} from '../hooks';
import type { Session } from '../types';

// ============================================================================
// CONTEXT TYPES
// ============================================================================

/**
 * Branch-related git data - changes infrequently.
 * Components that only show branch name don't need to re-render when file counts change.
 */
export interface GitBranchContextValue {
	/** Get branch info for a session */
	getBranchInfo: (sessionId: string) =>
		| {
				branch?: string;
				remote?: string;
				ahead: number;
				behind: number;
		  }
		| undefined;
}

/**
 * File status counts - changes on file operations.
 * Components that show file counts don't need full file details.
 */
export interface GitFileStatusContextValue {
	/** Map of session ID to file count */
	getFileCount: (sessionId: string) => number;
	/** Check if a session has uncommitted changes */
	hasChanges: (sessionId: string) => boolean;
	/** Whether data is currently being fetched */
	isLoading: boolean;
}

/**
 * Detailed file changes - only available for active session.
 * Components showing file details need this, but most don't.
 */
export interface GitDetailContextValue {
	/** Get detailed file changes for a session (only populated for active session) */
	getFileDetails: (sessionId: string) =>
		| {
				fileChanges?: GitFileChange[];
				totalAdditions: number;
				totalDeletions: number;
				modifiedCount: number;
		  }
		| undefined;
	/** Manually trigger a refresh of git status */
	refreshGitStatus: () => Promise<void>;
}

/**
 * Legacy combined context - for backwards compatibility.
 * New code should use the focused contexts instead.
 */
export interface GitStatusContextValue {
	gitStatusMap: Map<string, GitStatusData>;
	refreshGitStatus: () => Promise<void>;
	isLoading: boolean;
	getFileCount: (sessionId: string) => number;
	getStatus: (sessionId: string) => GitStatusData | undefined;
}

// ============================================================================
// CONTEXTS
// ============================================================================

// Create focused contexts with null defaults
const GitBranchContext = createContext<GitBranchContextValue | null>(null);
const GitFileStatusContext = createContext<GitFileStatusContextValue | null>(null);
const GitDetailContext = createContext<GitDetailContextValue | null>(null);

// Legacy combined context for backwards compatibility
const GitStatusContext = createContext<GitStatusContextValue | null>(null);

// ============================================================================
// PROVIDER
// ============================================================================

interface GitStatusProviderProps {
	children: ReactNode;
	/** Array of all sessions to poll */
	sessions: Session[];
	/** ID of the currently active session */
	activeSessionId?: string;
	/** Optional polling options override */
	options?: Omit<UseGitStatusPollingOptions, 'activeSessionId'>;
}

/**
 * GitStatusProvider - Provides centralized git status polling for all sessions.
 *
 * This provider consolidates git polling and exposes data through three focused contexts:
 * - GitBranchContext: Branch name, remote, ahead/behind (rarely changes)
 * - GitFileStatusContext: File counts and hasChanges (changes on file operations)
 * - GitDetailContext: Detailed file changes (only for active session)
 *
 * Components can subscribe to only the context they need, reducing cascade re-renders.
 */
export function GitStatusProvider({
	children,
	sessions,
	activeSessionId,
	options = {},
}: GitStatusProviderProps) {
	const { gitStatusMap, refreshGitStatus, isLoading } = useGitStatusPolling(sessions, {
		...options,
		activeSessionId,
	});

	// ============================================================================
	// BRANCH CONTEXT VALUE (rarely changes)
	// ============================================================================
	const branchContextValue = useMemo<GitBranchContextValue>(
		() => ({
			getBranchInfo: (sessionId: string) => {
				const data = gitStatusMap.get(sessionId);
				if (!data) return undefined;
				return {
					branch: data.branch,
					remote: data.remote,
					ahead: data.ahead,
					behind: data.behind,
				};
			},
		}),
		[gitStatusMap]
	);

	// ============================================================================
	// FILE STATUS CONTEXT VALUE (changes on file operations)
	// ============================================================================
	const fileStatusContextValue = useMemo<GitFileStatusContextValue>(
		() => ({
			getFileCount: (sessionId: string) => gitStatusMap.get(sessionId)?.fileCount ?? 0,
			hasChanges: (sessionId: string) => (gitStatusMap.get(sessionId)?.fileCount ?? 0) > 0,
			isLoading,
		}),
		[gitStatusMap, isLoading]
	);

	// ============================================================================
	// DETAIL CONTEXT VALUE (only for active session, most expensive)
	// ============================================================================
	const detailContextValue = useMemo<GitDetailContextValue>(
		() => ({
			getFileDetails: (sessionId: string) => {
				const data = gitStatusMap.get(sessionId);
				if (!data) return undefined;
				return {
					fileChanges: data.fileChanges,
					totalAdditions: data.totalAdditions,
					totalDeletions: data.totalDeletions,
					modifiedCount: data.modifiedCount,
				};
			},
			refreshGitStatus,
		}),
		[gitStatusMap, refreshGitStatus]
	);

	// ============================================================================
	// LEGACY COMBINED CONTEXT VALUE (for backwards compatibility)
	// ============================================================================
	const legacyContextValue = useMemo<GitStatusContextValue>(
		() => ({
			gitStatusMap,
			refreshGitStatus,
			isLoading,
			getFileCount: (sessionId: string) => gitStatusMap.get(sessionId)?.fileCount ?? 0,
			getStatus: (sessionId: string) => gitStatusMap.get(sessionId),
		}),
		[gitStatusMap, refreshGitStatus, isLoading]
	);

	return (
		<GitBranchContext.Provider value={branchContextValue}>
			<GitFileStatusContext.Provider value={fileStatusContextValue}>
				<GitDetailContext.Provider value={detailContextValue}>
					<GitStatusContext.Provider value={legacyContextValue}>
						{children}
					</GitStatusContext.Provider>
				</GitDetailContext.Provider>
			</GitFileStatusContext.Provider>
		</GitBranchContext.Provider>
	);
}

// ============================================================================
// HOOKS - Focused hooks for specific data needs
// ============================================================================

/**
 * useGitBranch - Hook for branch-related data.
 * Use when you only need branch name, remote, or ahead/behind counts.
 * Updates less frequently than file status.
 */
export function useGitBranch(): GitBranchContextValue {
	const context = useContext(GitBranchContext);
	if (!context) {
		throw new Error('useGitBranch must be used within a GitStatusProvider');
	}
	return context;
}

/**
 * useGitFileStatus - Hook for file count and change detection.
 * Use when you need to show file counts or check if there are uncommitted changes.
 * More efficient than full status when you don't need file details.
 */
export function useGitFileStatus(): GitFileStatusContextValue {
	const context = useContext(GitFileStatusContext);
	if (!context) {
		throw new Error('useGitFileStatus must be used within a GitStatusProvider');
	}
	return context;
}

/**
 * useGitDetail - Hook for detailed file changes.
 * Use when you need line additions/deletions or individual file changes.
 * Only populated for the active session.
 */
export function useGitDetail(): GitDetailContextValue {
	const context = useContext(GitDetailContext);
	if (!context) {
		throw new Error('useGitDetail must be used within a GitStatusProvider');
	}
	return context;
}

/**
 * useGitStatus - Legacy hook providing full git status data.
 * For backwards compatibility. New code should prefer focused hooks.
 *
 * @deprecated Use useGitBranch, useGitFileStatus, or useGitDetail instead
 */
export function useGitStatus(): GitStatusContextValue {
	const context = useContext(GitStatusContext);
	if (!context) {
		throw new Error('useGitStatus must be used within a GitStatusProvider');
	}
	return context;
}

// Re-export types for convenience
export type { GitStatusData, GitFileChange };
