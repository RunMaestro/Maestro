import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, FocusArea } from '../../types';
import { shouldOpenExternally, getAllFolderPaths } from '../../utils/fileExplorer';
import { useModalStore } from '../../stores/modalStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';

/** Loading state for file preview (shown while fetching remote files) */
export interface FilePreviewLoading {
	name: string;
	path: string;
}

/**
 * File info for opening in a file preview tab.
 */
export interface FileTabInfo {
	path: string;
	name: string;
	content: string;
	sshRemoteId?: string;
	lastModified?: number;
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
	/** Confirmation modal message setter */
	setConfirmModalMessage: (message: string) => void;
	/** Confirmation modal callback setter */
	setConfirmModalOnConfirm: (callback: () => () => void) => void;
	/** Confirmation modal open setter */
	setConfirmModalOpen: (open: boolean) => void;
	/**
	 * Callback to open a file in a tab (new tab-based file preview).
	 * When provided, file clicks will open tabs instead of the overlay.
	 */
	onOpenFileTab?: (file: FileTabInfo) => void;
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
		setConfirmModalMessage,
		setConfirmModalOnConfirm,
		setConfirmModalOpen,
		onOpenFileTab,
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

	// Prevent default drag-and-drop behavior at the document level.
	// This is critical in Electron/Chromium: without preventing default on both
	// dragover and drop at the document level, the browser can fall into a state
	// where subsequent drag-and-drop operations are rejected after the first drop.
	// Both events must have preventDefault() called to maintain a valid drop zone.
	useEffect(() => {
		const handleDragEnd = () => {
			dragCounterRef.current = 0;
			setIsDraggingImage(false);
		};

		const handleDocumentDragOver = (e: DragEvent) => {
			e.preventDefault();
		};

		const handleDocumentDrop = (e: DragEvent) => {
			e.preventDefault();
			handleDragEnd();
		};

		// dragend fires when the drag operation ends (drop or cancel)
		document.addEventListener('dragend', handleDragEnd);
		// Use capture phase for dragover/drop so they fire BEFORE React handlers that call stopPropagation().
		// This ensures preventDefault() is called at document level even when element handlers stop bubbling.
		document.addEventListener('dragover', handleDocumentDragOver, { capture: true });
		document.addEventListener('drop', handleDocumentDrop, { capture: true });

		return () => {
			document.removeEventListener('dragend', handleDragEnd);
			document.removeEventListener('dragover', handleDocumentDragOver, { capture: true });
			document.removeEventListener('drop', handleDocumentDrop, { capture: true });
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
					// Show confirmation modal before opening externally (use openModal atomically)
					useModalStore.getState().openModal('confirm', {
						message: `Open "${node.name}" in external application?`,
						onConfirm: async () => {
							await window.maestro.shell.openExternal(`file://${fullPath}`);
						},
					});
					return;
				}

				// Show loading state for remote files (SSH sessions may be slow)
				if (sshRemoteId) {
					useFileExplorerStore
						.getState()
						.setFilePreviewLoading({ name: node.name, path: fullPath });
				}

				try {
					// Pass SSH remote ID for remote sessions
					// Fetch both content and stat for lastModified timestamp
					const [content, stat] = await Promise.all([
						window.maestro.fs.readFile(fullPath, sshRemoteId),
						window.maestro.fs.stat(fullPath, sshRemoteId),
					]);
					const lastModified = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : Date.now();

					// Open file in tab-based file preview
					onOpenFileTab?.({
						path: fullPath,
						name: node.name,
						content,
						sshRemoteId,
						lastModified,
					});
					setActiveFocus('main');
				} catch (error) {
					console.error('Failed to read file:', error);
				} finally {
					// Clear loading state
					useFileExplorerStore.getState().setFilePreviewLoading(null);
				}
			}
		},
		[
			activeSession,
			setConfirmModalMessage,
			setConfirmModalOnConfirm,
			setConfirmModalOpen,
			setActiveFocus,
			onOpenFileTab,
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
			_session: Session,
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
