import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileExplorerPanel } from '../../renderer/components/FileExplorerPanel';
import { logger } from '../../renderer/utils/logger';
import type { Session, Theme } from '../../renderer/types';

const mockClipboardWrite = vi.hoisted(() => vi.fn());
const mockContextMenuPosition = vi.hoisted(() => ({ ready: true }));
const mockGetFileDetails = vi.hoisted(() => vi.fn());
const mockRefreshGitStatus = vi.hoisted(() => vi.fn());
const mockRegisterLayer = vi.hoisted(() => vi.fn(() => 'file-filter-layer'));
const mockUnregisterLayer = vi.hoisted(() => vi.fn());
const mockUpdateLayerHandler = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({
		count,
		estimateSize,
		getScrollElement,
	}: {
		count: number;
		estimateSize?: () => number;
		getScrollElement?: () => Element | null;
	}) => {
		const rowHeight = estimateSize?.() ?? 28;
		getScrollElement?.();
		return {
			getTotalSize: () => count * rowHeight,
			getVirtualItems: () =>
				Array.from({ length: count }, (_, index) => ({
					index,
					key: index,
					size: rowHeight,
					start: index * rowHeight,
				})),
			measure: vi.fn(),
		};
	},
}));

vi.mock('react-dom', async () => {
	const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
	return {
		...actual,
		createPortal: (children: React.ReactNode) => children,
	};
});

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

vi.mock('../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({
		getFileDetails: mockGetFileDetails,
		refreshGitStatus: mockRefreshGitStatus,
	}),
}));

vi.mock('../../renderer/hooks/ui/useContextMenuPosition', () => ({
	useContextMenuPosition: () => ({ left: 20, ready: mockContextMenuPosition.ready, top: 10 }),
}));

vi.mock('../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: mockClipboardWrite,
}));

const theme: Theme = {
	id: 'integration-theme',
	name: 'Integration Theme',
	mode: 'dark',
	colors: {
		accent: '#4a9eff',
		bgActivity: '#303030',
		bgInput: '#202020',
		bgMain: '#111111',
		bgSidebar: '#1d1d1d',
		border: '#404040',
		error: '#f44336',
		info: '#2196f3',
		scrollbarThumb: '#666666',
		success: '#4caf50',
		textDim: '#999999',
		textMain: '#ffffff',
		warning: '#ff9800',
	},
};

const fileTree = [
	{
		name: 'src',
		type: 'folder' as const,
		children: [
			{ name: 'index.ts', type: 'file' as const },
			{
				name: 'utils',
				type: 'folder' as const,
				children: [{ name: 'helpers.ts', type: 'file' as const }],
			},
		],
	},
	{ name: 'package.json', type: 'file' as const },
	{ name: 'README.md', type: 'file' as const },
];

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		aiLogs: [],
		aiPid: 123,
		changedFiles: [],
		createdAt: 1,
		cwd: '/Users/test/project',
		fileExplorerExpanded: ['src'],
		fileTree,
		fileTreeAutoRefreshInterval: 0,
		fullPath: '/Users/test/project',
		id: 'session-1',
		inputMode: 'ai',
		isGitRepo: true,
		name: 'Test Session',
		projectRoot: '/Users/test/project',
		shellLogs: [],
		state: 'idle',
		terminalPid: 456,
		toolType: 'claude-code',
		...overrides,
	} as Session;
}

