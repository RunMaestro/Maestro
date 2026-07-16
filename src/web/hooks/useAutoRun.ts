/**
 * useAutoRun hook for Auto Run state management in the web interface.
 *
 * Provides document listing, content loading/saving, launch/stop controls,
 * playbook CRUD, task reset, and error-pause recovery - mirroring the desktop
 * Auto Run capability surface so mobile/web users have feature parity.
 */

import { useState, useCallback } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { AutoRunState } from '../../shared/web-protocol/session';

/**
 * Default `sendRequest` timeout for `configure_auto_run` (matches the platform
 * default of 10s for ordinary launches).
 */
const LAUNCH_TIMEOUT_MS = 10_000;
/**
 * Worktree launches block on `git worktree add` and an upstream
 * `getBranches` round-trip on the server before the result is returned, which
 * can be slow on large repos or over SSH. Use a longer ceiling so legitimately
 * successful launches don't surface as `Request timed out`.
 */
const LAUNCH_WORKTREE_TIMEOUT_MS = 60_000;

/**
 * Known transport-level rejections from `useWebSocket.sendRequest`. These are
 * expected/recoverable (the user can retry once the connection is back), so
 * `launchAutoRun` resolves with `{ success: false, error }` for them and lets
 * the caller revert the optimistic UI. Anything else is treated as unexpected
 * and re-thrown so unhandled-rejection handlers (and Sentry, if/when wired up
 * for the web bundle) can capture it instead of having it silently swallowed.
 */
const KNOWN_TRANSPORT_ERRORS: ReadonlySet<string> = new Set([
	'Request timed out',
	'WebSocket not connected',
]);

/**
 * Auto Run document metadata (mirrors server-side AutoRunDocument).
 */
export interface AutoRunDocument {
	filename: string;
	path: string;
	taskCount: number;
	completedCount: number;
	/** Subfolder (relative path), empty for root. Used to render the doc tree. */
	folder?: string;
}

/**
 * Currently selected document with content.
 */
export interface SelectedDocument {
	filename: string;
	content: string;
}

/**
 * Optional worktree dispatch config - when set, the desktop creates a git
 * worktree, runs the Auto Run inside it, and (if requested) opens a PR on
 * completion. Mirrors the `worktree` field accepted by the
 * `configure_auto_run` WebSocket handler.
 */
export interface LaunchWorktreeConfig {
	enabled: boolean;
	path: string;
	branchName: string;
	/**
	 * Ref the new branch should be based on when it does not yet exist
	 * (e.g. "rc", "main"). Forwarded to `git worktree add -b <new> <path> <base>`.
	 * Defaults to the main repo's current HEAD if empty.
	 */
	baseBranch?: string;
	createPROnCompletion: boolean;
	prTargetBranch: string;
}

/**
 * Document entry within a playbook.
 */
export interface PlaybookDocumentEntry {
	filename: string;
	resetOnCompletion: boolean;
}

/**
 * Saved Playbook configuration (subset surfaced to web/mobile).
 */
export interface Playbook {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	documents: PlaybookDocumentEntry[];
	loopEnabled: boolean;
	maxLoops?: number | null;
	prompt: string;
}

/**
 * Launch configuration for Auto Run.
 */
