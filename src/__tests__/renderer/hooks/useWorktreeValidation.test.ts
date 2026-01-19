/**
 * Tests for useWorktreeValidation hook
 *
 * This hook provides debounced validation of git worktree paths,
 * checking for existence, branch mismatches, and uncommitted changes.
 *
 * Note: These tests use real timers with short waits because the hook
 * has a 500ms debounce that doesn't play well with fake timers and async state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorktreeValidation } from '../../../renderer/hooks';

// Mock the window.maestro.git object
const mockGit = {
	worktreeInfo: vi.fn(),
	getRepoRoot: vi.fn(),
	status: vi.fn(),
};

// Setup mock before each test
beforeEach(() => {
	vi.clearAllMocks();

	// Ensure window.maestro.git is mocked
	(window as any).maestro = {
		...(window as any).maestro,
		git: mockGit,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Helper to wait for debounce (500ms) + extra time for async operations
const waitForDebounce = () => new Promise((resolve) => setTimeout(resolve, 600));

describe('useWorktreeValidation', () => {
	describe('initial state', () => {
		it('returns initial state when worktree is disabled', () => {
			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'feature-branch',
					worktreeEnabled: false,
					sessionCwd: '/main/repo',
				})
			);

			expect(result.current.validation).toEqual({
				checking: false,
				exists: false,
				isWorktree: false,
				branchMismatch: false,
				sameRepo: true,
				hasUncommittedChanges: false,
			});
		});

		it('returns initial state when worktreePath is empty', () => {
			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			expect(result.current.validation).toEqual({
				checking: false,
				exists: false,
				isWorktree: false,
				branchMismatch: false,
				sameRepo: true,
				hasUncommittedChanges: false,
			});
		});

		it('sets checking state immediately when validation starts', () => {
			mockGit.worktreeInfo.mockImplementation(() => new Promise(() => {})); // Never resolves

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			expect(result.current.validation.checking).toBe(true);
		});
	});

	describe('path validation', () => {
		it('validates path that does not exist (will be created)', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: false,
			});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/new-worktree',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			expect(result.current.validation).toEqual({
				checking: false,
				exists: false,
				isWorktree: false,
				branchMismatch: false,
				sameRepo: true,
				hasUncommittedChanges: false,
			});
		});

		it('validates existing worktree with same branch (no mismatch)', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'feature-branch',
				repoRoot: '/main/repo',
			});
			mockGit.getRepoRoot.mockResolvedValue({
				success: true,
				root: '/main/repo',
			});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			expect(result.current.validation.exists).toBe(true);
			expect(result.current.validation.isWorktree).toBe(true);
			expect(result.current.validation.branchMismatch).toBe(false);
			expect(result.current.validation.sameRepo).toBe(true);
			expect(result.current.validation.currentBranch).toBe('feature-branch');
		});
	});

	describe('branch mismatch detection', () => {
		it('detects branch mismatch and checks for uncommitted changes', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'old-branch',
				repoRoot: '/main/repo',
			});
			mockGit.getRepoRoot.mockResolvedValue({
				success: true,
				root: '/main/repo',
			});
			mockGit.status.mockResolvedValue({
				stdout: 'M file.txt',
				stderr: '',
			});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'new-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			expect(result.current.validation.branchMismatch).toBe(true);
			expect(result.current.validation.hasUncommittedChanges).toBe(true);
			// sshRemoteId is undefined when not provided in deps
			expect(mockGit.status).toHaveBeenCalledWith('/path/to/worktree', undefined);
		});

		it('does not check uncommitted changes when repos differ', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'old-branch',
				repoRoot: '/different/repo',
			});
			mockGit.getRepoRoot.mockResolvedValue({
				success: true,
				root: '/main/repo',
			});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'new-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			// Status should not be called since repos differ
			expect(mockGit.status).not.toHaveBeenCalled();
		});
	});

	describe('different repository detection', () => {
		it('detects different repository and sets error', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'some-branch',
				repoRoot: '/different/repo',
			});
			mockGit.getRepoRoot.mockResolvedValue({
				success: true,
				root: '/main/repo',
			});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/different-repo-worktree',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			expect(result.current.validation.sameRepo).toBe(false);
			expect(result.current.validation.error).toBe(
				'This path contains a worktree for a different repository'
			);
		});
	});

	describe('error handling', () => {
		it('handles worktreeInfo API failure', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: false,
				error: 'Permission denied',
			});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			expect(result.current.validation.error).toBe('Permission denied');
		});

		it('handles exception during validation', async () => {
			mockGit.worktreeInfo.mockRejectedValue(new Error('Network error'));
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'feature-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			expect(result.current.validation.error).toBe('Failed to validate worktree path');
			expect(consoleError).toHaveBeenCalled();

			consoleError.mockRestore();
		});

		it('handles git status failure gracefully during uncommitted changes check', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'old-branch',
				repoRoot: '/main/repo',
			});
			mockGit.getRepoRoot.mockResolvedValue({
				success: true,
				root: '/main/repo',
			});
			mockGit.status.mockRejectedValue(new Error('Git status failed'));

			const { result } = renderHook(() =>
				useWorktreeValidation({
					worktreePath: '/path/to/worktree',
					branchName: 'new-branch',
					worktreeEnabled: true,
					sessionCwd: '/main/repo',
				})
			);

			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.checking).toBe(false);
			});

			// Should assume no uncommitted changes on status failure
			expect(result.current.validation.hasUncommittedChanges).toBe(false);
			expect(result.current.validation.branchMismatch).toBe(true);
		});
	});

	describe('debouncing and cleanup', () => {
		it('resets state when worktree becomes disabled', async () => {
			mockGit.worktreeInfo.mockResolvedValue({
				success: true,
				exists: true,
				isWorktree: true,
				currentBranch: 'feature-branch',
				repoRoot: '/main/repo',
			});
			mockGit.getRepoRoot.mockResolvedValue({
				success: true,
				root: '/main/repo',
			});

			const { result, rerender } = renderHook(
				({ enabled }) =>
					useWorktreeValidation({
						worktreePath: '/path/to/worktree',
						branchName: 'feature-branch',
						worktreeEnabled: enabled,
						sessionCwd: '/main/repo',
					}),
				{ initialProps: { enabled: true } }
			);

			// Wait for validation while enabled
			await waitForDebounce();

			await waitFor(() => {
				expect(result.current.validation.exists).toBe(true);
			});

			// Disable worktree
			rerender({ enabled: false });

			expect(result.current.validation).toEqual({
				checking: false,
				exists: false,
				isWorktree: false,
				branchMismatch: false,
				sameRepo: true,
				hasUncommittedChanges: false,
			});
		});
	});
});
