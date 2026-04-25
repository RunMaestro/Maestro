import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFilePreviewHandlers } from '../../../renderer/hooks/mainPanel/useFilePreviewHandlers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session, FilePreviewTab } from '../../../renderer/types';

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockSaveFile = vi.fn().mockResolvedValue(null);

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		fs: { writeFile: mockWriteFile },
		dialog: { saveFile: mockSaveFile },
	};
});

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test',
		cwd: '/test/project',
		fullPath: '/test/project',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: false,
		bookmarked: false,
		...overrides,
	} as Session;
}

function makeFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	return {
		id: 'file-1',
		name: 'test',
		extension: '.ts',
		content: 'console.log("hello")',
		path: '/test/project/src/test.ts',
		editMode: false,
		...overrides,
	} as FilePreviewTab;
}

describe('useFilePreviewHandlers', () => {
	it('returns null memoizedFilePreviewFile when no activeFileTab', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: null,
				activeFileTab: null,
			})
		);
		expect(result.current.memoizedFilePreviewFile).toBeNull();
	});

	it('creates stable memoizedFilePreviewFile from tab', () => {
		const tab = makeFileTab();
		const { result, rerender } = renderHook(
			({ tab: t }) =>
				useFilePreviewHandlers({
					activeSession: makeSession(),
					activeFileTabId: 'file-1',
					activeFileTab: t,
				}),
			{ initialProps: { tab } }
		);

		expect(result.current.memoizedFilePreviewFile).toEqual({
			name: 'test.ts',
			content: 'console.log("hello")',
			path: '/test/project/src/test.ts',
		});

		const first = result.current.memoizedFilePreviewFile;
		// Rerender with a new but value-equal tab to verify memo stability on object identity change
		rerender({ tab: makeFileTab() });
		expect(result.current.memoizedFilePreviewFile).toBe(first); // Same reference
	});

	it('does not match sibling path prefixes for filePreviewCwd', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession({ fullPath: '/test/project' }),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab({ path: '/test/project2/src/foo.ts' }),
			})
		);
		expect(result.current.filePreviewCwd).toBe('');
	});

	it('computes filePreviewCwd from session path', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession({ fullPath: '/test/project' }),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab({ path: '/test/project/src/utils/test.ts' }),
			})
		);
		expect(result.current.filePreviewCwd).toBe('src/utils');
	});

	it('returns empty cwd when file is at project root', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession({ fullPath: '/test/project' }),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab({ path: '/test/project/test.ts' }),
			})
		);
		expect(result.current.filePreviewCwd).toBe('');
	});

	it('handleFilePreviewClose calls onFileTabClose', () => {
		const onClose = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
				onFileTabClose: onClose,
			})
		);

		act(() => result.current.handleFilePreviewClose());
		expect(onClose).toHaveBeenCalledWith('file-1');
	});

	it('handleFilePreviewEditModeChange calls onFileTabEditModeChange', () => {
		const onEditMode = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
				onFileTabEditModeChange: onEditMode,
			})
		);

		act(() => result.current.handleFilePreviewEditModeChange(true));
		expect(onEditMode).toHaveBeenCalledWith('file-1', true);
	});

	it('handleFilePreviewSave writes file and clears edit content', async () => {
		const onEditContent = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
				onFileTabEditContentChange: onEditContent,
			})
		);

		await act(async () => {
			await result.current.handleFilePreviewSave('/test/project/src/test.ts', 'new content');
		});

		expect(mockWriteFile).toHaveBeenCalledWith(
			'/test/project/src/test.ts',
			'new content',
			undefined
		);
		expect(onEditContent).toHaveBeenCalledWith('file-1', undefined, 'new content');
	});

	it('handleFilePreviewSave passes sshRemoteId for SSH-backed previews', async () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'ssh-remote-1' },
				} as any),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
			})
		);

		await act(async () => {
			await result.current.handleFilePreviewSave('/test/project/src/test.ts', 'content');
		});

		expect(mockWriteFile).toHaveBeenCalledWith(
			'/test/project/src/test.ts',
			'content',
			'ssh-remote-1'
		);
	});

	it('handleFilePreviewEditContentChange detects changes', () => {
		const onEditContent = vi.fn();
		const tab = makeFileTab({ content: 'original' });
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: tab,
				onFileTabEditContentChange: onEditContent,
			})
		);

		act(() => result.current.handleFilePreviewEditContentChange('modified'));
		expect(onEditContent).toHaveBeenCalledWith('file-1', 'modified');
	});

	it('handleFilePreviewEditContentChange clears when content matches original', () => {
		const onEditContent = vi.fn();
		const tab = makeFileTab({ content: 'original' });
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: tab,
				onFileTabEditContentChange: onEditContent,
			})
		);

		act(() => result.current.handleFilePreviewEditContentChange('original'));
		expect(onEditContent).toHaveBeenCalledWith('file-1', undefined);
	});

	it('handleFilePreviewScrollPositionChange delegates correctly', () => {
		const onScroll = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
				onFileTabScrollPositionChange: onScroll,
			})
		);

		act(() => result.current.handleFilePreviewScrollPositionChange(150));
		expect(onScroll).toHaveBeenCalledWith('file-1', 150);
	});

	it('handleFilePreviewSearchQueryChange delegates correctly', () => {
		const onSearch = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
				onFileTabSearchQueryChange: onSearch,
			})
		);

		act(() => result.current.handleFilePreviewSearchQueryChange('search term'));
		expect(onSearch).toHaveBeenCalledWith('file-1', 'search term');
	});

	it('handleFilePreviewReload delegates correctly', () => {
		const onReload = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
				onReloadFileTab: onReload,
			})
		);

		act(() => result.current.handleFilePreviewReload());
		expect(onReload).toHaveBeenCalledWith('file-1');
	});

	it('resolves sshRemoteId from session', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession({ sshRemoteId: 'ssh-1' } as any),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
			})
		);
		expect(result.current.filePreviewSshRemoteId).toBe('ssh-1');
	});

	it('resolves sshRemoteId from sessionSshRemoteConfig', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-2' },
				} as any),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
			})
		);
		expect(result.current.filePreviewSshRemoteId).toBe('remote-2');
	});

	it('returns undefined sshRemoteId when no SSH configured', () => {
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: 'file-1',
				activeFileTab: makeFileTab(),
			})
		);
		expect(result.current.filePreviewSshRemoteId).toBeUndefined();
	});

	it('does not call handlers when activeFileTabId is null', () => {
		const onClose = vi.fn();
		const { result } = renderHook(() =>
			useFilePreviewHandlers({
				activeSession: makeSession(),
				activeFileTabId: null,
				activeFileTab: null,
				onFileTabClose: onClose,
			})
		);

		act(() => result.current.handleFilePreviewClose());
		expect(onClose).not.toHaveBeenCalled();
	});

	describe('save-as for untitled files', () => {
		it('shows save dialog when path is empty', async () => {
			mockSaveFile.mockResolvedValue('/test/project/newfile.md');
			const session = makeSession();
			// Set up session store so the save-as handler can update tab metadata
			useSessionStore.setState({
				sessions: [
					{
						...session,
						filePreviewTabs: [
							makeFileTab({ id: 'file-1', path: '', name: 'Untitled', extension: '', content: '' }),
						],
						activeFileTabId: 'file-1',
					} as Session,
				],
				activeSessionId: 'session-1',
			});

			const { result } = renderHook(() =>
				useFilePreviewHandlers({
					activeSession: session,
					activeFileTabId: 'file-1',
					activeFileTab: makeFileTab({ id: 'file-1', path: '', name: 'Untitled', extension: '' }),
				})
			);

			await act(async () => {
				await result.current.handleFilePreviewSave('', 'hello world');
			});

			expect(mockSaveFile).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save File' }));
			expect(mockWriteFile).toHaveBeenCalledWith(
				'/test/project/newfile.md',
				'hello world',
				undefined
			);
		});

		it('returns false and does not write when save dialog is cancelled', async () => {
			mockSaveFile.mockResolvedValue(null);

			const { result } = renderHook(() =>
				useFilePreviewHandlers({
					activeSession: makeSession(),
					activeFileTabId: 'file-1',
					activeFileTab: makeFileTab({ id: 'file-1', path: '', name: 'Untitled', extension: '' }),
				})
			);

			let saveResult: boolean | void;
			await act(async () => {
				saveResult = await result.current.handleFilePreviewSave('', 'hello world');
			});

			expect(saveResult!).toBe(false);
			expect(mockSaveFile).toHaveBeenCalled();
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		it('updates tab metadata after save-as', async () => {
			mockSaveFile.mockResolvedValue('/test/project/src/notes.md');
			const session = makeSession();
			useSessionStore.setState({
				sessions: [
					{
						...session,
						filePreviewTabs: [
							makeFileTab({ id: 'file-1', path: '', name: 'Untitled', extension: '', content: '' }),
						],
						activeFileTabId: 'file-1',
					} as Session,
				],
				activeSessionId: 'session-1',
			});

			const { result } = renderHook(() =>
				useFilePreviewHandlers({
					activeSession: session,
					activeFileTabId: 'file-1',
					activeFileTab: makeFileTab({ id: 'file-1', path: '', name: 'Untitled', extension: '' }),
				})
			);

			await act(async () => {
				await result.current.handleFilePreviewSave('', 'my notes');
			});

			const updatedSession = useSessionStore.getState().sessions[0];
			const updatedTab = updatedSession.filePreviewTabs.find(
				(t: FilePreviewTab) => t.id === 'file-1'
			);
			expect(updatedTab).toMatchObject({
				path: '/test/project/src/notes.md',
				name: 'notes',
				extension: '.md',
				content: 'my notes',
				editContent: undefined,
			});
		});

		it('skips save dialog for files with existing path', async () => {
			const onEditContent = vi.fn();
			const { result } = renderHook(() =>
				useFilePreviewHandlers({
					activeSession: makeSession(),
					activeFileTabId: 'file-1',
					activeFileTab: makeFileTab(),
					onFileTabEditContentChange: onEditContent,
				})
			);

			await act(async () => {
				await result.current.handleFilePreviewSave('/test/project/src/test.ts', 'updated');
			});

			expect(mockSaveFile).not.toHaveBeenCalled();
			expect(mockWriteFile).toHaveBeenCalledWith('/test/project/src/test.ts', 'updated', undefined);
			expect(onEditContent).toHaveBeenCalledWith('file-1', undefined, 'updated');
		});
	});
});
