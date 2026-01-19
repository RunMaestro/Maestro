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
	fileTreeFilter: '',
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
		originalHistory = window.maestro.history as typeof window.maestro.history | undefined;
		window.maestro = {
			...window.maestro,
			history: {
				reload: vi.fn().mockResolvedValue(true),
			},
		};
	});

	afterEach(() => {
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

		// loadFileTree is now called with (path, maxDepth, currentDepth, sshContext)
		// For local sessions (no sshRemoteId), sshContext is undefined
		expect(loadFileTree).toHaveBeenCalledWith('/test/project', 10, 0, undefined);
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
		expect(state.getSessions()[0].fileTree).toEqual([]);
		expect(state.getSessions()[0].fileTreeError).toContain('/test/project');
		expect(state.getSessions()[0].fileTreeError).toContain('boom');
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
		// But git operations use shellCwd when inputMode is 'terminal'
		// The second parameter is sshRemoteId, which is undefined for local sessions
		expect(loadFileTree).toHaveBeenCalledWith('/test/project', 10, 0, undefined);
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

		const state = createSessionsState([createMockSession({ fileTree })]);
		const deps = createDeps(state, { fileTreeFilter: 'read' });
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
			expect(loadFileTree).toHaveBeenCalledWith('/test/project', 10, 0, undefined);
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
		expect(loadFileTree).toHaveBeenCalledWith('/test/project', 10, 0, {
			sshRemoteId: 'my-ssh-remote',
			remoteCwd: '/remote/project',
		});
	});
});
