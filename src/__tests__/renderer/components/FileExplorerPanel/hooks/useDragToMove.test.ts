import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDragToMove } from '../../../../../renderer/components/FileExplorerPanel/hooks/useDragToMove';
import type { FileNode } from '../../../../../renderer/types/fileTree';
import { captureException } from '../../../../../renderer/utils/sentry';

vi.mock('../../../../../renderer/utils/logger', () => ({
	logger: { warn: vi.fn() },
}));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const destFolder: FileNode = {
	name: 'dest',
	type: 'folder',
	children: [{ name: 'existing.ts', type: 'file' }],
};

const session = {
	id: 'sess-1',
	fullPath: '/project',
	fileTree: [
		{ name: 'src', type: 'folder', children: [{ name: 'a.ts', type: 'file' }] },
		destFolder,
	] as FileNode[],
} as any;

const mockMaestro = {
	fs: {
		rename: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	},
};
(window as any).maestro = mockMaestro;

const defaultArgs = {
	session,
	sshRemoteId: undefined,
	refreshFileTree: vi.fn().mockResolvedValue(undefined),
	expandFolder: vi.fn(),
	onShowFlash: vi.fn(),
	setSelectedPaths: vi.fn(),
};

function makeDragEvent(types: string[], data: Record<string, string> = {}): React.DragEvent {
	return {
		dataTransfer: {
			types,
			getData: (key: string) => data[key] ?? '',
			dropEffect: 'none',
		},
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		relatedTarget: null,
		currentTarget: null,
	} as unknown as React.DragEvent;
}

const SINGLE = 'application/x-maestro-file-path';
const MULTI = 'application/x-maestro-file-paths';

