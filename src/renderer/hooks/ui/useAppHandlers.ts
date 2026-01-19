import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, FocusArea } from '../../types';
import { shouldOpenExternally, getAllFolderPaths } from '../../utils/fileExplorer';

/**
 * File preview information for file explorer navigation.
 */
export interface FilePreview {
	name: string;
	content: string;
	path: string;
}

/**
 * Dependencies for the useAppHandlers hook.
 */
/** Loading state for file preview (shown while fetching remote files) */
export interface FilePreviewLoading {
	name: string;
	path: string;
}

export interface UseAppHandlersDeps {
	/** Currently active session */
	activeSession: Session | null;
	/** ID of the currently active session */
	activeSessionId: string | null;
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Focus area setter */
	setActiveFocus: React.Dispatch<React.SetStateAction<FocusArea>>;
	/** File preview setter */
	setPreviewFile: (file: FilePreview | null) => void;
	/** File preview loading state setter (for remote file loading indicator) */
	setFilePreviewLoading?: (loading: FilePreviewLoading | null) => void;
	/** File preview history */
	filePreviewHistory: FilePreview[];
	/** File preview history setter */
	setFilePreviewHistory: (history: FilePreview[]) => void;
	/** Current index in file preview history */
	filePreviewHistoryIndex: number;
	/** File preview history index setter */
	setFilePreviewHistoryIndex: (index: number) => void;
	/** Confirmation modal message setter */
	setConfirmModalMessage: (message: string) => void;
	/** Confirmation modal callback setter */
	setConfirmModalOnConfirm: (callback: () => () => void) => void;
	/** Confirmation modal open setter */
	setConfirmModalOpen: (open: boolean) => void;
}

/**
 * Return type for useAppHandlers hook.
 */
export interface UseAppHandlersReturn {
	// Drag handlers
	/** Handle drag enter for image drop zone */
	handleImageDragEnter: (e: React.DragEvent) => void;
	/** Handle drag leave for image drop zone */
	handleImageDragLeave: (e: React.DragEvent) => void;
	/** Handle drag over for image drop zone */
	handleImageDragOver: (e: React.DragEvent) => void;
	/** Whether an image is currently being dragged over the app */
	isDraggingImage: boolean;
	/** Setter for drag state (used by drop handler) */
	setIsDraggingImage: React.Dispatch<React.SetStateAction<boolean>>;
	/** Ref to drag counter for drop handler */
	dragCounterRef: React.MutableRefObject<number>;

	// File handlers
	/** Handle file click in file explorer */
	handleFileClick: (node: { name: string; type: string }, path: string) => Promise<void>;
	/** Update working directory via folder selection dialog */
	updateSessionWorkingDirectory: () => Promise<void>;

