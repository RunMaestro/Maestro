import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../../main/git/worktreePullRequests', () => ({
	discoverWorktreePullRequest: vi.fn(),
	readWorktreePullRequestCi: vi.fn(),
}));
import { execGitReadOnly } from '../../../main/utils/remote-git';
import { discoverWorktreePullRequest } from '../../../main/git/worktreePullRequests';
import {
	invalidateWorktreePullRequest,
	refreshWorktreePullRequest,
} from '../../../main/git/worktreePullRequestRefresh';

const request = { worktreePath: '/refresh-test' };
let branch = 'first';
beforeEach(() => {
	invalidateWorktreePullRequest(request.worktreePath);
	vi.resetAllMocks();
	branch = 'first';
	vi.mocked(execGitReadOnly).mockImplementation(async (args) => ({
		stdout: args[0] === 'symbolic-ref' ? branch : args[0] === 'remote' ? 'origin' : 'sha',
		stderr: '',
		exitCode: 0,
	}));
});

describe('worktree PR refresh', () => {
	it('deduplicates concurrent refreshes and invalidates cached results', async () => {
		vi.mocked(discoverWorktreePullRequest).mockResolvedValue({
			status: 'detached',
			localSha: 'sha',
		});
		await Promise.all([refreshWorktreePullRequest(request), refreshWorktreePullRequest(request)]);
		await refreshWorktreePullRequest(request);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(1);
		invalidateWorktreePullRequest(request.worktreePath);
		await refreshWorktreePullRequest(request);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(2);
	});
	it('shares one discovery across duplicate sessions for the same checkout', async () => {
		let finish!: (result: { status: 'detached'; localSha: string }) => void;
		vi.mocked(discoverWorktreePullRequest).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const sessions = Array.from({ length: 8 }, () => refreshWorktreePullRequest({ ...request }));
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		finish({ status: 'detached', localSha: 'sha' });
		expect(
			(await Promise.all(sessions)).every((snapshot) => snapshot.discovery.status === 'detached')
		).toBe(true);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(1);
	});
	it('rejects an in-flight result after a branch switch', async () => {
		let finish!: (result: { status: 'detached'; localSha: string }) => void;
		vi.mocked(discoverWorktreePullRequest).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const pending = refreshWorktreePullRequest(request);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		branch = 'second';
		finish({ status: 'detached', localSha: 'sha' });
		expect((await pending).discovery.status).toBe('unavailable');
	});
});