export interface LaunchConfig {
	documents: Array<{ filename: string; resetOnCompletion?: boolean }>;
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
 * Saveable playbook payload (no id/timestamps - those are server-assigned).
 */
export interface PlaybookDraft {
	name: string;
	documents: PlaybookDocumentEntry[];
	loopEnabled: boolean;
	maxLoops?: number | null;
	prompt: string;
}

/**
 * Result of an Auto Run launch attempt.
 */
export interface LaunchAutoRunResult {
	success: boolean;
	error?: string;
}

/**
 * Return value from useAutoRun hook.
 */
export interface UseAutoRunReturn {
	documents: AutoRunDocument[];
	autoRunState: AutoRunState | null;
	isLoadingDocs: boolean;
	selectedDoc: SelectedDocument | null;
	playbooks: Playbook[];
	isLoadingPlaybooks: boolean;
	loadDocuments: (sessionId: string) => Promise<void>;
	loadDocumentContent: (sessionId: string, filename: string) => Promise<void>;
	saveDocumentContent: (sessionId: string, filename: string, content: string) => Promise<boolean>;
	resetDocumentTasks: (sessionId: string, filename: string) => Promise<boolean>;
	launchAutoRun: (sessionId: string, config: LaunchConfig) => Promise<LaunchAutoRunResult>;
	stopAutoRun: (sessionId: string) => Promise<boolean>;
	loadGitBranches: (sessionId: string) => Promise<{ branches: string[]; currentBranch?: string }>;
	listWorktrees: (sessionId: string) => Promise<WorktreeSummary[]>;
	resumeAutoRunError: (sessionId: string) => Promise<boolean>;
	skipAutoRunDocument: (sessionId: string) => Promise<boolean>;
	abortAutoRunError: (sessionId: string) => Promise<boolean>;
	loadPlaybooks: (sessionId: string) => Promise<void>;
	createPlaybook: (sessionId: string, draft: PlaybookDraft) => Promise<Playbook | null>;
	updatePlaybook: (
		sessionId: string,
		playbookId: string,
		updates: Partial<PlaybookDraft>
	) => Promise<Playbook | null>;
	deletePlaybook: (sessionId: string, playbookId: string) => Promise<boolean>;
}

/**
 * Hook for managing Auto Run state and operations.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param _send - Reserved for fire-and-forget messages (currently unused; kept
 *   in the signature for caller compatibility while every operation flows
 *   through `sendRequest` so callers can await responses)
 */
export function useAutoRun(
	sendRequest: UseWebSocketReturn['sendRequest'],
	_send: UseWebSocketReturn['send'],
	autoRunState: AutoRunState | null = null
): UseAutoRunReturn {
	const [documents, setDocuments] = useState<AutoRunDocument[]>([]);
	const [isLoadingDocs, setIsLoadingDocs] = useState(false);
	const [selectedDoc, setSelectedDoc] = useState<SelectedDocument | null>(null);
	const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
	const [isLoadingPlaybooks, setIsLoadingPlaybooks] = useState(false);

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

	const resetDocumentTasks = useCallback(
		async (sessionId: string, filename: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('reset_auto_run_doc_tasks', {
					sessionId,
					filename,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const launchAutoRun = useCallback(
		async (sessionId: string, config: LaunchConfig): Promise<LaunchAutoRunResult> => {
			const useWorktreeTimeout = Boolean(config.worktree && config.worktree.enabled);
			const timeoutMs = useWorktreeTimeout ? LAUNCH_WORKTREE_TIMEOUT_MS : LAUNCH_TIMEOUT_MS;
			let response: { success?: boolean; error?: string };
			try {
				response = await sendRequest<{ success?: boolean; error?: string }>(
					'configure_auto_run',
					{
						sessionId,
						documents: config.documents,
						prompt: config.prompt,
						loopEnabled: config.loopEnabled,
						maxLoops: config.maxLoops,
						launch: true,
						...(config.worktree && config.worktree.enabled ? { worktree: config.worktree } : {}),
					},
					timeoutMs
				);
			} catch (error) {
				// Handle known transport failures gracefully so the caller can
				// revert the optimistic indicator without a thrown exception.
				const message = error instanceof Error ? error.message : String(error);
				if (KNOWN_TRANSPORT_ERRORS.has(message)) {
					return { success: false, error: message };
				}
				// Anything else is unexpected - re-throw so it bubbles to the
				// caller's catch (which still reverts the optimistic UI) and to
				// any global unhandled-rejection / Sentry handler. Per
				// `CLAUDE.md` → Error Handling & Sentry, only known/recoverable
				// errors should be swallowed.
				throw error;
			}
			return {
				success: response.success ?? false,
				error: response.error,
			};
		},
		[sendRequest]
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

	const resumeAutoRunError = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('resume_auto_run_error', {
					sessionId,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const skipAutoRunDocument = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('skip_auto_run_document', {
					sessionId,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const abortAutoRunError = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('abort_auto_run_error', {
					sessionId,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const loadPlaybooks = useCallback(
		async (sessionId: string) => {
			setIsLoadingPlaybooks(true);
			try {
				const response = await sendRequest<{ playbooks?: Playbook[] }>('list_playbooks', {
					sessionId,
				});
				setPlaybooks(Array.isArray(response.playbooks) ? response.playbooks : []);
			} catch {
				setPlaybooks([]);
			} finally {
				setIsLoadingPlaybooks(false);
			}
		},
		[sendRequest]
	);

	const createPlaybook = useCallback(
		async (sessionId: string, draft: PlaybookDraft): Promise<Playbook | null> => {
			try {
				const response = await sendRequest<{ success?: boolean; playbook?: Playbook | null }>(
					'create_playbook',
					{
						sessionId,
						playbook: draft,
					}
				);
				const created = response.playbook ?? null;
				if (created) {
					setPlaybooks((prev) => [...prev, created]);
				}
				return created;
			} catch {
				return null;
			}
		},
		[sendRequest]
	);

	const updatePlaybook = useCallback(
		async (
			sessionId: string,
			playbookId: string,
			updates: Partial<PlaybookDraft>
		): Promise<Playbook | null> => {
			try {
				const response = await sendRequest<{ success?: boolean; playbook?: Playbook | null }>(
					'update_playbook',
					{
						sessionId,
						playbookId,
						updates,
					}
				);
				const updated = response.playbook ?? null;
				if (updated) {
					setPlaybooks((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
				}
				return updated;
			} catch {
				return null;
			}
		},
		[sendRequest]
	);

	const deletePlaybook = useCallback(
		async (sessionId: string, playbookId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('delete_playbook', {
					sessionId,
					playbookId,
				});
				const success = response.success ?? false;
				if (success) {
					setPlaybooks((prev) => prev.filter((p) => p.id !== playbookId));
				}
				return success;
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
		playbooks,
		isLoadingPlaybooks,
		loadDocuments,
		loadDocumentContent,
		saveDocumentContent,
		resetDocumentTasks,
		launchAutoRun,
		stopAutoRun,
		loadGitBranches,
		listWorktrees,
		resumeAutoRunError,
		skipAutoRunDocument,
		abortAutoRunError,
		loadPlaybooks,
		createPlaybook,
		updatePlaybook,
		deletePlaybook,
	};
}

export default useAutoRun;