function createProps(overrides: Partial<React.ComponentProps<typeof FileExplorerPanel>> = {}) {
	const session = overrides.session ?? createSession();
	return {
		activeFocus: 'main',
		activeRightTab: 'files',
		collapseAllFolders: vi.fn(),
		expandAllFolders: vi.fn(),
		fileExplorerIconTheme: 'default' as const,
		fileTreeContainerRef: React.createRef<HTMLDivElement>(),
		fileTreeFilter: '',
		fileTreeFilterInputRef: React.createRef<HTMLInputElement>(),
		fileTreeFilterOpen: false,
		filteredFileTree: session.fileTree ?? [],
		handleFileClick: vi.fn().mockResolvedValue(undefined),
		onAutoRefreshChange: vi.fn(),
		onFocusFileInGraph: vi.fn(),
		onOpenLastDocumentGraph: vi.fn(),
		onShowFlash: vi.fn(),
		refreshFileTree: vi.fn().mockResolvedValue({ totalChanges: 0 }),
		selectedFileIndex: 0,
		session,
		setActiveFocus: vi.fn(),
		setFileTreeFilter: vi.fn(),
		setFileTreeFilterOpen: vi.fn(),
		setSelectedFileIndex: vi.fn(),
		setSessions: vi.fn(),
		setShowHiddenFiles: vi.fn(),
		showHiddenFiles: false,
		theme,
		toggleFolder: vi.fn(),
		updateSessionWorkingDirectory: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('FileExplorerPanel integration coverage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockContextMenuPosition.ready = true;
		mockGetFileDetails.mockReturnValue(undefined);
		mockRefreshGitStatus.mockResolvedValue(undefined);
		const maestro = window.maestro as any;
		maestro.platform = 'darwin';
		maestro.fs = {
			...(maestro.fs ?? {}),
			countItems: vi.fn().mockResolvedValue({ fileCount: 2, folderCount: 1 }),
			delete: vi.fn().mockResolvedValue(undefined),
			rename: vi.fn().mockResolvedValue(undefined),
		};
		maestro.shell = {
			...(maestro.shell ?? {}),
			openPath: vi.fn(),
			showItemInFolder: vi.fn(),
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders retry countdown and remote loading progress states', () => {
		vi.useFakeTimers({ now: new Date('2026-05-27T10:00:00.000Z') });
		const retrySession = createSession({
			fileTreeError: 'SSH connection failed',
			fileTreeRetryAt: Date.now() + 5000,
		});
		const props = createProps({ session: retrySession });
		const { rerender } = render(<FileExplorerPanel {...props} />);

		expect(screen.getByText('SSH connection failed')).toBeInTheDocument();
		expect(screen.getByText(/Retrying in 5s/)).toBeInTheDocument();
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText(/Retrying in 4s/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Retry Now/i }));
		const retryUpdater = vi.mocked(props.setSessions).mock.calls.at(-1)?.[0] as (
			sessions: Session[]
		) => Session[];
		expect(retryUpdater([retrySession])[0].fileTreeRetryAt).toBeUndefined();
		const otherSession = createSession({
			fileTreeRetryAt: Date.now() + 10000,
			id: 'other-session',
		});
		expect(retryUpdater([retrySession, otherSession])[1].fileTreeRetryAt).toBe(
			otherSession.fileTreeRetryAt
		);

		const loadingSession = createSession({
			fileTree: [],
			fileTreeLoading: true,
			fileTreeLoadingProgress: {
				currentDirectory: '/Users/test/project/src',
				directoriesScanned: 12,
				filesFound: 1234,
			},
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } as any,
		});
		rerender(<FileExplorerPanel {...createProps({ session: loadingSession })} />);
		expect(screen.getByText('Loading remote files...')).toBeInTheDocument();
		expect(screen.getByText('1,234')).toBeInTheDocument();
		expect(screen.getByText('12')).toBeInTheDocument();
		expect(screen.getByText('scanning: src/')).toBeInTheDocument();
	});

	it('drives refresh controls, overlay interval selection, and auto-refresh errors', async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		const refreshFileTree = vi
			.fn()
			.mockResolvedValueOnce({ totalChanges: 1 })
			.mockRejectedValueOnce(new Error('network failure'));
		const session = createSession({ fileTreeAutoRefreshInterval: 5 });
		const props = createProps({ refreshFileTree, session });

		render(<FileExplorerPanel {...props} />);

		const refreshButton = screen.getByTitle('Auto-refresh every 5s');
		fireEvent.click(refreshButton);
		await act(async () => {
			await Promise.resolve();
		});
		expect(refreshFileTree).toHaveBeenCalledWith(session.id);
		expect(props.onShowFlash).toHaveBeenCalledWith('Detected 1 change');

		fireEvent.mouseEnter(refreshButton);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		fireEvent.click(screen.getByRole('button', { name: 'Every 20 seconds' }));
		expect(props.onAutoRefreshChange).toHaveBeenCalledWith(20);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(errorSpy).toHaveBeenCalledWith(
			'[FileExplorer] Auto-refresh failed:',
			undefined,
			expect.any(Error)
		);

		errorSpy.mockRestore();
	});

	it('covers header controls, hidden-file filtering, and error fallback actions', async () => {
		const hiddenTree = [
			{ name: '.env', type: 'file' as const },
			{ name: '.maestro', type: 'folder' as const, children: [] },
			{ name: 'visible.ts', type: 'file' as const },
		];
		const session = createSession({
			fileTree: hiddenTree,
			fileTreeStats: { fileCount: 2, folderCount: 1, totalSize: 1536 },
		});
		const props = createProps({
			filteredFileTree: hiddenTree,
			session,
		});
		const { rerender } = render(<FileExplorerPanel {...props} />);

		expect(screen.queryByText('.env')).not.toBeInTheDocument();
		expect(screen.getByText('.maestro')).toBeInTheDocument();
		expect(screen.getByText('visible.ts')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('1')).toBeInTheDocument();
		expect(screen.getByText('1.5 KB')).toBeInTheDocument();

		fireEvent.doubleClick(screen.getByTitle('/Users/test/project'));
		expect(mockClipboardWrite).toHaveBeenCalledWith('/Users/test/project');
		fireEvent.click(screen.getByTitle('Show dotfiles'));
		expect(props.setShowHiddenFiles).toHaveBeenCalledWith(true);
		fireEvent.click(screen.getByTitle('Expand all folders'));
		expect(props.expandAllFolders).toHaveBeenCalledWith(session.id, session, props.setSessions);
		fireEvent.click(screen.getByTitle('Collapse all folders'));
		expect(props.collapseAllFolders).toHaveBeenCalledWith(session.id, props.setSessions);

		rerender(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: hiddenTree,
					session: createSession({
						fileTree: hiddenTree,
						fileTreeStats: { fileCount: 1, folderCount: 1, totalSize: 0 },
					}),
				})}
			/>
		);
		expect(screen.getByText('0 B')).toBeInTheDocument();

		rerender(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: hiddenTree,
					session,
					showHiddenFiles: true,
				})}
			/>
		);
		expect(screen.getByText('.env')).toBeInTheDocument();

		const terminalErrorSession = createSession({
			fileTreeError: 'Directory missing',
			toolType: 'terminal',
		});
		const terminalProps = createProps({ session: terminalErrorSession });
		rerender(<FileExplorerPanel {...terminalProps} />);
		fireEvent.click(screen.getByRole('button', { name: 'Select New Directory' }));
		expect(terminalProps.updateSessionWorkingDirectory).toHaveBeenCalledWith(
			terminalErrorSession.id,
			terminalProps.setSessions
		);

		const agentErrorSession = createSession({ fileTreeError: 'Remote offline' });
		const agentProps = createProps({ session: agentErrorSession });
		rerender(<FileExplorerPanel {...agentProps} />);
		fireEvent.click(screen.getByRole('button', { name: 'Retry Connection' }));
		await act(async () => {
			await Promise.resolve();
		});
		expect(agentProps.refreshFileTree).toHaveBeenCalledWith(agentErrorSession.id);
	});

	it('covers filter layer handlers and file row interaction branches', () => {
		const props = createProps({
			fileTreeFilter: 'package',
			fileTreeFilterOpen: true,
		});
		const { container, rerender } = render(<FileExplorerPanel {...props} />);

		expect(mockRegisterLayer).toHaveBeenCalledWith(
			expect.objectContaining({ ariaLabel: 'File Tree Filter' })
		);
		expect(mockUpdateLayerHandler).toHaveBeenCalledWith('file-filter-layer', expect.any(Function));
		const escapeHandler = mockUpdateLayerHandler.mock.calls.at(-1)?.[1] as () => void;
		act(() => {
			escapeHandler();
		});
		expect(props.setFileTreeFilterOpen).toHaveBeenCalledWith(false);
		expect(props.setFileTreeFilter).toHaveBeenCalledWith('');
		const registeredLayer = mockRegisterLayer.mock.calls.at(-1)?.[0] as { onEscape: () => void };
		act(() => {
			registeredLayer.onEscape();
		});
		expect(props.setFileTreeFilterOpen).toHaveBeenCalledWith(false);
		expect(props.setFileTreeFilter).toHaveBeenCalledWith('');

		fireEvent.change(screen.getByPlaceholderText('Filter files...'), {
			target: { value: 'README' },
		});
		expect(props.setFileTreeFilter).toHaveBeenCalledWith('README');

		const packageRow = Array.from(container.querySelectorAll('[data-file-index]')).find((row) =>
			row.textContent?.includes('package.json')
		)!;
		const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		packageRow.dispatchEvent(mouseDown);
		expect(mouseDown.defaultPrevented).toBe(true);
		fireEvent.click(packageRow);
		expect(props.setSelectedFileIndex).toHaveBeenCalled();
		expect(props.setActiveFocus).not.toHaveBeenCalledWith('right');

		const activeFileSession = createSession({
			activeFileTabId: 'package-tab',
			filePreviewTabs: [
				{
					content: '{}',
					createdAt: 1,
					editContent: '{}',
					editMode: false,
					extension: '.json',
					id: 'package-tab',
					lastModified: 1,
					name: 'package',
					path: '/Users/test/project/package.json',
					scrollTop: 0,
					searchQuery: '',
				},
			],
		});
		mockGetFileDetails.mockReturnValue({
			fileChanges: [
				{ path: 'package.json', status: 'M' },
				{ path: 'README.md', status: 'D' },
			],
			modifiedCount: 1,
			totalAdditions: 0,
			totalDeletions: 1,
		});
		const interactionProps = createProps({
			activeFocus: 'right',
			fileTreeFilter: '',
			selectedFileIndex: 1,
			session: activeFileSession,
		});
		rerender(<FileExplorerPanel {...interactionProps} />);

		fireEvent.click(screen.getByText('src'));
		expect(interactionProps.toggleFolder).toHaveBeenCalledWith(
			'src',
			activeFileSession.id,
			interactionProps.setSessions
		);
		const plainMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		screen.getByText('package.json').closest('[data-file-index]')?.dispatchEvent(plainMouseDown);
		expect(plainMouseDown.defaultPrevented).toBe(false);
		fireEvent.click(screen.getByText('package.json'));
		expect(interactionProps.setActiveFocus).toHaveBeenCalledWith('right');
		fireEvent.doubleClick(screen.getByText('package.json'));
		expect(interactionProps.handleFileClick).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'package.json' }),
			'package.json',
			activeFileSession
		);
		fireEvent.doubleClick(screen.getByText('src'));
		expect(interactionProps.handleFileClick).toHaveBeenCalledTimes(1);
		const changeTypes = Array.from(
			container.querySelectorAll('[data-testid="git-change-indicator"]')
		).map((indicator) => indicator.getAttribute('data-change-type'));
		expect(changeTypes).toEqual(expect.arrayContaining(['modified', 'deleted']));
	});

	it('covers rename validation failures and file delete stats updates', async () => {
		const session = createSession({
			fileTreeStats: { fileCount: 4, folderCount: 2, totalSize: 2048 },
		});
		let currentSessions = [
			session,
			createSession({ id: 'session-2', name: 'Other Session', fileTree: [] }),
		];
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
		});
		const props = createProps({ session, setSessions });
		render(<FileExplorerPanel {...props} />);

		fireEvent.contextMenu(screen.getByText('package.json'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bad/name.json' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		expect(screen.getByText('Name cannot contain slashes')).toBeInTheDocument();

		vi.mocked(window.maestro.fs.rename).mockRejectedValueOnce(new Error('rename denied'));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'renamed.json' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		expect(await screen.findByText('rename denied')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		fireEvent.contextMenu(screen.getByText('package.json'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);
		await waitFor(() =>
			expect(window.maestro.fs.delete).toHaveBeenCalledWith('/Users/test/project/package.json', {
				sshRemoteId: undefined,
			})
		);
		expect(currentSessions[0].fileTree?.some((node) => node.name === 'package.json')).toBe(false);
		expect(currentSessions[0].fileTreeStats).toMatchObject({ fileCount: 3, folderCount: 2 });
		expect(currentSessions[1].id).toBe('session-2');
		expect(props.onShowFlash).toHaveBeenCalledWith('Deleted "package.json"');
	});

	it('executes file context menu graph, clipboard, shell, rename, and delete actions', async () => {
		const session = createSession({
			fileTreeStats: { fileCount: 4, folderCount: 2, totalSize: 2048 },
		});
		let currentSessions = [
			session,
			createSession({ id: 'session-2', name: 'Other Session', fileTree: [] }),
		];
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
		});
		const props = createProps({ session, setSessions });
		render(<FileExplorerPanel {...props} />);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Document Graph' }));
		expect(props.onFocusFileInGraph).toHaveBeenCalledWith('README.md');

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
		expect(props.handleFileClick).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'README.md' }),
			'README.md',
			session
		);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Copy Path' }));
		expect(mockClipboardWrite).toHaveBeenCalledWith('/Users/test/project/README.md');

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Open in Default App' }));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/Users/test/project/README.md');

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
		expect(window.maestro.shell.showItemInFolder).toHaveBeenCalledWith(
			'/Users/test/project/README.md'
		);

		fireEvent.contextMenu(screen.getByText('package.json'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'package-lock.json' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		await waitFor(() =>
			expect(window.maestro.fs.rename).toHaveBeenCalledWith(
				'/Users/test/project/package.json',
				'/Users/test/project/package-lock.json',
				undefined
			)
		);
		expect(currentSessions[0].fileTree?.some((node) => node.name === 'package-lock.json')).toBe(
			true
		);
		expect(currentSessions[1].id).toBe('session-2');
		expect(props.onShowFlash).toHaveBeenCalledWith('Renamed to "package-lock.json"');

		fireEvent.contextMenu(screen.getByText('src'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await screen.findByText(/This folder contains 2 files and 1 subfolder/);
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() =>
			expect(window.maestro.fs.delete).toHaveBeenCalledWith('/Users/test/project/src', {
				sshRemoteId: undefined,
			})
		);
		expect(currentSessions[0].fileTree?.some((node) => node.name === 'src')).toBe(false);
		expect(currentSessions[0].fileTreeStats).toMatchObject({ fileCount: 2, folderCount: 0 });
		expect(props.onShowFlash).toHaveBeenCalledWith('Deleted "src"');
	});

	it('covers refresh hover overlay cancellation and disable action', async () => {
		vi.useFakeTimers();
		const refreshFileTree = vi.fn().mockResolvedValue({ totalChanges: 0 });
		const props = createProps({
			refreshFileTree,
			session: createSession({ fileTreeAutoRefreshInterval: 20 }),
		});
		render(<FileExplorerPanel {...props} />);

		const refreshButton = screen.getByTitle('Auto-refresh every 20s');
		fireEvent.mouseEnter(refreshButton);
		fireEvent.mouseLeave(refreshButton);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();

		fireEvent.mouseEnter(refreshButton);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
		fireEvent.mouseLeave(refreshButton);
		fireEvent.mouseEnter(screen.getByText('Auto-refresh'));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		expect(screen.getByText('Auto-refresh')).toBeInTheDocument();
		fireEvent.mouseLeave(screen.getByText('Auto-refresh'));
		expect(screen.queryByText('Auto-refresh')).not.toBeInTheDocument();

		fireEvent.mouseEnter(refreshButton);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
		fireEvent.click(screen.getByRole('button', { name: 'Disable auto-refresh' }));
		expect(props.onAutoRefreshChange).toHaveBeenCalledWith(0);
	});

	it('tolerates refresh hover timers after the button unmounts', async () => {
		vi.useFakeTimers();
		const { unmount } = render(
			<FileExplorerPanel
				{...createProps({
					session: createSession({ fileTreeAutoRefreshInterval: 20 }),
				})}
			/>
		);

		fireEvent.mouseEnter(screen.getByTitle('Auto-refresh every 20s'));
		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(400);
		});
	});

	it('skips auto-refresh while a previous refresh is still in flight', async () => {
		vi.useFakeTimers();
		let resolveRefresh: (() => void) | undefined;
		const refreshFileTree = vi.fn(
			() =>
				new Promise<{ totalChanges: number }>((resolve) => {
					resolveRefresh = () => resolve({ totalChanges: 0 });
				})
		);
		const props = createProps({
			refreshFileTree,
			session: createSession({ fileTreeAutoRefreshInterval: 1 }),
		});
		render(<FileExplorerPanel {...props} />);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(refreshFileTree).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(refreshFileTree).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveRefresh?.();
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(500);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(refreshFileTree).toHaveBeenCalledTimes(2);
	});

	it('renames folders and remaps expanded descendant paths', async () => {
		const session = createSession({
			fileExplorerExpanded: ['src', 'src/utils', 'README.md'],
		});
		let currentSessions = [session];
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
		});
		const props = createProps({ session, setSessions });
		render(<FileExplorerPanel {...props} />);

		fireEvent.contextMenu(screen.getByText('src'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		expect(screen.getByText('Rename Folder')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Enter folder name...')).toBeInTheDocument();
		await act(async () => {
			await new Promise(requestAnimationFrame);
		});

		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'app' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		await waitFor(() =>
			expect(window.maestro.fs.rename).toHaveBeenCalledWith(
				'/Users/test/project/src',
				'/Users/test/project/app',
				undefined
			)
		);
		expect(currentSessions[0].fileExplorerExpanded).toEqual(['app', 'app/utils', 'README.md']);
		expect(currentSessions[0].fileTree?.some((node) => node.name === 'app')).toBe(true);
		expect(props.onShowFlash).toHaveBeenCalledWith('Renamed to "app"');
	});

	it('closes context menus with outside clicks and Escape', () => {
		render(<FileExplorerPanel {...createProps()} />);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		expect(screen.getByRole('button', { name: 'Copy Path' })).toBeInTheDocument();
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('button', { name: 'Copy Path' })).not.toBeInTheDocument();

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		expect(screen.getByRole('button', { name: 'Copy Path' })).toBeInTheDocument();
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		});
		expect(screen.getByRole('button', { name: 'Copy Path' })).toBeInTheDocument();
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		});
		expect(screen.queryByRole('button', { name: 'Copy Path' })).not.toBeInTheDocument();
	});

	it('reports delete failures and allows closing the delete modal', async () => {
		const session = createSession({
			fileTreeStats: { fileCount: 4, folderCount: 2, totalSize: 2048 },
		});
		const props = createProps({ session });
		vi.mocked(window.maestro.fs.delete)
			.mockRejectedValueOnce(new Error('permission denied'))
			.mockRejectedValueOnce('plain failure');

		render(<FileExplorerPanel {...props} />);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		let deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);
		await waitFor(() =>
			expect(props.onShowFlash).toHaveBeenCalledWith('Delete failed: permission denied')
		);
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText(/Are you sure you want to delete/)).not.toBeInTheDocument();

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);
		await waitFor(() =>
			expect(props.onShowFlash).toHaveBeenCalledWith('Delete failed: Unknown error')
		);
	});

	it('renders singular folder delete copy when count has no subfolders', async () => {
		vi.mocked(window.maestro.fs.countItems).mockResolvedValueOnce({ fileCount: 1, folderCount: 0 });
		render(<FileExplorerPanel {...createProps()} />);

		fireEvent.contextMenu(screen.getByText('src'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		expect(await screen.findByText(/This folder contains 1 file\./)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByText(/This folder contains 1 file\./)).not.toBeInTheDocument();

		vi.mocked(window.maestro.fs.countItems).mockResolvedValueOnce({ fileCount: 2, folderCount: 2 });
		fireEvent.contextMenu(screen.getByText('src'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(await screen.findByText(/2 files and 2 subfolders/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
	});

	it('warns and skips duplicate sibling and duplicate full paths', () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
		const duplicateTree = [
			{ name: 'dup.ts', type: 'file' as const },
			{ name: 'dup.ts', type: 'file' as const },
			{
				name: 'src',
				type: 'folder' as const,
				children: [{ name: 'utils.ts', type: 'file' as const }],
			},
			{ name: 'src/utils.ts', type: 'file' as const },
		];
		const session = createSession({
			fileExplorerExpanded: ['src'],
			fileTree: duplicateTree,
		});

		render(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: duplicateTree,
					session,
				})}
			/>
		);

		expect(warnSpy).toHaveBeenCalledWith('[FileExplorer] Duplicate sibling skipped:', undefined, [
			'',
			'dup.ts',
		]);
		expect(warnSpy).toHaveBeenCalledWith(
			'[FileExplorer] Duplicate path skipped:',
			undefined,
			'src/utils.ts'
		);
		warnSpy.mockRestore();
	});

	it('selects a full file name without an extension when rename opens', async () => {
		const extensionlessTree = [{ name: 'LICENSE', type: 'file' as const }];
		const session = createSession({ fileTree: extensionlessTree });
		render(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: extensionlessTree,
					session,
				})}
			/>
		);

		fireEvent.contextMenu(screen.getByText('LICENSE'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		await act(async () => {
			await new Promise(requestAnimationFrame);
		});

		const input = screen.getByRole('textbox') as HTMLInputElement;
		expect(input.selectionStart).toBe(0);
		expect(input.selectionEnd).toBe('LICENSE'.length);
	});

	it('keeps the delete modal open while a delete is in progress', async () => {
		let resolveDelete: (() => void) | undefined;
		vi.mocked(window.maestro.fs.delete).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				resolveDelete = resolve;
			})
		);
		render(<FileExplorerPanel {...createProps()} />);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);
		expect(await screen.findByRole('button', { name: 'Deleting...' })).toBeDisabled();

		fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
		expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();

		await act(async () => {
			resolveDelete?.();
			await Promise.resolve();
		});
		await waitFor(() =>
			expect(screen.queryByText(/Are you sure you want to delete/)).not.toBeInTheDocument()
		);
	});

	it('covers loading, empty, ssh, and change rendering branches', () => {
		const { rerender } = render(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: [],
					session: createSession({
						fileTree: [],
						fileTreeLoading: true,
						fileTreeLoadingProgress: undefined,
					}),
				})}
			/>
		);
		expect(screen.getByText('Loading files...')).toBeInTheDocument();

		rerender(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: [],
					session: createSession({
						fileTree: [],
						fileTreeLoading: true,
						fileTreeLoadingProgress: {
							currentDirectory: '/Users/test/project/',
							directoriesScanned: 1,
							filesFound: 1,
						},
					}),
				})}
			/>
		);
		expect(screen.getByText('Loading files...')).toBeInTheDocument();
		expect(screen.getByTitle('/Users/test/project/')).toBeInTheDocument();

		rerender(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: [],
					session: createSession({
						fileTree: [],
						fileTreeLoading: true,
						fileTreeLoadingProgress: {
							currentDirectory: '/Users/test/project/src',
							directoriesScanned: 0,
							filesFound: 1,
						},
					}),
				})}
			/>
		);
		expect(screen.getAllByText('1').length).toBeGreaterThan(0);
		expect(screen.getAllByText('0').length).toBeGreaterThan(0);

		rerender(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: [],
					session: createSession({ fileExplorerExpanded: undefined, fileTree: [] } as any),
				})}
			/>
		);
		expect(screen.getByText('No files found')).toBeInTheDocument();

		rerender(
			<FileExplorerPanel
				{...createProps({
					fileTreeFilter: 'missing',
					filteredFileTree: [],
					session: createSession({ fileTree: [] }),
				})}
			/>
		);
		expect(screen.getByText('No files match your search')).toBeInTheDocument();

		rerender(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: undefined as any,
					session: createSession({
						fileExplorerExpanded: undefined,
						fileTree,
						sshRemote: { host: 'example.com', name: 'Prod' } as any,
					} as any),
				})}
			/>
		);
		expect(screen.getByTitle('SSH: Prod (example.com)')).toBeInTheDocument();
		expect(screen.getByTitle('example.com:/Users/test/project')).toBeInTheDocument();

		rerender(
			<FileExplorerPanel
				{...createProps({
					session: createSession({
						activeFileTabId: 'missing-tab',
						filePreviewTabs: [],
					}),
				})}
			/>
		);
		mockGetFileDetails.mockReturnValue({
			fileChanges: [{ path: 'package.json', status: '??' }],
			modifiedCount: 0,
			totalAdditions: 1,
			totalDeletions: 0,
		});
		rerender(
			<FileExplorerPanel
				{...createProps({
					session: createSession({
						activeFileTabId: 'missing-tab',
						filePreviewTabs: [],
					}),
				})}
			/>
		);
		const addedIndicator = screen.getByTestId('git-change-indicator');
		expect(addedIndicator).toHaveAttribute('data-change-type', 'added');

		rerender(
			<FileExplorerPanel
				{...createProps({
					session: createSession({ fileTreeAutoRefreshInterval: undefined } as any),
				})}
			/>
		);
		expect(screen.getByTitle('Auto-refresh every 180s')).toBeInTheDocument();
	});

	it('covers refresh notification branches without requiring flash callbacks', async () => {
		const flash = vi.fn();
		const refreshFileTree = vi.fn().mockResolvedValueOnce({ totalChanges: 2 });
		const { rerender } = render(
			<FileExplorerPanel
				{...createProps({
					onShowFlash: flash,
					refreshFileTree,
					session: createSession({ fileTreeAutoRefreshInterval: 0 }),
				})}
			/>
		);

		fireEvent.click(screen.getByTitle('Refresh file tree'));
		await waitFor(() => expect(flash).toHaveBeenCalledWith('Detected 2 changes'));

		const refreshWithoutFlash = vi.fn().mockResolvedValueOnce({ totalChanges: 2 });
		rerender(
			<FileExplorerPanel
				{...createProps({
					onShowFlash: undefined,
					refreshFileTree: refreshWithoutFlash,
					session: createSession({ fileTreeAutoRefreshInterval: 0 }),
				})}
			/>
		);
		fireEvent.click(screen.getByTitle('Refresh file tree'));
		await waitFor(() => expect(refreshWithoutFlash).toHaveBeenCalled());

		const refreshWithoutChanges = vi.fn().mockResolvedValueOnce(undefined);
		rerender(
			<FileExplorerPanel
				{...createProps({
					refreshFileTree: refreshWithoutChanges,
					session: createSession({ fileTreeAutoRefreshInterval: 0 }),
				})}
			/>
		);
		fireEvent.click(screen.getByTitle('Refresh file tree'));
		await waitFor(() => expect(refreshWithoutChanges).toHaveBeenCalled());
	});

	it('covers rename and delete fallback branches without optional session data', async () => {
		vi.mocked(window.maestro.fs.rename).mockRejectedValueOnce('plain rename failure');
		const session = createSession({
			fileExplorerExpanded: undefined,
			fileTreeStats: undefined,
		} as any);
		let currentSessions = [session];
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
		});
		const props = createProps({ session, setSessions });
		render(<FileExplorerPanel {...props} />);

		fireEvent.contextMenu(screen.getByText('package.json'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'package-lock.json' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		expect(await screen.findByText('Rename failed')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		vi.mocked(window.maestro.fs.countItems).mockRejectedValueOnce(new Error('count failed'));
		fireEvent.contextMenu(screen.getByText('src'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(await screen.findByText(/Are you sure you want to delete/)).toBeInTheDocument();
		expect(screen.queryByText(/This folder contains/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(window.maestro.fs.delete).toHaveBeenCalled());
		expect(currentSessions[0].fileTreeStats).toBeUndefined();
		expect(currentSessions[0].fileExplorerExpanded).toEqual([]);
	});

	it('renames and deletes against fallback trees when the session tree is absent', async () => {
		const session = createSession({
			fileExplorerExpanded: undefined,
			fileTree: undefined,
			fileTreeStats: undefined,
		} as any);
		let currentSessions = [session];
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
		});
		const props = createProps({ filteredFileTree: fileTree, session, setSessions });
		render(<FileExplorerPanel {...props} />);

		fireEvent.contextMenu(screen.getByText('src'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'app' } });
		fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
		await waitFor(() =>
			expect(window.maestro.fs.rename).toHaveBeenCalledWith(
				'/Users/test/project/src',
				'/Users/test/project/app',
				undefined
			)
		);
		expect(currentSessions[0].fileTree).toEqual([]);
		expect(currentSessions[0].fileExplorerExpanded).toEqual([]);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);
		await waitFor(() => expect(window.maestro.fs.delete).toHaveBeenCalled());
		expect(currentSessions[0].fileTree).toEqual([]);
	});

	it('deletes a cached folder without children', async () => {
		const emptyFolderTree = [{ name: 'empty', type: 'folder' as const }];
		const session = createSession({
			fileTree: emptyFolderTree,
			fileTreeStats: { fileCount: 0, folderCount: 1, totalSize: 0 },
		});
		let currentSessions = [session];
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			currentSessions = typeof updater === 'function' ? updater(currentSessions) : updater;
		});

		render(
			<FileExplorerPanel
				{...createProps({
					filteredFileTree: emptyFolderTree,
					session,
					setSessions,
				})}
			/>
		);

		fireEvent.contextMenu(screen.getByText('empty'), { clientX: 12, clientY: 16 });
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(await screen.findByText(/Are you sure you want to delete/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await waitFor(() => expect(window.maestro.fs.delete).toHaveBeenCalled());
		expect(currentSessions[0].fileTree).toEqual([]);
		expect(currentSessions[0].fileTreeStats).toMatchObject({ fileCount: 0, folderCount: 0 });
	});

	it('renders hidden context menus while position calculation is pending', () => {
		mockContextMenuPosition.ready = false;
		render(<FileExplorerPanel {...createProps()} />);

		fireEvent.contextMenu(screen.getByText('README.md'), { clientX: 12, clientY: 16 });

		expect(screen.getByRole('button', { name: 'Copy Path' }).closest('.fixed')).toHaveStyle({
			opacity: '0',
		});
	});
});
