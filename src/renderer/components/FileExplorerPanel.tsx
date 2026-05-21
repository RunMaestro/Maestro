import React, { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
	ChevronRight,
	ChevronDown,
	ChevronUp,
	Folder,
	RefreshCw,
	Check,
	Eye,
	EyeOff,
	Target,
	Copy,
	ExternalLink,
	FolderOpen,
	Server,
	Clock,
	RotateCw,
	FileText,
	Globe,
	Edit2,
	Trash2,
	AlertTriangle,
	Search,
	FilePlus,
} from 'lucide-react';
import { Spinner } from './ui/Spinner';
import type { Session, Theme, FocusArea, FileChangeType } from '../types';
import type { FileNode } from '../types/fileTree';
import type { FileTreeChanges } from '../utils/fileExplorer';
import {
	removeNodeFromTree,
	renameNodeInTree,
	findNodeInTree,
	countNodesInTree,
} from '../utils/fileExplorer';
import { getExplorerFileIcon, getExplorerFolderIcon } from '../utils/theme';
import { buildChangedAncestors, buildFileChangeMap } from '../utils/gitChangeMap';
import { COLORBLIND_STATUS_COLORS } from '../constants/colorblindPalettes';
import { useGitDetail } from '../contexts/GitStatusContext';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { useEventListener } from '../hooks/utils/useEventListener';
import { getRevealLabel, getOpenInLabel } from '../utils/platformUtils';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { useSettingsStore } from '../stores/settingsStore';
import { RIGHT_PANEL_COMPACT_THRESHOLD } from '../constants/rightPanel';
import type { FileExplorerIconTheme } from '../utils/fileExplorerIcons/shared';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';
import { logger } from '../utils/logger';
import { MAESTRO_DIR } from '../../shared/maestro-paths';

/**
 * RetryCountdown component - shows time remaining until auto-retry.
 */
function RetryCountdown({
	retryAt,
	theme,
	onRetryNow,
}: {
	retryAt: number;
	theme: Theme;
	onRetryNow: () => void;
}) {
	const [secondsLeft, setSecondsLeft] = useState(() =>
		Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
	);

	useEffect(() => {
		const interval = setInterval(() => {
			const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
			setSecondsLeft(remaining);
		}, 1000);

		return () => clearInterval(interval);
	}, [retryAt]);

	return (
		<div className="flex flex-col items-center gap-2 mt-3">
			<div className="flex items-center gap-1.5 text-xs" style={{ color: theme.colors.textDim }}>
				<Clock className="w-3.5 h-3.5" />
				<span>Retrying in {secondsLeft}s...</span>
			</div>
			<button
				onClick={onRetryNow}
				className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.accent }}
			>
				<RotateCw className="w-3.5 h-3.5" />
				Retry Now
			</button>
		</div>
	);
}

/**
 * FileTreeLoadingProgress component - shows streaming progress during file tree load.
 * Particularly useful for slow SSH connections where the full tree walk can take time.
 */
function FileTreeLoadingProgress({
	theme,
	progress,
	isRemote,
	onCancel,
}: {
	theme: Theme;
	progress?: {
		directoriesScanned: number;
		filesFound: number;
		currentDirectory: string;
	};
	isRemote: boolean;
	onCancel?: () => void;
}) {
	// Extract just the folder name from the full path for display
	const currentFolder = progress?.currentDirectory
		? progress.currentDirectory.split('/').pop() || progress.currentDirectory
		: '';

	return (
		<div className="flex flex-col items-center justify-center gap-3 py-8">
			{/* Animated spinner */}
			<Spinner size={24} color={theme.colors.accent} />

			{/* Status text */}
			<div className="text-center">
				<div className="text-xs" style={{ color: theme.colors.textMain }}>
					{isRemote ? 'Loading remote files...' : 'Loading files...'}
				</div>

				{/* Progress counters - shown when we have progress data */}
				{progress && (progress.directoriesScanned > 0 || progress.filesFound > 0) && (
					<div className="text-xs mt-2 font-mono" style={{ color: theme.colors.textDim }}>
						<span style={{ color: theme.colors.accent }}>
							{progress.filesFound.toLocaleString()}
						</span>
						{' files in '}
						<span style={{ color: theme.colors.accent }}>
							{progress.directoriesScanned.toLocaleString()}
						</span>
						{' folders'}
					</div>
				)}

				{/* Current directory being scanned - truncated */}
				{currentFolder && (
					<div
						className="text-[10px] mt-1.5 max-w-[200px] truncate opacity-60"
						style={{ color: theme.colors.textDim }}
						title={progress?.currentDirectory}
					>
						scanning: {currentFolder}/
					</div>
				)}

				{/* Cancel — useful over SSH when the scan is hogging connections. */}
				{onCancel && (
					<button
						type="button"
						onClick={onCancel}
						className="text-[11px] mt-3 underline-offset-2 hover:underline transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						Stop loading
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * FileTreeTruncatedBanner - surfaces the "scan stopped at the entry cap" state
 * with two affordances: bump the cap (Load more) or remove it (Load all).
 *
 * "Load all" is gated so catastrophically large trees (10M+ files) still need
 * explicit opt-in.
 */
function FileTreeTruncatedBanner({
	theme,
	previousCap,
	onLoadMore,
	onLoadAll,
	isRefreshing,
}: {
	theme: Theme;
	previousCap?: number;
	onLoadMore: () => void;
	onLoadAll: () => void;
	isRefreshing: boolean;
}) {
	const capLabel =
		previousCap !== undefined && Number.isFinite(previousCap)
			? previousCap.toLocaleString()
			: 'the configured cap';
	const nextCap =
		previousCap !== undefined && Number.isFinite(previousCap)
			? (previousCap * 2).toLocaleString()
			: 'more';

	return (
		<div
			className="flex items-start gap-2 px-3 py-2 rounded border mb-2"
			style={{
				borderColor: theme.colors.warning,
				backgroundColor: `${theme.colors.warning}15`,
				color: theme.colors.textMain,
			}}
		>
			<AlertTriangle
				className="w-4 h-4 mt-0.5 flex-shrink-0"
				style={{ color: theme.colors.warning }}
			/>
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium">Unable to load all files into the file panel.</div>
				<div className="text-[11px] opacity-70 mt-0.5">
					Scan stopped at {capLabel} entries to protect memory. Adjust the cap in Settings → Display
					→ File Indexing.
				</div>
				<div className="flex gap-2 mt-1.5">
					<button
						type="button"
						onClick={onLoadMore}
						disabled={isRefreshing}
						className="px-2 py-0.5 rounded text-[11px] font-medium transition-colors disabled:opacity-50"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
						}}
					>
						Load more ({nextCap})
					</button>
					<button
						type="button"
						onClick={onLoadAll}
						disabled={isRefreshing}
						className="px-2 py-0.5 rounded text-[11px] font-medium border transition-colors disabled:opacity-50"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Load all
					</button>
				</div>
			</div>
		</div>
	);
}

// Auto-refresh interval options in seconds
const AUTO_REFRESH_OPTIONS = [
	{ label: 'Every 5 seconds', value: 5 },
	{ label: 'Every 20 seconds', value: 20 },
	{ label: 'Every 60 seconds', value: 60 },
	{ label: 'Every 3 minutes', value: 180 },
];

/**
 * NewFileModal - Modal for creating a new (empty) file inside a folder.
 */
interface NewFileModalProps {
	theme: Theme;
	parentFolderLabel: string;
	value: string;
	setValue: (value: string) => void;
	error: string | null;
	isCreating: boolean;
	onClose: () => void;
	onCreate: () => void;
}

function NewFileModal({
	theme,
	parentFolderLabel,
	value,
	setValue,
	error,
	isCreating,
	onClose,
	onCreate,
}: NewFileModalProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<Modal
			theme={theme}
			title={`New file in ${parentFolderLabel}`}
			priority={MODAL_PRIORITIES.RENAME_INSTANCE}
			onClose={isCreating ? () => {} : onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={onCreate}
					confirmLabel={isCreating ? 'Creating...' : 'Create'}
					confirmDisabled={isCreating || !value.trim()}
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={onCreate}
				placeholder="Enter file name..."
				error={error || undefined}
				submitEnabled={Boolean(value.trim()) && !isCreating}
			/>
		</Modal>
	);
}

/**
 * RenameFileModal - Modal for renaming files/folders in the file explorer
 */
interface RenameFileModalProps {
	theme: Theme;
	node: FileNode;
	value: string;
	setValue: (value: string) => void;
	error: string | null;
	onClose: () => void;
	onRename: () => void;
}

function RenameFileModal({
	theme,
	node,
	value,
	setValue,
	error,
	onClose,
	onRename,
}: RenameFileModalProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const isFolder = node.type === 'folder';
	const title = isFolder ? 'Rename Folder' : 'Rename File';

	// Select filename (without extension for files) on mount
	useEffect(() => {
		requestAnimationFrame(() => {
			if (inputRef.current) {
				const name = node.name;
				const dotIndex = !isFolder ? name.lastIndexOf('.') : -1;
				if (dotIndex > 0) {
					inputRef.current.setSelectionRange(0, dotIndex);
				} else {
					inputRef.current.select();
				}
			}
		});
	}, [node.name, isFolder]);

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.RENAME_INSTANCE}
			onClose={onClose}
			initialFocusRef={inputRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={onRename}
					confirmLabel="Rename"
					confirmDisabled={!value.trim() || value.trim() === node.name}
				/>
			}
		>
			<FormInput
				ref={inputRef}
				theme={theme}
				value={value}
				onChange={setValue}
				onSubmit={onRename}
				placeholder={isFolder ? 'Enter folder name...' : 'Enter file name...'}
				error={error || undefined}
				submitEnabled={Boolean(value.trim() && value.trim() !== node.name)}
			/>
		</Modal>
	);
}

