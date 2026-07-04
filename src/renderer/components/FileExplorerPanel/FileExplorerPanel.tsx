import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
	ChevronUp,
	ChevronDown,
	Folder,
	RefreshCw,
	Eye,
	EyeOff,
	Search,
	FolderOpen,
	Server,
	Copy,
	FolderInput,
	FolderUp,
	FileText,
	HardDrive,
} from 'lucide-react';
import { getBasename } from '../../../shared/formatters';
import { useSettingsStore } from '../../stores/settingsStore';
import { useGitDetail } from '../../contexts/GitStatusContext';
import { buildChangedAncestors, buildFileChangeMap } from '../../utils/gitChangeMap';
import { RIGHT_PANEL_COMPACT_THRESHOLD } from '../../constants/rightPanel';
import { getOpenInLabel } from '../../utils/platformUtils';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { dragHasOsFiles } from '../../utils/osFileDrop';

import type { FileExplorerPanelProps } from './types';
import { FILE_TREE_SINGLE_MIME, FILE_TREE_MULTI_MIME } from './types';

// Sub-components
import { RetryCountdown } from './components/RetryCountdown';
import { FileTreeLoadingProgress } from './components/FileTreeLoadingProgress';
import { FileTreeTruncatedBanner } from './components/FileTreeTruncatedBanner';
import { AutoRefreshOverlay } from './components/AutoRefreshOverlay';
import { NewFileModal } from './components/NewFileModal';
import { RenameFileModal } from './components/RenameFileModal';
import { DeleteFileModal } from './components/DeleteFileModal';
import { MultiDeleteModal } from './components/MultiDeleteModal';
import { MoveConflictModal } from './components/MoveConflictModal';
import { FileTreeRow } from './components/FileTreeRow';
import { FileTreeContextMenu } from './components/FileTreeContextMenu';

// Hooks
import { useFileTreeFlatten } from './hooks/useFileTreeFlatten';
import { useFileTreeSelection } from './hooks/useFileTreeSelection';
import { useFileTreeFilter } from './hooks/useFileTreeFilter';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import { useFileOperations } from './hooks/useFileOperations';
import { useDragToMove } from './hooks/useDragToMove';
import { useOsFileDragOut } from './hooks/useOsFileDragOut';
import { useFileContextMenu } from './hooks/useFileContextMenu';

// Utils
import { formatBytes } from './utils/pathHelpers';

