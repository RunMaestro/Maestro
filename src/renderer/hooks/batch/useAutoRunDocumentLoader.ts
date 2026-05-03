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

// SSH remote folders can't use chokidar, so we poll. The first iteration is
// scheduled after this delay (not immediate) so it doesn't double-fetch on top
// of the loader effect's initial pass.
const REMOTE_POLL_INTERVAL_MS = 20000;

// ============================================================================
// Hook implementation
// ============================================================================

export function useAutoRunDocumentLoader(): UseAutoRunDocumentLoaderReturn {
	const loadSequenceRef = useRef(0);
	// Last (sessionId|folder|sshRemoteId) tuple — lets us distinguish a true
	// session/folder change (full reload) from a `selectedFile`-only change
	// (single-file content fetch).
	const structureKeyRef = useRef<string | null>(null);

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

	// Internal helper: reads each doc once, counts tasks, and optionally
	// captures content for a single doc so callers don't have to re-read it.
	// `captureInList` tells the caller whether the requested capture target was
	// part of the documents list (so they can decide whether to fall back to an
	// explicit read for a stale selectedFile).
	const readTaskCountsAndContent = useCallback(
		async (
			folderPath: string,
			documents: string[],
			sshRemoteId: string | undefined,
			captureContentFor?: string
		) => {
			const counts = new Map<string, { completed: number; total: number }>();
			let capturedContent: string | undefined;
			const captureInList = !!captureContentFor && documents.includes(captureContentFor);

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
							if (captureContentFor && captureContentFor === docPath) {
								capturedContent = result.content;
							}
						}
					} catch {
						// Ignore errors for individual documents
					}
				})
			);

			return { counts, capturedContent, captureInList };
		},
		[]
	);

	// Public API: load task counts for all documents (back-compat signature)
	const loadTaskCounts = useCallback(
		async (folderPath: string, documents: string[], sshRemoteId?: string) => {
			const { counts } = await readTaskCountsAndContent(folderPath, documents, sshRemoteId);
			return counts;
		},
		[readTaskCountsAndContent]
	);

	// Helper: update a session's autoRunContent if it actually changed.
	const applySelectedContent = useCallback(
		(sessionId: string, nextContent: string) => {
			setSessions((prev) => {
				const target = prev.find((s) => s.id === sessionId);
				if (!target) return prev;
				if (target.autoRunContent === nextContent) return prev;
				return prev.map((s) =>
					s.id === sessionId
						? {
								...s,
								autoRunContent: nextContent,
								autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
							}
						: s
				);
			});
		},
		[setSessions]
	);

	// Loader effect: full reload on session/folder/sshRemoteId change,
	// targeted single-file content fetch when only selectedFile changes.
	useEffect(() => {
		const currentLoadSequence = ++loadSequenceRef.current;

		if (!activeSession?.autoRunFolderPath) {
			structureKeyRef.current = null;
			setAutoRunDocumentList([]);
			setAutoRunDocumentTree([]);
			setAutoRunDocumentTaskCounts(new Map());
			setAutoRunIsLoadingDocuments(false);
			return;
		}

		const folderPath = activeSession.autoRunFolderPath;
		const sshRemoteId =
			activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;
		const selectedFile = activeSession.autoRunSelectedFile;
		const sessionId = activeSession.id;

		const structureKey = `${activeSessionId}|${folderPath}|${sshRemoteId ?? ''}`;
		const structureChanged = structureKeyRef.current !== structureKey;
		structureKeyRef.current = structureKey;

		const load = async () => {
			if (structureChanged) {
				// Full reload: list + counts + selected file (deduped).
				setAutoRunIsLoadingDocuments(true);
				setAutoRunDocumentList([]);
				setAutoRunDocumentTree([]);
				setAutoRunDocumentTaskCounts(new Map());
				try {
					const listResult = await window.maestro.autorun.listDocs(folderPath, sshRemoteId);
					if (currentLoadSequence !== loadSequenceRef.current) return;
					if (listResult.success) {
						const files = listResult.files || [];
						setAutoRunDocumentList(files);
						setAutoRunDocumentTree(listResult.tree || []);

						const { counts, capturedContent, captureInList } = await readTaskCountsAndContent(
							folderPath,
							files,
							sshRemoteId,
							selectedFile
						);
						if (currentLoadSequence !== loadSequenceRef.current) return;
						setAutoRunDocumentTaskCounts(counts);

						if (selectedFile) {
							let content: string;
							if (captureInList) {
								// Already read during task counting — reuse it.
								content = capturedContent ?? '';
							} else {
								// Selected file isn't in the listing (stale ref); read explicitly.
								const contentResult = await window.maestro.autorun.readDoc(
									folderPath,
									selectedFile + '.md',
									sshRemoteId
								);
								if (currentLoadSequence !== loadSequenceRef.current) return;
								content = contentResult.success ? contentResult.content || '' : '';
							}
							setSessions((prev) =>
								prev.map((s) =>
									s.id === sessionId
										? {
												...s,
												autoRunContent: content,
												autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
											}
										: s
								)
							);
						}
					}
				} finally {
					if (currentLoadSequence === loadSequenceRef.current) {
						setAutoRunIsLoadingDocuments(false);
					}
				}
			} else if (selectedFile) {
				// Only the selected file changed — read just that file.
				const contentResult = await window.maestro.autorun.readDoc(
					folderPath,
					selectedFile + '.md',
					sshRemoteId
				);
				if (currentLoadSequence !== loadSequenceRef.current) return;
				const newContent = contentResult.success ? contentResult.content || '' : '';
				setSessions((prev) =>
					prev.map((s) =>
						s.id === sessionId
							? {
									...s,
									autoRunContent: newContent,
									autoRunContentVersion: (s.autoRunContentVersion || 0) + 1,
								}
							: s
					)
				);
			}
		};

		load();
		// Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
	}, [
		activeSessionId,
		activeSession?.id,
		activeSession?.autoRunFolderPath,
		activeSession?.autoRunSelectedFile,
		activeSession?.sshRemoteId,
		activeSession?.sessionSshRemoteConfig?.remoteId,
		readTaskCountsAndContent,
	]);

	// File watching for Auto Run - watch whenever a folder is configured
	// Updates reflect immediately whether from batch runs, terminal commands, or external editors
	// Note: For SSH remote sessions, file watching via chokidar is not available.
	// The backend returns isRemote: true and the UI should use polling instead.
	useEffect(() => {
		const sessionId = activeSession?.id;
		const folderPath = activeSession?.autoRunFolderPath;
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
			if (!listResult.success) return;

			const files = listResult.files || [];
			setAutoRunDocumentList(files);
			setAutoRunDocumentTree(listResult.tree || []);

			// Re-read selectedFile from the store at refresh time (the user may
			// have switched docs since this effect was set up).
			const currentSelected = useSessionStore
				.getState()
				.sessions.find((s) => s.id === sessionId)?.autoRunSelectedFile;

			const { counts, capturedContent, captureInList } = await readTaskCountsAndContent(
				folderPath,
				files,
				sshRemoteId,
				currentSelected
			);
			if (disposed) return;
			setAutoRunDocumentTaskCounts(counts);

			if (currentSelected) {
				let nextContent: string;
				if (captureInList) {
					nextContent = capturedContent ?? '';
				} else {
					const contentResult = await window.maestro.autorun.readDoc(
						folderPath,
						currentSelected + '.md',
						sshRemoteId
					);
					if (disposed) return;
					if (!contentResult.success) return;
					nextContent = contentResult.content || '';
				}
				applySelectedContent(sessionId, nextContent);
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
							}, REMOTE_POLL_INTERVAL_MS);
						}
					}
				};
				// Defer the first poll. The loader effect just performed the
				// initial pass; firing immediately would duplicate that work.
				remotePollTimeout = setTimeout(() => {
					void runRemotePoll();
				}, REMOTE_POLL_INTERVAL_MS);
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
		// Intentionally NOT depending on autoRunSelectedFile — the watcher reads
		// the latest selected file from the store at refresh time, so changing
		// the selected doc shouldn't tear down and re-establish the watcher.
		// Note: Use primitive values (remoteId) not object refs (sessionSshRemoteConfig) to avoid infinite re-render loops
	}, [
		activeSession?.id,
		activeSession?.autoRunFolderPath,
		activeSession?.sshRemoteId,
		activeSession?.sessionSshRemoteConfig?.remoteId,
		readTaskCountsAndContent,
		applySelectedContent,
	]);

	return { loadTaskCounts };
}
