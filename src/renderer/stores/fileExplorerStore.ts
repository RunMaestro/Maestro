/**
 * fileExplorerStore - Zustand store for file explorer UI state
 *
 * Consolidates file explorer state previously scattered across:
 * - uiStore (selectedFileIndex, fileTreeFilter, fileTreeFilterOpen)
 * - App.tsx useState (filePreviewLoading, flatFileList, graph view state)
 *
 * Per-session file tree DATA (fileTree, fileExplorerExpanded, etc.) stays
 * in sessionStore — deeply embedded in the Session type with 200+ call sites.
 *
 * Can be used outside React via getFileExplorerState() / getFileExplorerActions().
 */

import { create } from 'zustand';
import type { FlatTreeNode } from '../utils/fileExplorer';

// ============================================================================
// Types
// ============================================================================

export interface FilePreviewLoading {
	name: string;
	path: string;
}

export interface FileExplorerStoreState {
	// File tree UI (migrated from uiStore)
	selectedFileIndex: number;
	fileTreeFilter: string;
	fileTreeFilterOpen: boolean;

	// File preview loading indicator (migrated from App.tsx)
	filePreviewLoading: FilePreviewLoading | null;

	// Flattened file list for keyboard navigation (migrated from App.tsx)
	flatFileList: FlatTreeNode[];

	// Document Graph view state (migrated from App.tsx)
	isGraphViewOpen: boolean;
	graphFocusFilePath: string | undefined;
	lastGraphFocusFilePath: string | undefined;
}

export interface FileExplorerStoreActions {
	// File tree UI
	setSelectedFileIndex: (index: number | ((prev: number) => number)) => void;
	setFileTreeFilter: (filter: string | ((prev: string) => string)) => void;
	setFileTreeFilterOpen: (open: boolean | ((prev: boolean) => boolean)) => void;

	// File preview loading
	setFilePreviewLoading: (loading: FilePreviewLoading | null) => void;

	// Flat file list
	setFlatFileList: (list: FlatTreeNode[]) => void;

	// Document Graph
	/** Open graph focused on a file. Atomically sets focus path, last path, and opens view. */
	focusFileInGraph: (relativePath: string) => void;
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
	filePreviewLoading: null,
	flatFileList: [],
	isGraphViewOpen: false,
	graphFocusFilePath: undefined,
	lastGraphFocusFilePath: undefined,

	// --- Actions ---
	setSelectedFileIndex: (v) => set((s) => ({ selectedFileIndex: resolve(v, s.selectedFileIndex) })),
	setFileTreeFilter: (v) => set((s) => ({ fileTreeFilter: resolve(v, s.fileTreeFilter) })),
	setFileTreeFilterOpen: (v) =>
		set((s) => ({ fileTreeFilterOpen: resolve(v, s.fileTreeFilterOpen) })),

	setFilePreviewLoading: (loading) => set({ filePreviewLoading: loading }),

	setFlatFileList: (list) => set({ flatFileList: list }),

	focusFileInGraph: (relativePath) =>
		set({
			graphFocusFilePath: relativePath,
			lastGraphFocusFilePath: relativePath,
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
		}),

	setIsGraphViewOpen: (open) => set({ isGraphViewOpen: open }),
}));

// ============================================================================
// Non-React access
// ============================================================================

/**
 * Get current file explorer state snapshot.
 * Use outside React (services, orchestrators, IPC handlers).
 */
export function getFileExplorerState() {
	return useFileExplorerStore.getState();
}

/**
 * Get stable file explorer action references outside React.
 */
export function getFileExplorerActions() {
	const state = useFileExplorerStore.getState();
	return {
		setSelectedFileIndex: state.setSelectedFileIndex,
		setFileTreeFilter: state.setFileTreeFilter,
		setFileTreeFilterOpen: state.setFileTreeFilterOpen,
		setFilePreviewLoading: state.setFilePreviewLoading,
		setFlatFileList: state.setFlatFileList,
		focusFileInGraph: state.focusFileInGraph,
		openLastDocumentGraph: state.openLastDocumentGraph,
		closeGraphView: state.closeGraphView,
		setIsGraphViewOpen: state.setIsGraphViewOpen,
	};
}
