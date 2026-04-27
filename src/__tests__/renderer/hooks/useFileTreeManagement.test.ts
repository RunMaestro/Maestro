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
import { createMockSession } from '../../helpers/mockSession';
import type { FileNode } from '../../../renderer/types/fileTree';
import type { RightPanelHandle } from '../../../renderer/components/RightPanel';
import type { RefObject, SetStateAction } from 'react';
import {
	loadFileTree,
	loadFileTreeRemoteBatched,
	compareFileTrees,
} from '../../../renderer/utils/fileExplorer';
import { gitService } from '../../../renderer/services/git';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

vi.mock('../../../renderer/utils/fileExplorer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../renderer/utils/fileExplorer')>();
	return {
		...actual,
		loadFileTree: vi.fn(),
		loadFileTreeRemoteBatched: vi.fn(),
		compareFileTrees: vi.fn(),
	};
});

/** Wrap a tree array into the shape loadFileTree now returns. */
const asResult = (tree: FileNode[], truncated = false) => ({
	tree,
	truncated,
	filesFound: tree.length,
});

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

// createMockSession imported from shared helper

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

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));
		vi.mocked(compareFileTrees).mockReturnValue(changes);

		const state = createSessionsState([createMockSession({ fileTree: initialTree })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		let returnedChanges: typeof changes | undefined;
		await act(async () => {
			returnedChanges = await result.current.refreshFileTree(state.getSessions()[0].id);
		});

		// For local sessions (no sshRemoteId), sshContext and localOptions are undefined.
		// loadFullTree always forwards an 8th `signal` arg (undefined when caller omits extras).
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100_000,
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

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));
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

		// loadFileTree always uses projectRoot (treeRoot), not shellCwd.
		// Git operations use shellCwd when inputMode is 'terminal'.
		// loadFullTree always forwards an 8th `signal` arg (undefined when caller omits extras).
		expect(loadFileTree).toHaveBeenCalledWith(
			'/test/project',
			5,
			0,
			undefined,
			undefined,
			undefined,
			100_000,
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

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		renderHook(() => useFileTreeManagement(deps));

		await waitFor(() => {
			// loadFileTree is called with (path, maxDepth, currentDepth, sshContext, onProgress, localOptions, maxEntries, signal)
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				5,
				0,
				undefined,
				undefined,
				undefined,
				100_000,
				expect.any(AbortSignal)
			);
			expect(state.getSessions()[0].fileTree).toEqual(nextTree);
		});
	});

	it('routes SSH refresh through the batched find loader', async () => {
		const nextTree: FileNode[] = [{ name: 'remote-file.txt', type: 'file' }];
		const changes = {
			totalChanges: 0,
			newFiles: 0,
			newFolders: 0,
			removedFiles: 0,
			removedFolders: 0,
		};

		vi.mocked(loadFileTree).mockResolvedValue(asResult(nextTree));
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValue(asResult(nextTree));
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

		// The initial-load effect fires a shallow loadFileTree pass for SSH on mount.
		// That's tested separately ("fires shallow load before batched full load …");
		// here we only care about what the *refresh* path dispatches.
		vi.mocked(loadFileTree).mockClear();
		vi.mocked(loadFileTreeRemoteBatched).mockClear();

		await act(async () => {
			await result.current.refreshFileTree(sshSession.id);
		});

		// Verify SSH refresh dispatches to the batched loader (not recursive readDir)
		expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
			'/test/project',
			expect.objectContaining({
				maxDepth: 5,
				maxEntries: 100_000,
				sshRemoteId: 'my-ssh-remote',
			})
		);
		// Recursive loadFileTree must NOT be called for SSH refreshes — the whole
		// point of the batched loader is to skip the per-directory round-trips.
		expect(loadFileTree).not.toHaveBeenCalled();
	});

	it('fires shallow load before batched full load for SSH sessions on initial mount', async () => {
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

		// Shallow pass goes through loadFileTree (depth=1, single readDir round-trip).
		vi.mocked(loadFileTree).mockResolvedValueOnce(asResult(shallowTree));
		// Full pass goes through the batched find-based loader.
		vi.mocked(loadFileTreeRemoteBatched).mockResolvedValueOnce(asResult(fullTree));

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
			// Shallow load: depth=1, no entry cap, recursive readDir path.
			expect(loadFileTree).toHaveBeenCalledWith(
				'/test/project',
				1,
				0,
				expect.objectContaining({ sshRemoteId: 'my-ssh-remote' }),
				undefined,
				undefined,
				Number.POSITIVE_INFINITY,
				expect.any(AbortSignal)
			);
			// Full load: dispatched to batched find-based loader.
			expect(loadFileTreeRemoteBatched).toHaveBeenCalledWith(
				'/test/project',
				expect.objectContaining({
					maxDepth: 5,
					maxEntries: 100_000,
					sshRemoteId: 'my-ssh-remote',
					signal: expect.any(AbortSignal),
				})
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
		vi.mocked(loadFileTree).mockResolvedValue(asResult(fullTree));

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
			5,
			0,
			undefined,
			undefined,
			undefined,
			100_000,
			expect.any(AbortSignal)
		);
	});

	it('cancelFileTreeLoad aborts the in-flight load signal and clears loading state', async () => {
		// Hold the load open so we can cancel while it's pending.
		let resolveLoad: (value: ReturnType<typeof asResult>) => void = () => {};
		const pending = new Promise<ReturnType<typeof asResult>>((resolve) => {
			resolveLoad = resolve;
		});
		vi.mocked(loadFileTree).mockReturnValue(pending);

		const state = createSessionsState([createMockSession({ fileTree: [] })]);
		const deps = createDeps(state);
		const { result } = renderHook(() => useFileTreeManagement(deps));

		// Wait until the auto-load effect has kicked off and marked the session as loading.
		await waitFor(() => {
			expect(state.getSessions()[0].fileTreeLoading).toBe(true);
			expect(loadFileTree).toHaveBeenCalled();
		});

		// Grab the AbortSignal passed into loadFileTree and confirm it starts unaborted.
		const callArgs = vi.mocked(loadFileTree).mock.calls[0];
		const signal = callArgs[callArgs.length - 1] as AbortSignal;
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);

		// Cancel and verify the signal aborted and the UI state was cleared.
		await act(async () => {
			result.current.cancelFileTreeLoad(state.getSessions()[0].id);
		});

		expect(signal.aborted).toBe(true);
		expect(state.getSessions()[0].fileTreeLoading).toBe(false);
		expect(state.getSessions()[0].fileTreeLoadingProgress).toBeUndefined();

		// Resolve the pending load so the promise machinery settles cleanly.
		resolveLoad(asResult([]));
	});

	it('decouples stats from tree display in initial load', async () => {
		const fullTree: FileNode[] = [{ name: 'file.txt', type: 'file' }];

		// Tree resolves immediately
		vi.mocked(loadFileTree).mockResolvedValue(asResult(fullTree));

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