/**
 * DeleteFileModal - Confirmation modal for deleting files/folders in the file explorer
 */
interface DeleteFileModalProps {
	theme: Theme;
	node: FileNode;
	itemCount?: { fileCount: number; folderCount: number };
	isDeleting: boolean;
	onClose: () => void;
	onDelete: () => void;
}

function DeleteFileModal({
	theme,
	node,
	itemCount,
	isDeleting,
	onClose,
	onDelete,
}: DeleteFileModalProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const isFolder = node.type === 'folder';

	return (
		<Modal
			theme={theme}
			title={isFolder ? 'Delete Folder' : 'Delete File'}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={isDeleting ? () => {} : onClose}
			headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
			initialFocusRef={cancelButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={onDelete}
					confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
					confirmDisabled={isDeleting}
					destructive
					cancelButtonRef={cancelButtonRef}
				/>
			}
		>
			<div className="flex gap-4">
				<div
					className="flex-shrink-0 p-2 rounded-full h-fit"
					style={{ backgroundColor: `${theme.colors.error}20` }}
				>
					<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.error }} />
				</div>
				<div>
					<p style={{ color: theme.colors.textMain }}>
						Are you sure you want to delete the {isFolder ? 'folder' : 'file'} "{node.name}"? This
						action cannot be undone.
					</p>
					{isFolder && itemCount && (
						<p className="text-sm mt-3" style={{ color: theme.colors.warning }}>
							This folder contains {itemCount.fileCount} file{itemCount.fileCount !== 1 ? 's' : ''}
							{itemCount.folderCount > 0 && (
								<>
									{' '}
									and {itemCount.folderCount} subfolder{itemCount.folderCount !== 1 ? 's' : ''}
								</>
							)}
							.
						</p>
					)}
				</div>
			</div>
		</Modal>
	);
}

/**
 * MoveConflictModal — shown when a drag-to-move would clobber an existing file
 * or folder at the destination. Lets the user overwrite, rename with a
 * pre-computed non-conflicting name, or cancel.
 */
interface MoveConflictModalProps {
	theme: Theme;
	sourceName: string;
	destFolderLabel: string;
	autoRenameTo: string;
	isMoving: boolean;
	onCancel: () => void;
	onOverwrite: () => void;
	onAutoRename: () => void;
}

function MoveConflictModal({
	theme,
	sourceName,
	destFolderLabel,
	autoRenameTo,
	isMoving,
	onCancel,
	onOverwrite,
	onAutoRename,
}: MoveConflictModalProps) {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);

	return (
		<Modal
			theme={theme}
			title="Name conflict"
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={isMoving ? () => {} : onCancel}
			headerIcon={<AlertTriangle className="w-4 h-4" style={{ color: theme.colors.warning }} />}
			initialFocusRef={cancelButtonRef}
		>
			<div className="flex flex-col gap-4">
				<p style={{ color: theme.colors.textMain }}>
					"{sourceName}" already exists in {destFolderLabel}. How do you want to proceed?
				</p>
				<div className="flex flex-col gap-2">
					<button
						type="button"
						disabled={isMoving}
						onClick={onAutoRename}
						className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textMain,
						}}
					>
						<div className="font-medium">Rename to "{autoRenameTo}"</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Move the file with an auto-suffixed name so nothing is overwritten.
						</div>
					</button>
					<button
						type="button"
						disabled={isMoving}
						onClick={onOverwrite}
						className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.error,
						}}
					>
						<div className="font-medium">Overwrite existing</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Replace the file already at the destination. Cannot be undone.
						</div>
					</button>
					<button
						ref={cancelButtonRef}
						type="button"
						disabled={isMoving}
						onClick={onCancel}
						className="px-3 py-2 rounded text-sm text-left disabled:opacity-50 hover:bg-white/5 transition-colors"
						style={{
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textDim,
						}}
					>
						<div className="font-medium">Cancel</div>
					</button>
				</div>
			</div>
		</Modal>
	);
}

// Helper to format bytes into human-readable format
function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Flattened node for virtualization
interface FlattenedNode {
	node: FileNode;
	path: string;
	depth: number;
	globalIndex: number;
}

interface FileExplorerPanelProps {
	session: Session;
	theme: Theme;
	fileTreeFilter: string;
	setFileTreeFilter: (filter: string) => void;
	fileTreeFilterOpen: boolean;
	setFileTreeFilterOpen: (open: boolean) => void;
	filteredFileTree: FileNode[];
	selectedFileIndex: number;
	setSelectedFileIndex: (index: number) => void;
	activeFocus: FocusArea;
	activeRightTab: string;
	setActiveFocus: (focus: FocusArea) => void;
	fileTreeContainerRef?: React.RefObject<HTMLDivElement>;
	fileTreeFilterInputRef?: React.RefObject<HTMLInputElement>;
	toggleFolder: (
		path: string,
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	toggleFolderRecursive: (
		path: string,
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	handleFileClick: (node: FileNode, path: string, activeSession: Session) => Promise<void>;
	expandAllFolders: (
		activeSessionId: string,
		activeSession: Session,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	collapseAllFolders: (
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => void;
	updateSessionWorkingDirectory: (
		activeSessionId: string,
		setSessions: React.Dispatch<React.SetStateAction<Session[]>>
	) => Promise<void>;
	refreshFileTree: (
		sessionId: string,
		options?: { maxEntriesOverride?: number }
	) => Promise<FileTreeChanges | undefined>;
	/** Cancel the in-flight file tree load — useful when SSH scans monopolize connections. */
	cancelFileTreeLoad?: (sessionId: string) => void;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	onAutoRefreshChange?: (interval: number) => void;
	onShowFlash?: (message: string) => void;
	showHiddenFiles: boolean;
	fileExplorerIconTheme: FileExplorerIconTheme;
	setShowHiddenFiles: (value: boolean) => void;
	/** Callback to open graph view focused on a specific file (relative path to session.cwd) */
	onFocusFileInGraph?: (relativePath: string) => void;
	/**
	 * Opens a new in-app browser tab pointed at the given URL. Used by the
	 * "Open in Maestro Browser" context-menu action so JS-heavy local HTML
	 * (Plotly dashboards, etc.) renders in the full Electron webview instead
	 * of the sandboxed file-preview iframe.
	 */
	onOpenBrowserTabAt?: (url: string, options?: { title?: string }) => void;
}

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

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	// Path of the row last clicked while the filter was open. When the filter
	// closes via Escape we expand its ancestor folders and scroll it into view —
	// otherwise finding a result via search leads nowhere once the filter clears.
	const lastClickedUnderFilterRef = useRef<string | null>(null);
	const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);

	// Refresh overlay state
	const [overlayOpen, setOverlayOpen] = useState(false);
	const [overlayPosition, setOverlayPosition] = useState<{ top: number; left: number } | null>(
		null
	);
	const refreshButtonRef = useRef<HTMLButtonElement>(null);
	const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isOverOverlayRef = useRef(false);
	const autoRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
	const autoRefreshSpinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const autoRefreshInFlightRef = useRef(false);

	// Context menu state for file tree items
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		node: FileNode;
		path: string;
	} | null>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);
	const contextMenuPos = useContextMenuPosition(
		contextMenuRef,
		contextMenu?.x ?? 0,
		contextMenu?.y ?? 0
	);

