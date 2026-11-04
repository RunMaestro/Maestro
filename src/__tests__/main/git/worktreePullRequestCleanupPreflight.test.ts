import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
vi.mock('fs/promises', () => ({
	realpath: vi.fn(),
	readdir: vi.fn(),
	lstat: vi.fn(),
	readFile: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({ getSessionsStore: vi.fn() }));
vi.mock('../../../main/git/worktreePullRequests', () => ({ discoverWorktreePullRequest: vi.fn() }));
vi.mock('../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn(), execGit: vi.fn() }));
vi.mock('../../../shared/cli-activity', () => ({ isSessionBusyWithCli: () => false }));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: async () => 'gh',
	getExpandedEnv: () => ({}),
}));
import { getSessionsStore } from '../../../main/stores/getters';
import { discoverWorktreePullRequest } from '../../../main/git/worktreePullRequests';
import { execGit, execGitReadOnly } from '../../../main/utils/remote-git';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { preflightWorktreePullRequestCleanup } from '../../../main/git/worktreePullRequestCleanupPreflight';
const main = '/repo/main',
	worktree = '/repo/work',
	common = `${main}/.git`,
	sha = 'a'.repeat(40);
const headRepository = { host: 'github.com', owner: 'fork', name: 'project' };
const repository = { ...headRepository, owner: 'upstream' };
const target = {
	identity: { repository, number: 3 },
	headRepository,
	headBranch: 'feature',
	headSha: sha,
	baseBranch: 'rc',
};
const request = { sessionId: 'child', worktreePath: worktree, target };
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
let sessions: any[], remote: any, output: Record<string, string>;
beforeEach(() => {
	vi.resetAllMocks();
	sessions = [
		{ id: 'parent', cwd: main, projectRoot: main },
		{
			id: 'child',
			parentSessionId: 'parent',
			cwd: worktree,
			projectRoot: worktree,
			worktreeBranch: 'feature',
		},
	];
	remote = {
		number: 3,
		head: { repo: { owner: { login: 'fork' }, name: 'project' }, ref: 'feature', sha },
		base: { repo: { owner: { login: 'upstream' }, name: 'project' }, ref: 'rc' },
		state: 'closed',
		merged: true,
		merged_at: '2026-01-01T00:00:00Z',
		merge_commit_sha: 'b'.repeat(40),
	};
	output = {
		'symbolic-ref': 'feature',
		worktree: `worktree ${main}\0HEAD ${sha}\0branch refs/heads/rc\0\0worktree ${worktree}\0HEAD ${sha}\0branch refs/heads/feature\0\0`,
		'ls-files': `H 100644 ${sha} 0\tfile.txt\0`,
		'-c': '',
		remote: 'git@github.com:fork/project.git',
	};
	vi.mocked(getSessionsStore).mockReturnValue({ get: () => sessions } as never);
	vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
	vi.mocked(fs.lstat).mockResolvedValue({ isFile: () => true } as never);
	vi.mocked(fs.readFile).mockResolvedValue(`${worktree}/.git\n`);
	vi.mocked(fs.readdir).mockResolvedValue([
		{ name: 'file.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
	] as never);
	vi.mocked(execGitReadOnly).mockImplementation(async (args, cwd) => {
		const fallback =
			args[1] === '--show-toplevel'
				? cwd
				: args[1] === '--verify'
					? sha
					: args[1] === '--git-common-dir' || cwd === main
						? common
						: `${common}/worktrees/feature`;
		return ok(output[args.join(' ')] ?? output[args[0]] ?? fallback);
	});
	vi.mocked(discoverWorktreePullRequest).mockResolvedValue({
		status: 'found',
		head: { branch: 'feature', localSha: sha, repository: headRepository },
		pullRequest: {
			...target,
			title: 'Change',
			url: 'https://github.com/upstream/project/pull/3',
			state: 'MERGED',
			isDraft: false,
		},
	});
	vi.mocked(execFileNoThrow).mockImplementation(async () => ok(JSON.stringify(remote)));
	vi.mocked(execGit).mockResolvedValue(ok(worktree));
});
describe('read-only worktree cleanup preflight', () => {
	it.each(['b', 'c'])(
		'accepts a rewritten merge SHA %s but never authorizes removal',
		async (merge) => {
			remote.merge_commit_sha = merge.repeat(40);
			expect(await preflightWorktreePullRequestCleanup(request)).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'active-consumer' }, { code: 'mutation-busy' }],
			});
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['api', '--hostname', 'github.com', 'repos/upstream/project/pulls/3'],
				worktree,
				expect.any(Object)
			);
		}
	);
	it('refuses SSH before filesystem, store or GitHub access', async () => {
		expect(
			await preflightWorktreePullRequestCleanup({ ...request, sshRemoteId: 'remote' })
		).toMatchObject({ blockers: [{ code: 'ssh-unsupported' }] });
		for (const probe of [getSessionsStore, fs.realpath, execGitReadOnly, execFileNoThrow])
			expect(probe).not.toHaveBeenCalled();
	});
	it('inspects the native process source after independent merge confirmation', async () => {
		const processes: Array<{ sessionId: string; cwd: string; isTerminal: boolean }> = [];
		vi.mocked(execFileNoThrow).mockImplementation(async () => {
			processes.push({ sessionId: 'child-terminal-tab', cwd: worktree, isTerminal: true });
			return ok(JSON.stringify(remote));
		});
		const result = await preflightWorktreePullRequestCleanup(request, {
			getProcessManager: () => ({ getAll: () => processes }),
		});
		expect(result).toMatchObject({
			status: 'blocked',
			blockers: expect.arrayContaining([
				expect.objectContaining({
					code: 'active-consumer',
					message: expect.stringContaining('native AI or terminal'),
				}),
				expect.objectContaining({ code: 'mutation-busy' }),
			]),
		});
	});
	it.each([
		['parentSessionId', 'missing', 'registration'],
		['sshRemoteId', 'remote', 'ssh-unsupported'],
		['sessionSshRemoteConfig', { remoteId: 'remote' }, 'ssh-unsupported'],
		['cwd', main, 'main-checkout'],
		['worktreeBranch', 'other', 'identity-changed'],
	])('refuses changed registration %s', async (key, value, code) => {
		sessions[1][key as string] = value;
		expect(
			await preflightWorktreePullRequestCleanup({ ...request, worktreePath: sessions[1].cwd })
		).toMatchObject({
			blockers: [{ code }],
		});
	});
	it.each([
		['-c', ' M file.txt\0', 'dirty'],
		['-c', '?? notes\0', 'untracked'],
		['-c', '!! cache/\0', 'ignored-data'],
		['ls-files', `h 100644 ${sha} 0\tfile.txt\0`, 'unknown'],
		['ls-files', `S 100644 ${sha} 0\tfile.txt\0`, 'unknown'],
		['ls-files', `H 160000 ${sha} 0\tmodule\0`, 'unknown'],
		['symbolic-ref', 'other', 'identity-changed'],
		['rev-parse --verify HEAD', 'c'.repeat(40), 'head-changed'],
		['rev-parse --git-common-dir', '/other', 'repository'],
		['worktree', '', 'unknown'],
	])('refuses unsafe Git output %s %s', async (key, value, code) => {
		output[key] = value;
		expect(await preflightWorktreePullRequestCleanup(request)).toMatchObject({
			blockers: [{ code }],
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
	it.each([
		['merge_commit_sha', null, 'unknown'],
		['merged_at', 'invalid', 'unknown'],
		['merged', false, 'unmerged'],
		['number', 4, 'identity-changed'],
		['head', { ref: 'feature', sha, repo: null }, 'identity-changed'],
		['base', { ref: 'main' }, 'identity-changed'],
	])('refuses incomplete or changed GitHub %s', async (key, value, code) => {
		remote[key as string] = value;
		expect(await preflightWorktreePullRequestCleanup(request)).toMatchObject({
			blockers: [{ code }],
		});
	});
	it.each(['ignored', 'registration', 'origin'])('rechecks %s after GitHub', async (kind) => {
		vi.mocked(execFileNoThrow).mockImplementation(async () => {
			if (kind === 'ignored') output['-c'] = '!! new-data\0';
			else if (kind === 'origin') output.remote = 'git@github.com:other/project.git';
			else sessions[1].parentSessionId = 'missing';
			return ok(JSON.stringify(remote));
		});
		expect(await preflightWorktreePullRequestCleanup(request)).toMatchObject({
			blockers: [
				{
					code:
						kind === 'ignored'
							? 'ignored-data'
							: kind === 'origin'
								? 'identity-changed'
								: 'registration',
				},
			],
		});
	});
	it('rejects aliases and omitted empty directories', async () => {
		vi.mocked(fs.realpath).mockResolvedValueOnce('/other');
		expect(await preflightWorktreePullRequestCleanup(request)).toMatchObject({
			blockers: [{ code: 'path' }],
		});
		vi.mocked(fs.readdir).mockResolvedValue([
			{ name: 'empty', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
		] as never);
		expect(await preflightWorktreePullRequestCleanup(request)).toMatchObject({
			blockers: [{ code: 'unknown' }],
		});
	});
	it.each(['{', 'null'])('fails closed for invalid GitHub response %s', async (response) => {
		vi.mocked(execFileNoThrow).mockResolvedValue(ok(response));
		expect((await preflightWorktreePullRequestCleanup(request)).status).toBe('blocked');
	});
});
