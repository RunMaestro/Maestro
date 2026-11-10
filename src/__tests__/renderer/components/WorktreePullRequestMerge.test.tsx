import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreePullRequestMerge } from '../../../renderer/components/WorktreePullRequestMerge';
import type { WorktreePullRequest } from '../../../shared/worktreePullRequests';

const repo = { host: 'github.com', owner: 'owner', name: 'repo' };
const pr: WorktreePullRequest = {
	identity: { repository: repo, number: 3 },
	title: 'change',
	url: 'https://github.com/owner/repo/pull/3',
	state: 'OPEN',
	isDraft: false,
	headRepository: repo,
	headBranch: 'feature',
	headSha: 'a'.repeat(40),
	baseBranch: 'rc',
};
const target = {
	identity: pr.identity,
	headRepository: repo,
	headBranch: 'feature',
	headSha: pr.headSha,
	baseBranch: 'rc',
};
const check = vi.fn();
const merge = vi.fn();
const refresh = vi.fn();
beforeEach(() => {
	vi.resetAllMocks();
	window.maestro.git.preflightWorktreePullRequestMerge = check;
	window.maestro.git.mergeWorktreePullRequest = merge;
});
describe('manual worktree PR merge', () => {
	it('checks the displayed target, submits the selected method and refreshes after the result', async () => {
		check.mockResolvedValue({
			status: 'ready',
			target,
			allowedMethods: ['merge', 'squash'],
			queueRequired: false,
		});
		merge.mockResolvedValue({ status: 'merged', pullRequest: pr, observed: 'after-attempt' });
		render(
			<WorktreePullRequestMerge
				pullRequest={pr}
				worktreePath="/tree"
				disabled={false}
				refresh={refresh}
			/>
		);
		fireEvent.click(screen.getByText('Check merge readiness'));
		await screen.findByText('Merge pull request');
		fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'squash' } });
		fireEvent.click(screen.getByText('Merge pull request'));
		await screen.findByText('PR merged.');
		expect(check).toHaveBeenCalledWith({ worktreePath: '/tree', sshRemoteId: undefined, target });
		expect(merge).toHaveBeenCalledWith({
			worktreePath: '/tree',
			sshRemoteId: undefined,
			target,
			action: { kind: 'merge', method: 'squash' },
		});
		expect(refresh).toHaveBeenCalledOnce();
	});
	it('reports blockers and does not offer an action', async () => {
		check.mockResolvedValue({
			status: 'blocked',
			blockers: [{ code: 'draft', message: 'PR is a draft' }],
		});
		render(
			<WorktreePullRequestMerge
				pullRequest={pr}
				worktreePath="/tree"
				disabled={false}
				refresh={refresh}
			/>
		);
		fireEvent.click(screen.getByText('Check merge readiness'));
		await screen.findByText('PR is a draft');
		expect(screen.queryByText('Merge pull request')).toBeNull();
	});
	it('uses queue action and prevents repeated submissions while in flight', async () => {
		check.mockResolvedValue({ status: 'ready', target, allowedMethods: [], queueRequired: true });
		let resolve!: (value: unknown) => void;
		merge.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			})
		);
		render(
			<WorktreePullRequestMerge
				pullRequest={pr}
				worktreePath="/tree"
				disabled={false}
				refresh={refresh}
			/>
		);
		fireEvent.click(screen.getByText('Check merge readiness'));
		fireEvent.click(await screen.findByText('Add to merge queue'));
		expect(screen.getByText('Working…')).toBeDisabled();
		expect(merge).toHaveBeenCalledOnce();
		expect(merge.mock.calls[0][0].action).toEqual({ kind: 'enqueue' });
		resolve({ status: 'queued', pullRequest: pr });
		await screen.findByText('PR queued.');
		await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
	});
});
