import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileContextMenu } from '../../../../../renderer/components/FileExplorerPanel/hooks/useFileContextMenu';
import type { FileNode } from '../../../../../renderer/types/fileTree';
import * as pathHelpers from '../../../../../renderer/components/FileExplorerPanel/utils/pathHelpers';
import * as modalStore from '../../../../../renderer/stores/modalStore';

vi.mock('../../../../../renderer/hooks/ui/useClickOutside', () => ({
	useClickOutside: vi.fn(),
}));

vi.mock('../../../../../renderer/hooks/ui/useContextMenuPosition', () => ({
	useContextMenuPosition: vi.fn(() => ({ top: 100, left: 200, ready: true })),
}));

vi.mock('../../../../../renderer/stores/modalStore', () => ({
	useModalStore: { getState: vi.fn(() => ({ openModal: vi.fn() })) },
}));

vi.mock('../../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: vi.fn(),
}));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

vi.mock('../../../../../renderer/components/FileExplorerPanel/utils/pathHelpers', () => ({
	collectPreviewableFiles: vi.fn(() => [
		{ node: { name: 'a.md', type: 'file' }, path: 'docs/a.md' },
	]),
	findNodeAtPath: vi.fn((tree: FileNode[] | undefined, relativePath: string) => {
		const parts = relativePath.split('/').filter(Boolean);
		let children = tree;
		let node: FileNode | undefined;
		for (const part of parts) {
			node = children?.find((child) => child.name === part);
			children = node?.children;
		}
		return node ?? null;
	}),
}));

const fileNode: FileNode = { name: 'App.tsx', type: 'file' };
const folderNode: FileNode = {
	name: 'docs',
	type: 'folder',
	children: [{ name: 'a.md', type: 'file' }],
};

const session = {
	id: 'sess-1',
	fullPath: '/project',
	fileTree: [
		fileNode,
		{ name: 'README.md', type: 'file' },
		{ name: 'diagram.pdf', type: 'file' },
		folderNode,
	],
} as any;
const theme = {} as any;

const defaultArgs = {
	session,
	theme,
	onShowFlash: vi.fn(),
	onFocusFileInGraph: vi.fn(),
	onOpenBrowserTabAt: vi.fn(),
	handleFileClick: vi.fn().mockResolvedValue(undefined),
	openRenameModal: vi.fn(),
	openDeleteModal: vi.fn().mockResolvedValue(undefined),
	openNewFileModal: vi.fn(),
	openNewFolderModal: vi.fn(),
	setSelectedFileIndex: vi.fn(),
	selectedPathsRef: { current: new Set<string>() },
	setSelectedPaths: vi.fn(),
	refreshFileTree: vi.fn().mockResolvedValue(undefined),
	sshRemoteId: undefined,
};

const mockMaestro = {
	shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
	fs: {
		delete: vi.fn().mockResolvedValue({ success: true }),
		downloadRemoteFile: vi.fn().mockResolvedValue({ success: true, path: '/local/App.tsx' }),
	},
	dialog: { saveFile: vi.fn().mockResolvedValue('/local/App.tsx') },
};
(window as any).maestro = mockMaestro;

