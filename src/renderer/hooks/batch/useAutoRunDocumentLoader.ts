/**
 * useAutoRunDocumentLoader — extracted from App.tsx
 *
 * Loads and watches Auto Run documents for the active session:
 *   - Counts tasks (checked/unchecked) in document content
 *   - Loads document list, tree, and task counts on session switch
 *   - Watches folder for file changes and reloads data
 *   - Updates per-session autoRunContent when selected file changes
 *
 * Reads from: sessionStore (activeSession), batchStore (document setters)
 */

import { useEffect, useCallback, useRef } from 'react';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useBatchStore } from '../../stores/batchStore';
import { countMarkdownTasks } from './batchUtils';

// ============================================================================
// Return type
// ============================================================================

export interface UseAutoRunDocumentLoaderReturn {
	/** Load task counts for a set of documents in a folder */
	loadTaskCounts: (
		folderPath: string,
		documents: string[],
		sshRemoteId?: string
	) => Promise<Map<string, { completed: number; total: number }>>;
}

// ============================================================================
// Hook implementation
// ============================================================================

export function useAutoRunDocumentLoader(): UseAutoRunDocumentLoaderReturn {
	const loadSequenceRef = useRef(0);

	// --- Reactive subscriptions ---
	const activeSession = useSessionStore(selectActiveSession);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);

	// --- Store actions (stable via getState) ---
	const { setSessions } = useSessionStore.getState();
	const {
		setDocumentList: setAutoRunDocumentList,
		setDocumentTree: setAutoRunDocumentTree,
		setIsLoadingDocuments: setAutoRunIsLoadingDocuments,
		setDocumentTaskCounts: setAutoRunDocumentTaskCounts,
	} = useBatchStore.getState();

	// Load task counts for all documents
	const loadTaskCounts = useCallback(
		async (folderPath: string, documents: string[], sshRemoteId?: string) => {
			const counts = new Map<string, { completed: number; total: number }>();

			// Load content and count tasks for each document in parallel
			await Promise.all(
				documents.map(async (docPath) => {
					try {
						const result = await window.maestro.autorun.readDoc(
							folderPath,
							docPath + '.md',
							sshRemoteId
						);
						if (result.success && result.content) {
							const taskCount = countMarkdownTasks(result.content);
							if (taskCount.total > 0) {
								counts.set(docPath, {
									completed: taskCount.checked,
									total: taskCount.total,
								});
							}
						}
					} catch {
						// Ignore errors for individual documents
					}
				})
			);

			return counts;
		},
		[]
	);

	// Load Auto Run document list and content when session changes
	// Always reload content from disk when switching sessions to ensure fresh data
	useEffect(() => {
		const loadAutoRunData = async () => {
			const currentLoadSequence = ++loadSequenceRef.current;

			if (!activeSession?.autoRunFolderPath) {
				setAutoRunDocumentList([]);
				setAutoRunDocumentTree([]);
				setAutoRunDocumentTaskCounts(new Map());
				setAutoRunIsLoadingDocuments(false);
				return;
			}

			// Get SSH remote ID for remote sessions (check both runtime and config values)
			const sshRemoteId =
				activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;

			// Load document list
			setAutoRunIsLoadingDocuments(true);
			// Clear previous session data immediately to avoid stale cross-session display
			setAutoRunDocumentList([]);
			setAutoRunDocumentTree([]);
			setAutoRunDocumentTaskCounts(new Map());
			try {
				const listResult = await window.maestro.autorun.listDocs(
					activeSession.autoRunFolderPath,
					sshRemoteId
				);
				if (currentLoadSequence !== loadSequenceRef.current) return;
				if (listResult.success) {
					const files = listResult.files || [];
					setAutoRunDocumentList(files);
					setAutoRunDocumentTree(listResult.tree || []);

					// Load task counts for all documents
					const counts = await loadTaskCounts(activeSession.autoRunFolderPath, files, sshRemoteId);
					if (currentLoadSequence !== loadSequenceRef.current) return;
					setAutoRunDocumentTaskCounts(counts);
				}

				// Always load content from disk when switching sessions
				// This ensures we have fresh data and prevents stale content from showing
				if (activeSession.autoRunSelectedFile) {
					const contentResult = await window.maestro.autorun.readDoc(
						activeSession.autoRunFolderPath,
						activeSession.autoRunSelectedFile + '.md',
						sshRemoteId
					);
					if (currentLoadSequence !== loadSequenceRef.current) return;
					const newContent = contentResult.success ? contentResult.content || '' : '';
					setSessions((prev) =>
						prev.map((s) =>
							s.id === activeSession.id
								? {
										...s,
										autoRunContent: newContent,
										autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
									}
								: s
						)
					);
				}
			} finally {
				if (currentLoadSequence === loadSequenceRef.current) {
					setAutoRunIsLoadingDocuments(false);
				}
			}
		};

		loadAutoRunData();
		// Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
	}, [
		activeSessionId,
		activeSession?.autoRunFolderPath,
		activeSession?.autoRunSelectedFile,
		activeSession?.sshRemoteId,
		activeSession?.sessionSshRemoteConfig?.remoteId,
		loadTaskCounts,
	]);

	// File watching for Auto Run - watch whenever a folder is configured
	// Updates reflect immediately whether from batch runs, terminal commands, or external editors
	// Note: For SSH remote sessions, file watching via chokidar is not available.
	// The backend returns isRemote: true and the UI should use polling instead.
	useEffect(() => {
		const sessionId = activeSession?.id;
		const folderPath = activeSession?.autoRunFolderPath;
		const selectedFile = activeSession?.autoRunSelectedFile;
		// Get SSH remote ID for remote sessions (check both runtime and config values)
		const sshRemoteId =
			activeSession?.sshRemoteId || activeSession?.sessionSshRemoteConfig?.remoteId || undefined;

		// Only watch if folder is set
		if (!folderPath || !sessionId) return;

		let disposed = false;
		let unsubscribe = () => {};
		let remotePollTimeout: ReturnType<typeof setTimeout> | null = null;
		let isRefreshing = false;

		const refreshAutoRunData = async () => {
			const listResult = await window.maestro.autorun.listDocs(folderPath, sshRemoteId);
			if (disposed) return;
			if (listResult.success) {
				const files = listResult.files || [];
				setAutoRunDocumentList(files);
				setAutoRunDocumentTree(listResult.tree || []);

				const counts = await loadTaskCounts(folderPath, files, sshRemoteId);
				if (disposed) return;
				setAutoRunDocumentTaskCounts(counts);
			}

			if (selectedFile) {
				const contentResult = await window.maestro.autorun.readDoc(
					folderPath,
					selectedFile + '.md',
					sshRemoteId
				);
				if (disposed) return;
				if (contentResult.success) {
					setSessions((prev) =>
						prev.map((s) =>
							s.id === sessionId
								? {
										...s,
										autoRunContent: contentResult.content || '',
										autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
									}
								: s
						)
					);
				}
			}
		};

		(async () => {
			const watchResult = await window.maestro.autorun.watchFolder(folderPath, sshRemoteId);
			if (disposed) return;

			// SSH remote sessions don't support file watchers; fall back to polling.
			if ((watchResult as any)?.isRemote) {
				const runRemotePoll = async () => {
					if (disposed || isRefreshing) return;
					isRefreshing = true;
					try {
						await refreshAutoRunData();
					} finally {
						isRefreshing = false;
						if (!disposed) {
							remotePollTimeout = setTimeout(() => {
								void runRemotePoll();
							}, 3000);
						}
					}
				};
				void runRemotePoll();
				return;
			}

			// Local sessions use file change events.
			unsubscribe = window.maestro.autorun.onFileChanged(async (data) => {
				if (disposed) return;
				if (data.folderPath !== folderPath) return;

				await refreshAutoRunData();
			});
		})();

		// Cleanup: stop watching when folder changes or unmount
		return () => {
			disposed = true;
			if (remotePollTimeout) {
				clearTimeout(remotePollTimeout);
				remotePollTimeout = null;
			}
			window.maestro.autorun.unwatchFolder(folderPath);
			unsubscribe();
		};
		// Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
	}, [
		activeSession?.id,
		activeSession?.autoRunFolderPath,
		activeSession?.autoRunSelectedFile,
		activeSession?.sshRemoteId,
		activeSession?.sessionSshRemoteConfig?.remoteId,
		loadTaskCounts,
	]);

	return { loadTaskCounts };
}
