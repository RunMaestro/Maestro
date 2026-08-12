import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileOperations } from '../../../../../renderer/components/FileExplorerPanel/hooks/useFileOperations';
import type { FileNode } from '../../../../../renderer/types/fileTree';

vi.mock('../../../../../renderer/utils/fileExplorer', () => ({
	removeNodeFromTree: vi.fn((tree: any) => tree),
	renameNodeInTree: vi.fn((tree: any) => tree),
	findNodeInTree: vi.fn(() => null),
	countNodesInTree: vi.fn(() => ({ fileCount: 0, folderCount: 0 })),
}));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const fileNode: FileNode = { name: 'App.tsx', type: 'file' };
const folderNode: FileNode = {
	name: 'components',
	type: 'folder',
	children: [{ name: 'Button.tsx', type: 'file' }],
};

const session = {
	id: 'sess-1',
	fullPath: '/project',
	fileTree: [folderNode, fileNode] as FileNode[],
} as any;

const defaultArgs = {
	session,
	sshRemoteId: undefined,
	setSessions: vi.fn(),
	refreshFileTree: vi.fn().mockResolvedValue(undefined),
	expandFolder: vi.fn(),
	onShowFlash: vi.fn(),
};

// Mock window.maestro
const mockMaestro = {
	fs: {
		rename: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		mkdir: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		countItems: vi.fn().mockResolvedValue({ fileCount: 2, folderCount: 1 }),
	},
};
(window as any).maestro = mockMaestro;

describe('useFileOperations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ─── rename ──────────────────────────────────────────────────────────────

	it('opens rename modal with node name pre-filled', () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openRenameModal(fileNode, 'App.tsx');
		});
		expect(result.current.renameModal?.node).toBe(fileNode);
		expect(result.current.renameValue).toBe('App.tsx');
	});

	it('handleRename closes modal when new name equals the old name', async () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openRenameModal(fileNode, 'App.tsx');
		});
		// Same name - no-op
		await act(async () => {
			await result.current.handleRename();
		});
		expect(result.current.renameModal).toBeNull();
		expect(mockMaestro.fs.rename).not.toHaveBeenCalled();
	});

	it('handleRename sets error when name contains a slash', async () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openRenameModal(fileNode, 'App.tsx');
			result.current.setRenameValue('foo/bar.tsx');
		});
		await act(async () => {
			await result.current.handleRename();
		});
		expect(result.current.renameError).toContain('slashes');
	});

	it('handleRename calls fs.rename and flashes on success', async () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() => useFileOperations({ ...defaultArgs, onShowFlash }));
		act(() => {
			result.current.openRenameModal(fileNode, 'App.tsx');
			result.current.setRenameValue('App2.tsx');
		});
		await act(async () => {
			await result.current.handleRename();
		});
		expect(mockMaestro.fs.rename).toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenCalledWith('Renamed to "App2.tsx"');
	});

	it('handleRename updates expanded-path set when renaming a folder', async () => {
		const setSessions = vi.fn();
		const { result } = renderHook(() => useFileOperations({ ...defaultArgs, setSessions }));
		act(() => {
			result.current.openRenameModal(folderNode, 'components');
			result.current.setRenameValue('ui');
		});
		await act(async () => {
			await result.current.handleRename();
		});
		const updater = setSessions.mock.calls[0][0];
		const updated = updater([
			{ id: 'sess-1', fileExplorerExpanded: ['components', 'components/subdir'] },
		]);
		expect(updated[0].fileExplorerExpanded).toContain('ui');
		expect(updated[0].fileExplorerExpanded).toContain('ui/subdir');
		expect(updated[0].fileExplorerExpanded).not.toContain('components');
	});

	// ─── create new file ──────────────────────────────────────────────────────

	it('opens new file modal with the given parent folder path', () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openNewFileModal('components', '/project/components');
		});
		expect(result.current.newFileModal?.parentFolderPath).toBe('components');
	});

	it('handleCreateNewFile sets error when name contains a slash', async () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openNewFileModal('components', '/project/components');
			result.current.setNewFileValue('sub/file.ts');
		});
		await act(async () => {
			await result.current.handleCreateNewFile();
		});
		expect(result.current.newFileError).toContain('slashes');
	});

	it('handleCreateNewFile detects duplicate names in the parent folder', async () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openNewFileModal('components', '/project/components');
			result.current.setNewFileValue('Button.tsx'); // already in folderNode.children
		});
		await act(async () => {
			await result.current.handleCreateNewFile();
		});
		expect(result.current.newFileError).toContain('already exists');
		expect(mockMaestro.fs.writeFile).not.toHaveBeenCalled();
	});

	it('handleCreateNewFile calls writeFile, refresh, expandFolder and flashes', async () => {
		const expandFolder = vi.fn();
		const onShowFlash = vi.fn();
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() =>
			useFileOperations({ ...defaultArgs, expandFolder, onShowFlash, refreshFileTree })
		);
		act(() => {
			result.current.openNewFileModal('components', '/project/components');
			result.current.setNewFileValue('NewComp.tsx');
		});
		await act(async () => {
			await result.current.handleCreateNewFile();
		});
		expect(mockMaestro.fs.writeFile).toHaveBeenCalled();
		expect(refreshFileTree).toHaveBeenCalledWith('sess-1');
		expect(expandFolder).toHaveBeenCalledWith('components');
		expect(onShowFlash).toHaveBeenCalledWith('Created "NewComp.tsx"');
	});

	it('handleCreateNewFile calls mkdir (not writeFile) when opened as a folder', async () => {
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useFileOperations({ ...defaultArgs, refreshFileTree }));
		act(() => {
			result.current.openNewFolderModal('components', '/project/components');
			result.current.setNewFileValue('NewDir');
		});
		await act(async () => {
			await result.current.handleCreateNewFile();
		});
		expect(mockMaestro.fs.mkdir).toHaveBeenCalledWith('/project/components/NewDir', undefined);
		expect(mockMaestro.fs.writeFile).not.toHaveBeenCalled();
	});

	// ─── delete ───────────────────────────────────────────────────────────────

	it('openDeleteModal counts items for a folder', async () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		await act(async () => {
			await result.current.openDeleteModal(folderNode, 'components');
		});
		expect(mockMaestro.fs.countItems).toHaveBeenCalled();
		expect(result.current.deleteModal?.itemCount).toEqual({ fileCount: 2, folderCount: 1 });
	});

	it('handleDelete calls fs.delete and flashes on success', async () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() => useFileOperations({ ...defaultArgs, onShowFlash }));
		await act(async () => {
			await result.current.openDeleteModal(fileNode, 'App.tsx');
		});
		await act(async () => {
			await result.current.handleDelete();
		});
		expect(mockMaestro.fs.delete).toHaveBeenCalled();
		expect(onShowFlash).toHaveBeenCalledWith('Deleted "App.tsx"');
		expect(result.current.deleteModal).toBeNull();
	});

	it('setRenameValue clears renameError', () => {
		const { result } = renderHook(() => useFileOperations(defaultArgs));
		act(() => {
			result.current.openRenameModal(fileNode, 'App.tsx');
			result.current.setRenameValue('foo/bar');
		});
		expect(result.current.renameError).not.toBeNull();
		act(() => {
			result.current.setRenameValue('valid.tsx');
		});
		expect(result.current.renameError).toBeNull();
	});
});
