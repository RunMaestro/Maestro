import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, FocusArea } from '../../types';
import {
	shouldOpenExternally,
	getAllFolderPaths,
	type FileTreeNode,
} from '../../utils/fileExplorer';
import type { FileNode } from '../../types/fileTree';
import { useModalStore } from '../../stores/modalStore';
import { useSessionStore } from '../../stores/sessionStore';
import { generateId } from '../../utils/ids';
import { closeFileTab as closeFileTabHelper } from '../../utils/tabHelpers';
import { logger } from '../../utils/logger';

/**
 * If a remote-file loading tab is still in flight in the target session,
 * close it. Used when the SSH read failed or returned null without the user
 * having closed the tab themselves. Tabs that are no longer loading (or no
 * longer present at all) are left alone — the user may have already closed
 * them, or the path may have been replaced by a different file.
 */
function closeLoadingTabIfStillLoading(
	targetSessionId: string,
	path: string,
	loadRequestId: string
): void {
	const { setSessions } = useSessionStore.getState();
	setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== targetSessionId) return s;
			const tab = s.filePreviewTabs.find(
				(t) => t.path === path && t.isLoading && t.loadRequestId === loadRequestId
			);
			if (!tab) return s;
			const result = closeFileTabHelper(s, tab.id);
			return result ? result.session : s;
		})
	);
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
	/** Open the tab in loading state (no content yet). Used for slow remote reads. */
	isLoading?: boolean;
	/** While isLoading, the in-flight fs:readFile requestId — cancelled if the tab is closed mid-load. */
	loadRequestId?: string;
}

/**
 * Options for opening a file tab.
 */
export interface FileTabOpenOptions {
	openInNewTab?: boolean;
	/** Override which session the tab is created in (defaults to current active session). */
	targetSessionId?: string;
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
	onOpenFileTab?: (file: FileTabInfo, options?: FileTabOpenOptions) => void;
}

/**
 * Return type for useAppHandlers hook.
 */
export interface UseAppHandlersReturn {
	// Drag handlers
	/** Handle drag enter for image drop zone */
	handleFileDragEnter: (e: React.DragEvent) => void;
	/** Handle drag leave for image drop zone */
	handleFileDragLeave: (e: React.DragEvent) => void;
	/** Handle drag over for image drop zone */
	handleFileDragOver: (e: React.DragEvent) => void;
	/** Whether an image is currently being dragged over the app */
	isDraggingFile: boolean;
	/** Setter for drag state (used by drop handler) */
	setIsDraggingFile: React.Dispatch<React.SetStateAction<boolean>>;
	/** Ref to drag counter for drop handler */
	dragCounterRef: React.MutableRefObject<number>;

	// File handlers
	/** Handle file click in file explorer */
	handleFileClick: (node: FileNode, path: string) => Promise<void>;
	/** Update working directory via folder selection dialog */
	updateSessionWorkingDirectory: () => Promise<void>;