	// Rename modal state
	const [renameModal, setRenameModal] = useState<{
		node: FileNode;
		path: string;
		absolutePath: string;
	} | null>(null);
	const [renameValue, setRenameValue] = useState('');
	const [renameError, setRenameError] = useState<string | null>(null);

	// Delete confirmation modal state
	const [deleteModal, setDeleteModal] = useState<{
		node: FileNode;
		path: string;
		absolutePath: string;
		itemCount?: { fileCount: number; folderCount: number };
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// New-file modal state. `parentFolderPath` is the relative path of the
	// destination folder (empty string = project root).
	const [newFileModal, setNewFileModal] = useState<{
		parentFolderPath: string;
		parentFolderAbsolutePath: string;
	} | null>(null);
	const [newFileValue, setNewFileValue] = useState('');
	const [newFileError, setNewFileError] = useState<string | null>(null);
	const [isCreatingFile, setIsCreatingFile] = useState(false);

	// Drag-to-move state. `dragOverFolder` is the relative path of the folder row
	// currently being hovered (used for highlighting). `moveConflict` is set when
	// the destination already has a file/folder with the same name and we need
	// the user to pick overwrite / auto-rename / cancel.
	const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
	const [moveConflict, setMoveConflict] = useState<{
		sourceName: string;
		sourceRelativePath: string;
		sourceAbsolutePath: string;
		destFolderRelativePath: string;
		destFolderAbsolutePath: string;
		destAbsolutePath: string;
		autoRenameName: string;
		autoRenameAbsolutePath: string;
	} | null>(null);
	const [isMoving, setIsMoving] = useState(false);

	// Close context menu when clicking outside
	useClickOutside(
		contextMenuRef,
		() => {
			setContextMenu(null);
		},
		contextMenu !== null
	);

	// Use refs to avoid recreating the timer when callbacks change
	const refreshFileTreeRef = useRef(refreshFileTree);
	const sessionIdRef = useRef(session.id);

	// Keep refs up to date
	useEffect(() => {
		refreshFileTreeRef.current = refreshFileTree;
	}, [refreshFileTree]);

	useEffect(() => {
		sessionIdRef.current = session.id;
	}, [session.id]);

	// Get current auto-refresh interval from session (180s default as defense-in-depth for unmigrated sessions)
	const autoRefreshInterval = session.fileTreeAutoRefreshInterval ?? 180;

	// Handle refresh with animation and flash notification
	const handleRefresh = useCallback(async () => {
		setIsRefreshing(true);

		try {
			const changes = await refreshFileTree(session.id);

			// Show center screen flash notification with change count
			if (changes && onShowFlash) {
				const message =
					changes.totalChanges === 0
						? 'No changes detected'
						: `Detected ${changes.totalChanges} change${changes.totalChanges === 1 ? '' : 's'}`;
				onShowFlash(message);
			}
		} finally {
			// Keep spinner visible for at least 500ms for visual feedback
			setTimeout(() => setIsRefreshing(false), 500);
		}
	}, [refreshFileTree, session.id, onShowFlash]);

	// Auto-refresh timer - uses refs to avoid resetting timer when callbacks change
	useEffect(() => {
		// Clear existing timer
		if (autoRefreshTimerRef.current) {
			clearInterval(autoRefreshTimerRef.current);
			autoRefreshTimerRef.current = null;
		}

		// Start new timer if interval is set
		if (autoRefreshInterval > 0) {
			autoRefreshTimerRef.current = setInterval(async () => {
				// Skip if a previous auto-refresh is still in flight
				if (autoRefreshInFlightRef.current) return;
				autoRefreshInFlightRef.current = true;

				// Brief spin animation so user can see auto-refresh is active
				setIsRefreshing(true);
				try {
					await refreshFileTreeRef.current(sessionIdRef.current);
				} catch (error) {
					logger.error('[FileExplorer] Auto-refresh failed:', undefined, error);
				} finally {
					autoRefreshSpinTimeoutRef.current = setTimeout(() => {
						setIsRefreshing(false);
						autoRefreshInFlightRef.current = false;
					}, 500);
				}
			}, autoRefreshInterval * 1000);
		}

		// Cleanup on unmount or interval change
		return () => {
			if (autoRefreshTimerRef.current) {
				clearInterval(autoRefreshTimerRef.current);
				autoRefreshTimerRef.current = null;
			}
			if (autoRefreshSpinTimeoutRef.current) {
				clearTimeout(autoRefreshSpinTimeoutRef.current);
				autoRefreshSpinTimeoutRef.current = null;
			}
			autoRefreshInFlightRef.current = false;
		};
	}, [autoRefreshInterval]); // Only depends on the interval now

	// Hover handlers for refresh button overlay
	const handleRefreshMouseEnter = useCallback(() => {
		hoverTimeoutRef.current = setTimeout(() => {
			if (refreshButtonRef.current) {
				const rect = refreshButtonRef.current.getBoundingClientRect();
				setOverlayPosition({ top: rect.bottom + 4, left: rect.right });
			}
			setOverlayOpen(true);
		}, 400);
	}, []);

	const handleRefreshMouseLeave = useCallback(() => {
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
		// Delay closing to allow mouse to reach overlay
		hoverTimeoutRef.current = setTimeout(() => {
			if (!isOverOverlayRef.current) {
				setOverlayOpen(false);
			}
		}, 100);
	}, []);

	const handleOverlayMouseEnter = useCallback(() => {
		isOverOverlayRef.current = true;
		if (hoverTimeoutRef.current) {
			clearTimeout(hoverTimeoutRef.current);
			hoverTimeoutRef.current = null;
		}
	}, []);

	const handleOverlayMouseLeave = useCallback(() => {
		isOverOverlayRef.current = false;
		setOverlayOpen(false);
	}, []);

	const handleIntervalSelect = useCallback(
		(interval: number) => {
			onAutoRefreshChange?.(interval);
			setOverlayOpen(false);
		},
		[onAutoRefreshChange]
	);

	// Context menu handlers
	const handleContextMenu = useCallback(
		(e: React.MouseEvent, node: FileNode, path: string, globalIndex: number) => {
			e.preventDefault();
			e.stopPropagation();
			// Update selection to the right-clicked item so user sees which item the menu affects
			setSelectedFileIndex(globalIndex);
			setContextMenu({
				x: e.clientX,
				y: e.clientY,
				node,
				path,
			});
		},
		[setSelectedFileIndex]
	);

	const handleFocusInGraph = useCallback(() => {
		if (contextMenu && onFocusFileInGraph) {
			onFocusFileInGraph(contextMenu.path);
		}
		setContextMenu(null);
	}, [contextMenu, onFocusFileInGraph]);

	const handlePreviewFile = useCallback(() => {
		if (contextMenu && contextMenu.node.type === 'file') {
			handleFileClick(contextMenu.node, contextMenu.path, session);
		}
		setContextMenu(null);
	}, [contextMenu, handleFileClick, session]);

	// Ensure a folder is expanded in the tree. Idempotent — no-op if already
	// expanded or if the path is empty (project root is always visible). Used
	// after creating a file in a folder or moving a file into one, so the
	// resulting row is visible without an extra click.
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

	const handleCopyPath = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			safeClipboardWrite(absolutePath);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	const handleOpenInDefaultApp = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			window.maestro?.shell?.openPath(absolutePath);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	// Open the file in a new in-app browser tab. The file-preview iframe uses
	// `srcDoc` + a tight sandbox that gives scripts an opaque origin and no
	// base URL, which breaks JS-heavy dashboards (Plotly, etc.); the browser
	// tab uses a full Electron webview where everything just works.
	const handleOpenInMaestroBrowser = useCallback(() => {
		if (contextMenu && contextMenu.node.type === 'file' && onOpenBrowserTabAt) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			// Encode each path segment so spaces and other reserved chars
			// don't break the file:// URL.
			const encodedPath = absolutePath
				.split('/')
				.map((seg) => encodeURIComponent(seg))
				.join('/');
			const url = `file://${encodedPath}`;
			onOpenBrowserTabAt(url, { title: contextMenu.node.name });
		}
		setContextMenu(null);
	}, [contextMenu, onOpenBrowserTabAt, session.fullPath]);

