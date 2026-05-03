/**
 * useAutoRun hook for Auto Run state management in the web interface.
 *
 * Provides document listing, content loading/saving, launch/stop controls,
 * and real-time document change tracking via WebSocket broadcasts.
 */

import { useState, useCallback } from 'react';
import type { UseWebSocketReturn, AutoRunState } from './useWebSocket';

/**
 * Auto Run document metadata (mirrors server-side AutoRunDocument).
 */
export interface AutoRunDocument {
	filename: string;
	path: string;
	taskCount: number;
	completedCount: number;
}

/**
 * Currently selected document with content.
 */
export interface SelectedDocument {
	filename: string;
	content: string;
}

/**
 * Optional worktree dispatch config — when set, the desktop creates a git
 * worktree, runs the Auto Run inside it, and (if requested) opens a PR on
 * completion. Mirrors the `worktree` field accepted by the
 * `configure_auto_run` WebSocket handler.
 */
export interface LaunchWorktreeConfig {
	enabled: boolean;
	path: string;
	branchName: string;
	createPROnCompletion: boolean;
	prTargetBranch: string;
}

/**
 * Launch configuration for Auto Run.
 */
export interface LaunchConfig {
	documents: Array<{ filename: string }>;
	prompt?: string;
	loopEnabled?: boolean;
	maxLoops?: number;
	worktree?: LaunchWorktreeConfig;
}

/**
 * Worktree summary returned by `list_worktrees`.
 */
export interface WorktreeSummary {
	path: string;
	branch: string | null;
	isBare: boolean;
}

/**
 * Return value from useAutoRun hook.
 */
export interface UseAutoRunReturn {
	documents: AutoRunDocument[];
	autoRunState: AutoRunState | null;
	isLoadingDocs: boolean;
	selectedDoc: SelectedDocument | null;
	loadDocuments: (sessionId: string) => Promise<void>;
	loadDocumentContent: (sessionId: string, filename: string) => Promise<void>;
	saveDocumentContent: (sessionId: string, filename: string, content: string) => Promise<boolean>;
	launchAutoRun: (sessionId: string, config: LaunchConfig) => boolean;
	stopAutoRun: (sessionId: string) => Promise<boolean>;
	loadGitBranches: (sessionId: string) => Promise<{ branches: string[]; currentBranch?: string }>;
	listWorktrees: (sessionId: string) => Promise<WorktreeSummary[]>;
}

/**
 * Hook for managing Auto Run state and operations.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param send - WebSocket send function for fire-and-forget messages
 * @param onMessage - Optional message handler registration callback
 */
export function useAutoRun(
	sendRequest: UseWebSocketReturn['sendRequest'],
	send: UseWebSocketReturn['send'],
	autoRunState: AutoRunState | null = null
): UseAutoRunReturn {
	const [documents, setDocuments] = useState<AutoRunDocument[]>([]);
	const [isLoadingDocs, setIsLoadingDocs] = useState(false);
	const [selectedDoc, setSelectedDoc] = useState<SelectedDocument | null>(null);

	const loadDocuments = useCallback(
		async (sessionId: string) => {
			setIsLoadingDocs(true);
			try {
				const response = await sendRequest<{ documents?: AutoRunDocument[] }>('get_auto_run_docs', {
					sessionId,
				});
				setDocuments(response.documents ?? []);
			} catch {
				setDocuments([]);
			} finally {
				setIsLoadingDocs(false);
			}
		},
		[sendRequest]
	);

	const loadDocumentContent = useCallback(
		async (sessionId: string, filename: string) => {
			try {
				const response = await sendRequest<{ content?: string }>('get_auto_run_document', {
					sessionId,
					filename,
				});
				setSelectedDoc({
					filename,
					content: response.content ?? '',
				});
			} catch {
				setSelectedDoc({ filename, content: '' });
			}
		},
		[sendRequest]
	);

	const saveDocumentContent = useCallback(
		async (sessionId: string, filename: string, content: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('save_auto_run_document', {
					sessionId,
					filename,
					content,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const launchAutoRun = useCallback(
		(sessionId: string, config: LaunchConfig): boolean => {
			return send({
				type: 'configure_auto_run',
				sessionId,
				documents: config.documents,
				prompt: config.prompt,
				loopEnabled: config.loopEnabled,
				maxLoops: config.maxLoops,
				launch: true,
				...(config.worktree && config.worktree.enabled ? { worktree: config.worktree } : {}),
			});
		},
		[send]
	);

	const loadGitBranches = useCallback(
		async (sessionId: string): Promise<{ branches: string[]; currentBranch?: string }> => {
			// Let transport/backend failures propagate so callers can render a real
			// error state instead of an indistinguishable empty list.
			const response = await sendRequest<{ branches?: string[]; currentBranch?: string }>(
				'get_git_branches',
				{ sessionId }
			);
			return {
				branches: response.branches ?? [],
				currentBranch: response.currentBranch,
			};
		},
		[sendRequest]
	);

	const listWorktrees = useCallback(
		async (sessionId: string): Promise<WorktreeSummary[]> => {
			// Let transport/backend failures propagate; a silent `[]` would mask
			// SSH/exec regressions as "no worktrees" in the mobile UI.
			const response = await sendRequest<{ worktrees?: WorktreeSummary[] }>('list_worktrees', {
				sessionId,
			});
			return response.worktrees ?? [];
		},
		[sendRequest]
	);

	const stopAutoRun = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('stop_auto_run', { sessionId });
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	return {
		documents,
		autoRunState,
		isLoadingDocs,
		selectedDoc,
		loadDocuments,
		loadDocumentContent,
		saveDocumentContent,
		launchAutoRun,
		stopAutoRun,
		loadGitBranches,
		listWorktrees,
	};
}

export default useAutoRun;
