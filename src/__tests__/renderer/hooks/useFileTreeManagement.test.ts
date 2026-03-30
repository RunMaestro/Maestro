/**
 * @file useFileTreeManagement.test.ts
 * @description Unit tests for the useFileTreeManagement hook
 *
 * Tests cover:
 * - refreshFileTree success/error flows
 * - refreshGitFileState git metadata + history refresh
 * - filteredFileTree fuzzy filtering behavior
 * - initial file tree load on active session change
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFileTreeManagement, type UseFileTreeManagementDeps } from '../../../renderer/hooks';
import type { Session } from '../../../renderer/types';
import type { FileNode } from '../../../renderer/types/fileTree';
import type { RightPanelHandle } from '../../../renderer/components/RightPanel';
import type { RefObject, SetStateAction } from 'react';
import { loadFileTree, compareFileTrees } from '../../../renderer/utils/fileExplorer';
import { gitService } from '../../../renderer/services/git';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

vi.mock('../../../renderer/utils/fileExplorer', () => ({
	loadFileTree: vi.fn(),
	compareFileTrees: vi.fn(),
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		isRepo: vi.fn(),
		getBranches: vi.fn(),
		getTags: vi.fn(),
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

// ============================================================================
// Tests
// ============================================================================

describe('useFileTreeManagement', () => {
	let originalHistory: typeof window.maestro.history | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		useFileExplorerStore.setState({ fileTreeFilter: '' });
		// Most tests assume sessions are loaded (safety timeout can fire)
		useSessionStore.setState({ sessionsLoaded: true });
		originalHistory = window.maestro.history as typeof window.maestro.history | undefined;
		window.maestro = {
			...window.maestro,
			history: {
				reload: vi.fn().mockResolvedValue(true),
			},
		};
	});

	afterEach(() => {
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });
		if (originalHistory) {
			window.maestro.history = originalHistory;
		} else {
			delete (window.maestro as { history?: unknown }).history;
		}
	});

	it('refreshFileTree updates tree and returns changes', async () => {
		const initialTree: FileNode[] = [{ name: 'old.txt', type: 'file' }];
		const nextTree: FileNode[] = [{ name: 'new.txt', type: 'file' }];
		const changes = {
			totalChanges: 1,
			newFiles: 1,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(loadFileTree).mockResolvedValue(nextTree);
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		const state = createSessionsState([createMockSession({ fileTree: initialTree })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: typeof changes | undefined;
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		// For local sessions (no sshRemoteId), sshContext and localOptions are undefined
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			10,
			0,
			undefined,
			undefined,
			undefined
		);
		expect(compareFileTrees).toHaveBeenCalledWith(initialTree, nextTree);
		expect(returnedChanges).toEqual(changes);
		expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		expect(state.getSessions()[0].fileTreeError).toBeUndefined();
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

	it('refreshGitFileState refreshes git metadata and history', async () => {
		const nextTree: FileNode[] = [{ name: 'src', type: 'folder', children: [] }];

		vi.mocked(loadFileTree).mockResolvedValue(nextTree);
		vi.mocked(gitService.isRepo).mockResolvedValue(true);
		vi.mocked(gitService.getBranches).mockResolvedValue(['main']);
		vi.mocked(gitService.getTags).mockResolvedValue(['v1.0.0']);

		const session = createMockSession({
			inputMode: 'terminal',
			shellCwd: '/test/shell',
			fileTree: [{ name: 'existing', type: 'file' }],
		});
		const state = createSessionsState([session]);
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
			10,
			0,
			undefined,
			undefined,
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

		vi.mocked(loadFileTree).mockResolvedValue(nextTree);

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			// loadFileTree is now called with (path, maxDepth, currentDepth, sshContext)
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				10,
				0,
				undefined,
				undefined,
				undefined
			);
			expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		});
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

		vi.mocked(loadFileTree).mockResolvedValue(nextTree);
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

		// Verify SSH context is passed to loadFileTree
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			10,
			0,
			{
				sshRemoteId: 'my-ssh-remote',
				remoteCwd: '/remote/project',
				honorGitignore: undefined,
				ignorePatterns: undefined,
			},
			undefined,
			undefined
		);
	});

	it('fires shallow load before full load for SSH sessions on initial mount', async () => {
		const shallowTree: FileNode[] = [
			{ name: 'src', type: 'folder', children: [] },
			{ name: 'README.md', type: 'file' },
		];
		const fullTree: FileNode[] = [
			{
				name: 'src',
				type: 'folder',
				children: [{ name: 'index.ts', type: 'file' }],
			},
			{ name: 'README.md', type: 'file' },
		];

		// First call (shallow, depth=1) returns quickly, second call (full, depth=10) returns later
		vi.mocked(loadFileTree).mockResolvedValueOnce(shallowTree).mockResolvedValueOnce(fullTree);

		const mockDirectorySize = vi.fn().mockResolvedValue({
			fileCount: 2,
			folderCount: 1,
			totalSize: 1000,
		});

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		const sshSession = createMockSession({
			fileTree: [],
			sshRemoteId: 'my-ssh-remote',
			remoteCwd: '/remote/project',
		});
		const state = createSessionsState([sshSession]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			// Shallow load should be called with depth=1
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				1,
				0,
				expect.objectContaining({ sshRemoteId: 'my-ssh-remote' }),
				undefined,
				undefined
			);
			// Full load should be called with depth=10
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				10,
				0,
				expect.objectContaining({ sshRemoteId: 'my-ssh-remote' }),
				expect.any(Function),
				undefined
			);
		});

		// After both complete, final tree should be the full tree
		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(fullTree);
			expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		});

		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('does not fire shallow load for local sessions on initial mount', async () => {
		const fullTree: FileNode[] = [{ name: 'loaded.txt', type: 'file' }];
		vi.mocked(loadFileTree).mockResolvedValue(fullTree);

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(fullTree);
		});

		// loadFileTree should only be called once (full load, no shallow pass)
		expect(loadFileTree).toHaveBeenCalledTimes(1);
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			10,
			0,
			undefined,
			undefined,
			undefined
		);
	});

	it('decouples stats from tree display in initial load', async () => {
		const fullTree: FileNode[] = [{ name: 'file.txt', type: 'file' }];

		// Tree resolves immediately
		vi.mocked(loadFileTree).mockResolvedValue(fullTree);

		// Stats resolve after a delay
		let resolveStats: (value: {
			fileCount: number;
			folderCount: number;
			totalSize: number;
		}) => void;
		const statsPromise = new Promise<{ fileCount: number; folderCount: number; totalSize: number }>(
			(resolve) => {
				resolveStats = resolve;
			}
		);
		const mockDirectorySize = vi.fn().mockReturnValue(statsPromise);

		const originalFs = window.maestro?.fs;
		window.maestro = {
			...window.maestro,
			fs: {
				...originalFs,
				directorySize: mockDirectorySize,
			},
		};

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Tree should be set before stats resolve
		await waitFor(() => {
			expect(state.getSessions()[0].fileTree).toEqual(fullTree);
			expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		});

		// Stats should not be set yet
		expect(state.getSessions()[0].fileTreeStats).toBeUndefined();

		// Now resolve stats
		await act(async () => {
			resolveStats!({ fileCount: 5, folderCount: 2, totalSize: 10000 });
			// Allow microtasks to flush
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		// Stats should now be populated
		expect(state.getSessions()[0].fileTreeStats).toEqual({
			fileCount: 5,
			folderCount: 2,
			totalSize: 10000,
		});

		if (originalFs) {
			window.maestro.fs = originalFs;
		}
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
		const state = createSessionsState([sessionWithTreeNoStats]);
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

		// Restore original
		if (originalFs) {
			window.maestro.fs = originalFs;
		}
	});

	it('does not fire file-tree safety timeout until sessionsLoaded is true', () => {
		vi.useFakeTimers();

		// Start with sessionsLoaded = false (simulates startup before sessions restore)
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// Advance past the 5-second file-tree timeout but not the 8-second backstop
		act(() => {
			vi.advanceTimersByTime(6000);
		});

		// initialFileTreeReady should still be false — gated timer hasn't started yet
		expect(useSessionStore.getState().initialFileTreeReady).toBe(false);

		// Now mark sessions as loaded
		act(() => {
			useSessionStore.setState({ sessionsLoaded: true });
		});

		// Advance just under the 5-second threshold
		act(() => {
			vi.advanceTimersByTime(1900);
		});
		expect(useSessionStore.getState().initialFileTreeReady).toBe(false);

		// Advance past the gated 5-second threshold (total 7.9s from mount)
		act(() => {
			vi.advanceTimersByTime(200);
		});

		// The backstop hasn't fired yet (only 8.1s from mount, but the gated timer has)
		expect(useSessionStore.getState().initialFileTreeReady).toBe(true);

		vi.useRealTimers();
	});

	it('absolute backstop fires at 8s even if sessionsLoaded is never set', () => {
		vi.useFakeTimers();

		// sessionsLoaded stays false — simulates a stuck session restoration
		useSessionStore.setState({ sessionsLoaded: false, initialFileTreeReady: false });

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);

		renderHook(() => useFileTreeManagement(deps));

		// At 7.9s — backstop hasn't fired yet
		act(() => {
			vi.advanceTimersByTime(7900);
		});
		expect(useSessionStore.getState().initialFileTreeReady).toBe(false);

		// At 8s — backstop fires
		act(() => {
			vi.advanceTimersByTime(200);
		});
		expect(useSessionStore.getState().initialFileTreeReady).toBe(true);

		vi.useRealTimers();
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
