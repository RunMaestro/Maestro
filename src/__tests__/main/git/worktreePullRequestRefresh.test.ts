import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../../main/git/worktreePullRequests', () => ({
	discoverWorktreePullRequest: vi.fn(),
	readWorktreePullRequestCi: vi.fn(),
}));
import { execGitReadOnly } from '../../../main/utils/remote-git';
import {
	discoverWorktreePullRequest,
	readWorktreePullRequestCi,
} from '../../../main/git/worktreePullRequests';
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

afterEach(() => vi.restoreAllMocks());

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
	it.each(['discovery', 'ci'] as const)(
		'preserves the original unavailable %s result for every concurrent caller',
		async (stage) => {
			const unavailable = {
				status: 'unavailable' as const,
				reason: 'gh' as const,
				message: 'Authentication expired',
			};
			if (stage === 'discovery') {
				vi.mocked(discoverWorktreePullRequest).mockResolvedValue(unavailable);
			} else {
				const repository = { host: 'github.com', owner: 'owner', name: 'repo' };
				vi.mocked(discoverWorktreePullRequest).mockResolvedValue({
					status: 'found',
					head: { branch: 'first', localSha: 'sha', repository },
					pullRequest: {
						identity: { number: 1, repository },
						title: 'Change',
						url: 'https://github.com/owner/repo/pull/1',
						state: 'OPEN',
						isDraft: false,
						headRepository: repository,
						headBranch: 'first',
						headSha: 'sha',
						baseBranch: 'rc',
					},
				});
				vi.mocked(readWorktreePullRequestCi).mockResolvedValue({
					ci: { status: 'unavailable', message: unavailable.message },
				});
			}
			const results = await Promise.all(
				Array.from({ length: 8 }, () => refreshWorktreePullRequest(request))
			);
			for (const snapshot of results) {
				if (stage === 'discovery') expect(snapshot.discovery).toEqual(unavailable);
				else expect(snapshot.ci).toEqual({ status: 'unavailable', message: unavailable.message });
			}
			expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(1);
			await refreshWorktreePullRequest(request);
			expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(2);
		}
	);
	it('does not let a delayed unavailable caller evict a newer successful retry', async () => {
		let headReads = 0;
		let releaseHead!: () => void;
		const headGate = new Promise<void>((resolve) => {
			releaseHead = resolve;
		});
		vi.mocked(execGitReadOnly).mockImplementation(async (args) => {
			if (args[0] === 'rev-parse' && ++headReads === 4) await headGate;
			return {
				stdout: args[0] === 'symbolic-ref' ? branch : args[0] === 'remote' ? 'origin' : 'sha',
				stderr: '',
				exitCode: 0,
			};
		});
		const unavailable = {
			status: 'unavailable' as const,
			reason: 'gh' as const,
			message: 'Offline',
		};
		vi.mocked(discoverWorktreePullRequest)
			.mockResolvedValueOnce(unavailable)
			.mockResolvedValue({ status: 'detached', localSha: 'sha' });
		const first = refreshWorktreePullRequest(request);
		const delayed = refreshWorktreePullRequest(request);
		expect((await first).discovery).toEqual(unavailable);
		await vi.waitFor(() => expect(headReads).toBe(4));
		expect((await refreshWorktreePullRequest(request)).discovery.status).toBe('detached');
		releaseHead();
		expect((await delayed).discovery).toEqual(unavailable);
		await refreshWorktreePullRequest(request);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(2);
	});
	it('retains a slow pending refresh and starts the cache TTL when it completes', async () => {
		let now = 0;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		let finish!: (result: { status: 'detached'; localSha: string }) => void;
		vi.mocked(discoverWorktreePullRequest).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const first = refreshWorktreePullRequest(request);
		await vi.waitFor(() => expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(1));
		now = 120_000;
		const second = refreshWorktreePullRequest(request);
		finish({ status: 'detached', localSha: 'sha' });
		expect((await Promise.all([first, second])).map((s) => s.discovery.status)).toEqual([
			'detached',
			'detached',
		]);
		now += 29_999;
		await refreshWorktreePullRequest(request);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(1);
		now += 1;
		await refreshWorktreePullRequest(request);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(2);
	});
	it('refuses excess refreshes instead of evicting live requests under cache pressure', async () => {
		const paths = Array.from({ length: 101 }, (_, i) => `/pressure-${i}`);
		let finish!: (result: { status: 'detached'; localSha: string }) => void;
		const discovery = new Promise<{ status: 'detached'; localSha: string }>((resolve) => {
			finish = resolve;
		});
		vi.mocked(discoverWorktreePullRequest).mockReturnValue(discovery);
		try {
			const pending = paths
				.slice(0, 100)
				.map((worktreePath) => refreshWorktreePullRequest({ worktreePath }));
			await vi.waitFor(() => expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(100));
			expect(
				(await refreshWorktreePullRequest({ worktreePath: paths[100] })).discovery
			).toMatchObject({
				status: 'unavailable',
				message: expect.stringContaining('in flight'),
			});
			finish({ status: 'detached', localSha: 'sha' });
			expect((await Promise.all(pending)).every((s) => s.discovery.status === 'detached')).toBe(
				true
			);
		} finally {
			finish({ status: 'detached', localSha: 'sha' });
			for (const path of paths) invalidateWorktreePullRequest(path);
		}
	});
	it('still rejects a slow response after explicit invalidation', async () => {
		let finish!: (result: { status: 'detached'; localSha: string }) => void;
		vi.mocked(discoverWorktreePullRequest).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const pending = refreshWorktreePullRequest(request);
		await vi.waitFor(() => expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(1));
		invalidateWorktreePullRequest(request.worktreePath);
		finish({ status: 'detached', localSha: 'sha' });
		expect((await pending).discovery).toMatchObject({ status: 'unavailable' });
	});
	it('retries after a rejected pending discovery', async () => {
		vi.mocked(discoverWorktreePullRequest).mockRejectedValueOnce(new Error('offline'));
		await expect(refreshWorktreePullRequest(request)).rejects.toThrow('offline');
		vi.mocked(discoverWorktreePullRequest).mockResolvedValue({
			status: 'detached',
			localSha: 'sha',
		});
		expect((await refreshWorktreePullRequest(request)).discovery.status).toBe('detached');
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
