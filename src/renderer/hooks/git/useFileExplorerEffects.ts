/**
 * useFileExplorerEffects — extracted from App.tsx (Phase 2.6)
 *
 * Owns all file-explorer side effects and keyboard navigation:
 *   - Scroll position restore on session switch
 *   - Flat file list computation (keyboard-navigable list)
 *   - Pending jump path handler (/jump command)
 *   - Scroll to selected file on keyboard navigation
 *   - File explorer keyboard navigation (arrow keys, enter, etc.)
 *   - handleMainPanelFileClick (open [[wiki]] and path links)
 *   - stableFileTree memo (prevents re-renders)
 *
 * Reads from: sessionStore, uiStore, fileExplorerStore
 */

import { useEffect, useMemo, useCallback } from 'react';
import type { Session } from '../../types';
import type { FileNode } from '../../types/fileTree';
import { useSessionStore, selectActiveSession } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useFileExplorerStore } from '../../stores/fileExplorerStore';
import { shouldOpenExternally, flattenTree, type FlatTreeNode } from '../../utils/fileExplorer';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { captureException } from '../../utils/sentry';

// ============================================================================
// Dependencies interface
// ============================================================================

export interface UseFileExplorerEffectsDeps {
	/** Sessions ref for non-reactive access in callbacks */
	sessionsRef: React.MutableRefObject<Session[]>;
	/** Active session ID ref for non-reactive access in callbacks */
	activeSessionIdRef: React.MutableRefObject<string>;
	/** File tree container ref for scroll position management */
	fileTreeContainerRef: React.RefObject<HTMLDivElement | null>;
	/** Keyboard navigation flag ref (shared with useInputHandlers) */
	fileTreeKeyboardNavRef: React.MutableRefObject<boolean>;
	/** Filtered file tree from useFileTreeManagement */
	filteredFileTree: FileNode[];
	/** Whether tab completion dropdown is open */
	tabCompletionOpen: boolean;
	/** Toggle folder expand/collapse in file tree */
	toggleFolder: (path: string, sessionId: string, setSessions: any) => void;
	/** Handle file click from file tree */
	handleFileClick: (item: FlatTreeNode, fullPath: string) => void;
	/** Open a file in a tab */
	handleOpenFileTab: (
		fileData: {
			path: string;
			name: string;
			content: string;
			sshRemoteId?: string;
			lastModified?: number;
		},
		options?: { openInNewTab?: boolean; targetSessionId?: string }
	) => void;
}

// ============================================================================
// Return type
// ============================================================================

export interface UseFileExplorerEffectsReturn {
	/** Stable file tree reference (prevents re-renders) */
	stableFileTree: FileNode[];
	/** Handle click on [[wiki]] links and file paths in markdown */
	handleMainPanelFileClick: (
		relativePath: string,
		options?: { openInNewTab?: boolean }
	) => Promise<void>;
}

function stripLineColumnSuffix(filePath: string): string {
	return filePath.replace(/:(\d+)(?::\d+)?$/, '');
}

function isAbsoluteFilePath(filePath: string): boolean {
	return (
		filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
	);
}

function joinFilePath(rootPath: string, relativePath: string): string {
	const root = rootPath.replace(/[\\/]+$/, '');
	const child = relativePath.replace(/^[\\/]+/, '');
	return `${root}/${child}`;
}

function resolveClickedFilePath(projectRoot: string, fileReference: string): string {
	const normalizedReference = stripLineColumnSuffix(fileReference.trim());
	if (isAbsoluteFilePath(normalizedReference)) {
		return normalizedReference;
	}
	return joinFilePath(projectRoot, normalizedReference);
}

function getFilename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() || filePath;
}

// ============================================================================
// Hook
// ============================================================================

