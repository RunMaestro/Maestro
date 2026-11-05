import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreePullRequestMergeRequest } from '../../../shared/worktreePullRequests';

vi.mock('../../../main/git/worktreePullRequestMergePreflight', () => ({
	preflightWorktreePullRequestMerge: vi.fn(),
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn(async () => 'gh'),
	getExpandedEnv: () => ({}),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
import { mergeWorktreePullRequest } from '../../../main/git/worktreePullRequestMerge';
import { preflightWorktreePullRequestMerge } from '../../../main/git/worktreePullRequestMergePreflight';
import { execFileNoThrow } from '../../../main/utils/execFile';

const sha = 'a'.repeat(40);
const repository = { host: 'github.com', owner: 'upstream', name: 'project' };
const headRepository = { ...repository, owner: 'fork' };
const target = {
	identity: { repository, number: 3 },
	headRepository,
	headBranch: 'feature',
	headSha: sha,
	baseBranch: 'rc',
};
const request: WorktreePullRequestMergeRequest = {
	worktreePath: '/checkout',
	target,
	action: { kind: 'merge', method: 'squash' },
};
const pr = {
	...target,
	state: 'MERGED' as const,
	isDraft: false,
	title: 'Change',
	url: 'https://github.com/upstream/project/pull/3',
};
const ready = {
	status: 'ready' as const,
	target,
	allowedMethods: ['squash' as const],
	queueRequired: false,
};
const queueRequest: WorktreePullRequestMergeRequest = { ...request, action: { kind: 'enqueue' } };
const queueReady = { ...ready, queueRequired: true };
const reply = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
const node = () => ({
	data: {
		repository: {
			name: 'project',
			owner: { login: 'upstream' },
			pullRequest: {
				id: 'PR_123',
				number: 3,
				state: 'OPEN',
				headRefOid: sha,
				headRefName: 'feature',
				baseRefName: 'rc',
				headRepository: { name: 'project', owner: { login: 'fork' } },
			},
		},
	},
});

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(preflightWorktreePullRequestMerge).mockResolvedValue(ready);
	vi.mocked(execFileNoThrow)
		.mockResolvedValueOnce(reply(node()))
		.mockResolvedValue(reply({ data: { mergePullRequest: { pullRequest: { id: 'PR_123' } } } }));
});

describe('worktree PR guarded merge', () => {
	it('merges the explicit repository with the expected head and normal policy', async () => {
		vi.mocked(preflightWorktreePullRequestMerge)
			.mockResolvedValueOnce(ready)
			.mockResolvedValueOnce({ status: 'merged', pullRequest: pr });
		expect(await mergeWorktreePullRequest(request)).toMatchObject({
			status: 'merged',
			observed: 'after-attempt',
		});
		const args = vi.mocked(execFileNoThrow).mock.calls[1][1];
		expect(args).toEqual([
			'pr',
			'merge',
			'3',
			'--repo',
			'github.com/upstream/project',
			'--squash',
			'--match-head-commit',
			sha,
		]);
		expect(args.join(' ')).not.toMatch(/admin|auto|delete-branch/);
	});
	it('reconciles a direct merge timeout and leaves an unconfirmed outcome unknown', async () => {
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockResolvedValueOnce(reply(node()))
			.mockResolvedValueOnce({ stdout: '', stderr: 'timeout', exitCode: 'ETIMEDOUT' });
		expect(await mergeWorktreePullRequest(request)).toMatchObject({ status: 'unknown' });
	});
	it('enqueues with the expected head and does not report queueing as merged', async () => {
		const queued = { status: 'queued' as const, pullRequest: { ...pr, state: 'OPEN' as const } };
		vi.mocked(preflightWorktreePullRequestMerge)
			.mockResolvedValueOnce({ ...ready, queueRequired: true })
			.mockResolvedValueOnce(queued);
		expect(await mergeWorktreePullRequest({ ...request, action: { kind: 'enqueue' } })).toEqual(
			queued
		);
		const args = vi.mocked(execFileNoThrow).mock.calls[1][1];
		expect(args).toEqual(
			expect.arrayContaining(['--hostname', 'github.com', 'id=PR_123', `head=${sha}`])
		);
		expect(args.join(' ')).not.toMatch(/admin|bypass|jump/i);
		expect(args.find((arg) => arg.startsWith('query='))).toContain(
			'enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head})'
		);
		expect(args).not.toContain('method=SQUASH');
	});
	it('refuses blocked preflight, unsupported action, disabled method and wrong queue mode before mutation', async () => {
		vi.mocked(preflightWorktreePullRequestMerge).mockResolvedValueOnce({
			status: 'blocked',
			blockers: [{ code: 'head-changed', message: 'changed' }],
		});
		expect(await mergeWorktreePullRequest(request)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'head-changed' }],
		});
		expect(
			await mergeWorktreePullRequest({ ...request, action: { kind: 'merge', method: 'rebase' } })
		).toMatchObject({ status: 'blocked', blockers: [{ code: 'method' }] });
		expect(
			await mergeWorktreePullRequest({ ...request, action: { kind: 'enqueue' } })
		).toMatchObject({ status: 'blocked', blockers: [{ code: 'queue' }] });
		expect(
			await mergeWorktreePullRequest({ ...request, action: { kind: 'other' } } as never)
		).toMatchObject({ status: 'unknown' });
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
	it('recognizes an external merge before attempting a mutation', async () => {
		vi.mocked(preflightWorktreePullRequestMerge).mockResolvedValueOnce({
			status: 'merged',
			pullRequest: pr,
		});
		expect(await mergeWorktreePullRequest(request)).toMatchObject({
			status: 'merged',
			observed: 'before-attempt',
		});
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});
	it('does not mutate a mismatched node and reconciles a concurrent external merge', async () => {
		const changed = node();
		changed.data.repository.pullRequest.headRefOid = 'b'.repeat(40);
		vi.mocked(execFileNoThrow).mockReset().mockResolvedValueOnce(reply(changed));
		vi.mocked(preflightWorktreePullRequestMerge)
			.mockResolvedValueOnce(queueReady)
			.mockResolvedValueOnce({ status: 'merged', pullRequest: pr });
		expect(await mergeWorktreePullRequest(queueRequest)).toMatchObject({
			status: 'merged',
			observed: 'before-attempt',
		});
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
	});
	it('reconciles a timeout, but leaves an unconfirmed operation unknown', async () => {
		vi.mocked(preflightWorktreePullRequestMerge).mockResolvedValue(queueReady);
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockResolvedValueOnce(reply(node()))
			.mockResolvedValueOnce({ stdout: '', stderr: 'timeout', exitCode: 'ETIMEDOUT' });
		vi.mocked(preflightWorktreePullRequestMerge)
			.mockResolvedValueOnce(queueReady)
			.mockResolvedValueOnce({ status: 'merged', pullRequest: pr });
		expect(await mergeWorktreePullRequest(queueRequest)).toMatchObject({
			status: 'merged',
			observed: 'after-attempt',
		});
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockResolvedValueOnce(reply(node()))
			.mockResolvedValueOnce({ stdout: '', stderr: 'timeout', exitCode: 'ETIMEDOUT' });
		expect(await mergeWorktreePullRequest(queueRequest)).toMatchObject({ status: 'unknown' });
	});
	it('reports a definitive GraphQL rejection and a closed or changed head after mutation', async () => {
		vi.mocked(preflightWorktreePullRequestMerge).mockResolvedValue(queueReady);
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockResolvedValueOnce(reply(node()))
			.mockResolvedValueOnce(reply({ errors: [{ message: 'denied' }] }));
		expect(await mergeWorktreePullRequest(queueRequest)).toMatchObject({ status: 'blocked' });
		vi.mocked(execFileNoThrow)
			.mockReset()
			.mockResolvedValueOnce(reply(node()))
			.mockResolvedValueOnce(reply({}));
		vi.mocked(preflightWorktreePullRequestMerge)
			.mockResolvedValueOnce(queueReady)
			.mockResolvedValueOnce({
				status: 'blocked',
				blockers: [{ code: 'closed', message: 'closed' }],
			});
		expect(await mergeWorktreePullRequest(queueRequest)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'closed' }],
		});
	});
});