function FileExplorerPanelInner(props: FileExplorerPanelProps) {
	const {
		session,
		theme,
		fileTreeFilter,
		setFileTreeFilter,
		fileTreeFilterOpen,
		setFileTreeFilterOpen,
		filteredFileTree,
		selectedFileIndex,
		setSelectedFileIndex,
		activeFocus,
		activeRightTab,
		setActiveFocus,
		fileTreeFilterInputRef,
		toggleFolder,
		toggleFolderRecursive,
		handleFileClick,
		expandAllFolders,
		collapseAllFolders,
		updateSessionWorkingDirectory,
		refreshFileTree,
		cancelFileTreeLoad,
		setSessions,
		onAutoRefreshChange,
		onShowFlash,
		showHiddenFiles,
		fileExplorerIconTheme,
		setShowHiddenFiles,
		onFocusFileInGraph,
		onOpenBrowserTabAt,
		fileTreeContainerRef,
	} = props;

	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const rightPanelWidth = useSettingsStore((s) => s.rightPanelWidth);
	const dotfilesToggleHidden = useSettingsStore((s) => s.dotfilesToggleHidden);
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const htmlDoubleClickOpensInBrowser = useSettingsStore((s) => s.htmlDoubleClickOpensInBrowser);
	const compact = rightPanelWidth < RIGHT_PANEL_COMPACT_THRESHOLD;

	const [isTouchPointer, setIsTouchPointer] = useState<boolean>(() =>
		typeof window !== 'undefined' && window.matchMedia
			? window.matchMedia('(pointer: coarse)').matches
			: false
	);
	const longPressTimerRef = useRef<number | null>(null);
	const longPressFiredRef = useRef(false);

	useEffect(() => {
		if (typeof window === 'undefined' || !window.matchMedia) return;
		const mql = window.matchMedia('(pointer: coarse)');
		const handler = (e: MediaQueryListEvent) => setIsTouchPointer(e.matches);
		mql.addEventListener?.('change', handler);
		return () => mql.removeEventListener?.('change', handler);
	}, []);

	useEffect(() => {
		return () => {
			if (longPressTimerRef.current) {
				window.clearTimeout(longPressTimerRef.current);
			}
		};
	}, []);

	// Live git status comes from GitStatusProvider, which polls per session via
	// useGitStatusPolling. The legacy session.changedFiles field is never
	// populated, so consume the context directly here (#611).
	const { getFileDetails } = useGitDetail();
	const fileChanges = getFileDetails(session.id)?.fileChanges;
	const changeMap = useMemo(() => buildFileChangeMap(fileChanges), [fileChanges]);
	const changedAncestors = useMemo(() => buildChangedAncestors(changeMap.keys()), [changeMap]);

	// Coordinator refs with ≥3 cross-hook readers
	const refreshFileTreeRef = useRef(refreshFileTree);
	const sessionIdRef = useRef(session.id);
	const lastClickedUnderFilterRef = useRef<string | null>(null);

	useEffect(() => {
		refreshFileTreeRef.current = refreshFileTree;
	}, [refreshFileTree]);

	useEffect(() => {
		sessionIdRef.current = session.id;
	}, [session.id]);

	// SSH remote ID — use sshRemoteId (set after AI spawns) or fall back to
	// sessionSshRemoteConfig (set before spawn). Ensures file ops work for both
	// AI and terminal-only SSH sessions.
	const sshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

	// Get current auto-refresh interval (180s default for unmigrated sessions)
	const autoRefreshInterval = session.fileTreeAutoRefreshInterval ?? 180;

	// ── Flatten + Selection ────────────────────────────────────────────────────

	const { flattenedTree } = useFileTreeFlatten({
		filteredFileTree,
		fileTreeFilter,
		fileExplorerExpanded: session.fileExplorerExpanded,
		showHiddenFiles,
	});

	// Ref mirror so the memoized row renderer reads the latest tree shape
	// without being listed as a dep (avoids re-rendering every row on change).
	const flattenedTreeRef = useRef(flattenedTree);
	useEffect(() => {
		flattenedTreeRef.current = flattenedTree;
	}, [flattenedTree]);

	const { selectedPaths, selectedPathsRef, setSelectedPaths, handleRowSelectionClick } =
		useFileTreeSelection({
			sessionId: session.id,
			selectedFileIndex,
			setSelectedFileIndex,
			flattenedTreeRef,
		});

	// ── Virtualizer ───────────────────────────────────────────────────────────

	const parentRef = useRef<HTMLDivElement>(null);
	const ROW_HEIGHT = 28;

	const virtualizer = useVirtualizer({
		count: flattenedTree.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10,
	});

	// Re-sync the virtualizer when the Files tab becomes visible (or the tree
	// repopulates). The panel is kept mounted under `display:none` so the
	// auto-refresh timer survives tab switches (see RightPanel), but while hidden
	// the scroll element measures 0×0 and the still-running auto-refresh rebuilds
	// the tree, changing row count and clamping scrollTop without emitting a
	// scroll event. TanStack only refreshes its cached scrollOffset from a real
	// scroll event, so on show the offset is stale and it paints a blank gap at
	// the top until the user scrolls.
	//
	// scrollToOffset() can't fix this: it just sets element.scrollTop, and when
	// that value is unchanged (a short tree already clamped to 0) the browser
	// emits no scroll event, so the offset never refreshes. Assign scrollOffset
	// directly to the DOM's (clamped) truth instead - it persists, so the next
	// range recompute (here via measure(), or a later ResizeObserver tick once
	// the element has real size) uses the correct offset and repaints the right
	// window immediately.
	useEffect(() => {
		if (activeRightTab !== 'files') return;
		const el = parentRef.current;
		if (!el) return;
		const raf = requestAnimationFrame(() => {
			virtualizer.scrollOffset = el.scrollTop;
			virtualizer.measure();
		});
		return () => cancelAnimationFrame(raf);
	}, [activeRightTab, flattenedTree.length, virtualizer]);

	// ── Filter ────────────────────────────────────────────────────────────────

	useFileTreeFilter({
		fileTreeFilterOpen,
		setFileTreeFilterOpen,
		setFileTreeFilter,
		lastClickedUnderFilterRef,
		setActiveFocus,
		sessionId: session.id,
		setSessions,
		flattenedTree,
		setSelectedFileIndex,
		fileTreeContainerRef,
		virtualizer,
	});

	// ── Auto-refresh ──────────────────────────────────────────────────────────

	const {
		isRefreshing,
		overlayOpen,
		overlayPosition,
		refreshButtonRef,
		handleRefresh,
		handleRefreshMouseEnter,
		handleRefreshMouseLeave,
		handleOverlayMouseEnter,
		handleOverlayMouseLeave,
		handleIntervalSelect,
	} = useAutoRefresh({
		sessionId: session.id,
		autoRefreshInterval,
		refreshFileTree,
		onAutoRefreshChange,
		onShowFlash,
		setSessions,
	});

	// ── expandFolder — shared between file ops and drag-to-move ───────────────

	const expandFolder = useCallback(
		(relativePath: string) => {
			if (!relativePath) return;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const expanded = s.fileExplorerExpanded || [];
					if (expanded.includes(relativePath)) return s;
					return { ...s, fileExplorerExpanded: [...expanded, relativePath] };
				})
			);
		},
		[session.id, setSessions]
	);

	// ── File operations (rename / create / delete) ────────────────────────────

	const {
		renameModal,
		renameValue,
		renameError,
		newFileModal,
		newFileValue,
		newFileError,
		isCreatingFile,
		deleteModal,
		isDeleting,
		openRenameModal,
		closeRenameModal,
		setRenameValue,
		handleRename,
		openNewFileModal,
		openNewFolderModal,
		closeNewFileModal,
		setNewFileValue,
		handleCreateNewFile,
		openDeleteModal,
		closeDeleteModal,
		handleDelete,
	} = useFileOperations({
		session,
		sshRemoteId,
		setSessions,
		refreshFileTree,
		expandFolder,
		onShowFlash,
	});

	// ── Drag-to-move ──────────────────────────────────────────────────────────

	const {
		dragOverFolder,
		isExternalDrag,
		internalDragActive,
		moveConflict,
		isMoving,
		handleFolderDrop,
		handleFolderDragOver,
		handleFolderDragEnter,
		handleFolderDragLeave,
		handleMoveOverwriteAll,
		handleMoveAutoRenameAll,
		handleMoveSkipConflicts,
		closeMoveConflict,
		handleInternalDragStart,
		handleInternalDragEnd,
	} = useDragToMove({
		session,
		sshRemoteId,
		refreshFileTree,
		expandFolder,
		onShowFlash,
		setSelectedPaths,
	});

	// Option/Alt-drag a row out to Finder/Explorer to retrieve the real file
	// (downloads first over SSH). Separate from the in-app move/@mention drag.
	const { handleOsDragStart } = useOsFileDragOut({ session, sshRemoteId, onShowFlash });

	// ── Context menu ──────────────────────────────────────────────────────────

	const {
		contextMenu,
		multiDeleteModal,
		isMultiDeleting,
		contextMenuRef,
		contextMenuPos,
		openContextMenuAt,
		openContextMenu,
		openRootContextMenu,
		handleCopyPath,
		handleCopyFileName,
		handleDownloadFile,
		handleOpenInDefaultApp,
		handleOpenInMaestroBrowser,
		handleOpenInExplorer,
		handleOpenNewFile,
		handleOpenNewFolder,
		handleOpenRename,
		handleOpenDelete,
		handleFocusInGraph,
		handlePreviewFile,
		handlePreviewAllInFolder,
		handlePreviewMulti,
		handleOpenInDefaultAppMulti,
		handleOpenDeleteMulti,
		handleDeleteMulti,
		closeMultiDeleteModal,
	} = useFileContextMenu({
		session,
		theme,
		onShowFlash,
		onFocusFileInGraph,
		onOpenBrowserTabAt,
		handleFileClick,
		openRenameModal,
		openDeleteModal,
		openNewFileModal,
		openNewFolderModal,
		setSelectedFileIndex,
		selectedPathsRef,
		setSelectedPaths,
		refreshFileTree,
		sshRemoteId,
	});

	// ── Internal drag bubble suppression ──────────────────────────────────────
	// Swallow drag-enter/leave that propagate to the app-level overlay handler
	// while a Files-panel drag is moving WITHIN the panel itself.

	const handleInternalDragBubble = (e: React.DragEvent) => {
		if (
			e.dataTransfer.types.includes(FILE_TREE_SINGLE_MIME) ||
			e.dataTransfer.types.includes(FILE_TREE_MULTI_MIME)
		) {
			e.stopPropagation();
		}
	};

	// ── Render ────────────────────────────────────────────────────────────────

	// Panel-root drop zone: OS files dropped on empty space or a file row (i.e.
	// not on a folder row, which stops propagation) import into the tree root.
	// Internal tree drags fall through to the existing bubble-suppression so we
	// don't accidentally add a move-to-root path. For a remote session the import
	// uploads the dropped local files to the remote host over SSH.
	const externalImportEnabled = true;
	const handleRootDragEnter = (e: React.DragEvent) => {
		if (externalImportEnabled && dragHasOsFiles(e.dataTransfer)) {
			handleFolderDragEnter(e, '');
			return;
		}
		handleInternalDragBubble(e);
	};
	const handleRootDragOver = (e: React.DragEvent) => {
		if (externalImportEnabled && dragHasOsFiles(e.dataTransfer)) {
			handleFolderDragOver(e, '');
		}
	};
	const handleRootDragLeave = (e: React.DragEvent) => {
		if (dragHasOsFiles(e.dataTransfer)) {
			handleFolderDragLeave(e);
			return;
		}
		handleInternalDragBubble(e);
	};
	const handleRootDrop = (e: React.DragEvent) => {
		if (externalImportEnabled && dragHasOsFiles(e.dataTransfer)) {
			handleFolderDrop(e, '');
		}
	};
	// `dragOverFolder === ''` flags "drop into the tree root". It's set both by an
	// OS-file drag over the panel background and by an in-tree drag hovering the
	// "move to root" receptacle - gate on isExternalDrag so the whole-panel import
	// outline fires only for the former; the receptacle highlights itself.
	const isRootDropTarget = dragOverFolder === '' && isExternalDrag;

	return (
		<div
			className="flex flex-col h-full relative"
			onDragEnter={handleRootDragEnter}
			onDragOver={handleRootDragOver}
			onDragLeave={handleRootDragLeave}
			onDrop={handleRootDrop}
			style={
				isRootDropTarget
					? {
							outline: `2px dashed ${theme.colors.accent}`,
							outlineOffset: '-4px',
							borderRadius: '6px',
							backgroundColor: `${theme.colors.accent}0d`,
						}
					: undefined
			}
		>
			{/* File Tree Filter */}
			{fileTreeFilterOpen && (
				<div className="mb-3 pt-4">
					<div className="relative">
						<input
							ref={fileTreeFilterInputRef}
							autoFocus
							type="text"
							placeholder="Filter files..."
							value={fileTreeFilter}
							onChange={(e) => setFileTreeFilter(e.target.value)}
							className="w-full pl-3 pr-14 py-2 rounded border bg-transparent outline-none text-sm"
							style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
						/>
						<div
							className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-xs font-bold pointer-events-none"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textDim,
							}}
						>
							ESC
						</div>
					</div>
				</div>
			)}

			{/* Header with CWD */}
			<div
				className="sticky top-0 z-10 text-xs font-bold pt-4 pb-2 mb-2"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				{/* Toolbar row */}
				<div className="flex gap-1 mb-2">
					{/* Find files */}
					<button
						onClick={() => {
							if (fileTreeFilterOpen) {
								if (fileTreeFilter.length === 0) {
									setFileTreeFilterOpen(false);
								} else {
									fileTreeFilterInputRef?.current?.focus();
								}
							} else {
								setFileTreeFilterOpen(true);
								setTimeout(() => fileTreeFilterInputRef?.current?.focus(), 0);
							}
						}}
						className="flex-1 flex items-center justify-center gap-1 py-0.5 px-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
						style={{
							color: fileTreeFilterOpen ? theme.colors.accent : theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
							backgroundColor: fileTreeFilterOpen
								? `${theme.colors.accent}25`
								: `${theme.colors.accent}15`,
						}}
						title={`Find Files (${formatShortcutKeys(shortcuts.filterFiles?.keys ?? ['Meta', 'f'])})`}
					>
						{!compact && <Search className="w-3 h-3" />}
						Find
					</button>
					{/* Open in file manager — local sessions only */}
					{!sshRemoteId && (
						<button
							onClick={() =>
								window.maestro?.shell?.openPath(session.fullPath || session.projectRoot)
							}
							className="flex-1 flex items-center justify-center gap-1 py-0.5 px-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
							style={{
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
								backgroundColor: `${theme.colors.accent}15`,
							}}
							title={getOpenInLabel(window.maestro?.platform || 'darwin')}
						>
							{!compact && <FolderOpen className="w-3 h-3" />}
							Open
						</button>
					)}
					{/* Show/hide dotfiles */}
					{!dotfilesToggleHidden && (
						<button
							onClick={() => setShowHiddenFiles(!showHiddenFiles)}
							className="flex-1 flex items-center justify-center gap-1 py-0.5 px-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
							style={{
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
								backgroundColor: showHiddenFiles
									? `${theme.colors.accent}25`
									: `${theme.colors.accent}15`,
							}}
							title={showHiddenFiles ? 'Hide dotfiles' : 'Show dotfiles'}
						>
							{!compact &&
								(showHiddenFiles ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />)}
							.files
						</button>
					)}
					{/* Refresh */}
					<button
						ref={refreshButtonRef}
						onClick={handleRefresh}
						onMouseEnter={handleRefreshMouseEnter}
						onMouseLeave={handleRefreshMouseLeave}
						className="flex-1 flex items-center justify-center gap-1 py-0.5 px-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
						style={{
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
							backgroundColor:
								autoRefreshInterval > 0 ? `${theme.colors.accent}25` : `${theme.colors.accent}15`,
						}}
						title={
							autoRefreshInterval > 0
								? `Auto-refresh every ${autoRefreshInterval}s`
								: 'Refresh file tree'
						}
					>
						{!compact && <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />}
						Refresh
					</button>
					{/* Expand all */}
					<button
						onClick={() => expandAllFolders(session.id, session, setSessions)}
						className="flex items-center justify-center py-0.5 px-0.5 rounded text-xs font-medium transition-colors hover:bg-white/10"
						style={{
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
							backgroundColor: `${theme.colors.accent}15`,
						}}
						title="Expand all folders"
					>
						<div className="flex flex-col items-center -space-y-1.5">
							<ChevronUp className="w-3 h-3" />
							<ChevronDown className="w-3 h-3" />
						</div>
					</button>
					{/* Collapse all */}
					<button
						onClick={() => collapseAllFolders(session.id, setSessions)}
						className="flex items-center justify-center py-0.5 px-0.5 rounded text-xs font-medium transition-colors hover:bg-white/10"
						style={{
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
							backgroundColor: `${theme.colors.accent}15`,
						}}
						title="Collapse all folders"
					>
						<div className="flex flex-col items-center -space-y-1.5">
							<ChevronDown className="w-3 h-3" />
							<ChevronUp className="w-3 h-3" />
						</div>
					</button>
				</div>
				{/* Path row — doubles as a drop target for the workspace root. The path
				    points at the root working directory, so dropping a tree item (or an
				    OS file) here moves/imports it to the root, same as the bottom
				    receptacle. Uses '' as the destination, mirroring handleFolderDrop. */}
				<div
					className="flex items-center gap-1.5 min-w-0 overflow-hidden justify-center rounded transition-colors"
					onDragEnter={(e) => handleFolderDragEnter(e, '')}
					onDragOver={(e) => handleFolderDragOver(e, '')}
					onDragLeave={handleFolderDragLeave}
					onDrop={(e) => handleFolderDrop(e, '')}
					style={
						dragOverFolder === '' && !isExternalDrag
							? {
									outline: `1px dashed ${theme.colors.accent}`,
									outlineOffset: '-2px',
									backgroundColor: `${theme.colors.accent}20`,
								}
							: undefined
					}
				>
					{session.sshRemote && (
						<span
							className="flex-shrink-0"
							title={`SSH: ${session.sshRemote.name} (${session.sshRemote.host})`}
							style={{ color: theme.colors.accent }}
						>
							<Server className="w-3.5 h-3.5" />
						</span>
					)}
					<span
						className="flex-shrink-0 cursor-pointer opacity-30 hover:opacity-70 transition-opacity"
						style={{ color: theme.colors.accent }}
						onClick={async () => {
							if (await safeClipboardWrite(session.projectRoot)) {
								flashCopiedToClipboard(session.projectRoot, 'Path Copied');
							}
						}}
						title="Copy path to clipboard"
					>
						<Copy className="w-3 h-3" />
					</span>
					<span
						className="opacity-50 min-w-0 overflow-hidden whitespace-nowrap cursor-pointer"
						style={{
							direction: 'rtl',
							textOverflow: 'ellipsis',
							textAlign: 'center',
						}}
						title={
							session.sshRemote
								? `${session.sshRemote.host}:${session.projectRoot}`
								: session.projectRoot
						}
						onDoubleClick={async () => {
							if (await safeClipboardWrite(session.projectRoot)) {
								flashCopiedToClipboard(session.projectRoot, 'Path Copied');
							}
						}}
					>
						<bdi>{session.projectRoot}</bdi>
					</span>
				</div>
			</div>

			{/* File tree content */}
			{session.fileTreeError ? (
				<div className="flex flex-col items-center justify-center gap-3 py-8">
					<div className="text-xs text-center px-4" style={{ color: theme.colors.error }}>
						{session.fileTreeError}
					</div>
					{session.fileTreeRetryAt && session.fileTreeRetryAt > Date.now() ? (
						<RetryCountdown
							retryAt={session.fileTreeRetryAt}
							theme={theme}
							onRetryNow={() => {
								setSessions((prev) =>
									prev.map((s) => (s.id === session.id ? { ...s, fileTreeRetryAt: undefined } : s))
								);
							}}
						/>
					) : (
						<>
							{session.toolType === 'terminal' && (
								<button
									onClick={() => updateSessionWorkingDirectory(session.id, setSessions)}
									className="flex items-center gap-2 px-3 py-2 rounded border hover:bg-white/5 transition-colors text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									<Folder className="w-4 h-4" />
									Select New Directory
								</button>
							)}
							{session.toolType !== 'terminal' && (
								<button
									onClick={handleRefresh}
									disabled={isRefreshing}
									className="flex items-center gap-2 px-3 py-2 rounded border hover:bg-white/5 transition-colors text-xs disabled:opacity-50 disabled:cursor-not-allowed"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									<RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
									{isRefreshing ? 'Connecting...' : 'Retry Connection'}
								</button>
							)}
						</>
					)}
				</div>
			) : (
				<>
					{session.fileTreeLoading &&
						(() => {
							const isRemote = !!sshRemoteId;
							return (
								<FileTreeLoadingProgress
									theme={theme}
									progress={session.fileTreeLoadingProgress}
									isRemote={isRemote}
									onCancel={
										isRemote && cancelFileTreeLoad
											? () => cancelFileTreeLoad(session.id)
											: undefined
									}
								/>
							);
						})()}
					{!session.fileTreeLoading && session.fileTreeTruncated && (
						<FileTreeTruncatedBanner
							theme={theme}
							previousCap={session.fileTreeLoadedCap}
							isRefreshing={isRefreshing}
							onLoadMore={() => {
								const next = (session.fileTreeLoadedCap ?? 100_000) * 2;
								refreshFileTree(session.id, { maxEntriesOverride: next });
							}}
							onLoadAll={() => {
								refreshFileTree(session.id, {
									maxEntriesOverride: Number.POSITIVE_INFINITY,
								});
							}}
						/>
					)}
					{!session.fileTreeLoading &&
						(!session.fileTree || session.fileTree.length === 0) &&
						!fileTreeFilter && (
							<div
								className="flex flex-col items-center justify-center gap-2 py-8"
								onContextMenu={openRootContextMenu}
							>
								<Folder className="w-8 h-8 opacity-30" style={{ color: theme.colors.textDim }} />
								<div
									className="text-xs opacity-50 text-center"
									style={{ color: theme.colors.textDim }}
								>
									No files found
								</div>
							</div>
						)}
					{flattenedTree.length > 0 && (
						<div
							ref={parentRef}
							data-file-list-scroll
							className="flex-1 min-h-0 overflow-auto"
							onContextMenu={openRootContextMenu}
						>
							<div
								style={{
									height: `${virtualizer.getTotalSize()}px`,
									width: '100%',
									position: 'relative',
								}}
							>
								{virtualizer.getVirtualItems().map((virtualRow) => {
									const item = flattenedTree[virtualRow.index];
									// Render as a stable memo'd component (identity defined at module
									// level, not inside a render), so React never sees a new component
									// type on each parent render — prevents remounting every visible row.
									return (
										<FileTreeRow
											key={item.path}
											item={item}
											virtualRow={virtualRow}
											session={session}
											theme={theme}
											activeFocus={activeFocus}
											activeRightTab={activeRightTab}
											selectedFileIndex={selectedFileIndex}
											changeMap={changeMap}
											changedAncestors={changedAncestors}
											colorBlindMode={colorBlindMode}
											dragOverFolder={dragOverFolder}
											selectedPaths={selectedPaths}
											selectedPathsRef={selectedPathsRef}
											setSelectedPaths={setSelectedPaths}
											fileExplorerIconTheme={fileExplorerIconTheme}
											fileTreeFilter={fileTreeFilter}
											htmlDoubleClickOpensInBrowser={htmlDoubleClickOpensInBrowser}
											sshRemoteId={sshRemoteId}
											isTouchPointer={isTouchPointer}
											longPressTimerRef={longPressTimerRef}
											longPressFiredRef={longPressFiredRef}
											lastClickedUnderFilterRef={lastClickedUnderFilterRef}
											setActiveFocus={setActiveFocus}
											handleRowSelectionClick={handleRowSelectionClick}
											openContextMenuAt={openContextMenuAt}
											handleContextMenu={openContextMenu}
											handleFolderDragEnter={handleFolderDragEnter}
											handleFolderDragOver={handleFolderDragOver}
											handleFolderDragLeave={handleFolderDragLeave}
											handleFolderDrop={handleFolderDrop}
											onInternalDragStart={handleInternalDragStart}
											onInternalDragEnd={handleInternalDragEnd}
											onOsDragOut={handleOsDragStart}
											toggleFolder={toggleFolder}
											toggleFolderRecursive={toggleFolderRecursive}
											setSessions={setSessions}
											handleFileClick={handleFileClick}
											onOpenBrowserTabAt={onOpenBrowserTabAt}
										/>
									);
								})}
							</div>
						</div>
					)}
					{fileTreeFilter && flattenedTree.length === 0 && (
						<div className="text-xs opacity-50 italic text-center py-4">
							No files match your search
						</div>
					)}
				</>
			)}

			{/* Auto-refresh overlay */}
			{overlayOpen && overlayPosition && (
				<AutoRefreshOverlay
					theme={theme}
					position={overlayPosition}
					currentInterval={autoRefreshInterval}
					onIntervalSelect={handleIntervalSelect}
					onMouseEnter={handleOverlayMouseEnter}
					onMouseLeave={handleOverlayMouseLeave}
				/>
			)}

			{/* Move-to-root receptacle — appears only while an in-tree row is being
			    dragged, giving items buried in subfolders a target to land back at
			    the workspace root. Sits at the bottom of the panel, just above the
			    stats bar. Mirrors the Left Bar's "Drop here to ungroup" zone for UI
			    consistency. Items already at root never trigger it (the dragstart
			    handler suppresses it when every dragged item is already at root). */}
			{internalDragActive && (
				<div
					className="flex-shrink-0 mt-2 px-3 py-2 rounded border-2 border-dashed text-center text-xs flex items-center justify-center gap-1.5 transition-colors"
					onDragEnter={(e) => handleFolderDragEnter(e, '')}
					onDragOver={(e) => handleFolderDragOver(e, '')}
					onDragLeave={handleFolderDragLeave}
					onDrop={(e) => handleFolderDrop(e, '')}
					style={{
						borderColor: theme.colors.accent,
						color: theme.colors.textDim,
						backgroundColor:
							dragOverFolder === '' && !isExternalDrag
								? `${theme.colors.accent}25`
								: `${theme.colors.accent}10`,
					}}
				>
					<FolderUp className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					Drop here to move to root
				</div>
			)}

			{/* Status bar. `file-stats-container` enables the container query in index.css
			    that swaps the label words for icons on narrow widths so the bar never wraps. */}
			{session.fileTreeStats && (
				<div
					className="file-stats-container flex-shrink-0 flex items-center justify-center gap-3 px-3 py-1.5 text-xs rounded mt-3 mb-[7px] whitespace-nowrap"
					style={{
						backgroundColor: theme.colors.bgActivity,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textDim,
					}}
				>
					<span
						className="flex items-center gap-1"
						title={`${session.fileTreeStats.fileCount.toLocaleString()} file${session.fileTreeStats.fileCount !== 1 ? 's' : ''}`}
					>
						<FileText className="file-stats-icon w-3 h-3 shrink-0 opacity-60" />
						<span style={{ color: theme.colors.accent }}>
							{session.fileTreeStats.fileCount.toLocaleString()}
						</span>
						<span className="file-stats-label opacity-60">
							file{session.fileTreeStats.fileCount !== 1 ? 's' : ''},
						</span>
					</span>
					<span
						className="flex items-center gap-1"
						title={`${session.fileTreeStats.folderCount.toLocaleString()} folder${session.fileTreeStats.folderCount !== 1 ? 's' : ''}`}
					>
						<Folder className="file-stats-icon w-3 h-3 shrink-0 opacity-60" />
						<span style={{ color: theme.colors.accent }}>
							{session.fileTreeStats.folderCount.toLocaleString()}
						</span>
						<span className="file-stats-label opacity-60">
							folder{session.fileTreeStats.folderCount !== 1 ? 's' : ''}
						</span>
					</span>
					<span
						className="flex items-center gap-1"
						title={`Total size: ${formatBytes(session.fileTreeStats.totalSize)}`}
					>
						<HardDrive className="file-stats-icon w-3 h-3 shrink-0 opacity-60" />
						<span className="file-stats-label opacity-60">Size:</span>
						<span style={{ color: theme.colors.accent }}>
							{formatBytes(session.fileTreeStats.totalSize)}
						</span>
					</span>
				</div>
			)}

			{/* Context menu portal */}
			{contextMenu && (
				<FileTreeContextMenu
					theme={theme}
					contextMenu={contextMenu}
					contextMenuRef={contextMenuRef}
					contextMenuPos={contextMenuPos}
					sshRemoteId={sshRemoteId}
					onFocusFileInGraph={onFocusFileInGraph}
					onOpenBrowserTabAt={onOpenBrowserTabAt}
					isMultiSelectionContext={selectedPaths.size > 1 && selectedPaths.has(contextMenu.path)}
					selectedCount={selectedPaths.size}
					onCopyPath={handleCopyPath}
					onCopyFileName={handleCopyFileName}
					onDownloadFile={handleDownloadFile}
					onOpenInDefaultApp={handleOpenInDefaultApp}
					onOpenInMaestroBrowser={handleOpenInMaestroBrowser}
					onOpenInExplorer={handleOpenInExplorer}
					onOpenNewFile={handleOpenNewFile}
					onOpenNewFolder={handleOpenNewFolder}
					onPreviewFile={handlePreviewFile}
					onPreviewAllInFolder={handlePreviewAllInFolder}
					onPreviewMulti={handlePreviewMulti}
					onOpenInDefaultAppMulti={handleOpenInDefaultAppMulti}
					onOpenDeleteMulti={handleOpenDeleteMulti}
					onFocusInGraph={handleFocusInGraph}
					onOpenRename={handleOpenRename}
					onOpenDelete={handleOpenDelete}
				/>
			)}

			{/* Rename Modal */}
			{renameModal && (
				<RenameFileModal
					theme={theme}
					node={renameModal.node}
					value={renameValue}
					setValue={setRenameValue}
					error={renameError}
					onClose={closeRenameModal}
					onRename={handleRename}
				/>
			)}

			{/* Delete Confirmation Modal */}
			{deleteModal && (
				<DeleteFileModal
					theme={theme}
					node={deleteModal.node}
					itemCount={deleteModal.itemCount}
					isDeleting={isDeleting}
					onClose={closeDeleteModal}
					onDelete={handleDelete}
				/>
			)}

			{/* Multi-delete Confirmation Modal */}
			{multiDeleteModal && (
				<MultiDeleteModal
					theme={theme}
					modal={multiDeleteModal}
					isDeleting={isMultiDeleting}
					onClose={closeMultiDeleteModal}
					onDelete={handleDeleteMulti}
				/>
			)}

			{/* New File Modal */}
			{newFileModal && (
				<NewFileModal
					theme={theme}
					kind={newFileModal.kind}
					parentFolderLabel={
						newFileModal.parentFolderPath
							? `"${newFileModal.parentFolderPath}"`
							: 'the project root'
					}
					value={newFileValue}
					setValue={setNewFileValue}
					error={newFileError}
					isCreating={isCreatingFile}
					onClose={closeNewFileModal}
					onCreate={handleCreateNewFile}
				/>
			)}

			{/* Move Name-Conflict Modal */}
			{moveConflict && (
				<MoveConflictModal
					theme={theme}
					destFolderLabel={
						moveConflict.destFolderRelativePath
							? `"${moveConflict.destFolderRelativePath}"`
							: 'the project root'
					}
					conflicts={moveConflict.conflicts}
					nonConflictingCount={moveConflict.nonConflicting.length}
					isMoving={isMoving}
					operation={moveConflict.operation}
					onCancel={closeMoveConflict}
					onOverwriteAll={handleMoveOverwriteAll}
					onAutoRenameAll={handleMoveAutoRenameAll}
					onSkipConflicts={handleMoveSkipConflicts}
				/>
			)}

			{/* OS-file import overlay — explains what dropping a Finder/Explorer file
			    does, mirroring the main panel's chat-drop hint. Shown only for
			    external drags (isExternalDrag); in-tree moves get row highlighting
			    instead. `pointer-events-none` lets dragover/drop pass through to the
			    folder rows underneath so the target still resolves. */}
			{isExternalDrag && dragOverFolder !== null && (
				<div
					className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
					style={{ backgroundColor: `${theme.colors.accent}20` }}
				>
					<div
						className="rounded-xl border-2 border-dashed p-6 flex flex-col items-center gap-2 mx-4 text-center"
						style={{
							borderColor: theme.colors.accent,
							backgroundColor: `${theme.colors.bgMain}ee`,
						}}
					>
						<FolderInput className="w-12 h-12" style={{ color: theme.colors.accent }} />
						<span className="text-base font-medium" style={{ color: theme.colors.textMain }}>
							Drop to import
						</span>
						<span className="text-sm" style={{ color: theme.colors.textDim }}>
							{dragOverFolder
								? `Copies into "${getBasename(dragOverFolder)}".`
								: 'Copies into this workspace.'}{' '}
							Originals stay where they are.
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

export const FileExplorerPanel = memo(FileExplorerPanelInner);
