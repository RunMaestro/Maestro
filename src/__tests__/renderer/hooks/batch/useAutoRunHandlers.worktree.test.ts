/**
 * @file useAutoRunHandlers.worktree.test.ts
 * @description Integration tests for the worktree dispatch flow in handleStartBatchRun.
 *
 * These tests verify that handleStartBatchRun correctly routes Auto Run
 * execution to worktree agents across all three dispatch modes:
 *   - existing-open: dispatches to an already-open worktree session
 *   - create-new: creates a worktree on disk, spawns a session, then dispatches
 *   - existing-closed: spawns a session for an on-disk worktree, then dispatches
 *
 * Also verifies the regression case where no worktreeTarget is set (dispatches
 * to the active session as before).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks';
import type { Session, BatchRunConfig } from '../../../../renderer/types';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

// Mock gitService
vi.mock('../../../../renderer/services/git', () => ({
	gitService: {
		getBranches: vi.fn().mockResolvedValue(['main', 'develop']),
		getTags: vi.fn().mockResolvedValue([]),
	},
}));

// Mock notifyToast
vi.mock('../../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

import { gitService } from '../../../../renderer/services/git';
import { notifyToast } from '../../../../renderer/stores/notificationStore';

// ============================================================================
// Helpers
// ============================================================================

const createMockSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'parent-session-1',
		name: 'Parent Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/projects/my-repo',
		fullPath: '/projects/my-repo',
		projectRoot: '/projects/my-repo',
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
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		autoRunFolderPath: '/projects/autorun-docs',
		autoRunSelectedFile: 'Phase 1',
		autoRunContent: '# Phase 1',
		autoRunContentVersion: 1,
		autoRunMode: 'edit',
		worktreeConfig: { basePath: '/projects/worktrees' },
		...overrides,
	}) as Session;

const createMockDeps = () => ({
	setSessions: vi.fn(),
	setAutoRunDocumentList: vi.fn(),
	setAutoRunDocumentTree: vi.fn(),
	setAutoRunIsLoadingDocuments: vi.fn(),
	setAutoRunSetupModalOpen: vi.fn(),
	setBatchRunnerModalOpen: vi.fn(),
	setActiveRightTab: vi.fn(),
	setRightPanelOpen: vi.fn(),
	setActiveFocus: vi.fn(),
	setSuccessFlashNotification: vi.fn(),
	autoRunDocumentList: ['Phase 1', 'Phase 2'],
	startBatchRun: vi.fn(),
});

const baseDocuments = [
	{ id: '1', filename: 'Phase 1', resetOnCompletion: false, isDuplicate: false },
];

// ============================================================================
// Tests
// ============================================================================

describe('handleStartBatchRun — worktree dispatch integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as any);
		useSettingsStore.setState({
			defaultSaveToHistory: true,
			defaultShowThinking: 'off',
		} as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// Regression: no worktreeTarget
	// -----------------------------------------------------------------------

	describe('no worktreeTarget (regression)', () => {
		it('dispatches to activeSession.id when worktreeTarget is undefined', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Run tests',
				loopEnabled: false,
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(deps.startBatchRun).toHaveBeenCalledOnce();
			expect(deps.startBatchRun).toHaveBeenCalledWith(
				'parent-session-1',
				config,
				'/projects/autorun-docs'
			);
			expect(deps.setBatchRunnerModalOpen).toHaveBeenCalledWith(false);
		});

		it('uses activeSession.autoRunFolderPath regardless of worktree presence', async () => {
			const session = createMockSession({
				autoRunFolderPath: '/shared/docs',
			});
			const deps = createMockDeps();

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(deps.startBatchRun).toHaveBeenCalledWith(
				'parent-session-1',
				config,
				'/shared/docs'
			);
		});
	});

	// -----------------------------------------------------------------------
	// existing-open mode
	// -----------------------------------------------------------------------

	describe('existing-open mode', () => {
		it('dispatches to the specified sessionId instead of activeSession', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			// Populate store with both parent and target session so existence check passes
			const worktreeChild = createMockSession({
				id: 'worktree-child-42',
				name: 'Worktree Child',
				state: 'idle',
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, worktreeChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Run in worktree',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'worktree-child-42',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(deps.startBatchRun).toHaveBeenCalledOnce();
			expect(deps.startBatchRun).toHaveBeenCalledWith(
				'worktree-child-42',
				config,
				'/projects/autorun-docs'
			);
		});

		it('still uses activeSession.autoRunFolderPath for document source', async () => {
			const session = createMockSession({
				autoRunFolderPath: '/my/autorun/folder',
			});
			const deps = createMockDeps();

			// Populate store with target session
			const worktreeChild = createMockSession({
				id: 'worktree-child-99',
				state: 'idle',
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, worktreeChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'worktree-child-99',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// folderPath (third arg) comes from the parent session, not the worktree
			const [, , folderPath] = deps.startBatchRun.mock.calls[0];
			expect(folderPath).toBe('/my/autorun/folder');
		});

		it('does not call worktreeSetup for existing-open sessions', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			// Populate store with target session
			const openChild = createMockSession({
				id: 'open-child',
				state: 'idle',
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, openChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'open-child',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();
		});

		it('falls back to active session with warning toast when target session is removed', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			// Store has NO sessions matching the target ID (session was removed)
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'removed-session-id',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// Should fall back to active session
			expect(deps.startBatchRun).toHaveBeenCalledWith(
				'parent-session-1',
				config,
				'/projects/autorun-docs'
			);

			// Should show warning toast
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'Worktree Agent Not Found',
				})
			);
		});

		it('shows warning toast and does not dispatch when target session is busy', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			// Add a busy session to the store
			const busySession = createMockSession({
				id: 'busy-child',
				name: 'Busy Child',
				state: 'busy' as const,
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, busySession],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'busy-child',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// Should NOT dispatch
			expect(deps.startBatchRun).not.toHaveBeenCalled();

			// Should show warning toast
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'warning',
					title: 'Target Agent Busy',
					message: 'Target agent is busy. Please try again.',
				})
			);
		});

		it('populates config.worktree when createPROnCompletion is true', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			const worktreeChild = createMockSession({
				id: 'wt-pr-child',
				name: 'WT PR Child',
				state: 'idle',
				cwd: '/projects/worktrees/feature-x',
				worktreeBranch: 'feature-x',
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, worktreeChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'wt-pr-child',
					baseBranch: 'develop',
					createPROnCompletion: true,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree).toEqual({
				enabled: true,
				path: '/projects/worktrees/feature-x',
				branchName: 'feature-x',
				createPROnCompletion: true,
				prTargetBranch: 'develop',
			});
		});

		it('does not populate config.worktree when createPROnCompletion is false', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			const worktreeChild = createMockSession({
				id: 'wt-no-pr',
				state: 'idle',
				cwd: '/projects/worktrees/no-pr',
				worktreeBranch: 'no-pr',
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, worktreeChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'wt-no-pr',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree).toBeUndefined();
		});

		it('defaults prTargetBranch to "main" when baseBranch is not specified', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			const worktreeChild = createMockSession({
				id: 'wt-default-base',
				state: 'idle',
				cwd: '/projects/worktrees/default-base',
				worktreeBranch: 'default-base',
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, worktreeChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'wt-default-base',
					// baseBranch intentionally omitted
					createPROnCompletion: true,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree?.prTargetBranch).toBe('main');
		});

		it('falls back to path-derived branch name when worktreeBranch is not set', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			const worktreeChild = createMockSession({
				id: 'wt-no-branch',
				state: 'idle',
				cwd: '/projects/worktrees/path-derived',
				worktreeBranch: undefined,
				parentSessionId: session.id,
			});
			useSessionStore.setState({
				sessions: [session, worktreeChild],
				activeSessionId: session.id,
			} as any);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-open',
					sessionId: 'wt-no-branch',
					createPROnCompletion: true,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree?.branchName).toBe('path-derived');
		});
	});

	// -----------------------------------------------------------------------
	// create-new mode
	// -----------------------------------------------------------------------

	describe('create-new mode', () => {
		it('calls worktreeSetup with correct arguments', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Create worktree',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'auto-run-main-0222',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
				'/projects/my-repo',
				'/projects/worktrees/auto-run-main-0222',
				'auto-run-main-0222',
				undefined // no SSH
			);
		});

		it('adds a new session to the store with correct parentSessionId', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'feature-x']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'feature-x',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// Session should be added to the store
			const sessions = useSessionStore.getState().sessions;
			const newSession = sessions.find((s) => s.worktreeBranch === 'feature-x');
			expect(newSession).toBeDefined();
			expect(newSession!.parentSessionId).toBe('parent-session-1');
			expect(newSession!.cwd).toBe('/projects/worktrees/feature-x');
			expect(newSession!.toolType).toBe('claude-code');
		});

		it('dispatches startBatchRun with the new session ID', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'new-branch',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(deps.startBatchRun).toHaveBeenCalledOnce();
			const [targetId, , folderPath] = deps.startBatchRun.mock.calls[0];
			// Target should NOT be the parent session
			expect(targetId).not.toBe('parent-session-1');
			// Folder path should still come from the parent session
			expect(folderPath).toBe('/projects/autorun-docs');
		});

		it('expands parent worktrees when new session is added', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			// Pre-populate store with the parent session
			useSessionStore.setState({
				sessions: [session],
				activeSessionId: session.id,
			} as any);

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'expand-test',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// Parent session should have worktreesExpanded set
			const sessions = useSessionStore.getState().sessions;
			const parent = sessions.find((s) => s.id === 'parent-session-1');
			expect(parent?.worktreesExpanded).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// create-new with PR
	// -----------------------------------------------------------------------

	describe('create-new with PR creation', () => {
		it('populates config.worktree when createPROnCompletion is true', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'pr-branch',
					baseBranch: 'develop',
					createPROnCompletion: true,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree).toEqual({
				enabled: true,
				path: '/projects/worktrees/pr-branch',
				branchName: 'pr-branch',
				createPROnCompletion: true,
				prTargetBranch: 'develop',
			});
		});

		it('does not populate config.worktree when createPROnCompletion is false', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'no-pr-branch',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree).toBeUndefined();
		});

		it('defaults prTargetBranch to "main" when baseBranch is not specified', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'default-pr',
					// baseBranch intentionally omitted
					createPROnCompletion: true,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree?.prTargetBranch).toBe('main');
		});
	});

	// -----------------------------------------------------------------------
	// create-new failure
	// -----------------------------------------------------------------------

	describe('create-new failure', () => {
		it('does not call startBatchRun when worktreeSetup fails', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: false,
				error: 'fatal: branch already exists',
			});

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'conflict-branch',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(deps.startBatchRun).not.toHaveBeenCalled();
		});

		it('shows error toast when worktreeSetup fails', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: false,
				error: 'disk full',
			});

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'fail-branch',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Failed to Create Worktree',
					message: 'disk full',
				})
			);
		});

		it('does not add a session to the store when worktreeSetup fails', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: false,
				error: 'oops',
			});

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'ghost-branch',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			const sessions = useSessionStore.getState().sessions;
			expect(sessions).toHaveLength(0);
		});

		it('handles unexpected exception from worktreeSetup gracefully', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockRejectedValue(
				new Error('IPC channel closed')
			);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'exception-branch',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(deps.startBatchRun).not.toHaveBeenCalled();
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Worktree Error',
					message: 'IPC channel closed',
				})
			);
		});
	});

	// -----------------------------------------------------------------------
	// existing-closed mode
	// -----------------------------------------------------------------------

	describe('existing-closed mode', () => {
		it('creates a session from the worktree path and dispatches to it', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'feature-old']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Resume work',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-closed',
					worktreePath: '/projects/worktrees/feature-old',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// Should NOT call worktreeSetup — worktree already exists on disk
			expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();

			// Should have dispatched to a new session
			expect(deps.startBatchRun).toHaveBeenCalledOnce();
			const [targetId] = deps.startBatchRun.mock.calls[0];
			expect(targetId).not.toBe('parent-session-1');

			// Session should exist in the store with correct path
			const sessions = useSessionStore.getState().sessions;
			const newSession = sessions.find(
				(s) => s.cwd === '/projects/worktrees/feature-old'
			);
			expect(newSession).toBeDefined();
			expect(newSession!.parentSessionId).toBe('parent-session-1');
		});

		it('derives branch name from the worktree path', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(gitService.getBranches).mockResolvedValue([]);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-closed',
					worktreePath: '/deep/nested/path/my-feature',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			const sessions = useSessionStore.getState().sessions;
			const newSession = sessions.find(
				(s) => s.cwd === '/deep/nested/path/my-feature'
			);
			expect(newSession).toBeDefined();
			// Branch name should be derived from the last path segment
			expect(newSession!.worktreeBranch).toBe('my-feature');
		});

		it('populates config.worktree for PR creation when requested', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(gitService.getBranches).mockResolvedValue(['main', 'pr-feature']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-closed',
					worktreePath: '/projects/worktrees/pr-feature',
					baseBranch: 'develop',
					createPROnCompletion: true,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(config.worktree).toEqual({
				enabled: true,
				path: '/projects/worktrees/pr-feature',
				branchName: 'pr-feature',
				createPROnCompletion: true,
				prTargetBranch: 'develop',
			});
		});

		it('handles getBranches failure gracefully (non-fatal)', async () => {
			const session = createMockSession();
			const deps = createMockDeps();

			vi.mocked(gitService.getBranches).mockRejectedValue(
				new Error('git not found')
			);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-closed',
					worktreePath: '/projects/worktrees/resilient',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			// Should still dispatch — git info is nice-to-have
			expect(deps.startBatchRun).toHaveBeenCalledOnce();

			// Session should still exist with path-derived branch
			const sessions = useSessionStore.getState().sessions;
			const newSession = sessions.find(
				(s) => s.cwd === '/projects/worktrees/resilient'
			);
			expect(newSession).toBeDefined();
			expect(newSession!.worktreeBranch).toBe('resilient');
		});

		it('inherits SSH config from parent session', async () => {
			const sshConfig = {
				enabled: true,
				remoteId: 'my-server',
				host: 'dev.example.com',
				user: 'deploy',
			};
			const session = createMockSession({
				sessionSshRemoteConfig: sshConfig,
			});
			const deps = createMockDeps();

			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'existing-closed',
					worktreePath: '/remote/worktrees/ssh-feature',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			const sessions = useSessionStore.getState().sessions;
			const newSession = sessions.find(
				(s) => s.cwd === '/remote/worktrees/ssh-feature'
			);
			expect(newSession).toBeDefined();
			expect(newSession!.sessionSshRemoteConfig).toEqual(sshConfig);
		});
	});

	// -----------------------------------------------------------------------
	// SSH integration
	// -----------------------------------------------------------------------

	describe('SSH remote integration', () => {
		it('passes sshRemoteId to worktreeSetup for create-new mode', async () => {
			const session = createMockSession({
				sshRemoteId: 'remote-host-1',
			});
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'remote-branch',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
				'/projects/my-repo',
				'/projects/worktrees/remote-branch',
				'remote-branch',
				'remote-host-1'
			);
		});

		it('uses sessionSshRemoteConfig.remoteId as fallback', async () => {
			const session = createMockSession({
				sshRemoteId: undefined,
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'fallback-host',
					host: 'fallback.example.com',
					user: 'user',
				},
			});
			const deps = createMockDeps();

			vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
				success: true,
			});
			vi.mocked(gitService.getBranches).mockResolvedValue(['main']);

			const config: BatchRunConfig = {
				documents: baseDocuments,
				prompt: 'Go',
				loopEnabled: false,
				worktreeTarget: {
					mode: 'create-new',
					newBranchName: 'fallback-branch',
					baseBranch: 'main',
					createPROnCompletion: false,
				},
			};

			const { result } = renderHook(() => useAutoRunHandlers(session, deps));

			await act(async () => {
				await result.current.handleStartBatchRun(config);
			});

			expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
				'/projects/my-repo',
				'/projects/worktrees/fallback-branch',
				'fallback-branch',
				'fallback-host'
			);
		});
	});
});