export function useFileExplorerEffects(
	deps: UseFileExplorerEffectsDeps
): UseFileExplorerEffectsReturn {
	const {
		sessionsRef,
		activeSessionIdRef,
		fileTreeContainerRef,
		fileTreeKeyboardNavRef,
		filteredFileTree,
		tabCompletionOpen,
		toggleFolder,
		handleFileClick,
		handleOpenFileTab,
	} = deps;

	// --- Store subscriptions ---
	// PERF: Never useSessionStore(selectActiveSession). Streamed logs/tokens would
	// wake App via this hook. Subscribe only to file-explorer fields needed for
	// tree flatten / jump / keyboard expand state.
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const fileTree = useSessionStore((s) => selectActiveSession(s)?.fileTree);
	const fileExplorerExpanded = useSessionStore((s) => selectActiveSession(s)?.fileExplorerExpanded);
	const pendingJumpPath = useSessionStore((s) => selectActiveSession(s)?.pendingJumpPath);
	const setSessions = useMemo(() => useSessionStore.getState().setSessions, []);

	const activeFocus = useUIStore((s) => s.activeFocus);
	const activeRightTab = useUIStore((s) => s.activeRightTab);
	const setActiveFocus = useMemo(() => useUIStore.getState().setActiveFocus, []);
	const showHiddenFiles = useSettingsStore((s) => s.showHiddenFiles);

	const selectedFileIndex = useFileExplorerStore((s) => s.selectedFileIndex);
	const flatFileList = useFileExplorerStore((s) => s.flatFileList);
	const setSelectedFileIndex = useMemo(
		() => useFileExplorerStore.getState().setSelectedFileIndex,
		[]
	);
	const setFilteredFileTree = useMemo(
		() => useFileExplorerStore.getState().setFilteredFileTree,
		[]
	);
	const setFlatFileList = useMemo(() => useFileExplorerStore.getState().setFlatFileList, []);
	const setSelectedPaths = useMemo(() => useFileExplorerStore.getState().setSelectedPaths, []);
	const setSelectionAnchorIndex = useMemo(
		() => useFileExplorerStore.getState().setSelectionAnchorIndex,
		[]
	);

	const { hasOpenModal } = useLayerStack();

	// ====================================================================
	// stableFileTree — prevents FilePreview re-renders during agent activity
	// ====================================================================

	const stableFileTree = useMemo(() => fileTree || [], [fileTree]);

	// ====================================================================
	// handleMainPanelFileClick — open [[wiki]] and path links in markdown
	// ====================================================================

	const handleMainPanelFileClick = useCallback(
		async (relativePath: string, options?: { openInNewTab?: boolean }) => {
			const currentSession = sessionsRef.current.find((s) => s.id === activeSessionIdRef.current);
			if (!currentSession) return;
			const fullPath = resolveClickedFilePath(currentSession.fullPath, relativePath);
			const filename = getFilename(fullPath);

			// Get SSH remote ID
			const sshRemoteId =
				currentSession.sshRemoteId || currentSession.sessionSshRemoteConfig?.remoteId || undefined;

			// Check if file should be opened externally (PDF, etc.)
			if (!sshRemoteId && shouldOpenExternally(filename)) {
				window.maestro.shell.openPath(fullPath);
				return;
			}

			try {
				// Fetch content and stat in parallel for efficiency
				const [content, stat] = await Promise.all([
					window.maestro.fs.readFile(fullPath, sshRemoteId),
					window.maestro.fs.stat(fullPath, sshRemoteId).catch((err) => {
						// ENOENT is expected (file may have been deleted between listing and open)
						if (err?.code === 'ENOENT') return null;
						captureException(err, {
							extra: { fullPath, operation: 'file-stat', sshRemoteId },
						});
						return null;
					}),
				]);
				if (content === null) return;
				const lastModified = stat?.modifiedAt ? new Date(stat.modifiedAt).getTime() : undefined;
				handleOpenFileTab(
					{
						path: fullPath,
						name: filename,
						content,
						sshRemoteId,
						lastModified,
					},
					{ openInNewTab: options?.openInNewTab ?? false }
				);
				setActiveFocus('main');
			} catch (error) {
				captureException(error, {
					extra: {
						fullPath,
						filename,
						sshRemoteId,
						operation: 'file-open',
					},
				});
			}
		},
		[handleOpenFileTab, sessionsRef, activeSessionIdRef, setActiveFocus]
	);

	// ====================================================================
	// Effect: Restore file tree scroll position on session switch
	// ====================================================================

	useEffect(() => {
		const activeSession = selectActiveSession(useSessionStore.getState());
		if (
			activeSession &&
			fileTreeContainerRef.current &&
			activeSession.fileExplorerScrollPos !== undefined
		) {
			fileTreeContainerRef.current.scrollTop = activeSession.fileExplorerScrollPos;
		}
	}, [activeSessionId]); // Only restore on session switch

	// ====================================================================
	// Effect: Update flat file list when tree/expanded/filter/hidden changes
	// ====================================================================

	useEffect(() => {
		if (!fileExplorerExpanded) {
			setFilteredFileTree([]);
			setFlatFileList([]);
			return;
		}
		const expandedSet = new Set(fileExplorerExpanded);

		// Apply hidden files filter to match FileExplorerPanel's display
		const filterHiddenFiles = (nodes: FileNode[]): FileNode[] => {
			if (showHiddenFiles) return nodes;
			return nodes
				.filter((node) => !node.name.startsWith('.') || node.name === '.maestro')
				.map((node) => ({
					...node,
					children: node.children ? filterHiddenFiles(node.children) : undefined,
				}));
		};

		const displayTree = filterHiddenFiles(filteredFileTree);
		const newFlatList = flattenTree(displayTree, expandedSet);

		// Preserve selection identity by path (not index)
		const { flatFileList: oldList, selectedFileIndex: oldIndex } = useFileExplorerStore.getState();
		const selectedPath = oldList[oldIndex]?.fullPath;
		if (selectedPath) {
			const newIndex = newFlatList.findIndex((item) => item.fullPath === selectedPath);
			if (newIndex >= 0) {
				setSelectedFileIndex(newIndex);
			} else {
				setSelectedFileIndex(Math.min(oldIndex, Math.max(0, newFlatList.length - 1)));
			}
		}

		setFilteredFileTree(filteredFileTree);
		setFlatFileList(newFlatList);
	}, [fileExplorerExpanded, filteredFileTree, showHiddenFiles]);

	// ====================================================================
	// Effect: Handle pending jump path from /jump command
	// ====================================================================

	useEffect(() => {
		if (pendingJumpPath === undefined || flatFileList.length === 0 || !activeSessionId) return;

		const jumpPath = pendingJumpPath;
		let targetIndex = 0;

		if (jumpPath === '') {
			targetIndex = 0;
		} else {
			const folderIndex = flatFileList.findIndex(
				(item) => item.fullPath === jumpPath && item.isFolder
			);
			if (folderIndex !== -1) {
				targetIndex = folderIndex;
			}
		}

		fileTreeKeyboardNavRef.current = true;
		setSelectedFileIndex(targetIndex);

		// Clear the pending jump path
		setSessions((prev) =>
			prev.map((s) => (s.id === activeSessionId ? { ...s, pendingJumpPath: undefined } : s))
		);
	}, [pendingJumpPath, flatFileList, activeSessionId]);

	// ====================================================================
	// Effect: Scroll to selected file on keyboard navigation
	// ====================================================================

	useEffect(() => {
		if (!fileTreeKeyboardNavRef.current) return;
		fileTreeKeyboardNavRef.current = false;

		const shouldScroll =
			(activeFocus === 'right' && activeRightTab === 'files') ||
			(tabCompletionOpen && activeRightTab === 'files');
		if (!shouldScroll) return;

		requestAnimationFrame(() => {
			const container = fileTreeContainerRef.current;
			if (!container) return;

			const selectedElement = container.querySelector(
				`[data-file-index="${selectedFileIndex}"]`
			) as HTMLElement;

			if (selectedElement) {
				selectedElement.scrollIntoView({
					behavior: 'auto',
					block: 'center',
					inline: 'nearest',
				});
			}
		});
	}, [selectedFileIndex, activeFocus, activeRightTab, flatFileList, tabCompletionOpen]);

	// ====================================================================
	// Effect: File explorer keyboard navigation
	// ====================================================================

	useEffect(() => {
		const handleFileExplorerKeys = (e: KeyboardEvent) => {
			if (hasOpenModal()) return;

			if (activeFocus !== 'right' || activeRightTab !== 'files' || flatFileList.length === 0)
				return;

			const expandedFolders = new Set(fileExplorerExpanded || []);

			// Collapse the multi-selection and re-anchor at `index`. Called by every
			// non-extending move (plain/Cmd/Option arrows, ArrowLeft-to-parent) so the
			// next Shift+Arrow starts a fresh range from where the cursor now sits.
			const reanchorTo = (index: number) => {
				setSelectionAnchorIndex(index);
				if (useFileExplorerStore.getState().selectedPaths.size > 0) {
					setSelectedPaths(new Set());
				}
			};

			// Cmd+Arrow: jump to top/bottom
			if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				setSelectedFileIndex(0);
				reanchorTo(0);
			} else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				const last = flatFileList.length - 1;
				setSelectedFileIndex(last);
				reanchorTo(last);
			}
			// Shift+Arrow: extend the multi-selection by one row (Finder/Explorer
			// range select). The anchor is the row focused when the extension began;
			// the cursor (selectedFileIndex) moves and the range [anchor, cursor] is
			// selected. Non-extending moves above re-anchor, so each Shift run pivots
			// from the cursor's resting position.
			else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				const len = flatFileList.length;
				const storedAnchor = useFileExplorerStore.getState().selectionAnchorIndex;
				const anchor = storedAnchor >= 0 && storedAnchor < len ? storedAnchor : selectedFileIndex;
				if (anchor !== storedAnchor) setSelectionAnchorIndex(anchor);
				const cursor = Math.max(
					0,
					Math.min(len - 1, selectedFileIndex + (e.key === 'ArrowDown' ? 1 : -1))
				);
				setSelectedFileIndex(cursor);
				const start = Math.min(anchor, cursor);
				const end = Math.max(anchor, cursor);
				const next = new Set<string>();
				for (let i = start; i <= end; i++) {
					const item = flatFileList[i];
					if (item) next.add(item.fullPath);
				}
				setSelectedPaths(next);
			}
			// Option+Arrow: page up/down (10 items)
			else if (e.altKey && e.key === 'ArrowUp') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				const next = Math.max(0, selectedFileIndex - 10);
				setSelectedFileIndex(next);
				reanchorTo(next);
			} else if (e.altKey && e.key === 'ArrowDown') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				const next = Math.min(flatFileList.length - 1, selectedFileIndex + 10);
				setSelectedFileIndex(next);
				reanchorTo(next);
			}
			// Regular Arrow: move one item
			else if (e.key === 'ArrowUp') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				const next = Math.max(0, selectedFileIndex - 1);
				setSelectedFileIndex(next);
				reanchorTo(next);
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				fileTreeKeyboardNavRef.current = true;
				const next = Math.min(flatFileList.length - 1, selectedFileIndex + 1);
				setSelectedFileIndex(next);
				reanchorTo(next);
			} else if (e.key === 'ArrowLeft') {
				e.preventDefault();
				const selectedItem = flatFileList[selectedFileIndex];
				if (selectedItem?.isFolder && expandedFolders.has(selectedItem.fullPath)) {
					toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
				} else if (selectedItem) {
					const parentPath = selectedItem.fullPath.substring(
						0,
						selectedItem.fullPath.lastIndexOf('/')
					);
					if (parentPath && expandedFolders.has(parentPath)) {
						toggleFolder(parentPath, activeSessionId, setSessions);
						const parentIndex = flatFileList.findIndex((item) => item.fullPath === parentPath);
						if (parentIndex >= 0) {
							fileTreeKeyboardNavRef.current = true;
							setSelectedFileIndex(parentIndex);
							reanchorTo(parentIndex);
						}
					}
				}
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				const selectedItem = flatFileList[selectedFileIndex];
				if (selectedItem?.isFolder && !expandedFolders.has(selectedItem.fullPath)) {
					toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
				}
			} else if (e.key === 'Enter') {
				e.preventDefault();
				const selectedItem = flatFileList[selectedFileIndex];
				if (selectedItem) {
					if (selectedItem.isFolder) {
						toggleFolder(selectedItem.fullPath, activeSessionId, setSessions);
					} else {
						handleFileClick(selectedItem, selectedItem.fullPath);
					}
				}
			}
		};

		window.addEventListener('keydown', handleFileExplorerKeys);
		return () => window.removeEventListener('keydown', handleFileExplorerKeys);
	}, [
		activeFocus,
		activeRightTab,
		flatFileList,
		selectedFileIndex,
		activeSessionId,
		fileExplorerExpanded,
		setSessions,
		toggleFolder,
		handleFileClick,
		hasOpenModal,
		setSelectedPaths,
		setSelectionAnchorIndex,
	]);

	// ====================================================================
	// Return
	// ====================================================================

	return {
		stableFileTree,
		handleMainPanelFileClick,
	};
}
