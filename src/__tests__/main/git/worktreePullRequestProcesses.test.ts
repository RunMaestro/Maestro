import { expect, it, vi } from 'vitest';
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/git/worktreePullRequests', () => ({
	discoverWorktreePullRequest: vi.fn(),
	readWorktreePullRequestCi: vi.fn(),
}));
import { execFileNoThrow } from '../../../main/utils/execFile';
import { discoverWorktreePullRequest } from '../../../main/git/worktreePullRequests';
import {
	refreshWorktreePullRequest,
	invalidateWorktreePullRequest,
} from '../../../main/git/worktreePullRequestRefresh';

it('lets the event loop run between background checkout probe bursts without serializing network waits', async () => {
	const turns: number[] = [];
	let turn = 0;
	let keepTicking = true;
	const tick = () => {
		turn++;
		if (keepTicking) setImmediate(tick);
	};
	setImmediate(tick);
	vi.mocked(execFileNoThrow).mockImplementation(async (_file, args) => {
		turns.push(turn);
		return {
			stdout: args[0] === 'symbolic-ref' ? 'first' : args[0] === 'remote' ? 'origin' : 'sha',
			stderr: '',
			exitCode: 0,
		};
	});
	vi.mocked(discoverWorktreePullRequest).mockResolvedValue({ status: 'detached', localSha: 'sha' });
	try {
		await Promise.all(
			['/fair-pr-one', '/fair-pr-two', '/fair-pr-three'].map((worktreePath) =>
				refreshWorktreePullRequest({ worktreePath })
			)
		);
		expect(new Set(turns).size).toBeGreaterThan(1);
		expect(turns).toHaveLength(18);
	} finally {
		keepTicking = false;
		for (const worktreePath of ['/fair-pr-one', '/fair-pr-two', '/fair-pr-three'])
			invalidateWorktreePullRequest(worktreePath);
	}
});

it('keeps slow read I/O concurrent and does not poison later starts after a failure', async () => {
	const { scheduleWorktreePullRequestRead } =
		await import('../../../main/git/worktreePullRequestProcesses');
	let release!: (value: string) => void;
	const first = scheduleWorktreePullRequestRead(
		() =>
			new Promise<string>((resolve) => {
				release = resolve;
			})
	);
	const second = scheduleWorktreePullRequestRead(async () => 'second');
	expect(await second).toBe('second');
	release('first');
	expect(await first).toBe('first');
	await expect(
		scheduleWorktreePullRequestRead(async () => {
			throw new Error('read failed');
		})
	).rejects.toThrow('read failed');
	expect(await scheduleWorktreePullRequestRead(async () => 'retry')).toBe('retry');
});

it('shares in-flight probes for duplicate checkout callers while keeping before/after reads fresh', async () => {
	vi.mocked(execFileNoThrow)
		.mockClear()
		.mockImplementation(async (_file, args) => ({
			stdout: args[0] === 'symbolic-ref' ? 'first' : args[0] === 'remote' ? 'origin' : 'sha',
			stderr: '',
			exitCode: 0,
		}));
	vi.mocked(discoverWorktreePullRequest).mockResolvedValue({ status: 'detached', localSha: 'sha' });
	const worktreePath = '/shared-background-probe';
	try {
		const result = await Promise.all(
			Array.from({ length: 8 }, () => refreshWorktreePullRequest({ worktreePath }))
		);
		expect(result.every((r) => r.discovery.status === 'detached')).toBe(true);
		expect(execFileNoThrow).toHaveBeenCalledTimes(6);
	} finally {
		invalidateWorktreePullRequest(worktreePath);
	}
});

it('does not reuse a completed branch proof while another checkout read remains in flight', async () => {
	let branch = 'first';
	let releaseRemote!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
	let remoteStarted = false;
	const remote = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
		releaseRemote = resolve;
	});
	vi.mocked(execFileNoThrow)
		.mockClear()
		.mockImplementation(async (_file, args) => {
			if (args[0] === 'remote') {
				remoteStarted = true;
				return remote;
			}
			return { stdout: args[0] === 'symbolic-ref' ? branch : 'sha', stderr: '', exitCode: 0 };
		});
	vi.mocked(discoverWorktreePullRequest).mockResolvedValue({ status: 'detached', localSha: 'sha' });
	const worktreePath = '/fresh-background-probe';
	try {
		const first = refreshWorktreePullRequest({ worktreePath });
		await vi.waitFor(() => expect(remoteStarted).toBe(true));
		branch = 'second';
		const second = refreshWorktreePullRequest({ worktreePath });
		await vi.waitFor(() =>
			expect(
				vi.mocked(execFileNoThrow).mock.calls.filter(([, args]) => args[0] === 'symbolic-ref')
			).toHaveLength(2)
		);
		releaseRemote({ stdout: 'origin', stderr: '', exitCode: 0 });
		expect((await first).discovery.status).toBe('unavailable');
		expect((await second).discovery.status).toBe('detached');
	} finally {
		releaseRemote({ stdout: 'origin', stderr: '', exitCode: 0 });
		invalidateWorktreePullRequest(worktreePath);
	}
});

it('captures a queued read command before the caller can change its arguments', async () => {
	const { execWorktreeGitReadOnly } =
		await import('../../../main/git/worktreePullRequestProcesses');
	vi.mocked(execFileNoThrow)
		.mockClear()
		.mockResolvedValue({ stdout: 'sha', stderr: '', exitCode: 0 });
	const args = ['rev-parse', '--verify', 'HEAD'];
	const pending = execWorktreeGitReadOnly(args, '/queued-read-arguments');
	args.splice(0, args.length, 'branch', '--show-current');
	await pending;
	expect(vi.mocked(execFileNoThrow).mock.calls[0][1]).toEqual(['rev-parse', '--verify', 'HEAD']);
});
