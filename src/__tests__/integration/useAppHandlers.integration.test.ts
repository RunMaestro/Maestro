import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../renderer/utils/logger';

const mocks = vi.hoisted(() => ({
	shouldOpenExternally: vi.fn(),
	getAllFolderPaths: vi.fn(),
	openModal: vi.fn(),
	setFilePreviewLoading: vi.fn(),
}));

vi.mock('../../renderer/utils/fileExplorer', () => ({
	shouldOpenExternally: mocks.shouldOpenExternally,
	getAllFolderPaths: mocks.getAllFolderPaths,
}));

vi.mock('../../renderer/stores/modalStore', () => ({
	useModalStore: {
		getState: () => ({
			openModal: mocks.openModal,
		}),
	},
}));

vi.mock('../../renderer/stores/fileExplorerStore', () => ({
	useFileExplorerStore: {
		getState: () => ({
			setFilePreviewLoading: mocks.setFilePreviewLoading,
		}),
	},
}));

import { useAppHandlers } from '../../renderer/hooks/ui/useAppHandlers';

const baseSession = {
	id: 'session-1',
	cwd: '/workspace',
	fullPath: '/workspace',
	projectRoot: '/workspace/root',
	fileTree: [
		{
			name: 'src',
			type: 'directory',
			path: 'src',
			children: [{ name: 'index.ts', type: 'file', path: 'src/index.ts' }],
		},
	],
	fileExplorerExpanded: ['src'],
} as any;

function createDragEvent(types: string[] = ['Files']) {
	return {
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		dataTransfer: { types },
	} as any;
}

function createDeps(overrides: Record<string, unknown> = {}) {
	return {
		activeSession: baseSession,
		activeSessionId: 'session-1',
		setSessions: vi.fn(),
		setActiveFocus: vi.fn(),
		setConfirmModalMessage: vi.fn(),
		setConfirmModalOnConfirm: vi.fn(),
		setConfirmModalOpen: vi.fn(),
		onOpenFileTab: vi.fn(),
		...overrides,
	} as any;
}

function applySessionSetter(initialSessions: any[]) {
	let sessions = initialSessions;
	const setSessions = vi.fn((updater) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
	});
	return {
		setSessions,
		getSessions: () => sessions,
	};
}