describe('useDragToMove', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('initialises with no drag state', () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		expect(result.current.dragOverFolder).toBeNull();
		expect(result.current.moveConflict).toBeNull();
		expect(result.current.isMoving).toBe(false);
	});

	it('handleFolderDragEnter sets dragOverFolder for maestro drags', () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		const e = makeDragEvent([SINGLE]);
		act(() => {
			result.current.handleFolderDragEnter(e, 'dest');
		});
		expect(result.current.dragOverFolder).toBe('dest');
	});

	it('handleFolderDragLeave clears dragOverFolder when not entering a child', () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		const enterE = makeDragEvent([SINGLE]);
		act(() => {
			result.current.handleFolderDragEnter(enterE, 'dest');
		});
		const leaveE = makeDragEvent([SINGLE]);
		act(() => {
			result.current.handleFolderDragLeave(leaveE);
		});
		expect(result.current.dragOverFolder).toBeNull();
	});

	it('performMoves calls fs.rename and refreshes tree', async () => {
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useDragToMove({ ...defaultArgs, refreshFileTree }));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'a.ts',
						sourceAbsolutePath: '/project/src/a.ts',
						destAbsolutePath: '/project/dest/a.ts',
					},
				],
				'dest'
			);
		});
		expect(mockMaestro.fs.rename).toHaveBeenCalled();
		expect(refreshFileTree).toHaveBeenCalledWith('sess-1');
	});

	it('performMoves clears selectedPaths on success', async () => {
		const setSelectedPaths = vi.fn();
		const { result } = renderHook(() => useDragToMove({ ...defaultArgs, setSelectedPaths }));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'a.ts',
						sourceAbsolutePath: '/project/src/a.ts',
						destAbsolutePath: '/project/dest/a.ts',
					},
				],
				'dest'
			);
		});
		expect(setSelectedPaths).toHaveBeenCalledWith(new Set());
	});

	it('performMoves calls expandFolder on the destination', async () => {
		const expandFolder = vi.fn();
		const { result } = renderHook(() => useDragToMove({ ...defaultArgs, expandFolder }));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'a.ts',
						sourceAbsolutePath: '/project/src/a.ts',
						destAbsolutePath: '/project/dest/a.ts',
					},
				],
				'dest'
			);
		});
		expect(expandFolder).toHaveBeenCalledWith('dest');
	});

	it('performMoves flashes success message', async () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() => useDragToMove({ ...defaultArgs, onShowFlash }));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'a.ts',
						sourceAbsolutePath: '/project/src/a.ts',
						destAbsolutePath: '/project/dest/a.ts',
					},
				],
				'dest'
			);
		});
		expect(onShowFlash).toHaveBeenCalledWith('Moved "a.ts"');
	});

	it('performMoves flashes "Moved N items" for batch', async () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() => useDragToMove({ ...defaultArgs, onShowFlash }));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'a.ts',
						sourceAbsolutePath: '/project/src/a.ts',
						destAbsolutePath: '/project/dest/a.ts',
					},
					{
						sourceName: 'b.ts',
						sourceAbsolutePath: '/project/src/b.ts',
						destAbsolutePath: '/project/dest/b.ts',
					},
				],
				'dest'
			);
		});
		expect(onShowFlash).toHaveBeenCalledWith('Moved 2 items');
	});

	it('same-parent drop is a no-op in handleFolderDrop', async () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		const e = makeDragEvent([SINGLE], { [SINGLE]: 'dest/existing.ts' });
		act(() => {
			result.current.handleFolderDrop(e, 'dest');
		});
		// Should not call rename since source and dest are same parent
		expect(mockMaestro.fs.rename).not.toHaveBeenCalled();
	});

	it('self/descendant drop is a no-op in handleFolderDrop', async () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		const e = makeDragEvent([SINGLE], { [SINGLE]: 'dest' });
		act(() => {
			result.current.handleFolderDrop(e, 'dest');
		});
		expect(mockMaestro.fs.rename).not.toHaveBeenCalled();
	});

	it('conflict drops open the moveConflict modal', async () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		// Drop 'src/existing.ts' onto 'dest' where 'existing.ts' already exists
		const e = makeDragEvent([SINGLE], { [SINGLE]: 'src/existing.ts' });
		act(() => {
			result.current.handleFolderDrop(e, 'dest');
		});
		expect(result.current.moveConflict).not.toBeNull();
		expect(result.current.moveConflict?.conflicts[0].sourceName).toBe('existing.ts');
	});

	it('overwrite path calls fs.delete before fs.rename', async () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'existing.ts',
						sourceAbsolutePath: '/project/src/existing.ts',
						destAbsolutePath: '/project/dest/existing.ts',
						deleteDestFirst: true,
					},
				],
				'dest'
			);
		});
		expect(mockMaestro.fs.delete).toHaveBeenCalledBefore(mockMaestro.fs.rename as any);
	});

	it('pre-overwrite delete failure is swallowed and rename still proceeds', async () => {
		const deleteError = new Error('not found');
		mockMaestro.fs.delete.mockRejectedValueOnce(deleteError);
		const onShowFlash = vi.fn();
		const { result } = renderHook(() => useDragToMove({ ...defaultArgs, onShowFlash }));
		await act(async () => {
			await result.current.performMoves(
				[
					{
						sourceName: 'x.ts',
						sourceAbsolutePath: '/project/src/x.ts',
						destAbsolutePath: '/project/dest/x.ts',
						deleteDestFirst: true,
					},
				],
				'dest'
			);
		});
		expect(captureException).toHaveBeenCalledWith(
			deleteError,
			expect.objectContaining({
				extra: expect.objectContaining({
					sourceName: 'x.ts',
					destAbsolutePath: '/project/dest/x.ts',
					operation: 'move.preOverwriteDelete',
				}),
			})
		);
		expect(mockMaestro.fs.rename).toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenCalledWith('Moved "x.ts"');
	});

	it('multi-source MIME is parsed and all paths are moved', async () => {
		const { result } = renderHook(() => useDragToMove(defaultArgs));
		const paths = ['src/a.ts', 'src/b.ts'];
		const e = makeDragEvent([SINGLE, MULTI], {
			[SINGLE]: 'src/a.ts',
			[MULTI]: JSON.stringify(paths),
		});
		act(() => {
			result.current.handleFolderDrop(e, 'dest');
		});
		// Both files should be queued — rename called once after performMoves resolves
		await act(async () => {});
		expect(mockMaestro.fs.rename).toHaveBeenCalledTimes(2);
	});
});