	// Folder handlers
	/** Toggle folder expansion in file explorer */
	toggleFolder: (
		path: string,
		sessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	/** Toggle folder and all descendants (Alt+Click) */
	toggleFolderRecursive: (
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
 * Collect all descendant folder paths under a given set of nodes.
 */
function collectDescendantFolders(nodes: FileTreeNode[], currentPath: string): string[] {
	const result: string[] = [];
	for (const node of nodes) {
		const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
		if (node.type === 'folder') {
			result.push(fullPath);
			if (node.children) {
				result.push(...collectDescendantFolders(node.children, fullPath));
			}
		}
	}
	return result;
}

/**
 * Find a folder by targetPath in the tree and return it plus all descendant folder paths.
 */
function findSubtreeFolders(
	nodes: FileTreeNode[],
	currentPath: string,
	targetPath: string
): string[] | null {
	for (const node of nodes) {
		const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;
		if (fullPath === targetPath && node.type === 'folder') {
			const descendants = node.children ? collectDescendantFolders(node.children, fullPath) : [];
			return [fullPath, ...descendants];
		}
		if (node.type === 'folder' && node.children && targetPath.startsWith(fullPath + '/')) {
			const found = findSubtreeFolders(node.children, fullPath, targetPath);
			if (found) return found;
		}
	}
	return null;
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
	const [isDraggingFile, setIsDraggingFile] = useState(false);
	const dragCounterRef = useRef(0);

	// --- DRAG HANDLERS ---

	const handleFileDragEnter = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current++;
		// Show the overlay for either OS-level file drags ("Files") or internal
		// drags from the Files panel (which only carry the custom MIME type).
		if (
			e.dataTransfer.types.includes('Files') ||
			e.dataTransfer.types.includes('application/x-maestro-file-path')
		) {
			setIsDraggingFile(true);
		}
	}, []);

	const handleFileDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current--;
		// Only hide overlay when all nested elements have been left
		if (dragCounterRef.current <= 0) {
			dragCounterRef.current = 0;
			setIsDraggingFile(false);
		}
	}, []);

	const handleFileDragOver = useCallback((e: React.DragEvent) => {
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
			setIsDraggingFile(false);
		};

		const handleDocumentDragOver = (e: DragEvent) => {
			e.preventDefault();
		};

		const handleDocumentDrop = (e: DragEvent) => {
			e.preventDefault();
			handleDragEnd();
		};

		// Escape during a drag doesn't reliably fire `dragend` for OS-initiated
		// drags in Chromium/Electron, leaving the overlay stuck. Catch ESC
		// directly as a fallback.
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && dragCounterRef.current > 0) {
				handleDragEnd();
			}
		};

		// When the cursor leaves the window entirely during an external drag,
		// any subsequent ESC/drop happens outside our event scope. Detect this
		// via a `dragleave` whose relatedTarget is null OR whose coordinates are
		// at/past the viewport edge, and reset the overlay state proactively.
		const handleDocumentDragLeave = (e: DragEvent) => {
			const leftWindow =
				e.relatedTarget === null ||
				e.clientX <= 0 ||
				e.clientY <= 0 ||
				e.clientX >= window.innerWidth ||
				e.clientY >= window.innerHeight;
			if (leftWindow) {
				handleDragEnd();
			}
		};

		// dragend fires when the drag operation ends (drop or cancel)
		document.addEventListener('dragend', handleDragEnd);
		// Use capture phase for dragover/drop so they fire BEFORE React handlers that call stopPropagation().
		// This ensures preventDefault() is called at document level even when element handlers stop bubbling.
		document.addEventListener('dragover', handleDocumentDragOver, { capture: true });
		document.addEventListener('drop', handleDocumentDrop, { capture: true });
		document.addEventListener('keydown', handleKeyDown);
		document.addEventListener('dragleave', handleDocumentDragLeave);

		return () => {
			document.removeEventListener('dragend', handleDragEnd);
			document.removeEventListener('dragover', handleDocumentDragOver, { capture: true });
			document.removeEventListener('drop', handleDocumentDrop, { capture: true });
			document.removeEventListener('keydown', handleKeyDown);
			document.removeEventListener('dragleave', handleDocumentDragLeave);
		};
	}, []);

	// --- FILE HANDLERS ---

	const handleFileClick = useCallback(
		async (node: FileNode, path: string) => {
			if (!activeSession) return; // Guard against null session
			if (node.type !== 'file') return;

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
						await window.maestro.shell.openPath(fullPath);
					},
				});
				return;
			}

			// Pin the originating session so the loading tab and final content
			// land in the agent the user clicked from, even if they switch agents
			// while the SSH read is in flight.
			const targetSessionId = activeSession.id;

			// For SSH remote files, eagerly create a tab in loading state so the
			// loading UI is anchored to a real per-session tab (and stays put if
			// the user switches agents). The tab also carries the requestId we
			// use to cancel the SSH read if the user closes it mid-load.
			let loadRequestId: string | undefined;
			if (sshRemoteId) {
				loadRequestId = generateId();
				onOpenFileTab?.(
					{
						path: fullPath,
						name: node.name,
						content: '',
						sshRemoteId,
						isLoading: true,
						loadRequestId,
					},
					{ targetSessionId }
				);
				setActiveFocus('main');
			}

			try {
				// Pass SSH remote ID for remote sessions
				// Fetch both content and stat for lastModified timestamp
				const [content, stat] = await Promise.all([
					window.maestro.fs.readFile(fullPath, sshRemoteId, loadRequestId),
					window.maestro.fs.stat(fullPath, sshRemoteId),
				]);

				// content === null means either the file is missing or the SSH read
				// was cancelled (user closed the loading tab). In both cases the tab
				// has either been closed by the user or never existed; surface a
				// closure for the loading tab if it's still hanging around.
				if (content === null) {
					if (loadRequestId) {
						closeLoadingTabIfStillLoading(targetSessionId, fullPath, loadRequestId);
					}
					return;
				}

				const lastModified = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : Date.now();

				// Fill the per-session tab with content. For SSH this hits the
				// existing-tab branch in handleOpenFileTab (matching by path) and
				// flips isLoading off; for local files it opens the tab fresh.
				onOpenFileTab?.(
					{
						path: fullPath,
						name: node.name,
						content,
						sshRemoteId,
						lastModified,
					},
					{ targetSessionId }
				);
				setActiveFocus('main');
			} catch (error) {
				logger.error('Failed to read file:', undefined, error);
				// Don't strand a loading tab if the SSH read errored out.
				if (loadRequestId) {
					closeLoadingTabIfStillLoading(targetSessionId, fullPath, loadRequestId);
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

	/**
	 * Toggle a folder and all its descendant folders (Alt+Click behavior).
	 * If the folder is currently expanded, collapse it and all descendants.
	 * If collapsed, expand it and all descendants.
	 */
	const toggleFolderRecursive = useCallback(
		(
			path: string,
			sessionId: string,
			setSessionsFn: React.Dispatch<React.SetStateAction<Session[]>>
		) => {
			setSessionsFn((prev) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					if (!s.fileExplorerExpanded || !s.fileTree) return s;
					const expanded = new Set(s.fileExplorerExpanded);
					const isCurrentlyExpanded = expanded.has(path);
					const allPaths = findSubtreeFolders(s.fileTree, '', path) || [path];

					if (isCurrentlyExpanded) {
						for (const p of allPaths) {
							expanded.delete(p);
						}
					} else {
						for (const p of allPaths) {
							expanded.add(p);
						}
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
		handleFileDragEnter,
		handleFileDragLeave,
		handleFileDragOver,
		isDraggingFile,
		setIsDraggingFile,
		dragCounterRef,

		// File handlers
		handleFileClick,
		updateSessionWorkingDirectory,

		// Folder handlers
		toggleFolder,
		toggleFolderRecursive,
		expandAllFolders,
		collapseAllFolders,
	};
}
