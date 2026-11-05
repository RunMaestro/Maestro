import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/git/worktreePullRequests', () => ({ discoverWorktreePullRequest: vi.fn() }));
vi.mock('../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn(async () => 'gh'),
	getExpandedEnv: () => ({}),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
import { preflightWorktreePullRequestMerge } from '../../../main/git/worktreePullRequestMergePreflight';
import { discoverWorktreePullRequest } from '../../../main/git/worktreePullRequests';
import { execGitReadOnly } from '../../../main/utils/remote-git';
import { execFileNoThrow } from '../../../main/utils/execFile';

const sha = 'a'.repeat(40);
const headRepo = { host: 'github.com', owner: 'fork', name: 'project' };
const repo = { ...headRepo, owner: 'upstream' };
const target = {
	identity: { repository: repo, number: 3 },
	headRepository: headRepo,
	headBranch: 'feature',
	headSha: sha,
	baseBranch: 'rc',
};
const request = { worktreePath: '/checkout', target };
const pr = {
	...target,
	title: 'Change',
	url: 'https://github.com/upstream/project/pull/3',
	state: 'OPEN' as const,
	isDraft: false,
};
const found = {
	status: 'found' as const,
	head: { branch: 'feature', localSha: sha, repository: headRepo },
	pullRequest: pr,
};
const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const remote = () => ({
	number: 3,
	state: 'OPEN',
	isDraft: false,
	headRefOid: sha,
	headRefName: 'feature',
	baseRefName: 'rc',
	headRepository: { name: 'project', owner: { login: 'fork' } },
	mergeable: 'MERGEABLE',
	mergeStateStatus: 'CLEAN',
	reviewDecision: null,
	isMergeQueueEnabled: false,
	isInMergeQueue: false,
	mergeQueue: null,
	mergeQueueEntry: null,
});
const apiRepo = () => ({
	name: 'project',
	owner: { login: 'upstream' },
	viewerPermission: 'WRITE',
	mergeCommitAllowed: true,
	squashMergeAllowed: true,
	rebaseMergeAllowed: false,
	pullRequest: remote(),
});
const reply = (value: unknown) =>
	vi.mocked(execFileNoThrow).mockResolvedValue(ok(JSON.stringify(value)));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(discoverWorktreePullRequest).mockResolvedValue(found);
	vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
		ok(
			args[0] === 'rev-parse'
				? sha
				: args[0] === 'symbolic-ref'
					? 'feature'
					: 'git@github.com:fork/project.git'
		)
	);
	reply({ data: { repository: apiRepo() } });
});

