/**
 * Tests for useAutoRun (web mobile).
 *
 * Focused on the Run-in-Worktree additions:
 * - launchAutoRun forwards the optional `worktree` payload through
 *   `configure_auto_run`.
 * - loadGitBranches dispatches `get_git_branches` and unwraps the response.
 * - listWorktrees dispatches `list_worktrees` and unwraps the response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRun, type LaunchWorktreeConfig } from '../../../web/hooks/useAutoRun';

describe('useAutoRun (mobile/web)', () => {
	const send = vi.fn().mockReturnValue(true);
	const sendRequest = vi.fn();

	beforeEach(() => {
		send.mockClear();
		sendRequest.mockReset();
	});

	it('launchAutoRun omits worktree when none is supplied', () => {
		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		act(() => {
			result.current.launchAutoRun('s-1', {
				documents: [{ filename: 'doc.md' }],
				prompt: 'p',
			});
		});

		expect(send).toHaveBeenCalledTimes(1);
		const payload = send.mock.calls[0][0];
		expect(payload.type).toBe('configure_auto_run');
		expect(payload.sessionId).toBe('s-1');
		expect(payload.launch).toBe(true);
		expect(payload.worktree).toBeUndefined();
	});

	it('launchAutoRun forwards worktree config when enabled', () => {
		const worktree: LaunchWorktreeConfig = {
			enabled: true,
			path: '/repo/worktrees/auto-run-main-0503',
			branchName: 'auto-run-main-0503',
			createPROnCompletion: true,
			prTargetBranch: 'main',
		};

		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		act(() => {
			result.current.launchAutoRun('s-1', {
				documents: [{ filename: 'doc.md' }],
				worktree,
			});
		});

		const payload = send.mock.calls[0][0];
		expect(payload.worktree).toEqual(worktree);
	});

	it('launchAutoRun strips a disabled worktree config', () => {
		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		act(() => {
			result.current.launchAutoRun('s-1', {
				documents: [{ filename: 'doc.md' }],
				worktree: {
					enabled: false,
					path: '/x',
					branchName: 'b',
					createPROnCompletion: false,
					prTargetBranch: 'main',
				},
			});
		});
		expect(send.mock.calls[0][0].worktree).toBeUndefined();
	});

	it('loadGitBranches sends get_git_branches and returns branches list', async () => {
		sendRequest.mockResolvedValueOnce({
			branches: ['main', 'feature/x'],
			currentBranch: 'main',
		});

		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		const out = await result.current.loadGitBranches('s-1');

		expect(sendRequest).toHaveBeenCalledWith('get_git_branches', { sessionId: 's-1' });
		expect(out).toEqual({ branches: ['main', 'feature/x'], currentBranch: 'main' });
	});

	it('loadGitBranches propagates transport errors to the caller', async () => {
		sendRequest.mockRejectedValueOnce(new Error('boom'));
		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		await expect(result.current.loadGitBranches('s-1')).rejects.toThrow('boom');
	});

	it('listWorktrees sends list_worktrees and unwraps response', async () => {
		sendRequest.mockResolvedValueOnce({
			worktrees: [{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }],
		});

		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		const out = await result.current.listWorktrees('s-1');

		expect(sendRequest).toHaveBeenCalledWith('list_worktrees', { sessionId: 's-1' });
		expect(out).toEqual([{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }]);
	});

	it('listWorktrees propagates transport errors to the caller', async () => {
		sendRequest.mockRejectedValueOnce(new Error('boom'));
		const { result } = renderHook(() => useAutoRun(sendRequest, send));
		await expect(result.current.listWorktrees('s-1')).rejects.toThrow('boom');
	});
});
