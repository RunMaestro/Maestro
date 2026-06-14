import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileTreeFilter } from '../../../../../renderer/components/FileExplorerPanel/hooks/useFileTreeFilter';
import type { FlattenedNode } from '../../../../../renderer/components/FileExplorerPanel/types';

const mockRegisterLayer = vi.fn().mockReturnValue('layer-1');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

vi.mock('../../../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: { FILE_TREE_FILTER: 30 },
}));

const makeFlattened = (paths: string[]): FlattenedNode[] =>
	paths.map((path, i) => ({
		node: { name: path.split('/').pop()!, type: 'file' as const },
		path,
		depth: 0,
		globalIndex: i,
	}));

const defaultArgs = {
	fileTreeFilterOpen: false,
	setFileTreeFilterOpen: vi.fn(),
	setFileTreeFilter: vi.fn(),
	lastClickedUnderFilterRef: { current: null as string | null },
	setActiveFocus: vi.fn(),
	sessionId: 'sess-1',
	setSessions: vi.fn(),
	flattenedTree: makeFlattened(['src/index.ts', 'src/App.tsx']),
	setSelectedFileIndex: vi.fn(),
	fileTreeContainerRef: { current: { focus: vi.fn() } } as any,
	virtualizer: { scrollToIndex: vi.fn() },
};

describe('useFileTreeFilter', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterLayer.mockReturnValue('layer-1');
	});

	it('registers a layer when fileTreeFilterOpen becomes true', () => {
		renderHook(() => useFileTreeFilter({ ...defaultArgs, fileTreeFilterOpen: true }));
		expect(mockRegisterLayer).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'overlay', ariaLabel: 'File Tree Filter' })
		);
	});

	it('does not register a layer when fileTreeFilterOpen is false', () => {
		renderHook(() => useFileTreeFilter({ ...defaultArgs, fileTreeFilterOpen: false }));
		expect(mockRegisterLayer).not.toHaveBeenCalled();
	});

	it('unregisters the layer when fileTreeFilterOpen changes to false', () => {
		const { rerender } = renderHook(
			({ open }) => useFileTreeFilter({ ...defaultArgs, fileTreeFilterOpen: open }),
			{ initialProps: { open: true } }
		);
		rerender({ open: false });
		expect(mockUnregisterLayer).toHaveBeenCalledWith('layer-1');
	});

	it('calls updateLayerHandler when handleFilterEscape changes', () => {
		const { result } = renderHook(() =>
			useFileTreeFilter({ ...defaultArgs, fileTreeFilterOpen: true })
		);
		// updateLayerHandler should be called with the current handler
		expect(mockUpdateLayerHandler).toHaveBeenCalledWith(
			'layer-1',
			result.current.handleFilterEscape
		);
	});

	it('handleFilterEscape closes the filter and clears the query', () => {
		const setFileTreeFilterOpen = vi.fn();
		const setFileTreeFilter = vi.fn();
		const { result } = renderHook(() =>
			useFileTreeFilter({
				...defaultArgs,
				fileTreeFilterOpen: true,
				setFileTreeFilterOpen,
				setFileTreeFilter,
			})
		);
		act(() => {
			result.current.handleFilterEscape();
		});
		expect(setFileTreeFilterOpen).toHaveBeenCalledWith(false);
		expect(setFileTreeFilter).toHaveBeenCalledWith('');
	});

	it('handleFilterEscape expands ancestor folders of the last-clicked path', () => {
		const setSessions = vi.fn();
		const lastClickedUnderFilterRef = { current: 'src/components/App.tsx' };
		const { result } = renderHook(() =>
			useFileTreeFilter({
				...defaultArgs,
				fileTreeFilterOpen: true,
				setSessions,
				lastClickedUnderFilterRef,
			})
		);
		act(() => {
			result.current.handleFilterEscape();
		});
		expect(setSessions).toHaveBeenCalled();
		const updater = setSessions.mock.calls[0][0];
		const updated = updater([{ id: 'sess-1', fileExplorerExpanded: [] }]);
		expect(updated[0].fileExplorerExpanded).toContain('src');
		expect(updated[0].fileExplorerExpanded).toContain('src/components');
	});

	it('handleFilterEscape focuses the tree container', () => {
		const focusMock = vi.fn();
		const { result } = renderHook(() =>
			useFileTreeFilter({
				...defaultArgs,
				fileTreeFilterOpen: true,
				fileTreeContainerRef: { current: { focus: focusMock } } as any,
			})
		);
		act(() => {
			result.current.handleFilterEscape();
		});
		expect(focusMock).toHaveBeenCalled();
	});

	it('does not call setSessions when no path was clicked under filter', () => {
		const setSessions = vi.fn();
		const { result } = renderHook(() =>
			useFileTreeFilter({
				...defaultArgs,
				fileTreeFilterOpen: true,
				setSessions,
				lastClickedUnderFilterRef: { current: null },
			})
		);
		act(() => {
			result.current.handleFilterEscape();
		});
		expect(setSessions).not.toHaveBeenCalled();
	});
});