describe('useFileContextMenu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('initialises with contextMenu = null', () => {
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		expect(result.current.contextMenu).toBeNull();
	});

	it('openContextMenu sets contextMenu state', () => {
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 100,
			clientY: 200,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 3);
		});
		expect(result.current.contextMenu?.path).toBe('App.tsx');
		expect(result.current.contextMenu?.node).toBe(fileNode);
	});

	it('openContextMenu calls setSelectedFileIndex', () => {
		const setSelectedFileIndex = vi.fn();
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, setSelectedFileIndex })
		);
		const e = {
			clientX: 50,
			clientY: 60,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 7);
		});
		expect(setSelectedFileIndex).toHaveBeenCalledWith(7);
	});

	it('openContextMenu clears multi-selection when right-clicking outside it', () => {
		const setSelectedPaths = vi.fn();
		const selectedPathsRef = { current: new Set(['README.md', 'docs/a.md']) };
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, selectedPathsRef, setSelectedPaths })
		);
		const e = {
			clientX: 50,
			clientY: 60,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;

		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 7);
		});

		expect(setSelectedPaths).toHaveBeenCalledWith(expect.any(Set));
		expect((setSelectedPaths.mock.calls[0][0] as Set<string>).size).toBe(0);
	});

	it('closeContextMenu sets contextMenu to null', () => {
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 20,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 0);
		});
		act(() => {
			result.current.closeContextMenu();
		});
		expect(result.current.contextMenu).toBeNull();
	});

	it('handleCopyPath calls safeClipboardWrite with the absolute path', async () => {
		const { safeClipboardWrite } = await import('../../../../../renderer/utils/clipboard');
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'src/App.tsx', 0);
		});
		act(() => {
			result.current.handleCopyPath();
		});
		expect(safeClipboardWrite).toHaveBeenCalledWith('/project/src/App.tsx');
		expect(result.current.contextMenu).toBeNull();
	});

	it('handleCopyFileName calls safeClipboardWrite with just the leaf name', async () => {
		const { safeClipboardWrite } = await import('../../../../../renderer/utils/clipboard');
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'src/App.tsx', 0);
		});
		act(() => {
			result.current.handleCopyFileName();
		});
		expect(safeClipboardWrite).toHaveBeenCalledWith('App.tsx');
		expect(result.current.contextMenu).toBeNull();
	});

	it('handleOpenInDefaultApp calls shell.openPath', () => {
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 0);
		});
		act(() => {
			result.current.handleOpenInDefaultApp();
		});
		expect(mockMaestro.shell.openPath).toHaveBeenCalledWith('/project/App.tsx');
	});

	it('handleDownloadFile downloads the remote file to the chosen local path', async () => {
		const onShowFlash = vi.fn();
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, sshRemoteId: 'remote-1', onShowFlash })
		);
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'src/App.tsx', 0);
		});
		await act(async () => {
			await result.current.handleDownloadFile();
		});
		expect(mockMaestro.dialog.saveFile).toHaveBeenCalledWith({
			defaultPath: 'App.tsx',
			title: 'Download File',
		});
		expect(mockMaestro.fs.downloadRemoteFile).toHaveBeenCalledWith(
			'/project/src/App.tsx',
			'remote-1',
			'/local/App.tsx'
		);
		expect(onShowFlash).toHaveBeenCalledWith('Downloaded "App.tsx"');
		expect(result.current.contextMenu).toBeNull();
	});

	it('handleDownloadFile skips the download when the save dialog is cancelled', async () => {
		mockMaestro.dialog.saveFile.mockResolvedValueOnce(null);
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, sshRemoteId: 'remote-1' })
		);
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'src/App.tsx', 0);
		});
		await act(async () => {
			await result.current.handleDownloadFile();
		});
		expect(mockMaestro.fs.downloadRemoteFile).not.toHaveBeenCalled();
	});

	it('handleDownloadFile is a no-op for local sessions (no sshRemoteId)', async () => {
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'src/App.tsx', 0);
		});
		await act(async () => {
			await result.current.handleDownloadFile();
		});
		expect(mockMaestro.dialog.saveFile).not.toHaveBeenCalled();
		expect(mockMaestro.fs.downloadRemoteFile).not.toHaveBeenCalled();
	});

	it('handleOpenInExplorer calls shell.showItemInFolder', () => {
		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'src/App.tsx', 0);
		});
		act(() => {
			result.current.handleOpenInExplorer();
		});
		expect(mockMaestro.shell.showItemInFolder).toHaveBeenCalledWith('/project/src/App.tsx');
	});

	it('handlePreviewFile calls handleFileClick', async () => {
		const handleFileClick = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, handleFileClick }));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 0);
		});
		await act(async () => {
			await result.current.handlePreviewFile();
		});
		expect(handleFileClick).toHaveBeenCalledWith(fileNode, 'App.tsx', session);
	});

	it('handleFocusInGraph calls onFocusFileInGraph with the path', () => {
		const onFocusFileInGraph = vi.fn();
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, onFocusFileInGraph }));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'docs/readme.md', 0);
		});
		act(() => {
			result.current.handleFocusInGraph();
		});
		expect(onFocusFileInGraph).toHaveBeenCalledWith('docs/readme.md');
	});

	it('handleOpenRename dispatches to openRenameModal', () => {
		const openRenameModal = vi.fn();
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, openRenameModal }));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, fileNode, 'App.tsx', 0);
		});
		act(() => {
			result.current.handleOpenRename();
		});
		expect(openRenameModal).toHaveBeenCalledWith(fileNode, 'App.tsx');
	});

	it('handleOpenNewFile dispatches to openNewFileModal for folder', () => {
		const openNewFileModal = vi.fn();
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, openNewFileModal }));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, folderNode, 'docs', 0);
		});
		act(() => {
			result.current.handleOpenNewFile();
		});
		expect(openNewFileModal).toHaveBeenCalledWith('docs', '/project/docs');
	});

	it('handleOpenNewFolder dispatches to openNewFolderModal for folder', () => {
		const openNewFolderModal = vi.fn();
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, openNewFolderModal }));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, folderNode, 'docs', 0);
		});
		act(() => {
			result.current.handleOpenNewFolder();
		});
		expect(openNewFolderModal).toHaveBeenCalledWith('docs', '/project/docs');
	});

	it('handleOpenInMaestroBrowser encodes the file:// URL', () => {
		const onOpenBrowserTabAt = vi.fn();
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, onOpenBrowserTabAt }));
		const htmlNode: FileNode = { name: 'index.html', type: 'file' };
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, htmlNode, 'public/index.html', 0);
		});
		act(() => {
			result.current.handleOpenInMaestroBrowser();
		});
		expect(onOpenBrowserTabAt).toHaveBeenCalledWith('file:///project/public/index.html', {
			title: 'index.html',
		});
	});

	it('handleOpenInMaestroBrowser preserves Windows drive-letter file:// URLs', () => {
		const onOpenBrowserTabAt = vi.fn();
		const windowsSession = { ...session, fullPath: 'C:\\Users\\Test Project' } as any;
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, session: windowsSession, onOpenBrowserTabAt })
		);
		const htmlNode: FileNode = { name: 'index.html', type: 'file' };
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, htmlNode, 'public/index.html', 0);
		});
		act(() => {
			result.current.handleOpenInMaestroBrowser();
		});
		expect(onOpenBrowserTabAt).toHaveBeenCalledWith(
			'file:///C:/Users/Test%20Project/public/index.html',
			{ title: 'index.html' }
		);
	});

	it('handlePreviewAllInFolder opens modal when files exceed threshold', () => {
		const manyFiles = Array.from({ length: 30 }, (_, i) => ({
			node: { name: `f${i}.md`, type: 'file' },
			path: `docs/f${i}.md`,
		}));
		vi.mocked(pathHelpers.collectPreviewableFiles).mockReturnValueOnce(manyFiles as any);

		const openModal = vi.fn();
		vi.mocked(modalStore.useModalStore.getState).mockReturnValueOnce({ openModal } as any);

		const { result } = renderHook(() => useFileContextMenu(defaultArgs));
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;
		act(() => {
			result.current.openContextMenu(e, folderNode, 'docs', 0);
		});
		act(() => {
			result.current.handlePreviewAllInFolder();
		});
		expect(openModal).toHaveBeenCalledWith(
			'confirm',
			expect.objectContaining({ message: expect.stringContaining('30') })
		);
	});

	it('handlePreviewMulti previews selected previewable files', async () => {
		const handleFileClick = vi.fn().mockResolvedValue(undefined);
		const selectedPathsRef = { current: new Set(['README.md', 'diagram.pdf']) };
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, selectedPathsRef, handleFileClick })
		);
		const e = {
			clientX: 10,
			clientY: 10,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as React.MouseEvent;

		act(() => {
			result.current.openContextMenu(e, fileNode, 'README.md', 0);
		});
		await act(async () => {
			await result.current.handlePreviewMulti();
		});

		expect(handleFileClick).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'README.md' }),
			'README.md',
			session
		);
		expect(handleFileClick).toHaveBeenCalledTimes(1);
	});

	it('handleOpenDeleteMulti opens the multi-delete modal', () => {
		const selectedPathsRef = { current: new Set(['README.md', 'docs/a.md']) };
		const { result } = renderHook(() => useFileContextMenu({ ...defaultArgs, selectedPathsRef }));

		act(() => {
			result.current.handleOpenDeleteMulti();
		});

		expect(result.current.multiDeleteModal?.nodes.map((node) => node.path)).toEqual([
			'README.md',
			'docs/a.md',
		]);
	});

	it('handleDeleteMulti deletes selected nodes and refreshes once', async () => {
		const refreshFileTree = vi.fn().mockResolvedValue(undefined);
		const setSelectedPaths = vi.fn();
		const selectedPathsRef = { current: new Set(['README.md', 'docs/a.md']) };
		const { result } = renderHook(() =>
			useFileContextMenu({ ...defaultArgs, selectedPathsRef, setSelectedPaths, refreshFileTree })
		);

		act(() => {
			result.current.handleOpenDeleteMulti();
		});
		await act(async () => {
			await result.current.handleDeleteMulti();
		});

		expect(mockMaestro.fs.delete).toHaveBeenCalledWith('/project/README.md', {
			sshRemoteId: undefined,
		});
		expect(mockMaestro.fs.delete).toHaveBeenCalledWith('/project/docs/a.md', {
			sshRemoteId: undefined,
		});
		expect(refreshFileTree).toHaveBeenCalledWith('sess-1');
		expect(setSelectedPaths).toHaveBeenCalledWith(expect.any(Set));
		expect(result.current.multiDeleteModal).toBeNull();
	});
});
