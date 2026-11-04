import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn(async () => 'gh'),
	getExpandedEnv: () => ({}),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
import { execGitReadOnly } from '../../../main/utils/remote-git';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { discoverWorktreePullRequest } from '../../../main/git/worktreePullRequests';
import { readWorktreePullRequestCi } from '../../../main/git/worktreePullRequests';

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const repository = (owner: string) => ({ name: 'project', owner: { login: owner } });
const metadata = { ...repository('fork'), fork: true, parent: repository('upstream') };
const pull = (owner = 'fork', state = 'open') => ({
	number: 3,
	title: 'Change',
	html_url: 'https://github.com/upstream/project/pull/3',
	state,
	merged_at: state === 'closed' ? '2026-01-01' : null,
	draft: false,
	head: { repo: repository(owner), ref: 'feature', sha: 'remote-sha' },
	base: { ref: 'rc' },
});

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
		ok(
			args[0] === 'rev-parse'
				? 'local-sha'
				: args[0] === 'symbolic-ref'
					? 'feature'
					: 'git@github.com:fork/project.git'
		)
	);
});

describe('worktree PR discovery', () => {
	it('selects the fork identity in the parent repository and returns PR metadata', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce(ok(JSON.stringify([[pull('other'), pull()]])));
		const result = await discoverWorktreePullRequest({ worktreePath: '/checkout' });
		expect(result).toMatchObject({
			status: 'found',
			head: { localSha: 'local-sha' },
			pullRequest: {
				identity: { repository: { owner: 'upstream' }, number: 3 },
				headSha: 'remote-sha',
				baseBranch: 'rc',
			},
		});
		expect(vi.mocked(execFileNoThrow).mock.calls[1][1]).toContain('head=fork:feature');
	});
	it('reports multiple matching PRs as ambiguous', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce(ok(JSON.stringify([[pull(), { ...pull(), number: 4 }]])));
		expect(await discoverWorktreePullRequest({ worktreePath: '/checkout' })).toMatchObject({
			status: 'ambiguous',
			pullRequests: [{ identity: { number: 3 } }, { identity: { number: 4 } }],
		});
	});
	it('distinguishes no PR from an authentication failure', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce(ok('[[]]'));
		expect((await discoverWorktreePullRequest({ worktreePath: '/checkout' })).status).toBe('no-pr');
		vi.mocked(execFileNoThrow).mockResolvedValueOnce({
			stdout: '',
			stderr: 'authentication failed',
			exitCode: 1,
		});
		expect(await discoverWorktreePullRequest({ worktreePath: '/checkout' })).toMatchObject({
			status: 'unavailable',
			reason: 'gh',
		});
	});
	it('reports an offline PR lookup as unavailable instead of no PR', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce({ stdout: '', stderr: 'network unreachable', exitCode: 1 });
		expect(await discoverWorktreePullRequest({ worktreePath: '/checkout' })).toMatchObject({
			status: 'unavailable',
			reason: 'gh',
			message: 'network unreachable',
		});
	});
	it('reports a retained closed PR and rejects one belonging to another fork', async () => {
		const knownPullRequest = {
			repository: { host: 'github.com', owner: 'upstream', name: 'project' },
			number: 3,
		};
		const closed = { ...pull(), state: 'closed', merged_at: null };
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce(ok('[[]]'))
			.mockResolvedValueOnce(ok(JSON.stringify(closed)))
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce(ok('[[]]'))
			.mockResolvedValueOnce(ok(JSON.stringify(pull('other', 'closed'))));
		expect(
			await discoverWorktreePullRequest({ worktreePath: '/checkout', knownPullRequest })
		).toMatchObject({ status: 'found', pullRequest: { state: 'CLOSED' } });
		expect(
			await discoverWorktreePullRequest({ worktreePath: '/checkout', knownPullRequest })
		).toMatchObject({ status: 'no-pr' });
	});
	it('retains a merged PR by number after it leaves the open list', async () => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok(JSON.stringify(metadata)))
			.mockResolvedValueOnce(ok('[[]]'))
			.mockResolvedValueOnce(ok(JSON.stringify(pull('fork', 'closed'))));
		expect(
			await discoverWorktreePullRequest({
				worktreePath: '/checkout',
				knownPullRequest: {
					repository: { host: 'github.com', owner: 'upstream', name: 'project' },
					number: 3,
				},
			})
		).toMatchObject({ status: 'found', pullRequest: { state: 'MERGED' } });
	});
	it('never reads local paths for SSH and reports detached HEAD', async () => {
		expect(
			await discoverWorktreePullRequest({ worktreePath: '/remote', sshRemoteId: 'remote' })
		).toMatchObject({ status: 'unavailable', reason: 'ssh-unsupported' });
		expect(execGitReadOnly).not.toHaveBeenCalled();
		vi.mocked(execGitReadOnly)
			.mockResolvedValueOnce(ok('local-sha'))
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });
		expect(await discoverWorktreePullRequest({ worktreePath: '/checkout' })).toEqual({
			status: 'detached',
			localSha: 'local-sha',
		});
	});
});