describe('worktree PR merge preflight', () => {
	it('reads the reviewed PR with explicit host and exposes repository methods', async () => {
		expect(await preflightWorktreePullRequestMerge(request)).toEqual({
			status: 'ready',
			target,
			allowedMethods: ['merge', 'squash'],
			queueRequired: false,
		});
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining([
				'--hostname',
				'github.com',
				'graphql',
				'owner=upstream',
				'name=project',
				'number=3',
			]),
			'/checkout',
			expect.any(Object)
		);
		expect(discoverWorktreePullRequest).toHaveBeenCalledTimes(2);
	});
	it('blocks unpublished local commits before checking GitHub merge readiness', async () => {
		vi.mocked(discoverWorktreePullRequest).mockResolvedValue({
			...found,
			head: { ...found.head, localSha: 'b'.repeat(40) },
		});
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'head-changed', message: expect.stringContaining('Local HEAD') }],
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
	it.each(['UNSTABLE', 'HAS_HOOKS'])(
		'allows GitHub mergeable state %s without overriding required protections',
		async (mergeStateStatus) => {
			const metadata = apiRepo();
			metadata.pullRequest.mergeStateStatus = mergeStateStatus;
			reply({ data: { repository: metadata } });
			expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({ status: 'ready' });
			metadata.pullRequest.reviewDecision = 'REVIEW_REQUIRED' as never;
			reply({ data: { repository: metadata } });
			expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'reviews', message: expect.any(String) }],
			});
		}
	);
	it('rejects SSH before any local or network access', async () => {
		expect(
			await preflightWorktreePullRequestMerge({ ...request, sshRemoteId: 'remote' })
		).toMatchObject({ status: 'unavailable', message: expect.stringContaining('SSH') });
		expect(discoverWorktreePullRequest).not.toHaveBeenCalled();
		expect(execGitReadOnly).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
	it('rejects stale heads and wrong repo before API mutation could be attempted', async () => {
		vi.mocked(discoverWorktreePullRequest).mockResolvedValueOnce({
			...found,
			pullRequest: { ...pr, headSha: 'b'.repeat(40) },
		});
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'head-changed' }],
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
		vi.mocked(discoverWorktreePullRequest).mockResolvedValueOnce({
			...found,
			pullRequest: { ...pr, identity: { ...target.identity, number: 4 } },
		});
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'identity-changed' }],
		});
	});
	it('blocks required checks, reviews, conflicts, protection and unavailable permissions', async () => {
		const metadata = apiRepo();
		metadata.viewerPermission = 'READ';
		metadata.pullRequest.mergeable = 'CONFLICTING';
		metadata.pullRequest.mergeStateStatus = 'BLOCKED';
		metadata.pullRequest.reviewDecision = 'REVIEW_REQUIRED' as never;
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: expect.arrayContaining([
				{ code: 'protection', message: expect.any(String) },
				{ code: 'conflict', message: expect.any(String) },
				{ code: 'reviews', message: expect.any(String) },
			]),
		});
		metadata.pullRequest.mergeable = 'MERGEABLE';
		metadata.pullRequest.mergeStateStatus = 'BLOCKED';
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({ status: 'blocked' });
	});
	it('distinguishes queue required from queued', async () => {
		const metadata = apiRepo();
		metadata.pullRequest.isMergeQueueEnabled = true;
		metadata.pullRequest.mergeQueue = { id: 'queue' } as never;
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'ready',
			queueRequired: true,
		});
		metadata.pullRequest.isInMergeQueue = true;
		metadata.pullRequest.mergeQueueEntry = { id: 'entry' } as never;
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({ status: 'queued' });
	});
	it('blocks unknown mergeability and repositories with no direct merge method', async () => {
		const metadata = apiRepo();
		metadata.mergeCommitAllowed = false;
		metadata.squashMergeAllowed = false;
		metadata.pullRequest.mergeable = 'UNKNOWN';
		metadata.pullRequest.mergeStateStatus = 'UNKNOWN';
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: expect.arrayContaining([
				{ code: 'unknown', message: expect.any(String) },
				{ code: 'method', message: expect.any(String) },
			]),
		});
	});
	it('rejects identity changes returned by GitHub', async () => {
		const metadata = apiRepo();
		metadata.pullRequest.headRepository.owner.login = 'other';
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'identity-changed' }],
		});
	});
	it('fails closed on GraphQL errors, missing fields, and a checkout switch', async () => {
		reply({ errors: [{ message: 'denied' }], data: { repository: apiRepo() } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'unavailable',
		});
		reply({ data: { repository: { ...apiRepo(), viewerPermission: null } } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'unavailable',
		});
		reply({ data: { repository: apiRepo() } });
		vi.mocked(execGitReadOnly).mockResolvedValue(ok('different'));
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'unavailable',
			message: expect.stringContaining('Checkout changed'),
		});
	});
	it('reports draft, closed, merged and changed remote head distinctly', async () => {
		const metadata = apiRepo();
		metadata.pullRequest.headRefOid = 'b'.repeat(40);
		reply({ data: { repository: metadata } });
		expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'head-changed' }],
		});
		for (const [state, draft, expected] of [
			['OPEN', true, 'blocked'],
			['CLOSED', false, 'blocked'],
			['MERGED', false, 'merged'],
		] as const) {
			const updated = { ...pr, state, isDraft: draft };
			vi.mocked(discoverWorktreePullRequest).mockResolvedValue({ ...found, pullRequest: updated });
			metadata.pullRequest = { ...remote(), state, isDraft: draft };
			reply({ data: { repository: metadata } });
			expect(await preflightWorktreePullRequestMerge(request)).toMatchObject({ status: expected });
		}
	});
});
