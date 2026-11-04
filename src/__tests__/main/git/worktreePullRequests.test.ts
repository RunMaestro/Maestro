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
