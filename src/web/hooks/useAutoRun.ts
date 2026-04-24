/**
 * useAutoRun hook for Auto Run state management in the web interface.
 *
 * Provides document listing, content loading/saving, launch/stop controls,
 * playbook CRUD, task reset, and error-pause recovery — mirroring the desktop
 * Auto Run capability surface so mobile/web users have feature parity.
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
}

/**
 * Saveable playbook payload (no id/timestamps — those are server-assigned).
 */
export interface PlaybookDraft {
	name: string;
	documents: PlaybookDocumentEntry[];
	loopEnabled: boolean;
	maxLoops?: number | null;
	prompt: string;
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
	launchAutoRun: (sessionId: string, config: LaunchConfig) => boolean;
	stopAutoRun: (sessionId: string) => Promise<boolean>;
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
 * @param send - WebSocket send function for fire-and-forget messages
 */
export function useAutoRun(
	sendRequest: UseWebSocketReturn['sendRequest'],
	send: UseWebSocketReturn['send'],
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
		(sessionId: string, config: LaunchConfig): boolean => {
			return send({
				type: 'configure_auto_run',
				sessionId,
				documents: config.documents,
				prompt: config.prompt,
				loopEnabled: config.loopEnabled,
				maxLoops: config.maxLoops,
				launch: true,
			});
		},
		[send]
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