	const handleOpenInExplorer = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			window.maestro?.shell?.showItemInFolder(absolutePath);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	// Open new-file modal seeded with the right-clicked folder as the parent.
	const handleOpenNewFile = useCallback(() => {
		if (contextMenu && contextMenu.node.type === 'folder') {
			setNewFileModal({
				parentFolderPath: contextMenu.path,
				parentFolderAbsolutePath: `${session.fullPath}/${contextMenu.path}`,
			});
			setNewFileValue('');
			setNewFileError(null);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	// Open rename modal
	const handleOpenRename = useCallback(() => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			setRenameModal({
				node: contextMenu.node,
				path: contextMenu.path,
				absolutePath,
			});
			setRenameValue(contextMenu.node.name);
			setRenameError(null);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath]);

	// Get SSH remote ID - use sshRemoteId (set after AI spawns) or fall back to sessionSshRemoteConfig
	// (set before spawn). This ensures file operations work for both AI and terminal-only SSH sessions.
	const sshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

	// Execute rename
	const handleRename = useCallback(async () => {
		if (!renameModal || !renameValue.trim()) return;

		const newName = renameValue.trim();
		if (newName === renameModal.node.name) {
			setRenameModal(null);
			return;
		}

		// Validate new name
		if (newName.includes('/') || newName.includes('\\')) {
			setRenameError('Name cannot contain slashes');
			return;
		}

		try {
			const parentDir = renameModal.absolutePath.substring(
				0,
				renameModal.absolutePath.lastIndexOf('/')
			);
			const newPath = `${parentDir}/${newName}`;
			await window.maestro.fs.rename(renameModal.absolutePath, newPath, sshRemoteId);

			// Update tree locally instead of full refresh
			const newTree = renameNodeInTree(session.fileTree || [], renameModal.path, newName);

			// Calculate the new path for expanded folder updates
			const oldPath = renameModal.path;
			const pathParts = oldPath.split('/');
			pathParts[pathParts.length - 1] = newName;
			const newRelativePath = pathParts.join('/');

			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					return {
						...s,
						fileTree: newTree,
						// Update expanded folder paths if renamed item was a folder
						fileExplorerExpanded:
							renameModal.node.type === 'folder'
								? (s.fileExplorerExpanded || []).map((p) => {
										if (p === oldPath) return newRelativePath;
										if (p.startsWith(oldPath + '/'))
											return newRelativePath + p.slice(oldPath.length);
										return p;
									})
								: s.fileExplorerExpanded,
					};
				})
			);

			setRenameModal(null);
			onShowFlash?.(`Renamed to "${newName}"`);
		} catch (error) {
			setRenameError(error instanceof Error ? error.message : 'Rename failed');
		}
	}, [
		renameModal,
		renameValue,
		session.id,
		session.fileTree,
		onShowFlash,
		sshRemoteId,
		setSessions,
	]);

	// Create an empty file inside the new-file modal's parent folder. Validates
	// name (no slashes, not a duplicate inside the parent), writes via fs, and
	// refreshes the tree so the new row appears.
	const handleCreateNewFile = useCallback(async () => {
		if (!newFileModal || !newFileValue.trim()) return;

		const name = newFileValue.trim();
		if (name.includes('/') || name.includes('\\')) {
			setNewFileError('Name cannot contain slashes');
			return;
		}

		// Check duplicate against the parent folder's children in the in-memory
		// tree. Cheap enough and avoids a round trip; fs.writeFile would otherwise
		// silently overwrite.
		const parts = newFileModal.parentFolderPath.split('/').filter(Boolean);
		let children: FileNode[] | undefined = session.fileTree;
		for (const part of parts) {
			if (!children) break;
			children = children.find((c) => c.name === part)?.children;
		}
		if (children?.some((c) => c.name === name)) {
			setNewFileError(`"${name}" already exists in this folder`);
			return;
		}

		const absolutePath = `${newFileModal.parentFolderAbsolutePath}/${name}`;
		setIsCreatingFile(true);
		try {
			await window.maestro.fs.writeFile(absolutePath, '', sshRemoteId);
			await refreshFileTree(session.id);
			// Expand the target folder so the new file is visible immediately.
			expandFolder(newFileModal.parentFolderPath);
			setNewFileModal(null);
			onShowFlash?.(`Created "${name}"`);
		} catch (error) {
			setNewFileError(error instanceof Error ? error.message : 'Create failed');
		} finally {
			setIsCreatingFile(false);
		}
	}, [
		newFileModal,
		newFileValue,
		session.fileTree,
		session.id,
		sshRemoteId,
		refreshFileTree,
		onShowFlash,
		expandFolder,
	]);

	// Open delete confirmation modal
	const handleOpenDelete = useCallback(async () => {
		if (contextMenu) {
			const absolutePath = `${session.fullPath}/${contextMenu.path}`;
			const modalData: typeof deleteModal = {
				node: contextMenu.node,
				path: contextMenu.path,
				absolutePath,
			};

			// For folders, count items inside
			if (contextMenu.node.type === 'folder') {
				try {
					const count = await window.maestro.fs.countItems(absolutePath, sshRemoteId);
					modalData.itemCount = count;
				} catch {
					// If count fails, proceed without it
				}
			}

			setDeleteModal(modalData);
		}
		setContextMenu(null);
	}, [contextMenu, session.fullPath, sshRemoteId]);

	// Execute delete
	const handleDelete = useCallback(async () => {
		if (!deleteModal) return;

		setIsDeleting(true);
		try {
			await window.maestro.fs.delete(deleteModal.absolutePath, { sshRemoteId });

			// Get the node being deleted to count its contents for stats update
			const deletedNode = findNodeInTree(session.fileTree || [], deleteModal.path);
			let deletedFileCount = 0;
			let deletedFolderCount = 0;

			if (deletedNode) {
				if (deletedNode.type === 'folder') {
					deletedFolderCount = 1;
					if (deletedNode.children) {
						const childCounts = countNodesInTree(deletedNode.children);
						deletedFileCount = childCounts.fileCount;
						deletedFolderCount += childCounts.folderCount;
					}
				} else {
					deletedFileCount = 1;
				}
			}

			// Update tree locally instead of full refresh
			const newTree = removeNodeFromTree(session.fileTree || [], deleteModal.path);
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					return {
						...s,
						fileTree: newTree,
						fileTreeStats: s.fileTreeStats
							? {
									...s.fileTreeStats,
									fileCount: Math.max(0, s.fileTreeStats.fileCount - deletedFileCount),
									folderCount: Math.max(0, s.fileTreeStats.folderCount - deletedFolderCount),
								}
							: undefined,
						// Also remove from expanded folders if it was a folder
						fileExplorerExpanded:
							deleteModal.node.type === 'folder'
								? (s.fileExplorerExpanded || []).filter((p) => !p.startsWith(deleteModal.path))
								: s.fileExplorerExpanded,
					};
				})
			);

			setDeleteModal(null);
			onShowFlash?.(`Deleted "${deleteModal.node.name}"`);
		} catch (error) {
			onShowFlash?.(`Delete failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			setIsDeleting(false);
		}
	}, [deleteModal, session.id, session.fileTree, onShowFlash, sshRemoteId, setSessions]);

	// ====================================================================
	// Drag-to-move within the file tree
	// ====================================================================

	// True when `destFolderRelative` is the same as, or a descendant of,
	// `sourceRelative` — moving a folder into itself would orphan its subtree.
	const isSelfOrDescendant = useCallback((sourceRelative: string, destFolderRelative: string) => {
		return (
			destFolderRelative === sourceRelative || destFolderRelative.startsWith(sourceRelative + '/')
		);
	}, []);

	const parentDirOf = useCallback((relativePath: string): string => {
		const idx = relativePath.lastIndexOf('/');
		return idx < 0 ? '' : relativePath.slice(0, idx);
	}, []);

	const basenameOf = useCallback((relativePath: string): string => {
		const idx = relativePath.lastIndexOf('/');
		return idx < 0 ? relativePath : relativePath.slice(idx + 1);
	}, []);

	// Find a node at `relativePath` within the current file tree. Returns null
	// when the path doesn't resolve — we treat that as "no conflict" and let
	// fs:rename surface any race between this lookup and the move.
	const findNodeAtPath = useCallback(
		(relativePath: string): FileNode | null => {
			if (!relativePath) return null;
			const parts = relativePath.split('/').filter(Boolean);
			let children: FileNode[] | undefined = session.fileTree;
			let node: FileNode | null = null;
			for (const part of parts) {
				if (!children) return null;
				const match: FileNode | undefined = children.find((c) => c.name === part);
				if (!match) return null;
				node = match;
				children = match.children;
			}
			return node;
		},
		[session.fileTree]
	);

	// Compute "name (2).ext", "name (3).ext", etc. against existing names. Hidden
	// files (".env") keep their leading dot as part of the stem so we don't end
	// up with "(2).env".
	const computeAutoRenameName = useCallback((existingNames: Set<string>, baseName: string) => {
		if (!existingNames.has(baseName)) return baseName;
		const dotIdx = baseName.lastIndexOf('.');
		const hasExt = dotIdx > 0;
		const stem = hasExt ? baseName.slice(0, dotIdx) : baseName;
		const ext = hasExt ? baseName.slice(dotIdx) : '';
		for (let i = 2; i < 1000; i++) {
			const candidate = `${stem} (${i})${ext}`;
			if (!existingNames.has(candidate)) return candidate;
		}
		return baseName;
	}, []);

	const performMove = useCallback(
		async (
			sourceAbsolute: string,
			destAbsolute: string,
			sourceName: string,
			destFolderRelative: string
		) => {
			setIsMoving(true);
			try {
				await window.maestro.fs.rename(sourceAbsolute, destAbsolute, sshRemoteId);
				// fs:rename mutates the tree's shape (parent dirs change, expansions
				// may go stale), so do a full refresh instead of an in-place patch.
				await refreshFileTree(session.id);
				// Expand the destination folder so the moved row is visible without
				// an extra click.
				expandFolder(destFolderRelative);
				onShowFlash?.(`Moved "${sourceName}"`);
			} catch (error) {
				onShowFlash?.(`Move failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
			} finally {
				setIsMoving(false);
				setMoveConflict(null);
			}
		},
		[sshRemoteId, refreshFileTree, session.id, onShowFlash, expandFolder]
	);

	const handleFolderDrop = useCallback(
		(e: React.DragEvent, destFolderRelative: string) => {
			const sourceRelative = e.dataTransfer.getData('application/x-maestro-file-path');
			if (!sourceRelative) return;

			e.preventDefault();
			e.stopPropagation();
			setDragOverFolder(null);

			// Self / descendant / same-parent drops are no-ops. Validation also
			// happens in handleFolderDragOver, but guard here in case dragOver was
			// bypassed by a same-element drop.
			if (isSelfOrDescendant(sourceRelative, destFolderRelative)) return;
			if (parentDirOf(sourceRelative) === destFolderRelative) return;

			const sourceName = basenameOf(sourceRelative);
			const sourceAbsolute = `${session.fullPath}/${sourceRelative}`;
			const destFolderAbsolute = `${session.fullPath}/${destFolderRelative}`;
			const destRelative = `${destFolderRelative}/${sourceName}`;
			const destAbsolute = `${destFolderAbsolute}/${sourceName}`;

			const conflictNode = findNodeAtPath(destRelative);
			if (!conflictNode) {
				void performMove(sourceAbsolute, destAbsolute, sourceName, destFolderRelative);
				return;
			}

			const destFolderNode = findNodeAtPath(destFolderRelative);
			const existingNames = new Set(destFolderNode?.children?.map((c) => c.name) ?? []);
			const autoRenameName = computeAutoRenameName(existingNames, sourceName);
			setMoveConflict({
				sourceName,
				sourceRelativePath: sourceRelative,
				sourceAbsolutePath: sourceAbsolute,
				destFolderRelativePath: destFolderRelative,
				destFolderAbsolutePath: destFolderAbsolute,
				destAbsolutePath: destAbsolute,
				autoRenameName,
				autoRenameAbsolutePath: `${destFolderAbsolute}/${autoRenameName}`,
			});
		},
		[
			session.fullPath,
			isSelfOrDescendant,
			parentDirOf,
			basenameOf,
			findNodeAtPath,
			computeAutoRenameName,
			performMove,
		]
	);

	const handleFolderDragOver = useCallback(
		(e: React.DragEvent, destFolderRelative: string) => {
			if (!e.dataTransfer.types.includes('application/x-maestro-file-path')) return;
			// During dragOver, getData() returns '' in some browsers as a security
			// measure — we can still consult the type list to know it's our drag.
			// If we can read the path, validate it; otherwise optimistically accept
			// and re-validate on drop.
			const sourceRelative = e.dataTransfer.getData('application/x-maestro-file-path');
			if (sourceRelative && isSelfOrDescendant(sourceRelative, destFolderRelative)) {
				e.dataTransfer.dropEffect = 'none';
				return;
			}
			if (sourceRelative && parentDirOf(sourceRelative) === destFolderRelative) {
				e.dataTransfer.dropEffect = 'none';
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = 'move';
		},
		[isSelfOrDescendant, parentDirOf]
	);

	const handleFolderDragEnter = useCallback((e: React.DragEvent, destFolderRelative: string) => {
		if (!e.dataTransfer.types.includes('application/x-maestro-file-path')) return;
		e.stopPropagation();
		setDragOverFolder(destFolderRelative);
	}, []);

	const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
		if (!e.dataTransfer.types.includes('application/x-maestro-file-path')) return;
		e.stopPropagation();
		// Keep the highlight when moving into a descendant of the row (label,
		// icon, indent guides). Clear when leaving the row outline entirely.
		const next = e.relatedTarget as Node | null;
		const row = e.currentTarget as Node | null;
		if (row && next && row.contains(next)) return;
		setDragOverFolder(null);
	}, []);

	// Confirm-overwrite handler for the conflict modal: deletes the existing
	// target first (works for both files and dirs, where a plain rename onto a
	// non-empty dir would fail with ENOTEMPTY), then performs the move.
	const handleMoveOverwrite = useCallback(async () => {
		if (!moveConflict) return;
		setIsMoving(true);
		try {
			await window.maestro.fs.delete(moveConflict.destAbsolutePath, {
				recursive: true,
				sshRemoteId,
			});
			await window.maestro.fs.rename(
				moveConflict.sourceAbsolutePath,
				moveConflict.destAbsolutePath,
				sshRemoteId
			);
			await refreshFileTree(session.id);
			expandFolder(moveConflict.destFolderRelativePath);
			onShowFlash?.(`Moved "${moveConflict.sourceName}" (overwrote existing)`);
		} catch (error) {
			onShowFlash?.(`Move failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			setIsMoving(false);
			setMoveConflict(null);
		}
	}, [moveConflict, sshRemoteId, refreshFileTree, session.id, onShowFlash, expandFolder]);

	const handleMoveAutoRename = useCallback(() => {
		if (!moveConflict) return;
		void performMove(
			moveConflict.sourceAbsolutePath,
			moveConflict.autoRenameAbsolutePath,
			moveConflict.autoRenameName,
			moveConflict.destFolderRelativePath
		);
	}, [moveConflict, performMove]);

	// Close context menu on Escape key (only attached while the menu is open).
	useEventListener(
		'keydown',
		(e) => {
			if ((e as KeyboardEvent).key === 'Escape') {
				setContextMenu(null);
			}
		},
		{ enabled: contextMenu !== null }
	);

	// Closing the filter via Escape: if the user clicked a result first, expand
	// its ancestor folders and queue a scroll-into-view so the search payoff
	// actually lands on something they can see and act on. Move DOM focus to
	// the tree container — otherwise the browser restores focus to whatever
	// was focused before the filter opened (typically FilePreview), and that
	// component's onKeyDown swallows Cmd+F before our window-level shortcut
	// handler can route it back to the file panel.
	const handleFilterEscape = useCallback(() => {
		const clickedPath = lastClickedUnderFilterRef.current;
		lastClickedUnderFilterRef.current = null;

		if (clickedPath) {
			const parts = clickedPath.split('/').filter(Boolean);
			const ancestors: string[] = [];
			for (let i = 1; i < parts.length; i++) {
				ancestors.push(parts.slice(0, i).join('/'));
			}

			if (ancestors.length > 0) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== session.id) return s;
						const expanded = new Set(s.fileExplorerExpanded ?? []);
						for (const p of ancestors) expanded.add(p);
						return { ...s, fileExplorerExpanded: Array.from(expanded) };
					})
				);
			}

			setPendingRevealPath(clickedPath);
		}

		setFileTreeFilterOpen(false);
		setFileTreeFilter('');
		fileTreeContainerRef?.current?.focus();
	}, [session.id, setSessions, setFileTreeFilterOpen, setFileTreeFilter, fileTreeContainerRef]);

	// Register layer when filter is open
	useEffect(() => {
		if (fileTreeFilterOpen) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.FILE_TREE_FILTER,
				blocksLowerLayers: false,
				capturesFocus: true,
				focusTrap: 'none',
				onEscape: handleFilterEscape,
				allowClickOutside: true,
				ariaLabel: 'File Tree Filter',
			});
			layerIdRef.current = id;
			return () => unregisterLayer(id);
		}
		// handleFilterEscape intentionally omitted — updateLayerHandler effect below
		// keeps the registered callback fresh without re-registering the layer.
	}, [fileTreeFilterOpen, registerLayer, unregisterLayer]);

	// Update handler when dependencies change
	useEffect(() => {
		if (fileTreeFilterOpen && layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, handleFilterEscape);
		}
	}, [fileTreeFilterOpen, handleFilterEscape, updateLayerHandler]);

	// Filter hidden files from the tree based on showHiddenFiles setting.
	// Invariant: `.maestro` is ALWAYS visible regardless of the dotfiles toggle —
	// it's the project's Maestro workspace (playbooks, cue config, etc.) and
	// hiding it strands users who don't realize their config is "hidden". This
	// has regressed before; if you change the dotfile filter, keep the carve-out.
	const filterHiddenFiles = useCallback(
		(nodes: FileNode[]): FileNode[] => {
			if (!nodes) return [];
			if (showHiddenFiles) return nodes;
			return nodes
				.filter((node) => !node.name.startsWith('.') || node.name === MAESTRO_DIR)
				.map((node) => ({
					...node,
					children: node.children ? filterHiddenFiles(node.children) : undefined,
				}));
		},
		[showHiddenFiles]
	);

	// Apply hidden file filtering to the already-filtered tree
	const displayTree = useMemo(() => {
		return filterHiddenFiles(filteredFileTree || []);
	}, [filteredFileTree, filterHiddenFiles]);

	// Flatten tree for virtualization - only includes visible nodes (respects expanded state)
	// When filtering, auto-expand all folders to show matches
	const flattenedTree = useMemo(() => {
		const expandedSet = new Set(session.fileExplorerExpanded || []);
		const isFiltering = fileTreeFilter.length > 0;
		const result: FlattenedNode[] = [];
		const seenPaths = new Set<string>();
		let globalIndex = 0;

		const flatten = (nodes: FileNode[], currentPath = '', depth = 0) => {
			// Guard: deduplicate sibling nodes by name within the same parent
			const seenNames = new Set<string>();
			for (const node of nodes) {
				const normalizedName = node.name.normalize('NFC');
				if (seenNames.has(normalizedName)) {
					logger.warn('[FileExplorer] Duplicate sibling skipped:', undefined, [
						currentPath,
						node.name,
					]);
					continue;
				}
				seenNames.add(normalizedName);

				const fullPath = currentPath ? `${currentPath}/${node.name}` : node.name;

				// Guard: skip duplicate paths to prevent React key collisions
				if (seenPaths.has(fullPath)) {
					logger.warn('[FileExplorer] Duplicate path skipped:', undefined, fullPath);
					continue;
				}
				seenPaths.add(fullPath);

				result.push({ node, path: fullPath, depth, globalIndex });
				globalIndex++;

				// When filtering, auto-expand all folders to reveal matches
				// Otherwise, only include children if folder is manually expanded
				const shouldShowChildren =
					node.type === 'folder' && node.children && (isFiltering || expandedSet.has(fullPath));

				if (shouldShowChildren) {
					flatten(node.children!, fullPath, depth + 1);
				}
			}
		};

		flatten(displayTree);
		return result;
	}, [displayTree, session.fileExplorerExpanded, fileTreeFilter]);

	// Virtualization setup
	const parentRef = useRef<HTMLDivElement>(null);
	const ROW_HEIGHT = 28; // Height of each tree row in pixels

	const virtualizer = useVirtualizer({
		count: flattenedTree.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 10, // Render 10 extra items above/below viewport for smooth scrolling
	});

	// After Escape expanded ancestor folders, the flattened tree includes the
	// previously-hidden row — select it, focus the file pane, and scroll it into
	// view. Defer the scroll to the next frame so the virtualizer has measured
	// the new row count.
	useEffect(() => {
		if (!pendingRevealPath) return;
		const idx = flattenedTree.findIndex((item) => item.path === pendingRevealPath);
		if (idx < 0) return;
		setSelectedFileIndex(idx);
		setActiveFocus('right');
		const raf = requestAnimationFrame(() => {
			virtualizer.scrollToIndex(idx, { align: 'center' });
		});
		setPendingRevealPath(null);
		return () => cancelAnimationFrame(raf);
	}, [flattenedTree, pendingRevealPath, virtualizer, setSelectedFileIndex, setActiveFocus]);

	// Memoized row renderer
	const TreeRow = useCallback(
		({
			item,
			virtualRow,
		}: {
			item: FlattenedNode;
			virtualRow: { index: number; start: number; size: number };
		}) => {
			const { node, path: fullPath, depth, globalIndex } = item;
			const absolutePath = `${session.fullPath}/${fullPath}`;
			const isFolder = node.type === 'folder';
			// Match against the full relative path — `path.includes(node.name)` used
			// to false-match files with identical leaf names. (#611)
			const changeType: FileChangeType | undefined = isFolder ? undefined : changeMap.get(fullPath);
			// Folders highlight when any descendant is changed (VSCode-style walk).
			const folderHasChange = isFolder && changedAncestors.has(fullPath);
			const hasChange = !!changeType || folderHasChange;
			// Use the colorblind-safe status palette (teal/orange/vermillion) when
			// the user has enabled colorBlindMode, mirroring how the default file
			// icon already swaps its tint via the same palette. Keeps the dot
			// distinguishable for protanopia/deuteranopia/tritanopia.
			const successColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.success : theme.colors.success;
			const warningColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.warning : theme.colors.warning;
			const errorColor = colorBlindMode ? COLORBLIND_STATUS_COLORS.error : theme.colors.error;
			const changeColor =
				changeType === 'added'
					? successColor
					: changeType === 'deleted'
						? errorColor
						: changeType === 'modified'
							? warningColor
							: undefined;
			const expandedSet = new Set(session.fileExplorerExpanded || []);
			const isExpanded = expandedSet.has(fullPath);
			// Check active file tab for selection highlighting
			const activeFileTabPath = session.activeFileTabId
				? session.filePreviewTabs?.find((t) => t.id === session.activeFileTabId)?.path
				: undefined;
			const isSelected = activeFileTabPath === absolutePath;
			const isKeyboardSelected =
				activeFocus === 'right' && activeRightTab === 'files' && globalIndex === selectedFileIndex;

			// Generate indent guides for each depth level
			const indentGuides = [];
			for (let i = 0; i < depth; i++) {
				indentGuides.push(
					<div
						key={i}
						className="absolute top-0 bottom-0 w-px"
						style={{
							left: `${12 + i * 20}px`,
							backgroundColor: theme.colors.border,
						}}
					/>
				);
			}

			const isDropTarget = isFolder && dragOverFolder === fullPath;

			return (
				<div
					key={fullPath}
					data-file-index={globalIndex}
					title={isFolder ? 'Alt/Option+click to expand or collapse all subfolders' : undefined}
					className={`absolute top-0 left-0 w-full flex items-center gap-2 py-1 text-xs cursor-pointer hover:bg-white/5 px-2 rounded transition-colors border-l-2 select-none min-w-0 ${isSelected ? 'bg-white/10' : ''}`}
					style={{
						height: `${virtualRow.size}px`,
						transform: `translateY(${virtualRow.start}px)`,
						paddingLeft: `${8 + depth * 20}px`,
						color: hasChange ? theme.colors.textMain : theme.colors.textDim,
						borderLeftColor: isDropTarget
							? theme.colors.accent
							: isKeyboardSelected
								? theme.colors.accent
								: 'transparent',
						backgroundColor: isDropTarget
							? `${theme.colors.accent}33`
							: isKeyboardSelected
								? theme.colors.bgActivity
								: isSelected
									? 'rgba(255,255,255,0.1)'
									: undefined,
						outline: isDropTarget ? `1px dashed ${theme.colors.accent}` : undefined,
						outlineOffset: isDropTarget ? '-2px' : undefined,
					}}
					draggable
					onDragStart={(e) => {
						e.dataTransfer.setData('application/x-maestro-file-path', fullPath);
						// 'copyMove' so folder-row drop targets can choose 'move' (in-tree
						// reorganisation) while drops on the AI input still default to copy
						// (insert @mention without moving the source file).
						e.dataTransfer.effectAllowed = 'copyMove';
					}}
					onDragEnter={isFolder ? (e) => handleFolderDragEnter(e, fullPath) : undefined}
					onDragOver={isFolder ? (e) => handleFolderDragOver(e, fullPath) : undefined}
					onDragLeave={isFolder ? handleFolderDragLeave : undefined}
					onDrop={isFolder ? (e) => handleFolderDrop(e, fullPath) : undefined}
					onMouseDown={(e) => {
						// Prevent focus from leaving the filter input when filtering
						if (fileTreeFilter.length > 0) {
							e.preventDefault();
						}
					}}
					onClick={(e) => {
						setSelectedFileIndex(globalIndex);
						if (fileTreeFilter.length > 0) {
							lastClickedUnderFilterRef.current = fullPath;
						}
						// Only change focus if not filtering
						if (fileTreeFilter.length === 0) {
							setActiveFocus('right');
						}
						if (isFolder) {
							if (e.altKey) {
								toggleFolderRecursive(fullPath, session.id, setSessions);
							} else {
								toggleFolder(fullPath, session.id, setSessions);
							}
						}
					}}
					onDoubleClick={() => {
						if (isFolder) return;
						// Optional shortcut: HTML files can default to opening in the
						// Maestro browser instead of the preview. SSH skips this (file://
						// can't reach the remote host); the right-click menu still offers
						// both paths regardless of the setting.
						const isHtml = /\.html?$/i.test(node.name);
						if (htmlDoubleClickOpensInBrowser && isHtml && !sshRemoteId && onOpenBrowserTabAt) {
							const encodedPath = absolutePath
								.split('/')
								.map((seg) => encodeURIComponent(seg))
								.join('/');
							onOpenBrowserTabAt(`file://${encodedPath}`, { title: node.name });
							return;
						}
						handleFileClick(node, fullPath, session);
					}}
					onContextMenu={(e) => handleContextMenu(e, node, fullPath, globalIndex)}
				>
					{indentGuides}
					{isFolder &&
						(isExpanded ? (
							<ChevronDown className="w-3 h-3 flex-shrink-0" />
						) : (
							<ChevronRight className="w-3 h-3 flex-shrink-0" />
						))}
					<span className="flex-shrink-0">
						{isFolder
							? getExplorerFolderIcon(node.name, isExpanded, theme, fileExplorerIconTheme)
							: getExplorerFileIcon(
									node.name,
									theme,
									// Per #611 follow-up: don't tint the icon based on change
									// state — let the dot + filename color carry that signal so
									// the icon set stays visually consistent across themes.
									undefined,
									fileExplorerIconTheme,
									colorBlindMode
								)}
					</span>
					<span
						className={`truncate min-w-0 flex-1 ${changeType ? 'font-medium' : ''}`}
						title={node.name}
						style={changeColor ? { color: changeColor } : undefined}
					>
						{node.name}
					</span>
					{hasChange && (
						<span
							data-testid="git-change-indicator"
							data-change-type={changeType ?? 'descendant'}
							aria-label={changeType ? `${changeType} file` : 'contains changed files'}
							title={changeType ?? 'contains changed files'}
							className="flex-shrink-0 inline-block w-2 h-2 rounded-full"
							style={{
								backgroundColor: changeColor ?? theme.colors.textDim,
								opacity: changeType ? 1 : 0.55,
							}}
						/>
					)}
				</div>
			);
		},
		[
			session.fullPath,
			changeMap,
			changedAncestors,
			session.fileExplorerExpanded,
			session.id,
			session.activeFileTabId,
			session.filePreviewTabs,
			activeFocus,
			activeRightTab,
			selectedFileIndex,
			theme,
			toggleFolder,
			toggleFolderRecursive,
			setSessions,
			setSelectedFileIndex,
			setActiveFocus,
			handleFileClick,
			fileTreeFilter,
			fileExplorerIconTheme,
			colorBlindMode,
			handleContextMenu,
			htmlDoubleClickOpensInBrowser,
			onOpenBrowserTabAt,
			sshRemoteId,
			dragOverFolder,
			handleFolderDragEnter,
			handleFolderDragOver,
			handleFolderDragLeave,
			handleFolderDrop,
		]
	);

	// Swallow drag-enter/leave that propagate to the app-level overlay handler
	// while a Files-panel drag is moving WITHIN the panel itself. Otherwise the
	// drop overlay flashes on every row-to-row transition because each child
	// element fires dragenter/dragleave that bumps the app-level counter.
	// External (OS) file drags still bubble normally so the overlay shows when
	// the cursor is over the file panel during a Finder/Explorer drag.
	const handleInternalDragBubble = (e: React.DragEvent) => {
		if (e.dataTransfer.types.includes('application/x-maestro-file-path')) {
			e.stopPropagation();
		}
	};

	return (
		<div
			className="flex flex-col h-full relative"
			onDragEnter={handleInternalDragBubble}
			onDragLeave={handleInternalDragBubble}
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
				{/* Toolbar row — compact buttons */}
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
					{/* Open in file manager — local sessions only; SSH remote paths can't be opened locally. */}
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
					{/* Show/hide dotfiles — can be force-hidden via the dotfilesToggleHidden setting (corporate installs). */}
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
				{/* Path row — full width */}
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

			{/* File tree content - virtualized */}
			{session.fileTreeError ? (
				<div className="flex flex-col items-center justify-center gap-3 py-8">
					<div className="text-xs text-center px-4" style={{ color: theme.colors.error }}>
						{session.fileTreeError}
					</div>
					{/* Show retry countdown if scheduled */}
					{session.fileTreeRetryAt && session.fileTreeRetryAt > Date.now() ? (
						<RetryCountdown
							retryAt={session.fileTreeRetryAt}
							theme={theme}
							onRetryNow={() => {
								// Clear retry time and trigger immediate refresh
								setSessions((prev) =>
									prev.map((s) => (s.id === session.id ? { ...s, fileTreeRetryAt: undefined } : s))
								);
							}}
						/>
					) : (
						<>
							{/* Only show "Select New Directory" for terminal sessions, not agent sessions */}
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
							{/* For agent sessions, show a refresh button instead */}
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
					{/* Show loading progress when file tree is actively loading */}
					{session.fileTreeLoading &&
						(() => {
							// Reuse the same SSH detection as `sshRemoteId` above (line ~769)
							// — gating on `.enabled` here would diverge if a session has a
							// configured `remoteId` but `enabled === false`, or vice versa.
							const isRemote = !!sshRemoteId;
							return (
								<FileTreeLoadingProgress
									theme={theme}
									progress={session.fileTreeLoadingProgress}
									isRemote={isRemote}
									// Cancel only meaningful for SSH — local scans complete fast and the
									// button just causes confusion when the tree never appears to "stop".
									onCancel={
										isRemote && cancelFileTreeLoad
											? () => cancelFileTreeLoad(session.id)
											: undefined
									}
								/>
							);
						})()}
					{/* Truncation banner - scan hit the entry cap and stopped early. */}
					{!session.fileTreeLoading && session.fileTreeTruncated && (
						<FileTreeTruncatedBanner
							theme={theme}
							previousCap={session.fileTreeLoadedCap}
							isRefreshing={isRefreshing}
							onLoadMore={() => {
								const next = (session.fileTreeLoadedCap ?? 100_000) * 2;
								setIsRefreshing(true);
								refreshFileTree(session.id, { maxEntriesOverride: next }).finally(() => {
									setTimeout(() => setIsRefreshing(false), 500);
								});
							}}
							onLoadAll={() => {
								setIsRefreshing(true);
								refreshFileTree(session.id, {
									maxEntriesOverride: Number.POSITIVE_INFINITY,
								}).finally(() => {
									setTimeout(() => setIsRefreshing(false), 500);
								});
							}}
						/>
					)}
					{/* Show empty state when loading is complete but no files found */}
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
						<div
							ref={parentRef}
							data-file-list-scroll
							className="flex-1 overflow-auto"
							style={{ height: 'calc(100vh - 200px)' }}
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
									// Invoke as a plain function (not <TreeRow/>) so React doesn't see a
									// new component type identity each parent render — TreeRow is a
									// useCallback with a long dep list and would otherwise remount every
									// visible row on every render. The returned <div> carries its own key.
									return TreeRow({ item, virtualRow });
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

			{/* Auto-refresh overlay - rendered via portal */}
			{overlayOpen &&
				overlayPosition &&
				createPortal(
					<div
						className="fixed z-[100] rounded-lg shadow-xl border overflow-hidden"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
							minWidth: '200px',
							top: overlayPosition.top,
							left: overlayPosition.left,
							transform: 'translateX(-100%)',
						}}
						onMouseEnter={handleOverlayMouseEnter}
						onMouseLeave={handleOverlayMouseLeave}
					>
						{/* Header */}
						<div
							className="px-3 py-2 text-xs font-medium border-b"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						>
							Auto-refresh
						</div>

						{/* Options */}
						<div className="p-1">
							{AUTO_REFRESH_OPTIONS.map((option) => (
								<button
									key={option.value}
									onClick={() => handleIntervalSelect(option.value)}
									className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{
										color:
											autoRefreshInterval === option.value
												? theme.colors.accent
												: theme.colors.textMain,
										backgroundColor:
											autoRefreshInterval === option.value
												? `${theme.colors.accent}15`
												: 'transparent',
									}}
								>
									<span className="whitespace-nowrap">{option.label}</span>
									{autoRefreshInterval === option.value && (
										<Check className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									)}
								</button>
							))}

							{/* Disable option - only shown when auto-refresh is active */}
							{autoRefreshInterval > 0 && (
								<>
									<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
									<button
										onClick={() => handleIntervalSelect(0)}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textDim }}
									>
										Disable auto-refresh
									</button>
								</>
							)}
						</div>
					</div>,
					document.body
				)}

			{/* Status bar at bottom */}
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

			{/* File tree context menu - rendered via portal */}
			{contextMenu &&
				createPortal(
					<div
						ref={contextMenuRef}
						className="fixed z-[10000] rounded-lg shadow-xl border overflow-hidden"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
							minWidth: '180px',
							top: contextMenuPos.top,
							left: contextMenuPos.left,
							opacity: contextMenuPos.ready ? 1 : 0,
						}}
					>
						<div className="p-1">
							{/* New File option - for folders only, top of the menu */}
							{contextMenu.node.type === 'folder' && (
								<>
									<button
										onClick={handleOpenNewFile}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										<span>New File</span>
									</button>
									<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
								</>
							)}

							{/* Preview option - for files only */}
							{contextMenu.node.type === 'file' && (
								<button
									onClick={handlePreviewFile}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<FileText className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>Preview</span>
								</button>
							)}

							{/* Document Graph option - only for markdown files */}
							{contextMenu.node.type === 'file' &&
								(contextMenu.node.name.endsWith('.md') ||
									contextMenu.node.name.endsWith('.markdown')) &&
								onFocusFileInGraph && (
									<button
										onClick={handleFocusInGraph}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Target className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										<span>Document Graph</span>
									</button>
								)}

							{/* Open in Maestro Browser - HTML files only, not over SSH (file:// won't reach the remote) */}
							{contextMenu.node.type === 'file' &&
								(contextMenu.node.name.toLowerCase().endsWith('.html') ||
									contextMenu.node.name.toLowerCase().endsWith('.htm')) &&
								!sshRemoteId &&
								onOpenBrowserTabAt && (
									<button
										onClick={handleOpenInMaestroBrowser}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Globe className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										<span>Open in Maestro Browser</span>
									</button>
								)}

							{/* Open in Default App option - for files only, not available over SSH */}
							{contextMenu.node.type === 'file' && !sshRemoteId && (
								<button
									onClick={handleOpenInDefaultApp}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
									<span>Open in Default App</span>
								</button>
							)}

							{/* Divider after preview/graph options if any were shown */}
							{contextMenu.node.type === 'file' && (
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							)}

							{/* Copy Path option */}
							<button
								onClick={handleCopyPath}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								<span>Copy Path</span>
							</button>

							{/* Reveal in Finder / Explorer option — local-only, hidden over SSH */}
							{!sshRemoteId && (
								<button
									onClick={handleOpenInExplorer}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									<span>{getRevealLabel(window.maestro.platform)}</span>
								</button>
							)}

							{/* Divider before destructive actions */}
							<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

							{/* Rename option */}
							<button
								onClick={handleOpenRename}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
							>
								<Edit2 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								<span>Rename</span>
							</button>

							{/* Delete option */}
							<button
								onClick={handleOpenDelete}
								className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.error }}
							>
								<Trash2 className="w-3.5 h-3.5" />
								<span>Delete</span>
							</button>
						</div>
					</div>,
					document.body
				)}

			{/* Rename Modal */}
			{renameModal && (
				<RenameFileModal
					theme={theme}
					node={renameModal.node}
					value={renameValue}
					setValue={(v) => {
						setRenameValue(v);
						setRenameError(null);
					}}
					error={renameError}
					onClose={() => setRenameModal(null)}
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
					onClose={() => setDeleteModal(null)}
					onDelete={handleDelete}
				/>
			)}

			{/* New File Modal */}
			{newFileModal && (
				<NewFileModal
					theme={theme}
					parentFolderLabel={
						newFileModal.parentFolderPath
							? `"${newFileModal.parentFolderPath}"`
							: 'the project root'
					}
					value={newFileValue}
					setValue={(v) => {
						setNewFileValue(v);
						setNewFileError(null);
					}}
					error={newFileError}
					isCreating={isCreatingFile}
					onClose={() => setNewFileModal(null)}
					onCreate={handleCreateNewFile}
				/>
			)}

			{/* Move Name-Conflict Modal */}
			{moveConflict && (
				<MoveConflictModal
					theme={theme}
					sourceName={moveConflict.sourceName}
					destFolderLabel={
						moveConflict.destFolderRelativePath
							? `"${moveConflict.destFolderRelativePath}"`
							: 'the project root'
					}
					autoRenameTo={moveConflict.autoRenameName}
					isMoving={isMoving}
					onCancel={() => setMoveConflict(null)}
					onOverwrite={handleMoveOverwrite}
					onAutoRename={handleMoveAutoRename}
				/>
			)}
		</div>
	);
}

export const FileExplorerPanel = memo(FileExplorerPanelInner);