describe('worktree PR checks', () => {
	it('keeps an unavailable local comparison separate from check states', async () => {
		const local = 'a'.repeat(40);
		const remote = 'b'.repeat(40);
		const repo = { host: 'github.com', owner: 'fork', name: 'project' };
		const found = {
			status: 'found' as const,
			head: { branch: 'feature', localSha: local, repository: repo },
			pullRequest: {
				identity: { repository: { ...repo, owner: 'upstream' }, number: 3 },
				title: 'Change',
				url: 'https://github.com/upstream/project/pull/3',
				state: 'OPEN' as const,
				isDraft: false,
				headRepository: repo,
				headBranch: 'feature',
				headSha: remote,
				baseBranch: 'rc',
			},
		};
		vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
			args[0] === 'rev-list'
				? { stdout: '', stderr: 'unknown revision', exitCode: 1 }
				: ok(args[0] === 'symbolic-ref' ? 'feature' : local)
		);
		vi.mocked(execFileNoThrow).mockImplementation(async (_gh, args) => {
			const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
			if (endpoint.includes('check-runs'))
				return ok(
					JSON.stringify([
						{
							check_runs: [
								{ id: 1, name: 'queued', status: 'queued' },
								{ id: 2, name: 'running', status: 'in_progress' },
								{ id: 3, name: 'failed', status: 'completed', conclusion: 'failure' },
								{ id: 4, name: 'skipped', status: 'completed', conclusion: 'skipped' },
								{ id: 5, name: 'cancelled', status: 'completed', conclusion: 'cancelled' },
							],
						},
					])
				);
			if (endpoint.includes('statuses')) return ok('[[]]');
			if (endpoint.includes('actions/runs')) return ok('[{"workflow_runs":[]}]');
			return ok(JSON.stringify({ ...pull(), head: { ...pull().head, sha: remote } }));
		});
		const result = await readWorktreePullRequestCi({ worktreePath: '/checkout' }, found);
		expect(result.divergence).toMatchObject({ status: 'unavailable', message: 'unknown revision' });
		expect(result.ci).toMatchObject({
			status: 'available',
			headSha: remote,
			checks: [
				{ id: '1', state: 'pending' },
				{ id: '2', state: 'running' },
				{ id: '3', state: 'failed' },
				{ id: '4', state: 'skipped' },
				{ id: '5', state: 'cancelled' },
			],
		});
	});
	it('reads current head checks and separately reports local divergence', async () => {
		const { readWorktreePullRequestCi } = await import('../../../main/git/worktreePullRequests');
		const local = 'a'.repeat(40);
		const remote = 'b'.repeat(40);
		vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
			ok(args[0] === 'rev-list' ? '2\t1' : args[0] === 'symbolic-ref' ? 'feature' : local)
		);
		vi.mocked(execFileNoThrow).mockImplementation(async (_gh, args) => {
			const path = args.find((arg) => arg.startsWith('repos/')) || '';
			if (path.includes('check-runs'))
				return ok(
					JSON.stringify([
						{
							check_runs: [
								{
									id: 12,
									name: 'test',
									status: 'completed',
									conclusion: 'success',
									check_suite: { id: 44 },
								},
							],
						},
					])
				);
			if (path.includes('statuses')) return ok('[[]]');
			if (path.includes('actions/runs'))
				return ok(
					JSON.stringify([{ workflow_runs: [{ check_suite_id: 44, workflow_id: 55, name: 'CI' }] }])
				);
			return ok(JSON.stringify({ ...pull(), head: { ...pull().head, sha: remote } }));
		});
		const repo = { host: 'github.com', owner: 'fork', name: 'project' };
		const result = await readWorktreePullRequestCi(
			{ worktreePath: '/checkout' },
			{
				status: 'found',
				head: { branch: 'feature', localSha: local, repository: repo },
				pullRequest: {
					identity: { repository: { ...repo, owner: 'upstream' }, number: 3 },
					title: 'Change',
					url: 'https://github.com/upstream/project/pull/3',
					state: 'OPEN',
					isDraft: false,
					headRepository: repo,
					headBranch: 'feature',
					headSha: remote,
					baseBranch: 'rc',
				},
			}
		);
		expect(result.divergence).toMatchObject({ status: 'different', ahead: 2, behind: 1 });
		expect(result.ci).toMatchObject({
			status: 'available',
			headSha: remote,
			checks: [{ state: 'passed', workflow: { id: '55', name: 'CI' } }],
		});
	});

	it('rejects checks if the PR head changes while they are being fetched', async () => {
		const sha = 'a'.repeat(40);
		const repo = { host: 'github.com', owner: 'fork', name: 'project' };
		vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
			ok(args[0] === 'symbolic-ref' ? 'feature' : sha)
		);
		vi.mocked(execFileNoThrow).mockImplementation(async (_gh, args) => {
			const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
			if (endpoint.includes('check-runs')) return ok('[{"check_runs":[]}]');
			if (endpoint.includes('statuses')) return ok('[[]]');
			if (endpoint.includes('actions/runs')) return ok('[{"workflow_runs":[]}]');
			return ok(JSON.stringify({ ...pull(), head: { ...pull().head, sha: 'b'.repeat(40) } }));
		});
		const found = {
			status: 'found' as const,
			head: { branch: 'feature', localSha: sha, repository: repo },
			pullRequest: {
				identity: { repository: { ...repo, owner: 'upstream' }, number: 3 },
				title: 'Change',
				url: 'https://github.com/upstream/project/pull/3',
				state: 'OPEN' as const,
				isDraft: false,
				headRepository: repo,
				headBranch: 'feature',
				headSha: sha,
				baseBranch: 'rc',
			},
		};
		expect(await readWorktreePullRequestCi({ worktreePath: '/checkout' }, found)).toMatchObject({
			ci: { status: 'unavailable', message: expect.stringContaining('changed') },
			divergence: { status: 'unavailable' },
		});
		vi.mocked(execGitReadOnly).mockClear();
		vi.mocked(execFileNoThrow).mockClear();
		expect(
			await readWorktreePullRequestCi({ worktreePath: '/remote', sshRemoteId: 'remote' }, found)
		).toMatchObject({ ci: { status: 'unavailable', message: expect.stringContaining('SSH') } });
		expect(execGitReadOnly).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
});
