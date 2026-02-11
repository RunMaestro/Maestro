/**
 * Tests for fileExplorerStore — File explorer UI state management
 *
 * Tests file tree UI state, file preview loading, flat file list,
 * and document graph view state. Covers functional updaters,
 * atomic graph actions, and non-React access helpers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	useFileExplorerStore,
	getFileExplorerState,
	getFileExplorerActions,
} from '../../../renderer/stores/fileExplorerStore';
import type { FlatTreeNode } from '../../../renderer/utils/fileExplorer';

// ============================================================================
// Helpers
// ============================================================================

function createFlatTreeNode(overrides: Partial<FlatTreeNode> = {}): FlatTreeNode {
	return {
		name: overrides.name ?? 'file.ts',
		type: overrides.type ?? 'file',
		fullPath: overrides.fullPath ?? 'src/file.ts',
		isFolder: overrides.isFolder ?? false,
		...overrides,
	} as FlatTreeNode;
}

function resetStore() {
	useFileExplorerStore.setState({
		selectedFileIndex: 0,
		fileTreeFilter: '',
		fileTreeFilterOpen: false,
		filePreviewLoading: null,
		flatFileList: [],
		isGraphViewOpen: false,
		graphFocusFilePath: undefined,
		lastGraphFocusFilePath: undefined,
	});
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
	resetStore();
});

// ============================================================================
// Tests
// ============================================================================

describe('fileExplorerStore', () => {
	describe('initial state', () => {
		it('has correct default values', () => {
			const state = useFileExplorerStore.getState();
			expect(state.selectedFileIndex).toBe(0);
			expect(state.fileTreeFilter).toBe('');
			expect(state.fileTreeFilterOpen).toBe(false);
			expect(state.filePreviewLoading).toBeNull();
			expect(state.flatFileList).toEqual([]);
			expect(state.isGraphViewOpen).toBe(false);
			expect(state.graphFocusFilePath).toBeUndefined();
			expect(state.lastGraphFocusFilePath).toBeUndefined();
		});
	});

	describe('file tree UI state', () => {
		it('setSelectedFileIndex sets with value', () => {
			useFileExplorerStore.getState().setSelectedFileIndex(5);
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(5);
		});

		it('setSelectedFileIndex supports functional updater', () => {
			useFileExplorerStore.getState().setSelectedFileIndex(3);
			useFileExplorerStore.getState().setSelectedFileIndex((prev) => prev + 2);
			expect(useFileExplorerStore.getState().selectedFileIndex).toBe(5);
		});

		it('setFileTreeFilter sets with value', () => {
			useFileExplorerStore.getState().setFileTreeFilter('utils');
			expect(useFileExplorerStore.getState().fileTreeFilter).toBe('utils');
		});

		it('setFileTreeFilter supports functional updater', () => {
			useFileExplorerStore.getState().setFileTreeFilter('hel');
			useFileExplorerStore.getState().setFileTreeFilter((prev) => prev + 'lo');
			expect(useFileExplorerStore.getState().fileTreeFilter).toBe('hello');
		});

		it('setFileTreeFilterOpen sets with value', () => {
			useFileExplorerStore.getState().setFileTreeFilterOpen(true);
			expect(useFileExplorerStore.getState().fileTreeFilterOpen).toBe(true);
		});

		it('setFileTreeFilterOpen supports functional updater', () => {
			useFileExplorerStore.getState().setFileTreeFilterOpen(false);
			useFileExplorerStore.getState().setFileTreeFilterOpen((prev) => !prev);
			expect(useFileExplorerStore.getState().fileTreeFilterOpen).toBe(true);
		});
	});

	describe('file preview loading', () => {
		it('sets loading state with name and path', () => {
			useFileExplorerStore.getState().setFilePreviewLoading({
				name: 'index.ts',
				path: '/project/src/index.ts',
			});
			expect(useFileExplorerStore.getState().filePreviewLoading).toEqual({
				name: 'index.ts',
				path: '/project/src/index.ts',
			});
		});

		it('clears loading state with null', () => {
			useFileExplorerStore.getState().setFilePreviewLoading({
				name: 'file.ts',
				path: '/path/file.ts',
			});
			useFileExplorerStore.getState().setFilePreviewLoading(null);
			expect(useFileExplorerStore.getState().filePreviewLoading).toBeNull();
		});
	});

	describe('flat file list', () => {
		it('sets flat file list', () => {
			const nodes = [
				createFlatTreeNode({ name: 'src', isFolder: true, fullPath: 'src' }),
				createFlatTreeNode({ name: 'index.ts', fullPath: 'src/index.ts' }),
			];
			useFileExplorerStore.getState().setFlatFileList(nodes);
			expect(useFileExplorerStore.getState().flatFileList).toHaveLength(2);
			expect(useFileExplorerStore.getState().flatFileList[0].name).toBe('src');
		});

		it('clears flat file list with empty array', () => {
			useFileExplorerStore.getState().setFlatFileList([createFlatTreeNode()]);
			useFileExplorerStore.getState().setFlatFileList([]);
			expect(useFileExplorerStore.getState().flatFileList).toEqual([]);
		});
	});

	describe('document graph actions', () => {
		it('focusFileInGraph atomically sets all three fields', () => {
			useFileExplorerStore.getState().focusFileInGraph('src/utils/helpers.ts');

			const state = useFileExplorerStore.getState();
			expect(state.graphFocusFilePath).toBe('src/utils/helpers.ts');
			expect(state.lastGraphFocusFilePath).toBe('src/utils/helpers.ts');
			expect(state.isGraphViewOpen).toBe(true);
		});

		it('focusFileInGraph overwrites previous focus path', () => {
			useFileExplorerStore.getState().focusFileInGraph('first.ts');
			useFileExplorerStore.getState().focusFileInGraph('second.ts');

			const state = useFileExplorerStore.getState();
			expect(state.graphFocusFilePath).toBe('second.ts');
			expect(state.lastGraphFocusFilePath).toBe('second.ts');
		});

		it('focusFileInGraph works after closeGraphView', () => {
			useFileExplorerStore.getState().focusFileInGraph('first.ts');
			useFileExplorerStore.getState().closeGraphView();
			useFileExplorerStore.getState().focusFileInGraph('second.ts');

			const state = useFileExplorerStore.getState();
			expect(state.graphFocusFilePath).toBe('second.ts');
			expect(state.isGraphViewOpen).toBe(true);
		});

		it('openLastDocumentGraph opens with last path', () => {
			useFileExplorerStore.getState().focusFileInGraph('src/App.tsx');
			useFileExplorerStore.getState().closeGraphView();

			// Re-open with last path
			useFileExplorerStore.getState().openLastDocumentGraph();

			const state = useFileExplorerStore.getState();
			expect(state.graphFocusFilePath).toBe('src/App.tsx');
			expect(state.isGraphViewOpen).toBe(true);
			expect(state.lastGraphFocusFilePath).toBe('src/App.tsx');
		});

		it('openLastDocumentGraph is no-op when no previous path', () => {
			useFileExplorerStore.getState().openLastDocumentGraph();

			const state = useFileExplorerStore.getState();
			expect(state.isGraphViewOpen).toBe(false);
			expect(state.graphFocusFilePath).toBeUndefined();
		});

		it('closeGraphView clears isGraphViewOpen and graphFocusFilePath', () => {
			useFileExplorerStore.getState().focusFileInGraph('file.ts');
			useFileExplorerStore.getState().closeGraphView();

			const state = useFileExplorerStore.getState();
			expect(state.isGraphViewOpen).toBe(false);
			expect(state.graphFocusFilePath).toBeUndefined();
		});

		it('closeGraphView preserves lastGraphFocusFilePath', () => {
			useFileExplorerStore.getState().focusFileInGraph('important.ts');
			useFileExplorerStore.getState().closeGraphView();

			expect(useFileExplorerStore.getState().lastGraphFocusFilePath).toBe('important.ts');
		});

		it('setIsGraphViewOpen directly sets the boolean', () => {
			useFileExplorerStore.getState().setIsGraphViewOpen(true);
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(true);

			useFileExplorerStore.getState().setIsGraphViewOpen(false);
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
		});

		it('full lifecycle: focus → close → reopen last', () => {
			// Focus on a file
			useFileExplorerStore.getState().focusFileInGraph('src/main.ts');
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(true);

			// Close the view
			useFileExplorerStore.getState().closeGraphView();
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(false);
			expect(useFileExplorerStore.getState().graphFocusFilePath).toBeUndefined();

			// Re-open last
			useFileExplorerStore.getState().openLastDocumentGraph();
			expect(useFileExplorerStore.getState().isGraphViewOpen).toBe(true);
			expect(useFileExplorerStore.getState().graphFocusFilePath).toBe('src/main.ts');
		});

		it('multiple files: focus A → focus B → close → open last gets B', () => {
			useFileExplorerStore.getState().focusFileInGraph('a.ts');
			useFileExplorerStore.getState().focusFileInGraph('b.ts');
			useFileExplorerStore.getState().closeGraphView();
			useFileExplorerStore.getState().openLastDocumentGraph();

			expect(useFileExplorerStore.getState().graphFocusFilePath).toBe('b.ts');
		});
	});

	describe('non-React access', () => {
		it('getFileExplorerState returns current state', () => {
			useFileExplorerStore.getState().setFileTreeFilter('search');
			const state = getFileExplorerState();
			expect(state.fileTreeFilter).toBe('search');
		});

		it('getFileExplorerActions returns action functions', () => {
			const actions = getFileExplorerActions();
			expect(typeof actions.setSelectedFileIndex).toBe('function');
			expect(typeof actions.setFileTreeFilter).toBe('function');
			expect(typeof actions.setFileTreeFilterOpen).toBe('function');
			expect(typeof actions.setFilePreviewLoading).toBe('function');
			expect(typeof actions.setFlatFileList).toBe('function');
			expect(typeof actions.focusFileInGraph).toBe('function');
			expect(typeof actions.openLastDocumentGraph).toBe('function');
			expect(typeof actions.closeGraphView).toBe('function');
			expect(typeof actions.setIsGraphViewOpen).toBe('function');
		});

		it('actions from getFileExplorerActions update state', () => {
			const actions = getFileExplorerActions();
			actions.setSelectedFileIndex(10);
			actions.setFileTreeFilter('test');
			actions.focusFileInGraph('via-actions.ts');

			const state = getFileExplorerState();
			expect(state.selectedFileIndex).toBe(10);
			expect(state.fileTreeFilter).toBe('test');
			expect(state.graphFocusFilePath).toBe('via-actions.ts');
			expect(state.isGraphViewOpen).toBe(true);
		});
	});

	describe('store reset', () => {
		it('resets all state to defaults', () => {
			// Set non-default values
			const store = useFileExplorerStore.getState();
			store.setSelectedFileIndex(99);
			store.setFileTreeFilter('search');
			store.setFileTreeFilterOpen(true);
			store.setFilePreviewLoading({ name: 'f', path: '/f' });
			store.setFlatFileList([createFlatTreeNode()]);
			store.focusFileInGraph('some/path.ts');

			// Reset
			resetStore();

			const state = useFileExplorerStore.getState();
			expect(state.selectedFileIndex).toBe(0);
			expect(state.fileTreeFilter).toBe('');
			expect(state.fileTreeFilterOpen).toBe(false);
			expect(state.filePreviewLoading).toBeNull();
			expect(state.flatFileList).toEqual([]);
			expect(state.isGraphViewOpen).toBe(false);
			expect(state.graphFocusFilePath).toBeUndefined();
			expect(state.lastGraphFocusFilePath).toBeUndefined();
		});
	});
});