describe('useAppHandlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.shouldOpenExternally.mockReturnValue(false);
		mocks.getAllFolderPaths.mockReturnValue(['src', 'src/nested']);
		window.maestro = {
			shell: {
				openPath: vi.fn().mockResolvedValue(undefined),
			},
			fs: {
				readFile: vi.fn().mockResolvedValue('file contents'),
				stat: vi.fn().mockResolvedValue({ modifiedAt: '2026-05-14T12:00:00.000Z' }),
			},
			dialog: {
				selectFolder: vi.fn().mockResolvedValue('/new/workspace'),
			},
		} as any;
	});

	it('tracks file drag state and clears it on leave and dragend', () => {
		const { result } = renderHook(() => useAppHandlers(createDeps()));
		const dragEnter = createDragEvent(['Files']);
		const dragLeave = createDragEvent(['Files']);

		act(() => {
			result.current.handleFileDragEnter(dragEnter);
			result.current.handleFileDragEnter(createDragEvent(['Files']));
			result.current.handleFileDragLeave(createDragEvent(['Files']));
		});

		expect(dragEnter.preventDefault).toHaveBeenCalled();
		expect(dragEnter.stopPropagation).toHaveBeenCalled();
		expect(result.current.isDraggingFile).toBe(true);
		expect(result.current.dragCounterRef.current).toBe(1);

		act(() => {
			result.current.handleFileDragLeave(dragLeave);
		});

		expect(result.current.isDraggingFile).toBe(false);
		expect(result.current.dragCounterRef.current).toBe(0);

		act(() => {
			const textDrag = createDragEvent(['text/plain']);
			result.current.handleFileDragEnter(textDrag);
			result.current.handleFileDragLeave(textDrag);
		});
		expect(result.current.isDraggingFile).toBe(false);

		act(() => {
			result.current.setIsDraggingFile(true);
			result.current.dragCounterRef.current = 2;
			document.dispatchEvent(new Event('drop'));
		});

		expect(result.current.isDraggingFile).toBe(true);
		expect(result.current.dragCounterRef.current).toBe(2);

		act(() => {
			document.dispatchEvent(new Event('dragend'));
		});

		expect(result.current.isDraggingFile).toBe(false);
		expect(result.current.dragCounterRef.current).toBe(0);

		const dragOver = createDragEvent();
		act(() => {
			result.current.handleFileDragOver(dragOver);
		});
		expect(dragOver.preventDefault).toHaveBeenCalled();
		expect(dragOver.stopPropagation).toHaveBeenCalled();
	});

	it('opens local external files through a confirmation modal', async () => {
		mocks.shouldOpenExternally.mockReturnValue(true);
		const deps = createDeps();
		const { result } = renderHook(() => useAppHandlers(deps));

		await act(async () => {
			await result.current.handleFileClick(
				{ name: 'diagram.png', type: 'file' },
				'assets/diagram.png'
			);
		});

		expect(mocks.openModal).toHaveBeenCalledWith('confirm', {
			message: 'Open "diagram.png" in external application?',
			onConfirm: expect.any(Function),
		});
		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();

		await mocks.openModal.mock.calls[0][1].onConfirm();
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith(
			'/workspace/root/assets/diagram.png'
		);
	});

	it('opens local files in preview tabs with stat timestamps', async () => {
		const deps = createDeps();
		const { result } = renderHook(() => useAppHandlers(deps));

		await act(async () => {
			await result.current.handleFileClick({ name: 'readme.md', type: 'file' }, 'docs/readme.md');
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
			'/workspace/root/docs/readme.md',
			undefined,
			undefined
		);
		expect(window.maestro.fs.stat).toHaveBeenCalledWith(
			'/workspace/root/docs/readme.md',
			undefined
		);
		expect(deps.onOpenFileTab).toHaveBeenCalledWith(
			{
				path: '/workspace/root/docs/readme.md',
				name: 'readme.md',
				content: 'file contents',
				sshRemoteId: undefined,
				lastModified: new Date('2026-05-14T12:00:00.000Z').getTime(),
			},
			{ targetSessionId: 'session-1' }
		);
		expect(deps.setActiveFocus).toHaveBeenCalledWith('main');
	});

	it('uses fullPath as the file root when projectRoot is unavailable', async () => {
		const deps = createDeps({
			activeSession: { ...baseSession, projectRoot: undefined, fullPath: '/fallback/root' },
		});
		const { result } = renderHook(() => useAppHandlers(deps));

		await act(async () => {
			await result.current.handleFileClick({ name: 'readme.md', type: 'file' }, 'readme.md');
			await result.current.handleFileClick({ name: 'docs', type: 'directory' }, 'docs');
		});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
			'/fallback/root/readme.md',
			undefined,
			undefined
		);
		expect(window.maestro.fs.readFile).toHaveBeenCalledTimes(1);
	});

	it('uses SSH remote IDs, loading state, and fallback timestamps for remote previews', async () => {
		const deps = createDeps({
			activeSession: {
				...baseSession,
				sshRemoteId: undefined,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-1' },
			},
		});
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce({});
		const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456);
		const { result } = renderHook(() => useAppHandlers(deps));

		await act(async () => {
			await result.current.handleFileClick({ name: 'remote.txt', type: 'file' }, 'remote.txt');
		});

		expect(deps.onOpenFileTab).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				path: '/workspace/root/remote.txt',
				name: 'remote.txt',
				content: '',
				sshRemoteId: 'ssh-1',
				isLoading: true,
				loadRequestId: expect.any(String),
			}),
			{ targetSessionId: 'session-1' }
		);
		const loadRequestId = deps.onOpenFileTab.mock.calls[0][0].loadRequestId;
		expect(window.maestro.fs.readFile).toHaveBeenCalledWith(
			'/workspace/root/remote.txt',
			'ssh-1',
			loadRequestId
		);
		expect(deps.onOpenFileTab).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				sshRemoteId: 'ssh-1',
				lastModified: 123456,
			}),
			{ targetSessionId: 'session-1' }
		);
		nowSpy.mockRestore();
	});

	it('does not open a tab for null content and logs read failures', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const deps = createDeps();
		const { result } = renderHook(() => useAppHandlers(deps));

		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce(null);
		await act(async () => {
			await result.current.handleFileClick({ name: 'empty.md', type: 'file' }, 'empty.md');
		});
		expect(deps.onOpenFileTab).not.toHaveBeenCalled();

		const failure = new Error('read failed');
		vi.mocked(window.maestro.fs.readFile).mockRejectedValueOnce(failure);
		await act(async () => {
			await result.current.handleFileClick({ name: 'broken.md', type: 'file' }, 'broken.md');
		});

		expect(loggerError).toHaveBeenCalledWith('Failed to read file:', undefined, failure);
		loggerError.mockRestore();
	});

	it('ignores null sessions, folders, and cancelled working-directory selection', async () => {
		const deps = createDeps({ activeSession: null });
		const { result } = renderHook(() => useAppHandlers(deps));

		await act(async () => {
			await result.current.handleFileClick({ name: 'readme.md', type: 'file' }, 'readme.md');
		});

		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();

		vi.mocked(window.maestro.dialog.selectFolder).mockResolvedValueOnce(null);
		await act(async () => {
			await result.current.updateSessionWorkingDirectory();
		});
		expect(deps.setSessions).not.toHaveBeenCalled();
	});

	it('updates the active session when a new local working directory is selected', async () => {
		const { setSessions, getSessions } = applySessionSetter([
			{ ...baseSession, id: 'other', cwd: '/other' },
			{
				...baseSession,
				sshRemote: { host: 'example.com' },
				sshRemoteId: 'ssh-old',
				remoteCwd: '/remote',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-old' },
			},
		]);
		const { result } = renderHook(() => useAppHandlers(createDeps({ setSessions })));

		await act(async () => {
			await result.current.updateSessionWorkingDirectory();
		});

		expect(window.maestro.dialog.selectFolder).toHaveBeenCalled();
		expect(getSessions()[0]).toEqual(expect.objectContaining({ id: 'other', cwd: '/other' }));
		expect(getSessions()[1]).toEqual(
			expect.objectContaining({
				cwd: '/new/workspace',
				fullPath: '/new/workspace',
				projectRoot: '/new/workspace',
				fileTree: [],
				fileTreeError: undefined,
				sshRemote: undefined,
				sshRemoteId: undefined,
				remoteCwd: undefined,
				sessionSshRemoteConfig: { enabled: false, remoteId: null },
			})
		);
	});

	it('toggles, expands, and collapses file explorer folders', () => {
		const { result } = renderHook(() => useAppHandlers(createDeps()));
		const { setSessions, getSessions } = applySessionSetter([
			{ ...baseSession, id: 'other', fileExplorerExpanded: ['other'] },
			{ ...baseSession, fileExplorerExpanded: ['src'] },
			{ ...baseSession, id: 'no-expanded', fileExplorerExpanded: undefined },
			{ ...baseSession, id: 'no-tree', fileTree: undefined, fileExplorerExpanded: [] },
		]);

		act(() => {
			result.current.toggleFolder('src', 'session-1', setSessions);
		});
		expect(getSessions()[1].fileExplorerExpanded).toEqual([]);

		act(() => {
			result.current.toggleFolder('docs', 'session-1', setSessions);
		});
		expect(getSessions()[1].fileExplorerExpanded).toEqual(['docs']);

		act(() => {
			result.current.toggleFolder('ignored', 'no-expanded', setSessions);
		});
		expect(getSessions()[2].fileExplorerExpanded).toBeUndefined();

		act(() => {
			result.current.expandAllFolders('session-1', baseSession, setSessions);
			result.current.expandAllFolders('no-tree', baseSession, setSessions);
		});
		expect(mocks.getAllFolderPaths).toHaveBeenCalledWith(baseSession.fileTree);
		expect(getSessions()[1].fileExplorerExpanded).toEqual(['src', 'src/nested']);
		expect(getSessions()[3].fileExplorerExpanded).toEqual([]);

		act(() => {
			result.current.collapseAllFolders('session-1', setSessions);
		});
		expect(getSessions()[1].fileExplorerExpanded).toEqual([]);
		expect(getSessions()[0].fileExplorerExpanded).toEqual(['other']);
	});
});