	// Folder handlers
	/** Toggle folder expansion in file explorer */
	toggleFolder: (
		path: string,
		sessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	/** Expand all folders in file tree */
	expandAllFolders: (
		sessionId: string,
		session: Session,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	/** Collapse all folders in file tree */
	collapseAllFolders: (
		sessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
}

/**
 * Hook for app-level handlers: drag events, file operations, and folder management.
 *
 * Handles:
 * - Image drag/drop overlay state and events
 * - File click handling with external app support
 * - Working directory updates
 * - File tree folder expansion/collapse
 *
 * @param deps - Hook dependencies
 * @returns Handler functions and state
 */
export function useAppHandlers(deps: UseAppHandlersDeps): UseAppHandlersReturn {
	const {
		activeSession,
		activeSessionId,
		setSessions,
		setActiveFocus,
		setPreviewFile,
		setFilePreviewLoading,
		filePreviewHistory,
		setFilePreviewHistory,
		filePreviewHistoryIndex,
		setFilePreviewHistoryIndex,
		setConfirmModalMessage,
		setConfirmModalOnConfirm,
		setConfirmModalOpen,
	} = deps;

	// --- DRAG STATE ---
	const [isDraggingImage, setIsDraggingImage] = useState(false);
	const dragCounterRef = useRef(0);

	// --- DRAG HANDLERS ---

	const handleImageDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current++;
		// Check if dragging files that include images
		if (e.dataTransfer.types.includes('Files')) {
			setIsDraggingImage(true);
		}
	}, []);

	const handleImageDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current--;
		// Only hide overlay when all nested elements have been left
		if (dragCounterRef.current <= 0) {
			dragCounterRef.current = 0;
			setIsDraggingImage(false);
		}
	}, []);

	const handleImageDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
	}, []);

	// Reset drag state when drag ends (e.g., user cancels by pressing Escape or dragging outside window)
	useEffect(() => {
		const handleDragEnd = () => {
			dragCounterRef.current = 0;
			setIsDraggingImage(false);
		};

		// dragend fires when the drag operation ends (drop or cancel)
		document.addEventListener('dragend', handleDragEnd);
		// Also listen for drop anywhere in case it's not on our drop zone
		document.addEventListener('drop', handleDragEnd);

		return () => {
			document.removeEventListener('dragend', handleDragEnd);
			document.removeEventListener('drop', handleDragEnd);
		};
	}, []);

	// --- FILE HANDLERS ---

	const handleFileClick = useCallback(
		async (node: { name: string; type: string }, path: string) => {
			if (!activeSession) return; // Guard against null session
			if (node.type === 'file') {
				// Construct full file path using projectRoot (not fullPath which can diverge from file tree root)
				// The file tree is rooted at projectRoot, so paths are relative to it
				const treeRoot = activeSession.projectRoot || activeSession.fullPath;
				const fullPath = `${treeRoot}/${path}`;

				// Get SSH remote ID - use sshRemoteId (set after AI spawns) or fall back to sessionSshRemoteConfig
				// (set before spawn). This ensures file operations work for both AI and terminal-only SSH sessions.
				const sshRemoteId =
					activeSession.sshRemoteId || activeSession.sessionSshRemoteConfig?.remoteId || undefined;

				// Check if file should be opened externally (only for local files)
				if (!sshRemoteId && shouldOpenExternally(node.name)) {
					// Show confirmation modal before opening externally
					setConfirmModalMessage(`Open "${node.name}" in external application?`);
					setConfirmModalOnConfirm(() => async () => {
						await window.maestro.shell.openExternal(`file://${fullPath}`);
						setConfirmModalOpen(false);
					});
					setConfirmModalOpen(true);
					return;
				}

				// Show loading state for remote files (SSH sessions may be slow)
				if (sshRemoteId && setFilePreviewLoading) {
					setFilePreviewLoading({ name: node.name, path: fullPath });
				}

				try {
					// Pass SSH remote ID for remote sessions
					const content = await window.maestro.fs.readFile(fullPath, sshRemoteId);
					const newFile = {
						name: node.name,
						content: content,
						path: fullPath,
					};

					// Only add to history if it's a different file than the current one
					const currentFile = filePreviewHistory[filePreviewHistoryIndex];
					if (!currentFile || currentFile.path !== fullPath) {
						// Add to navigation history (truncate forward history if we're not at the end)
						const newHistory = filePreviewHistory.slice(0, filePreviewHistoryIndex + 1);
						newHistory.push(newFile);
						setFilePreviewHistory(newHistory);
						setFilePreviewHistoryIndex(newHistory.length - 1);
					}

					setPreviewFile(newFile);
					setActiveFocus('main');
				} catch (error) {
					console.error('Failed to read file:', error);
				} finally {
					// Clear loading state
					if (setFilePreviewLoading) {
						setFilePreviewLoading(null);
					}
				}
			}
		},
		[
			activeSession,
			filePreviewHistory,
			filePreviewHistoryIndex,
			setConfirmModalMessage,
			setConfirmModalOnConfirm,
			setConfirmModalOpen,
			setFilePreviewHistory,
			setFilePreviewHistoryIndex,
			setPreviewFile,
			setActiveFocus,
			setFilePreviewLoading,
		]
	);

	const updateSessionWorkingDirectory = useCallback(async () => {
		const newPath = await window.maestro.dialog.selectFolder();
		if (!newPath) return;

		setSessions((prev) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				return {
					...s,
					cwd: newPath,
					fullPath: newPath,
					projectRoot: newPath, // Also update projectRoot so Files tab header stays in sync
					fileTree: [],
					fileTreeError: undefined,
					// Clear ALL runtime SSH state when selecting a new local directory
					sshRemote: undefined,
					sshRemoteId: undefined,
					remoteCwd: undefined,
					// EXPLICITLY disable SSH for this session
					// Setting to { enabled: false, remoteId: null } overrides any agent-level SSH config
					// (undefined would fall back to agent-level config, which might have SSH enabled)
					sessionSshRemoteConfig: { enabled: false, remoteId: null },
				};
			})
		);
	}, [activeSessionId, setSessions]);

	// --- FOLDER HANDLERS ---

	const toggleFolder = useCallback(
		(
			path: string,
			sessionId: string,
			setSessionsFn: React.Dispatch<React.SetStateAction<Session[]>>
		) => {
			setSessionsFn((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					if (!s.fileExplorerExpanded) return s;
					const expanded = new Set(s.fileExplorerExpanded);
					if (expanded.has(path)) {
						expanded.delete(path);
					} else {
						expanded.add(path);
					}
					return { ...s, fileExplorerExpanded: Array.from(expanded) };
				})
			);
		},
		[]
	);

	const expandAllFolders = useCallback(
		(
			sessionId: string,
			session: Session,
			setSessionsFn: React.Dispatch<React.SetStateAction<Session[]>>
		) => {
			setSessionsFn((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					if (!s.fileTree) return s;
					const allFolderPaths = getAllFolderPaths(s.fileTree);
					return { ...s, fileExplorerExpanded: allFolderPaths };
				})
			);
		},
		[]
	);

	const collapseAllFolders = useCallback(
		(sessionId: string, setSessionsFn: React.Dispatch<React.SetStateAction<Session[]>>) => {
			setSessionsFn((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return { ...s, fileExplorerExpanded: [] };
				})
			);
		},
		[]
	);

	return {
		// Drag handlers
		handleImageDragEnter,
		handleImageDragLeave,
		handleImageDragOver,
		isDraggingImage,
		setIsDraggingImage,
		dragCounterRef,

		// File handlers
		handleFileClick,
		updateSessionWorkingDirectory,

		// Folder handlers
		toggleFolder,
		expandAllFolders,
		collapseAllFolders,
	};
}
