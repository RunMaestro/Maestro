/**
 * @file useWorktreeManager.test.ts
 * @description Tests for PR title and body generation in useWorktreeManager.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorktreeManager } from '../../renderer/hooks/batch/useWorktreeManager';
import { captureException } from '../../renderer/utils/sentry';
import type { BatchDocumentEntry } from '../../renderer/types';

vi.mock('../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const singleDoc: BatchDocumentEntry[] = [{ filename: 'auth-module', resetOnCompletion: false }];

const twoDocs: BatchDocumentEntry[] = [
	{ filename: 'auth-module', resetOnCompletion: false },
	{ filename: 'db-migration', resetOnCompletion: false },
];

const manyDocs: BatchDocumentEntry[] = [
	{ filename: 'auth-module', resetOnCompletion: false },
	{ filename: 'db-migration', resetOnCompletion: false },
	{ filename: 'api-routes', resetOnCompletion: false },
	{ filename: 'frontend-ui', resetOnCompletion: false },
];

const gitMock = {
	worktreeSetup: vi.fn(),
	worktreeCheckout: vi.fn(),
	getDefaultBranch: vi.fn(),
	log: vi.fn(),
	createPR: vi.fn(),
};

const loggerMock = {
	log: vi.fn(),
};

beforeEach(() => {
	vi.restoreAllMocks();
	vi.mocked(captureException).mockReset();
	vi.mocked(gitMock.worktreeSetup).mockReset();
	vi.mocked(gitMock.worktreeCheckout).mockReset();
	vi.mocked(gitMock.getDefaultBranch).mockReset();
	vi.mocked(gitMock.log).mockReset();
	vi.mocked(gitMock.createPR).mockReset();
	vi.mocked(loggerMock.log).mockReset();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});

	window.maestro = {
		git: gitMock,
		logger: loggerMock,
	} as unknown as typeof window.maestro;
});

describe('useWorktreeManager - PR generation', () => {
	describe('generatePRTitle', () => {
		it('includes branch name and document name for single doc', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('feature/auth', singleDoc, 5);
			expect(title).toBe('feature/auth: 5 tasks completed in auth-module');
		});

		it('lists both document names for two docs', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('feature/auth', twoDocs, 12);
			expect(title).toBe('feature/auth: 12 tasks across auth-module, db-migration');
		});

		it('truncates with "+N more" for three or more docs', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('feature/auth', manyDocs, 20);
			expect(title).toBe('feature/auth: 20 tasks across auth-module, db-migration +2 more');
		});

		it('uses singular "task" for 1 completed task', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle('hotfix/typo', singleDoc, 1);
			expect(title).toContain('1 task completed');
		});

		it('falls back to "Auto Run" when branch name is undefined', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const title = result.current.generatePRTitle(undefined, singleDoc, 3);
			expect(title).toMatch(/^Auto Run:/);
		});
	});

	describe('generatePRBody', () => {
		it('includes document list and task count', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(twoDocs, 8);
			expect(body).toContain('- auth-module');
			expect(body).toContain('- db-migration');
			expect(body).toContain('**Total tasks completed:** 8');
		});

		it('includes commit subjects when provided', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const commits = ['Add login endpoint', 'Fix password hashing', 'Update tests'];
			const body = result.current.generatePRBody(singleDoc, 3, commits);
			expect(body).toContain('## Changes');
			expect(body).toContain('- Add login endpoint');
			expect(body).toContain('- Fix password hashing');
			expect(body).toContain('- Update tests');
		});

		it('omits Changes section when no commits provided', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(singleDoc, 1);
			expect(body).not.toContain('## Changes');
		});

		it('omits Changes section for empty commit list', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(singleDoc, 1, []);
			expect(body).not.toContain('## Changes');
		});

		it('includes Maestro attribution footer', () => {
			const { result } = renderHook(() => useWorktreeManager());
			const body = result.current.generatePRBody(singleDoc, 1);
			expect(body).toContain('Maestro');
			expect(body).toContain('Auto Run');
		});
	});

	describe('setupWorktree', () => {
		it('returns the session cwd when worktree mode is disabled', async () => {
			const { result } = renderHook(() => useWorktreeManager());

			await expect(result.current.setupWorktree('/repo', { enabled: false })).resolves.toEqual({
				success: true,
				effectiveCwd: '/repo',
				worktreeActive: false,
			});

			expect(gitMock.worktreeSetup).not.toHaveBeenCalled();
		});

		it('returns the session cwd and logs when enabled worktree config is incomplete', async () => {
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					branchName: 'feature/missing-path',
				})
			).resolves.toEqual({
				success: true,
				effectiveCwd: '/repo',
				worktreeActive: false,
			});

			expect(loggerMock.log).toHaveBeenCalledWith(
				'warn',
				'Worktree enabled but missing configuration',
				'WorktreeManager',
				{
					hasPath: false,
					hasBranchName: true,
				}
			);
			expect(gitMock.worktreeSetup).not.toHaveBeenCalled();
		});

		it('uses a default setup error when worktree setup fails without an error message', async () => {
			gitMock.worktreeSetup.mockResolvedValue({ success: false });
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
				})
			).resolves.toMatchObject({
				success: false,
				effectiveCwd: '/repo',
				worktreeActive: false,
				error: 'Failed to set up worktree',
			});
		});

		it('returns the worktree path when setup succeeds without a branch mismatch', async () => {
			gitMock.worktreeSetup.mockResolvedValue({ success: true, branchMismatch: false });
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
				})
			).resolves.toEqual({
				success: true,
				effectiveCwd: '/repo-worktree',
				worktreeActive: true,
				worktreePath: '/repo-worktree',
				worktreeBranch: 'feature/batch',
			});

			expect(gitMock.worktreeCheckout).not.toHaveBeenCalled();
		});

		it('returns an uncommitted-changes error when branch checkout cannot proceed safely', async () => {
			gitMock.worktreeSetup.mockResolvedValue({ success: true, branchMismatch: true });
			gitMock.worktreeCheckout.mockResolvedValue({
				success: false,
				hasUncommittedChanges: true,
			});
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
				})
			).resolves.toMatchObject({
				success: false,
				effectiveCwd: '/repo',
				worktreeActive: false,
				error: 'Worktree has uncommitted changes - cannot checkout branch',
			});
		});

		it('returns the worktree path after resolving a branch mismatch with checkout', async () => {
			gitMock.worktreeSetup.mockResolvedValue({ success: true, branchMismatch: true });
			gitMock.worktreeCheckout.mockResolvedValue({ success: true });
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
					sshRemoteId: 'remote-1',
				})
			).resolves.toMatchObject({
				success: true,
				effectiveCwd: '/repo-worktree',
				worktreeActive: true,
				worktreeBranch: 'feature/batch',
			});

			expect(gitMock.worktreeCheckout).toHaveBeenCalledWith(
				'/repo-worktree',
				'feature/batch',
				true,
				'remote-1'
			);
		});

		it('uses a default checkout error when branch checkout fails without an error message', async () => {
			gitMock.worktreeSetup.mockResolvedValue({ success: true, branchMismatch: true });
			gitMock.worktreeCheckout.mockResolvedValue({ success: false });
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
				})
			).resolves.toMatchObject({
				success: false,
				effectiveCwd: '/repo',
				worktreeActive: false,
				error: 'Failed to checkout branch',
			});
		});

		it('stringifies non-Error exceptions from setup', async () => {
			gitMock.worktreeSetup.mockRejectedValue('setup exploded');
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
				})
			).resolves.toMatchObject({
				success: false,
				error: 'setup exploded',
			});
		});

		it('returns Error messages from setup exceptions', async () => {
			gitMock.worktreeSetup.mockRejectedValue(new Error('setup failed'));
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.setupWorktree('/repo', {
					enabled: true,
					path: '/repo-worktree',
					branchName: 'feature/batch',
				})
			).resolves.toMatchObject({
				success: false,
				error: 'setup failed',
			});
		});
	});

	describe('createPR', () => {
		it('uses the detected default branch when no target branch is configured', async () => {
			gitMock.getDefaultBranch.mockResolvedValue({ success: true, branch: 'trunk' });
			gitMock.log.mockResolvedValue({ entries: [] });
			gitMock.createPR.mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/acme/maestro/pull/43',
			});
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.createPR({
					worktreePath: '/repo-worktree',
					mainRepoCwd: '/repo',
					worktree: {
						enabled: true,
						path: '/repo-worktree',
						branchName: 'feature/batch',
					},
					documents: singleDoc,
					totalCompletedTasks: 1,
				})
			).resolves.toMatchObject({
				success: true,
				targetBranch: 'trunk',
			});

			expect(gitMock.createPR).toHaveBeenCalledWith(
				'/repo-worktree',
				'trunk',
				expect.any(String),
				expect.not.stringContaining('## Changes'),
				undefined
			);
		});

		it('includes commit log subjects when creating a PR with a configured target branch', async () => {
			gitMock.log.mockResolvedValue({
				entries: [{ subject: 'Add batch docs' }, { subject: 'Fix generated task list' }],
			});
			gitMock.createPR.mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/acme/maestro/pull/42',
			});
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.createPR({
					worktreePath: '/repo-worktree',
					mainRepoCwd: '/repo',
					worktree: {
						enabled: true,
						path: '/repo-worktree',
						branchName: 'feature/batch',
						prTargetBranch: 'develop',
					},
					documents: twoDocs,
					totalCompletedTasks: 2,
				})
			).resolves.toEqual({
				success: true,
				prUrl: 'https://github.com/acme/maestro/pull/42',
				targetBranch: 'develop',
			});

			expect(gitMock.getDefaultBranch).not.toHaveBeenCalled();
			expect(gitMock.createPR).toHaveBeenCalledWith(
				'/repo-worktree',
				'develop',
				'feature/batch: 2 tasks across auth-module, db-migration',
				expect.stringContaining('- Add batch docs'),
				undefined
			);
			expect(gitMock.createPR.mock.calls[0][3]).toContain('- Fix generated task list');
		});

		it('continues PR creation when reading commit history fails', async () => {
			const logError = new Error('log failed');
			gitMock.getDefaultBranch.mockResolvedValue({ success: false });
			gitMock.log.mockRejectedValue(logError);
			gitMock.createPR.mockResolvedValue({
				success: true,
				prUrl: 'https://github.com/acme/maestro/pull/44',
			});
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.createPR({
					worktreePath: '/repo-worktree',
					mainRepoCwd: '/repo',
					worktree: {
						enabled: true,
						path: '/repo-worktree',
						branchName: 'feature/batch',
					},
					documents: singleDoc,
					totalCompletedTasks: 1,
				})
			).resolves.toMatchObject({
				success: true,
				targetBranch: 'main',
			});

			expect(captureException).toHaveBeenCalledWith(logError, {
				extra: { worktreePath: '/repo-worktree', operation: 'git.log' },
			});
		});

		it('returns PR creation errors with the resolved target branch', async () => {
			gitMock.getDefaultBranch.mockResolvedValue({ success: true });
			gitMock.log.mockResolvedValue({});
			gitMock.createPR.mockResolvedValue({
				success: false,
				error: 'gh auth missing',
			});
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.createPR({
					worktreePath: '/repo-worktree',
					mainRepoCwd: '/repo',
					worktree: {
						enabled: true,
						path: '/repo-worktree',
						branchName: 'feature/batch',
					},
					documents: singleDoc,
					totalCompletedTasks: 1,
				})
			).resolves.toEqual({
				success: false,
				error: 'gh auth missing',
				targetBranch: 'main',
			});
		});

		it('returns Error messages when PR creation throws', async () => {
			gitMock.getDefaultBranch.mockResolvedValue({ success: true, branch: 'main' });
			gitMock.log.mockResolvedValue({});
			gitMock.createPR.mockRejectedValue(new Error('create failed'));
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.createPR({
					worktreePath: '/repo-worktree',
					mainRepoCwd: '/repo',
					worktree: {
						enabled: true,
						path: '/repo-worktree',
						branchName: 'feature/batch',
					},
					documents: singleDoc,
					totalCompletedTasks: 1,
				})
			).resolves.toEqual({
				success: false,
				error: 'create failed',
				targetBranch: 'main',
			});
		});

		it('uses a generic error when PR creation throws a non-Error value', async () => {
			gitMock.getDefaultBranch.mockResolvedValue({ success: true, branch: 'main' });
			gitMock.log.mockResolvedValue({});
			gitMock.createPR.mockRejectedValue('create exploded');
			const { result } = renderHook(() => useWorktreeManager());

			await expect(
				result.current.createPR({
					worktreePath: '/repo-worktree',
					mainRepoCwd: '/repo',
					worktree: {
						enabled: true,
						path: '/repo-worktree',
						branchName: 'feature/batch',
					},
					documents: singleDoc,
					totalCompletedTasks: 1,
				})
			).resolves.toEqual({
				success: false,
				error: 'Unknown error',
				targetBranch: 'main',
			});
		});
	});
});
