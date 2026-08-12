import type React from 'react';
import type { Session, Theme, FocusArea } from '../../types';
import type { FileNode } from '../../types/fileTree';
import type { FileTreeChanges } from '../../utils/fileExplorer';
import type { FileExplorerIconTheme } from '../../utils/fileExplorerIcons/shared';

/** MIME type for dragging multiple file-tree rows as a JSON array of relative paths. */
export const FILE_TREE_MULTI_MIME = 'application/x-maestro-file-paths';
/** MIME type for dragging a single file-tree row as a relative path. */
export const FILE_TREE_SINGLE_MIME = 'application/x-maestro-file-path';

/**
 * Above this many files, "Preview All Files in Folder" asks for confirmation
 * first so a deep folder doesn't silently flood the tab bar with hundreds of tabs.
 */
export const PREVIEW_ALL_CONFIRM_THRESHOLD = 25;

// Auto-refresh interval options in seconds
export const AUTO_REFRESH_OPTIONS = [
	{ label: 'Every 5 seconds', value: 5 },
	{ label: 'Every 20 seconds', value: 20 },
	{ label: 'Every 60 seconds', value: 60 },
	{ label: 'Every 3 minutes', value: 180 },
];

/** Flattened node for virtualization - one entry per visible tree row. */
export interface FlattenedNode {
	node: FileNode;
	path: string;
	depth: number;
	globalIndex: number;
}

/**
 * One file/folder slated to be moved in a drag-drop batch. Pre-computed during
 * drop validation so the modal and the executor can share a single plan.
 */
export interface PendingMove {
	sourceName: string;
	sourceRelativePath: string;
	sourceAbsolutePath: string;
	destAbsolutePath: string;
	autoRenameName: string;
	autoRenameAbsolutePath: string;
}

export interface MoveConflictState {
	destFolderRelativePath: string;
	destFolderAbsolutePath: string;
	conflicts: PendingMove[];
	nonConflicting: PendingMove[];
	/**
	 * Whether the pending transfer moves rows within the tree (`move`, the
	 * default) or copies OS files dragged in from Finder/Explorer (`copy`). Only
	 * affects the conflict modal's verbs and the executor's filesystem call.
	 */
	operation: 'move' | 'copy';
}

export interface RenameModalState {
	node: FileNode;
	path: string;
	absolutePath: string;
}

export interface DeleteModalState {
	node: FileNode;
	path: string;
	absolutePath: string;
	itemCount?: { fileCount: number; folderCount: number };
}

export interface MultiDeleteModalState {
	nodes: { node: FileNode; path: string }[];
}

export interface NewFileModalState {
	kind: 'file' | 'folder';
	parentFolderPath: string;
	parentFolderAbsolutePath: string;
}

export interface ContextMenuState {
	x: number;
	y: number;
	/**
	 * The file/folder row under the cursor, or `null` for the empty-space menu
	 * (right-clicking the blank area of the panel or an empty workspace). The
	 * root menu only offers "New Folder", targeting the workspace root.
	 */
	node: FileNode | null;
	path: string;
}

export interface FileExplorerPanelProps {
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
	/** Cancel the in-flight file tree load - useful when SSH scans monopolize connections. */
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
