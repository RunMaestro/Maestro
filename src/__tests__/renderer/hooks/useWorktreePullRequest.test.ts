import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorktreePullRequest } from '../../../renderer/hooks/worktree/useWorktreePullRequest';
import type { WorktreePullRequestSnapshot } from '../../../shared/worktreePullRequests';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('useWorktreePullRequest', () => {
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
});
