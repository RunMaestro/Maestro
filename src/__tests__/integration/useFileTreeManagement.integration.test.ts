/**
 * @file useFileTreeManagement.integration.test.ts
 * @description Integration tests for the useFileTreeManagement hook
 *
 * Tests cover:
 * - refreshFileTree success/error flows
 * - refreshGitFileState git metadata + history refresh
 * - filteredFileTree fuzzy filtering behavior
 * - initial file tree load on active session change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFileTreeManagement, type UseFileTreeManagementDeps } from '../../renderer/hooks';
import type { Session } from '../../renderer/types';
import type { FileNode } from '../../renderer/types/fileTree';
import type { RightPanelHandle } from '../../renderer/components/RightPanel';
import type { RefObject, SetStateAction } from 'react';
import {
	loadFileTree,
	loadFileTreeRemoteBatched,
	compareFileTrees,
	type FileTreeLoadResult,
} from '../../renderer/utils/fileExplorer';
import { gitService } from '../../renderer/services/git';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { logger } from '../../renderer/utils/logger';

vi.mock('../../renderer/utils/fileExplorer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../renderer/utils/fileExplorer')>();
	return {
		...actual,
		loadFileTree: vi.fn(),
		loadFileTreeRemoteBatched: vi.fn(),
		compareFileTrees: vi.fn(),
	};
});

vi.mock('../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
	},
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

// ============================================================================
// Test Helpers
// ============================================================================

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	cwd: '/test/project',
	fullPath: '/test/project',
	projectRoot: '/test/project',
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	contextUsage: 0,
	inputMode: 'ai',
	aiPid: 0,
	terminalPid: 0,
	port: 0,
	isLive: false,
	changedFiles: [],
	isGitRepo: false,
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	executionQueue: [],
	activeTimeMs: 0,
	aiTabs: [],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	...overrides,
});

const createSessionsState = (initialSessions: Session[]) => {
	let sessions = initialSessions;
	const sessionsRef = { current: sessions };
	const setSessions = vi.fn((updater: SetStateAction<Session[]>) => {
		sessions = typeof updater === 'function' ? updater(sessions) : updater;
		sessionsRef.current = sessions;
	});

	return {
		getSessions: () => sessions,
		sessionsRef,
		setSessions,
	};
};

const createDeps = (
	state: ReturnType<typeof createSessionsState>,
	overrides: Partial<UseFileTreeManagementDeps> = {}
): UseFileTreeManagementDeps => ({
	sessions: state.getSessions(),
	sessionsRef: state.sessionsRef,
	setSessions: state.setSessions,
	activeSessionId: state.getSessions()[0]?.id ?? null,
	activeSession: state.getSessions()[0] ?? null,
	rightPanelRef: { current: { refreshHistoryPanel: vi.fn() } },
	...overrides,
});

const createDeferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
};

const createLoadResult = (
	tree: FileNode[],
	overrides: Partial<FileTreeLoadResult> = {}
): FileTreeLoadResult => ({
	tree,
	truncated: false,
	filesFound: tree.length,
	...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('useFileTreeManagement', () => {
	let originalHistory: typeof window.maestro.history | undefined;
	let originalFs: typeof window.maestro.fs | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		useFileExplorerStore.setState({ fileTreeFilter: '' });
		originalHistory = window.maestro.history as typeof window.maestro.history | undefined;
		originalFs = window.maestro.fs as typeof window.maestro.fs | undefined;
		window.maestro = {
			...window.maestro,
			history: {
				reload: vi.fn().mockResolvedValue(true),
			},
			fs: {
				...window.maestro.fs,
				directorySize: vi.fn().mockResolvedValue({
					fileCount: 3,
					folderCount: 1,
					totalSize: 1024,
				}),
			},
		};
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalHistory) {
			window.maestro.history = originalHistory;
		} else {
			delete (window.maestro as { history?: unknown }).history;
		}
		if (originalFs) {
			window.maestro.fs = originalFs;
		} else {
			delete (window.maestro as { fs?: unknown }).fs;
		}
	});

	it('refreshFileTree updates tree and returns changes', async () => {
		const nextTree: FileNode[] = [{ name: 'new.txt', type: 'file' }];
		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
		});
		const changes = {
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(loadFileTree).mockResolvedValue(createLoadResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		const state = createSessionsState([createMockSession({ fileTree: undefined }), siblingSession]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: typeof changes | undefined;
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		// For local sessions (no sshRemoteId), sshContext and localOptions are undefined
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100000,
			undefined
		);
		expect(compareFileTrees).toHaveBeenCalledWith([], nextTree);
		expect(returnedChanges).toEqual(changes);
		expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		expect(state.getSessions()[0].fileTreeError).toBeUndefined();
		expect(state.getSessions()[1]).toBe(siblingSession);
	});

	it('refreshFileTree handles load errors', async () => {
		vi.mocked(loadFileTree).mockRejectedValue(new Error('boom'));

		const state = createSessionsState([
			createMockSession({ fileTree: [{ name: 'keep', type: 'file' }] }),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: unknown;
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		expect(returnedChanges).toBeUndefined();
		// Refresh errors preserve the existing file tree (transient failures shouldn't wipe data)
		expect(state.getSessions()[0].fileTree).toEqual([{ name: 'keep', type: 'file' }]);
	});

	it('refreshFileTree logs unknown load and stats failures', async () => {
		vi.mocked(window.maestro.fs.directorySize).mockRejectedValue(undefined);
		vi.mocked(loadFileTree).mockRejectedValue(undefined);

		const state = createSessionsState([
			createMockSession({ fileTree: [{ name: 'keep', type: 'file' }] }),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		await waitFor(() => {
			expect(logger.warn).toHaveBeenCalledWith(
				'directorySize failed during refresh (non-fatal)',
				'FileTreeManagement',
				{ error: 'Unknown error' }
			);
		});
		expect(logger.error).toHaveBeenCalledWith('File tree refresh error', 'FileTreeManagement', {
			error: 'Unknown error',
		});
		expect(state.getSessions()[0].fileTree).toEqual([{ name: 'keep', type: 'file' }]);
	});

	it('refreshFileTree returns undefined without touching loaders for a missing session', async () => {
		const state = createSessionsState([
			createMockSession({
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: unknown = 'not-called';
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree('missing-session');
		});

		expect(returnedChanges).toBeUndefined();
		expect(loadFileTree).not.toHaveBeenCalled();
		expect(window.maestro.fs.directorySize).not.toHaveBeenCalled();
	});

	it('refreshFileTree uses session SSH fallback, local options, and keeps stats when size fails', async () => {
		const initialTree: FileNode[] = [{ name: 'old.txt', type: 'file' }];
		const nextTree: FileNode[] = [{ name: 'remote-new.txt', type: 'file' }];
		const existingStats = { fileCount: 9, folderCount: 2, totalSize: 2048 };
		const changes = {
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(window.maestro.fs.directorySize).mockRejectedValue(new Error('du failed'));
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValue(createLoadResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		const session = createMockSession({
			cwd: '/fallback/project',
			fileTree: initialTree,
			fileTreeStats: existingStats,
			projectRoot: undefined,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-from-session',
				workingDirOverride: '/remote/work',
			},
		});
		const state = createSessionsState([session]);
		const deps = createDeps(state, {
			localHonorGitignore: false,
			localIgnorePatterns: ['node_modules'],
			sshRemoteHonorGitignore: true,
			sshRemoteIgnorePatterns: ['dist'],
		});
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshFileTree(session.id);
		});

		expect(window.maestro.fs.directorySize).toHaveBeenCalledWith(
			'/fallback/project',
			'remote-from-session',
			['node_modules'],
			false
		);
		expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
			'/fallback/project',
			expect.objectContaining({
				maxDepth: 5,
				maxEntries: 100000,
				sshRemoteId: 'remote-from-session',
				ignorePatterns: ['dist'],
				honorGitignore: true,
			})
		);
		expect(logger.warn).toHaveBeenCalledWith(
			'directorySize failed during refresh (non-fatal)',
			'FileTreeManagement',
			{ error: 'du failed' }
		);
		expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		expect(state.getSessions()[0].fileTreeStats).toEqual(existingStats);
	});

	it('refreshFileTree discards stale results when a newer refresh starts first', async () => {
		const staleTree = createDeferred<FileTreeLoadResult>();
		const freshTree: FileNode[] = [{ name: 'fresh.txt', type: 'file' }];
		vi.mocked(loadFileTree)
			.mockReturnValueOnce(staleTree.promise)
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let staleRefresh: Promise<unknown>;
		let freshRefresh: Promise<unknown>;
		await act(async () => {
			staleRefresh = result.current.refreshFileTree('session-1');
			freshRefresh = result.current.refreshFileTree('session-1');
			await freshRefresh;
			staleTree.resolve(createLoadResult([{ name: 'stale.txt', type: 'file' }]));
			await staleRefresh;
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(compareFileTrees).toHaveBeenCalledTimes(1);
	});

	it('refreshFileTree discards stale results when a newer refresh starts while stats are pending', async () => {
		const staleStats = createDeferred<{
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}>();
		const freshTree: FileNode[] = [{ name: 'fresh-after-stats.txt', type: 'file' }];
		vi.mocked(window.maestro.fs.directorySize)
			.mockReturnValueOnce(staleStats.promise)
			.mockResolvedValueOnce({ fileCount: 2, folderCount: 1, totalSize: 24 });
		vi.mocked(loadFileTree)
			.mockResolvedValueOnce(createLoadResult([{ name: 'stale-after-stats.txt', type: 'file' }]))
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let staleRefresh: Promise<unknown>;
		let freshRefresh: Promise<unknown>;
		await act(async () => {
			staleRefresh = result.current.refreshFileTree('session-1');
			await Promise.resolve();
			freshRefresh = result.current.refreshFileTree('session-1');
			await freshRefresh;
			staleStats.resolve({ fileCount: 99, folderCount: 9, totalSize: 999 });
			await staleRefresh;
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(state.getSessions()[0].fileTreeStats).toEqual({
			fileCount: 2,
			folderCount: 1,
			totalSize: 24,
		});
		expect(compareFileTrees).toHaveBeenCalledTimes(2);
	});

	it('refreshGitFileState refreshes git metadata and history', async () => {
		const nextTree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];

		vi.mocked(loadFileTree).mockResolvedValue(createLoadResult(nextTree));
		vi.mocked(gitService.isRepo).mockResolvedValue(true);
		vi.mocked(gitService.getBranches).mockResolvedValue(['main']);
		vi.mocked(gitService.getTags).mockResolvedValue(['v1.0.0']);

		const session = createMockSession({
			inputMode: 'terminal',
			shellCwd: '/test/shell',
			fileTree: [{ name: 'existing', type: 'file' }],
		});
		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
		});
		const state = createSessionsState([session, siblingSession]);
		const rightPanelRef: RefObject<RightPanelHandle | null> = {
			current: { refreshHistoryPanel: vi.fn() },
		};
		const deps = createDeps(state, { rightPanelRef });
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState(session.id);
		});

		// loadFileTree always uses projectRoot (treeRoot), not shellCwd
		// Git operations use shellCwd when inputMode is 'terminal'
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100000,
			undefined
		);
		expect(gitService.isRepo).toHaveBeenCalledWith('/test/shell', undefined);
		expect(gitService.getBranches).toHaveBeenCalledWith('/test/shell', undefined);
		expect(gitService.getTags).toHaveBeenCalledWith('/test/shell', undefined);
		expect(window.maestro.history.reload).toHaveBeenCalled();
		expect(rightPanelRef.current?.refreshHistoryPanel).toHaveBeenCalled();

		const updated = state.getSessions()[0];
		expect(updated.fileTree).toEqual(nextTree);
		expect(updated.isGitRepo).toBe(true);
		expect(updated.gitBranches).toEqual(['main']);
		expect(updated.gitTags).toEqual(['v1.0.0']);
		expect(updated.gitRefsCacheTime).toEqual(expect.any(Number));
		expect(state.getSessions()[1]).toBe(siblingSession);
	});

	it('refreshGitFileState returns without work for a missing session', async () => {
		const state = createSessionsState([
			createMockSession({
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState('missing-session');
		});

		expect(loadFileTree).not.toHaveBeenCalled();
		expect(gitService.isRepo).not.toHaveBeenCalled();
		expect(window.maestro.history.reload).not.toHaveBeenCalled();
	});

	it('refreshGitFileState skips refs for non-git folders and preserves stats when size fails', async () => {
		const existingStats = { fileCount: 4, folderCount: 1, totalSize: 512 };
		const nextTree: FileNode[] = [{ name: 'plain.txt', type: 'file' }];

		vi.mocked(window.maestro.fs.directorySize).mockRejectedValue(new Error('du failed'));
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValue(createLoadResult(nextTree));
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const session = createMockSession({
			cwd: '/repo/work',
			fileTree: [{ name: 'old.txt', type: 'file' }],
			fileTreeStats: existingStats,
			projectRoot: undefined,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-git',
				workingDirOverride: '/remote/repo',
			},
		});
		const state = createSessionsState([session]);
		const rightPanelRef: RefObject<RightPanelHandle | null> = {
			current: null,
		};
		const deps = createDeps(state, {
			rightPanelRef,
			sshRemoteHonorGitignore: false,
			sshRemoteIgnorePatterns: ['vendor'],
		});
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState(session.id);
		});

		expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
			'/repo/work',
			expect.objectContaining({
				maxDepth: 5,
				maxEntries: 100000,
				sshRemoteId: 'remote-git',
				ignorePatterns: ['vendor'],
				honorGitignore: false,
			})
		);
		expect(gitService.isRepo).toHaveBeenCalledWith('/repo/work', 'remote-git');
		expect(gitService.getBranches).not.toHaveBeenCalled();
		expect(gitService.getTags).not.toHaveBeenCalled();
		expect(window.maestro.history.reload).toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			'directorySize failed during git refresh (non-fatal)',
			'FileTreeManagement',
			{ error: 'du failed' }
		);

		const updated = state.getSessions()[0];
		expect(updated.fileTree).toEqual(nextTree);
		expect(updated.fileTreeStats).toEqual(existingStats);
		expect(updated.isGitRepo).toBe(false);
		expect(updated.gitBranches).toBeUndefined();
		expect(updated.gitTags).toBeUndefined();
		expect(updated.gitRefsCacheTime).toBeUndefined();
	});

	it('refreshGitFileState logs failures and preserves the existing tree', async () => {
		vi.mocked(loadFileTree).mockRejectedValue(undefined);
		vi.mocked(gitService.isRepo).mockResolvedValue(true);

		const existingTree: FileNode[] = [{ name: 'keep.txt', type: 'file' }];
		const state = createSessionsState([
			createMockSession({
				fileTree: existingTree,
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState('session-1');
		});

		expect(logger.error).toHaveBeenCalledWith(
			'Git/file state refresh error',
			'FileTreeManagement',
			{ error: 'Unknown error' }
		);
		expect(state.getSessions()[0].fileTree).toEqual(existingTree);
		expect(window.maestro.history.reload).not.toHaveBeenCalled();
	});

	it('refreshGitFileState discards stale git results when a newer refresh starts first', async () => {
		const staleTree = createDeferred<FileTreeLoadResult>();
		const freshTree: FileNode[] = [{ name: 'fresh-git.txt', type: 'file' }];
		vi.mocked(loadFileTree)
			.mockReturnValueOnce(staleTree.promise)
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let staleRefresh: Promise<void>;
		let freshRefresh: Promise<void>;
		await act(async () => {
			staleRefresh = result.current.refreshGitFileState('session-1');
			freshRefresh = result.current.refreshGitFileState('session-1');
			await freshRefresh;
			staleTree.resolve(createLoadResult([{ name: 'stale-git.txt', type: 'file' }]));
			await staleRefresh;
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(window.maestro.history.reload).toHaveBeenCalledTimes(1);
	});

	it('refreshGitFileState discards stale git results when stats finish after a newer refresh', async () => {
		const staleStats = createDeferred<{
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}>();
		const freshTree: FileNode[] = [{ name: 'fresh-git-stats.txt', type: 'file' }];
		vi.mocked(window.maestro.fs.directorySize)
			.mockReturnValueOnce(staleStats.promise)
			.mockResolvedValueOnce({ fileCount: 3, folderCount: 1, totalSize: 48 });
		vi.mocked(loadFileTree)
			.mockResolvedValueOnce(createLoadResult([{ name: 'stale-git-stats.txt', type: 'file' }]))
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let staleRefresh: Promise<void>;
		let freshRefresh: Promise<void>;
		await act(async () => {
			staleRefresh = result.current.refreshGitFileState('session-1');
			await Promise.resolve();
			freshRefresh = result.current.refreshGitFileState('session-1');
			await freshRefresh;
			staleStats.resolve({ fileCount: 99, folderCount: 9, totalSize: 999 });
			await staleRefresh;
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(state.getSessions()[0].fileTreeStats).toEqual({
			fileCount: 3,
			folderCount: 1,
			totalSize: 48,
		});
		expect(window.maestro.history.reload).toHaveBeenCalledTimes(1);
	});

	it('refreshGitFileState keeps newer git data when an older stats response resolves late', async () => {
		const staleStats = createDeferred<{
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}>();
		const freshTree: FileNode[] = [{ name: 'fresh-after-git-stats.txt', type: 'file' }];
		vi.mocked(window.maestro.fs.directorySize)
			.mockReturnValueOnce(staleStats.promise)
			.mockResolvedValueOnce({ fileCount: 4, folderCount: 1, totalSize: 64 });
		vi.mocked(loadFileTree)
			.mockResolvedValueOnce(
				createLoadResult([{ name: 'stale-after-git-stats.txt', type: 'file' }])
			)
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let staleRefresh: Promise<void>;
		await act(async () => {
			staleRefresh = result.current.refreshGitFileState('session-1');
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			await result.current.refreshGitFileState('session-1');
		});

		await act(async () => {
			staleStats.resolve({ fileCount: 99, folderCount: 9, totalSize: 999 });
			await staleRefresh;
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(state.getSessions()[0].fileTreeStats).toEqual({
			fileCount: 4,
			folderCount: 1,
			totalSize: 64,
		});
		expect(window.maestro.history.reload).toHaveBeenCalledTimes(2);
	});

	it('refreshGitFileState discards stale git refs that finish after a newer refresh', async () => {
		const staleBranches = createDeferred<string[]>();
		const staleTags = createDeferred<string[]>();
		const freshTree: FileNode[] = [{ name: 'fresh-after-refs.txt', type: 'file' }];
		vi.mocked(window.maestro.fs.directorySize)
			.mockResolvedValueOnce({ fileCount: 2, folderCount: 1, totalSize: 24 })
			.mockResolvedValueOnce({ fileCount: 5, folderCount: 2, totalSize: 80 });
		vi.mocked(loadFileTree)
			.mockResolvedValueOnce(createLoadResult([{ name: 'stale-after-refs.txt', type: 'file' }]))
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(gitService.isRepo).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		vi.mocked(gitService.getBranches).mockReturnValueOnce(staleBranches.promise);
		vi.mocked(gitService.getTags).mockReturnValueOnce(staleTags.promise);

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let staleRefresh: Promise<void>;
		await act(async () => {
			staleRefresh = result.current.refreshGitFileState('session-1');
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			await result.current.refreshGitFileState('session-1');
		});

		await act(async () => {
			staleBranches.resolve(['stale-main']);
			staleTags.resolve(['stale-v1']);
			await staleRefresh;
		});

		const updated = state.getSessions()[0];
		expect(updated.fileTree).toEqual(freshTree);
		expect(updated.isGitRepo).toBe(false);
		expect(updated.gitBranches).toBeUndefined();
		expect(updated.gitTags).toBeUndefined();
		expect(window.maestro.history.reload).toHaveBeenCalledTimes(1);
	});

	it('refreshGitFileState uses cwd for terminal git operations when shellCwd is missing', async () => {
		vi.mocked(loadFileTree).mockResolvedValue(
			createLoadResult([{ name: 'terminal.txt', type: 'file' }])
		);
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const state = createSessionsState([
			createMockSession({
				inputMode: 'terminal',
				shellCwd: undefined,
				cwd: '/terminal/cwd',
				projectRoot: '/tree/root',
			}),
		]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState('session-1');
		});

		expect(loadFileTree).toHaveBeenCalledWith(
			'/tree/root',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100000,
			undefined
		);
		expect(gitService.isRepo).toHaveBeenCalledWith('/terminal/cwd', undefined);
	});

	it('refreshGitFileState logs unknown directory size failures without blocking git refresh', async () => {
		vi.mocked(window.maestro.fs.directorySize).mockRejectedValue(undefined);
		vi.mocked(loadFileTree).mockResolvedValue(
			createLoadResult([{ name: 'git-unknown-stats.txt', type: 'file' }])
		);
		vi.mocked(gitService.isRepo).mockResolvedValue(false);

		const state = createSessionsState([createMockSession()]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshGitFileState('session-1');
		});

		expect(logger.warn).toHaveBeenCalledWith(
			'directorySize failed during git refresh (non-fatal)',
			'FileTreeManagement',
			{ error: 'Unknown error' }
		);
		expect(state.getSessions()[0].fileTree).toEqual([
			{ name: 'git-unknown-stats.txt', type: 'file' },
		]);
	});

	it('filters file tree by fuzzy match and keeps matching folders', () => {
		const fileTree: FileNode[] = [
			{
				name: 'docs',
				type: 'folder',
				children: [
					{ name: 'readme.md', type: 'file' },
					{ name: 'guide.txt', type: 'file' },
				],
			},
			{
				name: 'src',
				type: 'folder',
				children: [{ name: 'index.ts', type: 'file' }],
			},
			{ name: 'notes.txt', type: 'file' },
		];

		useFileExplorerStore.setState({ fileTreeFilter: 'read' });
		const state = createSessionsState([createMockSession({ fileTree })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		expect(result.current.filteredFileTree).toEqual([
			{
				name: 'docs',
				type: 'folder',
				children: [{ name: 'readme.md', type: 'file' }],
			},
		]);
	});

	it('loads file tree on mount when active session tree is empty', async () => {
		const nextTree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];

		vi.mocked(loadFileTree).mockResolvedValue(createLoadResult(nextTree));

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			// loadFileTree is now called with (path, maxDepth, currentDepth, sshContext)
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				5,
				0,
				undefined,
				undefined,
				undefined,
				100000,
				expect.any(AbortSignal)
			);
			expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		});
	});

	it('streams SSH load progress and keeps loading successful when stats fail', async () => {
		const nextTree: FileNode[] = [{ name: 'remote-loaded.txt', type: 'file' }];
		let progressSnapshot: unknown;
		let state: ReturnType<typeof createSessionsState>;

		vi.mocked(window.maestro.fs.directorySize).mockRejectedValue(new Error('du timeout'));
		vi.mocked(loadFileTree).mockResolvedValue(createLoadResult([]));
		vi.mocked(loadFileTreeRemoteBatched).mockImplementation(async (_root, options) => {
			options.onProgress?.({
				directoriesScanned: 2,
				filesFound: 5,
				currentDirectory: '/remote/work/src',
			});
			progressSnapshot = state.getSessions()[0].fileTreeLoadingProgress;
			return createLoadResult(nextTree);
		});

		const session = createMockSession({
			fileTree: [],
			projectRoot: undefined,
			sshRemoteId: 'remote-load',
			remoteCwd: '/remote/work',
		});
		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
		});
		state = createSessionsState([session, siblingSession]);
		const deps = createDeps(state, {
			localHonorGitignore: true,
			localIgnorePatterns: ['coverage'],
		});

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		});

		expect(progressSnapshot).toEqual({
			directoriesScanned: 2,
			filesFound: 5,
			currentDirectory: '/remote/work/src',
		});
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			1,
			0,
			{
				sshRemoteId: 'remote-load',
				remoteCwd: '/remote/work',
				ignorePatterns: undefined,
				honorGitignore: undefined,
			},
			undefined,
			{
				ignorePatterns: ['coverage'],
				honorGitignore: true,
			},
			Number.POSITIVE_INFINITY,
			expect.any(AbortSignal)
		);
		expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
			'/test/project',
			expect.objectContaining({
				maxDepth: 5,
				maxEntries: 100000,
				sshRemoteId: 'remote-load',
				ignorePatterns: [],
				honorGitignore: false,
				signal: expect.any(AbortSignal),
				onProgress: expect.any(Function),
				onPhase: expect.any(Function),
			})
		);
		expect(window.maestro.fs.directorySize).toHaveBeenCalledWith(
			'/test/project',
			'remote-load',
			['coverage'],
			true
		);
		expect(logger.warn).toHaveBeenCalledWith(
			'directorySize failed (non-fatal)',
			'FileTreeManagement',
			{ error: 'du timeout' }
		);
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();
		expect(state.getSessions()[0].fileTreeLoadingProgress).toBeUndefined();
		expect(state.getSessions()[1]).toBe(siblingSession);
	});

	it('keeps newer refresh data when an initial load becomes stale while awaiting stats', async () => {
		const initialStats = createDeferred<{
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}>();
		const freshTree: FileNode[] = [{ name: 'fresh-after-initial-stats.txt', type: 'file' }];
		vi.mocked(window.maestro.fs.directorySize)
			.mockReturnValueOnce(initialStats.promise)
			.mockResolvedValueOnce({ fileCount: 6, folderCount: 2, totalSize: 96 });
		vi.mocked(loadFileTree)
			.mockResolvedValueOnce(createLoadResult([{ name: 'stale-initial.txt', type: 'file' }]))
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});

		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
		});
		const state = createSessionsState([createMockSession({ fileTree: [] }), siblingSession]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(loadFileTree).toHaveBeenCalledTimes(1);
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			await result.current.refreshFileTree('session-1');
		});
		expect(state.getSessions()[0].fileTree).toEqual(freshTree);

		await act(async () => {
			initialStats.resolve({ fileCount: 99, folderCount: 9, totalSize: 999 });
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		expect(state.getSessions()[0].fileTreeLoadingProgress).toBeUndefined();
		expect(state.getSessions()[1]).toBe(siblingSession);
	});

	it('does not report stale initial-load failures after a newer refresh succeeds', async () => {
		const staleInitialTree = createDeferred<FileTreeLoadResult>();
		const freshTree: FileNode[] = [{ name: 'fresh-after-initial-error.txt', type: 'file' }];
		vi.mocked(loadFileTree)
			.mockReturnValueOnce(staleInitialTree.promise)
			.mockResolvedValueOnce(createLoadResult(freshTree));
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});

		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
		});
		const state = createSessionsState([createMockSession({ fileTree: [] }), siblingSession]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(loadFileTree).toHaveBeenCalledTimes(1);
		});

		await act(async () => {
			await result.current.refreshFileTree('session-1');
		});

		await act(async () => {
			staleInitialTree.reject(new Error('stale initial failure'));
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(state.getSessions()[0].fileTree).toEqual(freshTree);
		expect(state.getSessions()[0].fileTreeError).toBeUndefined();
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		expect(state.getSessions()[1]).toBe(siblingSession);
		expect(logger.error).not.toHaveBeenCalledWith(
			'File tree error',
			'FileTreeManagement',
			expect.anything()
		);
	});

	it('logs unknown directorySize errors during initial load without failing the tree load', async () => {
		const nextTree: FileNode[] = [{ name: 'loaded-without-stats.txt', type: 'file' }];
		vi.mocked(window.maestro.fs.directorySize).mockRejectedValue(undefined);
		vi.mocked(loadFileTree).mockResolvedValue(createLoadResult(nextTree));

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		});

		expect(logger.warn).toHaveBeenCalledWith(
			'directorySize failed (non-fatal)',
			'FileTreeManagement',
			{
				error: 'Unknown error',
			}
		);
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();
	});

	it('sets retry state when initial file tree load fails without an error message', async () => {
		vi.mocked(loadFileTree).mockRejectedValue(undefined);
		const beforeRetryAt = Date.now() + 20000;

		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
		});
		const state = createSessionsState([createMockSession({ fileTree: [] }), siblingSession]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTreeError).toBe(
				'Cannot access directory: /test/project\nUnknown error'
			);
		});
		expect(state.getSessions()[0].fileTree).toEqual([]);
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		expect(state.getSessions()[0].fileTreeLoadingProgress).toBeUndefined();
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();
		expect(state.getSessions()[0].fileTreeRetryAt).toBeGreaterThanOrEqual(beforeRetryAt);
		expect(state.getSessions()[0].fileTreeRetryAt).toBeLessThanOrEqual(Date.now() + 20000);
		expect(state.getSessions()[1]).toBe(siblingSession);
		expect(logger.error).toHaveBeenCalledWith('File tree error', 'FileTreeManagement', {
			error: 'Unknown error',
		});
	});

	it('honors retry backoff and clears the retry marker when the timer expires', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const retryAt = new Date('2026-01-01T00:00:01.000Z').getTime();

		const state = createSessionsState([
			createMockSession({
				fileTree: [],
				fileTreeRetryAt: retryAt,
			}),
			createMockSession({
				id: 'session-2',
				fileTree: [{ name: 'sibling.txt', type: 'file' }],
			}),
		]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		expect(loadFileTree).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

		act(() => {
			vi.advanceTimersByTime(1000);
		});

		expect(state.getSessions()[0].fileTreeRetryAt).toBeUndefined();
		expect(state.getSessions()[1].fileTree).toEqual([{ name: 'sibling.txt', type: 'file' }]);
	});

	it('does not schedule duplicate retry timers while already in backoff', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const retryAt = new Date('2026-01-01T00:00:05.000Z').getTime();

		const state = createSessionsState([
			createMockSession({
				fileTree: [],
				fileTreeRetryAt: retryAt,
			}),
		]);
		const { rerender } = renderHook((props) => useFileTreeManagement(props), {
			initialProps: createDeps(state),
		});

		const timerCountBeforeRerender = vi.getTimerCount();
		expect(timerCountBeforeRerender).toBeGreaterThanOrEqual(1);

		rerender(createDeps(state, { localIgnorePatterns: ['tmp'] }));

		expect(loadFileTree).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(timerCountBeforeRerender);
	});

	it('clears pending retry timers on unmount', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

		const state = createSessionsState([
			createMockSession({
				fileTree: [],
				fileTreeRetryAt: new Date('2026-01-01T00:00:05.000Z').getTime(),
			}),
		]);
		const deps = createDeps(state);

		const { unmount } = renderHook(() => useFileTreeManagement(deps));

		expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
		unmount();

		expect(clearTimeoutSpy).toHaveBeenCalled();
		clearTimeoutSpy.mockRestore();
	});

	it('re-scans an already loaded active tree when local file options change', async () => {
		const nextTree: FileNode[] = [{ name: 'rescanned.txt', type: 'file' }];
		vi.mocked(loadFileTree).mockResolvedValue(createLoadResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue({
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		});

		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'old.txt', type: 'file' }],
				fileTreeStats: { fileCount: 1, folderCount: 0, totalSize: 12 },
			}),
		]);
		const initialDeps = createDeps(state);
		const { rerender } = renderHook((props) => useFileTreeManagement(props), {
			initialProps: initialDeps,
		});

		rerender(
			createDeps(state, {
				localHonorGitignore: true,
				localIgnorePatterns: ['tmp'],
			})
		);

		await waitFor(() => {
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				5,
				0,
				undefined,
				undefined,
				{
					ignorePatterns: ['tmp'],
					honorGitignore: true,
				},
				100000,
				undefined
			);
		});
		expect(state.getSessions()[0].fileTree).toEqual(nextTree);
	});

	it('does not load, migrate, or re-scan when no active session is available', () => {
		const state = createSessionsState([]);
		const initialDeps = createDeps(state);
		const { rerender } = renderHook((props) => useFileTreeManagement(props), {
			initialProps: initialDeps,
		});

		rerender(
			createDeps(state, {
				localIgnorePatterns: ['tmp'],
			})
		);

		expect(loadFileTree).not.toHaveBeenCalled();
		expect(window.maestro.fs.directorySize).not.toHaveBeenCalled();
	});

	it('does not re-scan on local option changes before a tree has stats', () => {
		const state = createSessionsState([
			createMockSession({
				fileTree: [{ name: 'loaded-without-stats.txt', type: 'file' }],
				fileTreeError: 'skip stats migration for this branch test',
				fileTreeStats: undefined,
			}),
		]);
		const initialDeps = createDeps(state);
		const { rerender } = renderHook((props) => useFileTreeManagement(props), {
			initialProps: initialDeps,
		});

		rerender(
			createDeps(state, {
				localIgnorePatterns: ['tmp'],
			})
		);

		expect(loadFileTree).not.toHaveBeenCalled();
	});

	it('passes SSH context when session has sshRemoteId', async () => {
		const nextTree: FileNode[] = [{ name: 'remote-file.txt', type: 'file' }];
		const changes = {
			totalChanges: 0,
			newFiles: 0,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValue(createLoadResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		// Create session with SSH context
		const sshSession = createMockSession({
			fileTree: [],
			sshRemoteId: 'my-ssh-remote',
			remoteCwd: '/remote/project',
		});
		const state = createSessionsState([sshSession]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		await act(async () => {
			await result.current.refreshFileTree(sshSession.id);
		});

		// Verify SSH context is passed to the batched remote loader.
		expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
			'/test/project',
			expect.objectContaining({
				maxDepth: 5,
				maxEntries: 100000,
				sshRemoteId: 'my-ssh-remote',
				honorGitignore: false,
				ignorePatterns: [],
			})
		);
	});

	it('fetches stats for sessions with file tree but no stats (migration)', async () => {
		// Mock directorySize for the migration
		const mockDirectorySize = vi.fn().mockResolvedValue({
			fileCount: 100,
			folderCount: 20,
			totalSize: 5000000,
		});

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		// Create session with file tree but no stats (simulating pre-Dec 2025 session)
		const sessionWithTreeNoStats = createMockSession({
			fileTree: [{ name: 'existing.txt', type: 'file' }],
			fileTreeStats: undefined,
			fileTreeError: undefined,
			fileTreeLoading: false,
		});
		const siblingSession = createMockSession({
			id: 'session-2',
			fileTree: [{ name: 'sibling.txt', type: 'file' }],
			fileTreeStats: undefined,
			fileTreeError: undefined,
			fileTreeLoading: false,
		});
		const state = createSessionsState([sessionWithTreeNoStats, siblingSession]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Wait for the migration effect to run
		await waitFor(() => {
			expect(mockDirectorySize).toHaveBeenCalledWith(
				'/test/project',
				undefined,
				undefined,
				undefined
			);
		});

		// Verify stats were populated
		await waitFor(() => {
			const updated = state.getSessions()[0];
			expect(updated.fileTreeStats).toEqual({
				fileCount: 100,
				folderCount: 20,
				totalSize: 5000000,
			});
		});
		expect(state.getSessions()[1]).toBe(siblingSession);

		// Restore original
		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('logs and preserves the existing tree when stats migration fails', async () => {
		const mockDirectorySize = vi.fn().mockRejectedValue(new Error('stat failed'));

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		const sessionWithTreeNoStats = createMockSession({
			fileTree: [{ name: 'existing.txt', type: 'file' }],
			fileTreeStats: undefined,
			fileTreeError: undefined,
			fileTreeLoading: false,
		});
		const state = createSessionsState([sessionWithTreeNoStats]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(logger.warn).toHaveBeenCalledWith('Stats migration failed', 'FileTreeManagement', {
				error: 'stat failed',
				sessionId: sessionWithTreeNoStats.id,
			});
		});
		expect(state.getSessions()[0].fileTree).toEqual([{ name: 'existing.txt', type: 'file' }]);
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();

		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('uses cwd and logs an unknown error when remote stats migration fails without an Error', async () => {
		const mockDirectorySize = vi.fn().mockRejectedValue(undefined);

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		const sessionWithTreeNoStats = createMockSession({
			cwd: '/fallback/cwd',
			projectRoot: undefined,
			fileTree: [{ name: 'existing.txt', type: 'file' }],
			fileTreeStats: undefined,
			fileTreeError: undefined,
			fileTreeLoading: false,
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'stats-remote',
				workingDirOverride: '/remote/stats',
			},
		});
		const state = createSessionsState([sessionWithTreeNoStats]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(mockDirectorySize).toHaveBeenCalledWith(
				'/fallback/cwd',
				'stats-remote',
				undefined,
				undefined
			);
		});
		await waitFor(() => {
			expect(logger.warn).toHaveBeenCalledWith('Stats migration failed', 'FileTreeManagement', {
				error: 'Unknown error',
				sessionId: sessionWithTreeNoStats.id,
			});
		});
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();

		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('does not fetch stats when session already has stats', async () => {
		const mockDirectorySize = vi.fn();

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		// Create session with both file tree and stats (no migration needed)
		const sessionWithStats = createMockSession({
			fileTree: [{ name: 'existing.txt', type: 'file' }],
			fileTreeStats: {
				fileCount: 50,
				folderCount: 10,
				totalSize: 1000000,
			},
		});
		const state = createSessionsState([sessionWithStats]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Migration should NOT run since stats exist
		// Give it a moment to not be called
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mockDirectorySize).not.toHaveBeenCalled();

		// Restore original
		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});
});
