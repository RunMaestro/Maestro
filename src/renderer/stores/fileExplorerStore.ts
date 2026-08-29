/**
 * fileExplorerStore - Zustand store for file explorer UI state
 *
 * Consolidates file explorer state previously scattered across:
 * - uiStore (selectedFileIndex, fileTreeFilter, fileTreeFilterOpen)
 * - App.tsx useState (flatFileList, graph view state)
 *
 * Per-session file tree DATA (fileTree, fileExplorerExpanded, etc.) stays
 * in sessionStore - deeply embedded in the Session type with 200+ call sites.
 *
 * Can be used outside React via useFileExplorerStore.getState().
 */

import { create } from 'zustand';
import type { FlatTreeNode } from '../utils/fileExplorer';
import type { FileNode } from '../types/fileTree';

// ============================================================================
// Types
// ============================================================================

export interface FileExplorerStoreState {
	// File tree UI (migrated from uiStore)
	selectedFileIndex: number;
	fileTreeFilter: string;
	fileTreeFilterOpen: boolean;

	// Multi-selection (Cmd/Shift+click and Shift+Arrow keyboard range select).
	// `selectedPaths` holds the *explicitly* selected relative paths; when empty,
	// the row at `selectedFileIndex` is the implicit single selection. Lives here
	// (not local panel state) so the window-level keyboard handler in
	// useFileExplorerEffects and the mouse handlers in the panel share one anchor.
	selectedPaths: Set<string>;
	/** Anchor row for range selection. -1 = no active anchor (fall back to selectedFileIndex). */
	selectionAnchorIndex: number;

	// Filtered file tree (tree-structured, for FileExplorerPanel rendering)
	filteredFileTree: FileNode[];

	// Flattened file list for keyboard navigation (migrated from App.tsx)
	flatFileList: FlatTreeNode[];

	// Document Graph view state (migrated from App.tsx)
	isGraphViewOpen: boolean;
	graphFocusFilePath: string | undefined;
	lastGraphFocusFilePath: string | undefined;
	/**
	 * Explicit file set the graph is scoped to, or undefined for the ordinary
	 * focus-rooted graph. Set by "Open N in Document Graph" on a multi-selection.
	 */
	graphScopeFiles: string[] | undefined;
	/**
	 * Directory the graph is scoped to, or undefined. Set by "Open in Document
	 * Graph" on a folder. `''` is a legitimate value meaning the project root,
	 * so this is checked with `!== undefined`, never for truthiness.
	 */
	graphScopeDirectory: string | undefined;
	/**
	 * Directory the graph resolves its paths against, overriding the agent's
	 * project root.
	 *
	 * Needed because not every graphable set lives under the project. Claude's
	 * per-project memory sits in `~/.claude/projects/<encoded>/memory/`, so
	 * rooting at the agent's cwd would resolve every scoped path to nothing.
	 */
	graphRootPath: string | undefined;
}

