/**
 * Tests for useGitAgentActions - the single source of truth behind both git
 * menus (header branch pill dropdown, Left Bar right-click menu).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useGitAgentActions,
	resolveGitCwd,
	resolveGitSshRemoteId,
} from '../../../../renderer/hooks/git/useGitAgentActions';
import {
	gitRunKey,
	useGitCommandRunStore,
	type GitCommandRun,
	type GitRunStatus,
} from '../../../../renderer/stores/gitCommandRunStore';
import type { Session } from '../../../../renderer/types';

const DEFAULT_BRANCH_INFO = { branch: 'feature/login', remote: '', ahead: 4, behind: 1 };
const mockGetBranchInfo = vi.fn(() => DEFAULT_BRANCH_INFO);
const mockRefreshGitStatus = vi.fn().mockResolvedValue(undefined);
const DEFAULT_FILE_DETAILS = { totalAdditions: 206, totalDeletions: 37, modifiedCount: 5 };
const mockGetFileDetails = vi.fn(() => DEFAULT_FILE_DETAILS);
const mockGetFileCount = vi.fn(() => 5);
vi.mock('../../../../renderer/contexts/GitStatusContext', () => ({
	useGitBranch: () => ({ getBranchInfo: mockGetBranchInfo }),
	useGitDetail: () => ({
		getFileDetails: mockGetFileDetails,
		refreshGitStatus: mockRefreshGitStatus,
	}),
	useGitFileStatus: () => ({ getFileCount: mockGetFileCount }),
}));

const mockGetDiff = vi.fn();
vi.mock('../../../../renderer/services/git', () => ({
	gitService: { getDiff: (...args: unknown[]) => mockGetDiff(...args) },
}));

const mockNotifyCenterFlash = vi.fn();
vi.mock('../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (...args: unknown[]) => mockNotifyCenterFlash(...args),
}));

const mockSetActiveSessionId = vi.fn();
vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), {
		getState: () => ({ setActiveSessionId: mockSetActiveSessionId }),
	}),
}));

const mockOpenModal = vi.fn();
vi.mock('../../../../renderer/stores/modalStore', () => ({
	useModalStore: Object.assign(
		vi.fn((selector) => selector({ openModal: mockOpenModal })),
		{ getState: () => ({ openModal: mockOpenModal }) }
	),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		cwd: '/test/repo',
		fullPath: '/test/repo',
		toolType: 'claude-code',
		inputMode: 'ai',
		aiTabs: [],
		terminalTabs: [],
		isGitRepo: true,
		...overrides,
	} as Session;
}

describe('resolveGitCwd', () => {
	it('uses cwd for an AI-mode agent', () => {
		expect(resolveGitCwd(makeSession())).toBe('/test/repo');
	});

	it('prefers the live shell cwd for a terminal-mode agent', () => {
		expect(
			resolveGitCwd(makeSession({ inputMode: 'terminal', shellCwd: '/test/repo/packages/app' }))
		).toBe('/test/repo/packages/app');
	});

	it('falls back to cwd when a terminal agent has no shell cwd yet', () => {
		expect(resolveGitCwd(makeSession({ inputMode: 'terminal' }))).toBe('/test/repo');
	});
});

describe('resolveGitSshRemoteId', () => {
	it('returns undefined for a local agent', () => {
		expect(resolveGitSshRemoteId(makeSession())).toBeUndefined();
	});

	it('reads the top-level id', () => {
		expect(resolveGitSshRemoteId(makeSession({ sshRemoteId: 'remote-1' }))).toBe('remote-1');
	});

	it('reads the per-session config when enabled', () => {
		expect(
			resolveGitSshRemoteId(
				makeSession({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-2' },
				} as Partial<Session>)
			)
		).toBe('remote-2');
	});

	it('ignores a disabled per-session config', () => {
		expect(
			resolveGitSshRemoteId(
				makeSession({
					sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-2' },
				} as Partial<Session>)
			)
		).toBeUndefined();
	});
});

describe('useGitAgentActions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBranchInfo.mockReturnValue(DEFAULT_BRANCH_INFO);
		mockGetFileDetails.mockReturnValue(DEFAULT_FILE_DETAILS);
		mockGetFileCount.mockReturnValue(5);
		mockGetDiff.mockResolvedValue({ diff: 'diff --git a/x b/x' });
	});

	// Every git surface badges its diff row off these, so they have to survive
	// the trip out of the two separate contexts that carry them.
	it('surfaces the working-tree change totals', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		expect(result.current.changes).toEqual({
			fileCount: 5,
			additions: 206,
			deletions: 37,
			modified: 5,
		});
	});

	it('reports zero line counts for an agent with no detail polled', () => {
		// Only the active agent gets numstat, so the others have counts but no lines.
		mockGetFileDetails.mockReturnValue(undefined as unknown as typeof DEFAULT_FILE_DETAILS);
		mockGetFileCount.mockReturnValue(4);
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		expect(result.current.changes).toEqual({
			fileCount: 4,
			additions: 0,
			deletions: 0,
			modified: 0,
		});
	});

	it('reports a clean tree for a null session', () => {
		const { result } = renderHook(() => useGitAgentActions(null));

		expect(result.current.changes.fileCount).toBe(0);
	});

	it('surfaces the polled branch and ahead/behind counts', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		expect(result.current.isGitRepo).toBe(true);
		expect(result.current.branch).toBe('feature/login');
		expect(result.current.ahead).toBe(4);
		expect(result.current.behind).toBe(1);
		expect(result.current.canCreatePR).toBe(true);
	});

	it('reports a non-git agent so callers can render nothing', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession({ isGitRepo: false })));

		expect(result.current.isGitRepo).toBe(false);
		expect(result.current.canCreatePR).toBe(false);
	});

	it('tolerates a null session without throwing', () => {
		const { result } = renderHook(() => useGitAgentActions(null));

		expect(result.current.isGitRepo).toBe(false);
		result.current.pull();
		expect(mockOpenModal).not.toHaveBeenCalled();
	});

	it('falls back to the worktree branch when polling has no data yet', () => {
		mockGetBranchInfo.mockReturnValue({ branch: '', remote: '', ahead: 0, behind: 0 });
		const { result } = renderHook(() =>
			useGitAgentActions(makeSession({ worktreeBranch: 'feature/x' }))
		);

		expect(result.current.branch).toBe('feature/x');
		expect(result.current.canCreatePR).toBe(true);
	});

	it('cannot open a PR when no branch is known from either source', () => {
		mockGetBranchInfo.mockReturnValue({ branch: '', remote: '', ahead: 0, behind: 0 });
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		expect(result.current.canCreatePR).toBe(false);
	});

	it('opens the log with an explicit repo target', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));
		result.current.viewLog();

		expect(mockOpenModal).toHaveBeenCalledWith('gitLog', {
			cwd: '/test/repo',
			sshRemoteId: undefined,
		});
	});

	it('opens the streaming runner for pull and push', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));

		result.current.pull();
		expect(mockOpenModal).toHaveBeenLastCalledWith(
			'gitCommandRunner',
			expect.objectContaining({ operation: 'pull', branch: 'feature/login' })
		);

		result.current.push();
		expect(mockOpenModal).toHaveBeenLastCalledWith(
			'gitCommandRunner',
			expect.objectContaining({ operation: 'push' })
		);
	});

	it('opens the branch switcher seeded with the current branch', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));
		result.current.switchBranch();

		expect(mockOpenModal).toHaveBeenCalledWith(
			'branchSwitcher',
			expect.objectContaining({ sessionId: 'session-1', currentBranch: 'feature/login' })
		);
	});

	it('passes the live branch to the PR modal', () => {
		const { result } = renderHook(() => useGitAgentActions(makeSession()));
		result.current.createPR();

		expect(mockOpenModal).toHaveBeenCalledWith(
			'createPR',
			expect.objectContaining({ sourceBranch: 'feature/login' })
		);
	});

	it('threads the SSH remote into every action', () => {
		const session = makeSession({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		} as Partial<Session>);
		const { result } = renderHook(() => useGitAgentActions(session));

		result.current.viewLog();
		result.current.pull();
		result.current.switchBranch();

		for (const call of mockOpenModal.mock.calls) {
			expect(call[1]).toEqual(expect.objectContaining({ sshRemoteId: 'remote-1' }));
		}
	});

	describe('viewDiff', () => {
		it('fetches the diff for this agent and opens the viewer with its repo path', async () => {
			const { result } = renderHook(() => useGitAgentActions(makeSession({ cwd: '/other/repo' })));
			await act(async () => {
				await result.current.viewDiff();
			});

			expect(mockGetDiff).toHaveBeenCalledWith('/other/repo', undefined, undefined);
			// The cwd rides along so the viewer resolves clicked files against THIS
			// agent's tree rather than whichever agent is active.
			expect(mockOpenModal).toHaveBeenCalledWith('gitDiff', {
				diff: 'diff --git a/x b/x',
				cwd: '/other/repo',
			});
		});

		it('uses the live shell cwd for a terminal-mode agent', async () => {
			const { result } = renderHook(() =>
				useGitAgentActions(makeSession({ inputMode: 'terminal', shellCwd: '/repo/packages/app' }))
			);
			await act(async () => {
				await result.current.viewDiff();
			});

			expect(mockGetDiff).toHaveBeenCalledWith('/repo/packages/app', undefined, undefined);
		});

		it('passes the SSH remote through', async () => {
			const { result } = renderHook(() =>
				useGitAgentActions(
					makeSession({
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					} as Partial<Session>)
				)
			);
			await act(async () => {
				await result.current.viewDiff();
			});

			expect(mockGetDiff).toHaveBeenCalledWith('/test/repo', undefined, 'remote-1');
		});

		it('flashes and re-syncs stale status instead of opening an empty viewer', async () => {
			mockGetDiff.mockResolvedValue({ diff: '' });
			const { result } = renderHook(() => useGitAgentActions(makeSession()));
			await act(async () => {
				await result.current.viewDiff();
			});

			expect(mockOpenModal).not.toHaveBeenCalled();
			expect(mockNotifyCenterFlash).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'No diff to examine' })
			);
			// The polling cache claimed changes that git doesn't see - refresh it.
			expect(mockRefreshGitStatus).toHaveBeenCalled();
		});

		it('does nothing for a null session', async () => {
			const { result } = renderHook(() => useGitAgentActions(null));
			await act(async () => {
				await result.current.viewDiff();
			});

			expect(mockGetDiff).not.toHaveBeenCalled();
			expect(mockOpenModal).not.toHaveBeenCalled();
		});
	});

	describe('configureWorktrees', () => {
		it('activates the agent before opening the config modal', () => {
			// The modal renders against the active session, so activating IS how
			// the right-clicked agent gets targeted.
			const { result } = renderHook(() => useGitAgentActions(makeSession({ id: 'other-agent' })));
			result.current.configureWorktrees();

			expect(mockSetActiveSessionId).toHaveBeenCalledWith('other-agent');
			expect(mockOpenModal).toHaveBeenCalledWith('worktreeConfig');
		});

		it('is unavailable for worktree children, which own no config', () => {
			const { result } = renderHook(() =>
				useGitAgentActions(makeSession({ parentSessionId: 'parent-1' }))
			);

			expect(result.current.canConfigureWorktrees).toBe(false);
		});

		it('is available for a plain git agent', () => {
			const { result } = renderHook(() => useGitAgentActions(makeSession()));
			expect(result.current.canConfigureWorktrees).toBe(true);
		});

		it('is unavailable for a non-git agent', () => {
			const { result } = renderHook(() => useGitAgentActions(makeSession({ isGitRepo: false })));
			expect(result.current.canConfigureWorktrees).toBe(false);
		});
	});

	// A pull/push survives its console being dismissed with Run in Background,
	// so every menu row has to be able to say the command is still going.
	describe('background run indicators', () => {
		function seedRun(overrides: Partial<GitCommandRun> & { operation: 'pull' | 'push' }) {
			const key = gitRunKey({ operation: overrides.operation, cwd: '/test/repo' });
			useGitCommandRunStore.setState({
				runs: {
					[key]: {
						key,
						runId: 'run-1',
						sessionId: 'session-1',
						cwd: '/test/repo',
						setUpstream: false,
						output: '',
						status: 'running' as GitRunStatus,
						announced: false,
						...overrides,
					} as GitCommandRun,
				},
			});
			return key;
		}

		beforeEach(() => {
			useGitCommandRunStore.setState({ runs: {} });
		});

		it('reports nothing running on a quiet repo', () => {
			const { result } = renderHook(() => useGitAgentActions(makeSession()));

			expect(result.current.pullRunning).toBe(false);
			expect(result.current.pushRunning).toBe(false);
		});

		it('flags the operation that is running, not the other one', () => {
			seedRun({ operation: 'push' });
			const { result } = renderHook(() => useGitAgentActions(makeSession()));

			expect(result.current.pushRunning).toBe(true);
			expect(result.current.pullRunning).toBe(false);
		});

		it('stops flagging once the run settles', () => {
			seedRun({ operation: 'push', status: 'success' });
			const { result } = renderHook(() => useGitAgentActions(makeSession()));

			expect(result.current.pushRunning).toBe(false);
		});

		// Runs are keyed by repo, so a push in a sibling worktree must not light
		// up this agent's row.
		it('ignores a run against a different repo', () => {
			const key = gitRunKey({ operation: 'push', cwd: '/other/repo' });
			useGitCommandRunStore.setState({
				runs: {
					[key]: {
						key,
						runId: 'run-2',
						sessionId: 'session-2',
						operation: 'push',
						cwd: '/other/repo',
						setUpstream: false,
						output: '',
						status: 'running',
						announced: false,
					} as GitCommandRun,
				},
			});
			const { result } = renderHook(() => useGitAgentActions(makeSession()));

			expect(result.current.pushRunning).toBe(false);
		});

		it('reports nothing for a null agent', () => {
			const { result } = renderHook(() => useGitAgentActions(null));

			expect(result.current.pullRunning).toBe(false);
			expect(result.current.pushRunning).toBe(false);
		});
	});
});
