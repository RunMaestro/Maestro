import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGitCommandRunStore } from '../../../renderer/stores/gitCommandRunStore';
import { useWorktreePullRequest } from '../../../renderer/hooks/worktree/useWorktreePullRequest';
import type { WorktreePullRequestSnapshot } from '../../../shared/worktreePullRequests';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('useWorktreePullRequest', () => {
	it('discovers an externally created PR on the next poll and clears its identity on branch change', async () => {
		const repo = { host: 'github.com', owner: 'owner', name: 'repo' };
		const head = { branch: 'feature', localSha: 'abc', repository: repo };
		const identity = { repository: repo, number: 42 };
		const refresh = vi
			.fn()
			.mockResolvedValueOnce({ discovery: { status: 'no-pr', head, repository: repo } })
			.mockResolvedValueOnce({ discovery: { status: 'found', head, pullRequest: { identity } } })
			.mockResolvedValue({ discovery: { status: 'no-pr', head, repository: repo } });
		window.maestro.git.refreshWorktreePullRequest = refresh;
		vi.useFakeTimers();
		try {
			const { result, rerender, unmount } = renderHook(
				({ branch }) => useWorktreePullRequest('/repo', branch),
				{ initialProps: { branch: 'feature' } }
			);
			await act(async () => {});
			expect(result.current.snapshot?.discovery.status).toBe('no-pr');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(result.current.snapshot?.discovery.status).toBe('found');
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(refresh.mock.calls[2][0].knownPullRequest).toEqual(identity);
			rerender({ branch: 'other' });
			await act(async () => {});
			expect(refresh.mock.calls[3][0].knownPullRequest).toBeUndefined();
			unmount();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(refresh).toHaveBeenCalledTimes(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(['authentication required', 'offline'])(
		'exposes %s when no earlier snapshot exists',
		async (message) => {
			window.maestro.git.refreshWorktreePullRequest = vi.fn().mockResolvedValue({
				discovery: { status: 'unavailable', reason: 'gh', message },
			});
			const { result } = renderHook(() => useWorktreePullRequest('/repo', 'main'));
			await waitFor(() =>
				expect(result.current.snapshot?.discovery).toMatchObject({ status: 'unavailable', message })
			);
			expect(result.current.stale).toBe(false);
		}
	);
	it('discards a response from the previous branch and cleans up polling', async () => {
		let resolveFirst!: (snapshot: WorktreePullRequestSnapshot) => void;
		const first = new Promise<WorktreePullRequestSnapshot>((resolve) => (resolveFirst = resolve));
		const refresh = vi
			.fn()
			.mockReturnValueOnce(first)
			.mockResolvedValue({
				discovery: { status: 'unavailable', reason: 'gh', message: 'offline' },
			});
		const invalidate = vi.fn().mockResolvedValue(undefined);
		window.maestro.git.refreshWorktreePullRequest = refresh;
		window.maestro.git.invalidateWorktreePullRequest = invalidate;
		const { result, rerender, unmount } = renderHook(
			({ branch }) => useWorktreePullRequest('/repo', branch),
			{ initialProps: { branch: 'old' } }
		);
		rerender({ branch: 'new' });
		await waitFor(() => expect(result.current.snapshot?.discovery.status).toBe('unavailable'));
		await act(async () => {
			resolveFirst({ discovery: { status: 'detached', localSha: 'old' } });
			await first;
		});
		expect(result.current.snapshot?.discovery).toMatchObject({ message: 'offline' });
		await act(async () => result.current.refresh());
		await waitFor(() => expect(invalidate).toHaveBeenCalledWith('/repo'));
		unmount();
		expect(refresh).toHaveBeenCalledTimes(3);
	});
	it('refreshes on checkout and successful push, retaining stale data on failure', async () => {
		const refresh = vi
			.fn()
			.mockResolvedValueOnce({ discovery: { status: 'detached', localSha: 'abc' } })
			.mockResolvedValueOnce({
				discovery: { status: 'unavailable', reason: 'gh', message: 'offline' },
			})
			.mockResolvedValue({ discovery: { status: 'detached', localSha: 'def' } });
		const invalidate = vi.fn().mockResolvedValue(undefined);
		window.maestro.git.refreshWorktreePullRequest = refresh;
		window.maestro.git.invalidateWorktreePullRequest = invalidate;
		const { result, unmount } = renderHook(() => useWorktreePullRequest('/repo', 'main'));
		await waitFor(() => expect(result.current.snapshot?.discovery.status).toBe('detached'));
		await act(async () => result.current.refresh());
		await waitFor(() => expect(result.current.stale).toBe(true));
		expect(result.current.error).toBe('offline');
		await act(async () =>
			window.dispatchEvent(new CustomEvent('maestro:git-checkout', { detail: { cwd: '/repo' } }))
		);
		await waitFor(() =>
			expect(result.current.snapshot?.discovery).toMatchObject({ localSha: 'def' })
		);
		expect(result.current.stale).toBe(false);
		const run = {
			key: 'push',
			runId: 'run',
			sessionId: 'session',
			operation: 'push' as const,
			cwd: '/repo',
			status: 'running' as const,
			setUpstream: false,
			output: '',
			announced: false,
		};
		act(() => useGitCommandRunStore.setState({ runs: { push: run } }));
		act(() => useGitCommandRunStore.setState({ runs: { push: { ...run, status: 'success' } } }));
		await waitFor(() => expect(refresh).toHaveBeenCalledTimes(4));
		unmount();
		useGitCommandRunStore.setState({ runs: {} });
		window.dispatchEvent(new CustomEvent('maestro:git-checkout', { detail: { cwd: '/repo' } }));
		expect(refresh).toHaveBeenCalledTimes(4);
	});
});