export interface FileExplorerStoreActions {
	// File tree UI
	setSelectedFileIndex: (index: number | ((prev: number) => number)) => void;
	setFileTreeFilter: (filter: string | ((prev: string) => string)) => void;
	setFileTreeFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// Multi-selection
	setSelectedPaths: (paths: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
	setSelectionAnchorIndex: (index: number) => void;

	// File tree data
	setFilteredFileTree: (tree: FileNode[]) => void;
	setFlatFileList: (list: FlatTreeNode[]) => void;

	// Document Graph
	/** Open graph focused on a file. Atomically sets focus path, last path, and opens view. */
	focusFileInGraph: (relativePath: string) => void;
	/**
	 * Open the graph over an explicit set of files, or over a directory.
	 *
	 * Distinct from `focusFileInGraph`, which walks outward from one document
	 * and can only ever show what that document reaches. A scope shows exactly
	 * the files asked for, including the ones that link to nothing - which is
	 * the only way an unlinked document is visible at all.
	 *
	 * `focusPath` is the file to center on when the user right-clicked a
	 * specific row inside the selection; omit it to let the builder center on
	 * the most-connected file.
	 */
	openGraphScope: (scope: {
		files?: string[];
		directory?: string;
		focusPath?: string;
		/** Root to resolve against, when the set lives outside the project. */
		rootPath?: string;
	}) => void;
	/** Re-open the last document graph. No-op if no previous path exists. */
	openLastDocumentGraph: () => void;
	/** Close the graph view. Preserves lastGraphFocusFilePath for re-open. */
	closeGraphView: () => void;
	/** Direct setter for isGraphViewOpen (for inline callbacks with side-effects). */
	setIsGraphViewOpen: (open: boolean) => void;
}

export type FileExplorerStore = FileExplorerStoreState & FileExplorerStoreActions;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve a value-or-updater argument, matching React's setState signature.
 */
function resolve<T>(valOrFn: T | ((prev: T) => T), prev: T): T {
	return typeof valOrFn === 'function' ? (valOrFn as (prev: T) => T)(prev) : valOrFn;
}

// ============================================================================
// Store
// ============================================================================

export const useFileExplorerStore = create<FileExplorerStore>()((set, get) => ({
	// --- State ---
	selectedFileIndex: 0,
	fileTreeFilter: '',
	fileTreeFilterOpen: false,
	selectedPaths: new Set(),
	selectionAnchorIndex: -1,
	filteredFileTree: [],
	flatFileList: [],
	isGraphViewOpen: false,
	graphFocusFilePath: undefined,
	lastGraphFocusFilePath: undefined,
	graphScopeFiles: undefined,
	graphScopeDirectory: undefined,
	graphRootPath: undefined,

	// --- Actions ---
	setSelectedFileIndex: (v) => set((s) => ({ selectedFileIndex: resolve(v, s.selectedFileIndex) })),
	setFileTreeFilter: (v) => set((s) => ({ fileTreeFilter: resolve(v, s.fileTreeFilter) })),
	setFileTreeFilterOpen: (v) =>
		set((s) => ({ fileTreeFilterOpen: resolve(v, s.fileTreeFilterOpen) })),

	setSelectedPaths: (v) => set((s) => ({ selectedPaths: resolve(v, s.selectedPaths) })),
	setSelectionAnchorIndex: (index) => set({ selectionAnchorIndex: index }),

	setFilteredFileTree: (tree) => set({ filteredFileTree: tree }),
	setFlatFileList: (list) => set({ flatFileList: list }),

	focusFileInGraph: (relativePath) =>
		set({
			graphFocusFilePath: relativePath,
			lastGraphFocusFilePath: relativePath,
			isGraphViewOpen: true,
			// Clear any previous scope: this is the focus-rooted graph, and a
			// leftover scope would silently narrow it.
			graphScopeFiles: undefined,
			graphScopeDirectory: undefined,
			graphRootPath: undefined,
		}),

	openGraphScope: ({ files, directory, focusPath, rootPath }) =>
		set({
			// The builder auto-centers when this is empty. `lastGraphFocusFilePath`
			// is deliberately not written here - "re-open the last graph" means the
			// last focused document, and a scope is not one.
			graphFocusFilePath: focusPath ?? '',
			graphScopeFiles: files,
			graphScopeDirectory: directory,
			graphRootPath: rootPath,
			isGraphViewOpen: true,
		}),

	openLastDocumentGraph: () => {
		const { lastGraphFocusFilePath } = get();
		if (lastGraphFocusFilePath) {
			set({
				graphFocusFilePath: lastGraphFocusFilePath,
				isGraphViewOpen: true,
			});
		}
	},

	closeGraphView: () =>
		set({
			isGraphViewOpen: false,
			graphFocusFilePath: undefined,
			graphScopeFiles: undefined,
			graphScopeDirectory: undefined,
			graphRootPath: undefined,
		}),

	setIsGraphViewOpen: (open) => set({ isGraphViewOpen: open }),
}));
