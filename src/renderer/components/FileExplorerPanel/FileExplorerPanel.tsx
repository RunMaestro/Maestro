import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
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
} from 'lucide-react';
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
	// the tree — changing row count/sizes and clamping scrollTop without emitting
	// a scroll event. TanStack only updates its internal scrollOffset on a real
	// scroll event, so on show the offset can be stale, painting a blank gap at
	// the top until the user scrolls. Forcing a measure + offset re-sync repaints
	// the correct window immediately.
	useEffect(() => {
		if (activeRightTab !== 'files') return;
		const el = parentRef.current;
		if (!el) return;
		const raf = requestAnimationFrame(() => {
			virtualizer.measure();
			virtualizer.scrollToOffset(el.scrollTop);
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
	} = useDragToMove({
		session,
		sshRemoteId,
		refreshFileTree,
		expandFolder,
		onShowFlash,
		setSelectedPaths,
	});

	// ── Context menu ──────────────────────────────────────────────────────────

	const {
		contextMenu,
		multiDeleteModal,
		isMultiDeleting,
		contextMenuRef,
		contextMenuPos,
		openContextMenu,
		handleCopyPath,
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
	// don't accidentally add a move-to-root path. Remotes have no local source.
	const externalImportEnabled = !sshRemoteId;
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
	// `dragOverFolder === ''` is only ever set by an OS-file drag hovering the
	// panel background (folder rows set their own relative path), so it uniquely
	// flags "drop into the tree root".
	const isRootDropTarget = dragOverFolder === '';

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
				{/* Path row */}
				<div className="flex items-center gap-1.5 min-w-0 overflow-hidden justify-center">
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
							<div className="flex flex-col items-center justify-center gap-2 py-8">
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
						<div ref={parentRef} data-file-list-scroll className="flex-1 min-h-0 overflow-auto">
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
											lastClickedUnderFilterRef={lastClickedUnderFilterRef}
											setActiveFocus={setActiveFocus}
											handleRowSelectionClick={handleRowSelectionClick}
											handleContextMenu={openContextMenu}
											handleFolderDragEnter={handleFolderDragEnter}
											handleFolderDragOver={handleFolderDragOver}
											handleFolderDragLeave={handleFolderDragLeave}
											handleFolderDrop={handleFolderDrop}
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

			{/* Status bar */}
			{session.fileTreeStats && (
				<div
					className="flex-shrink-0 flex items-center justify-center gap-3 px-3 py-1.5 text-xs rounded mt-3 mb-[7px]"
					style={{
						backgroundColor: theme.colors.bgActivity,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textDim,
					}}
				>
					<span>
						<span style={{ color: theme.colors.accent }}>
							{session.fileTreeStats.fileCount.toLocaleString()}
						</span>
						<span className="opacity-60">
							{' '}
							file{session.fileTreeStats.fileCount !== 1 ? 's' : ''},{' '}
						</span>
						<span style={{ color: theme.colors.accent }}>
							{session.fileTreeStats.folderCount.toLocaleString()}
						</span>
						<span className="opacity-60">
							{' '}
							folder{session.fileTreeStats.folderCount !== 1 ? 's' : ''}
						</span>
					</span>
					<span>
						<span className="opacity-60">Size:</span>{' '}
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
		</div>
	);
}

export const FileExplorerPanel = memo(FileExplorerPanelInner);
