/**
 * Tests for useAutoRun (web mobile).
 *
 * Covers:
 * - launchAutoRun forwards the optional `worktree` payload through
 *   `configure_auto_run` and returns a Promise<LaunchAutoRunResult>.
 * - launchAutoRun resolves with success=false (and an error message) when the
 *   server reports failure or the request rejects - used by the mobile App
 *   to revert the optimistic "connecting" indicator (Gap 1).
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
		sendRequest.mockResolvedValue({ success: true });
	});

	describe('launchAutoRun', () => {
		it('omits worktree when none is supplied and resolves with the server result', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					prompt: 'p',
				});
			});

			expect(sendRequest).toHaveBeenCalledTimes(1);
			expect(sendRequest).toHaveBeenCalledWith(
				'configure_auto_run',
				{
					sessionId: 's-1',
					documents: [{ filename: 'doc.md' }],
					prompt: 'p',
					loopEnabled: undefined,
					maxLoops: undefined,
					launch: true,
				},
				10_000
			);
			expect(response).toEqual({ success: true, error: undefined });
		});

		it('uses an extended timeout when worktree dispatch is enabled', async () => {
			const worktree: LaunchWorktreeConfig = {
				enabled: true,
				path: '/repo/worktrees/auto-run-main-0503',
				branchName: 'auto-run-main-0503',
				createPROnCompletion: false,
				prTargetBranch: 'main',
			};
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					worktree,
				});
			});

			expect(sendRequest.mock.calls[0][2]).toBe(60_000);
		});

		it('uses the default timeout when worktree dispatch is disabled', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
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

			expect(sendRequest.mock.calls[0][2]).toBe(10_000);
		});

		it('forwards worktree config when enabled', async () => {
			const worktree: LaunchWorktreeConfig = {
				enabled: true,
				path: '/repo/worktrees/auto-run-main-0503',
				branchName: 'auto-run-main-0503',
				createPROnCompletion: true,
				prTargetBranch: 'main',
			};

			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
					worktree,
				});
			});

			const payload = sendRequest.mock.calls[0][1];
			expect(payload.worktree).toEqual(worktree);
		});

		it('strips a disabled worktree config', async () => {
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await act(async () => {
				await result.current.launchAutoRun('s-1', {
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
			expect(sendRequest.mock.calls[0][1].worktree).toBeUndefined();
		});

		it('returns success=false when the server reports an error', async () => {
			sendRequest.mockResolvedValueOnce({ success: false, error: 'Bad request' });
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: 'Bad request' });
		});

		it('returns success=false when sendRequest rejects with a known transport error', async () => {
			sendRequest.mockRejectedValueOnce(new Error('Request timed out'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: 'Request timed out' });
		});

		it('also handles WebSocket-not-connected as a known transport failure', async () => {
			sendRequest.mockRejectedValueOnce(new Error('WebSocket not connected'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: 'WebSocket not connected' });
		});

		it('re-throws unexpected errors so they bubble to global handlers / Sentry', async () => {
			const unexpected = new Error('Some non-transport bug');
			sendRequest.mockRejectedValueOnce(unexpected);
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			await expect(
				result.current.launchAutoRun('s-1', { documents: [{ filename: 'doc.md' }] })
			).rejects.toBe(unexpected);
		});

		it('treats a missing success field as failure', async () => {
			sendRequest.mockResolvedValueOnce({});
			const { result } = renderHook(() => useAutoRun(sendRequest, send));

			let response: { success: boolean; error?: string } | undefined;
			await act(async () => {
				response = await result.current.launchAutoRun('s-1', {
					documents: [{ filename: 'doc.md' }],
				});
			});

			expect(response).toEqual({ success: false, error: undefined });
		});
	});

	describe('loadGitBranches', () => {
		it('sends get_git_branches and returns branches list', async () => {
			sendRequest.mockResolvedValueOnce({
				branches: ['main', 'feature/x'],
				currentBranch: 'main',
			});

			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			const out = await result.current.loadGitBranches('s-1');

			expect(sendRequest).toHaveBeenCalledWith('get_git_branches', { sessionId: 's-1' });
			expect(out).toEqual({ branches: ['main', 'feature/x'], currentBranch: 'main' });
		});

		it('propagates transport errors to the caller', async () => {
			sendRequest.mockRejectedValueOnce(new Error('boom'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await expect(result.current.loadGitBranches('s-1')).rejects.toThrow('boom');
		});
	});

	describe('listWorktrees', () => {
		it('sends list_worktrees and unwraps response', async () => {
			sendRequest.mockResolvedValueOnce({
				worktrees: [{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }],
			});

			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			const out = await result.current.listWorktrees('s-1');

			expect(sendRequest).toHaveBeenCalledWith('list_worktrees', { sessionId: 's-1' });
			expect(out).toEqual([{ path: '/repo/wt-1', branch: 'feat/x', isBare: false }]);
		});

		it('propagates transport errors to the caller', async () => {
			sendRequest.mockRejectedValueOnce(new Error('boom'));
			const { result } = renderHook(() => useAutoRun(sendRequest, send));
			await expect(result.current.listWorktrees('s-1')).rejects.toThrow('boom');
		});
	});
});
