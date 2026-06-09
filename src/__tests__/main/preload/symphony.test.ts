/**
 * Tests for Symphony preload API
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createSymphonyApi } from '../../../main/preload/symphony';

describe('Symphony Preload API', () => {
	let api: ReturnType<typeof createSymphonyApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSymphonyApi();
	});

	it.each([
		['getRegistry', () => api.getRegistry(true), ['symphony:getRegistry', true]],
		[
			'getIssues',
			() => api.getIssues('owner/repo', true),
			['symphony:getIssues', 'owner/repo', true],
		],
		[
			'getIssueCounts',
			() => api.getIssueCounts(['owner/repo'], true),
			['symphony:getIssueCounts', ['owner/repo'], true],
		],
		['getState', () => api.getState(), ['symphony:getState']],
		['getActive', () => api.getActive(), ['symphony:getActive']],
		['getCompleted', () => api.getCompleted(5), ['symphony:getCompleted', 5]],
		['getStats', () => api.getStats(), ['symphony:getStats']],
		[
			'start',
			() =>
				api.start({
					repoSlug: 'owner/repo',
					repoUrl: 'https://github.com/owner/repo',
					repoName: 'Repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
					agentType: 'claude-code',
					sessionId: 'session-1',
				}),
			[
				'symphony:start',
				{
					repoSlug: 'owner/repo',
					repoUrl: 'https://github.com/owner/repo',
					repoName: 'Repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
					agentType: 'claude-code',
					sessionId: 'session-1',
				},
			],
		],
		[
			'registerActive',
			() =>
				api.registerActive({
					contributionId: 'contribution-1',
					repoSlug: 'owner/repo',
					repoName: 'Repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					localPath: '/tmp/repo',
					branchName: 'symphony/issue-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					totalDocuments: 2,
				}),
			[
				'symphony:registerActive',
				{
					contributionId: 'contribution-1',
					repoSlug: 'owner/repo',
					repoName: 'Repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					localPath: '/tmp/repo',
					branchName: 'symphony/issue-1',
					sessionId: 'session-1',
					agentType: 'claude-code',
					totalDocuments: 2,
				},
			],
		],
		[
			'updateStatus',
			() =>
				api.updateStatus({
					contributionId: 'contribution-1',
					status: 'running',
					progress: { completedDocuments: 1 },
				}),
			[
				'symphony:updateStatus',
				{
					contributionId: 'contribution-1',
					status: 'running',
					progress: { completedDocuments: 1 },
				},
			],
		],
		[
			'complete',
			() =>
				api.complete({
					contributionId: 'contribution-1',
					prBody: 'Ready',
				}),
			['symphony:complete', { contributionId: 'contribution-1', prBody: 'Ready' }],
		],
		[
			'cancel',
			() => api.cancel('contribution-1', false),
			['symphony:cancel', 'contribution-1', false],
		],
		['checkPRStatuses', () => api.checkPRStatuses(), ['symphony:checkPRStatuses']],
		[
			'syncContribution',
			() => api.syncContribution('contribution-1'),
			['symphony:syncContribution', 'contribution-1'],
		],
		['clearCache', () => api.clearCache(), ['symphony:clearCache']],
		[
			'cloneRepo',
			() => api.cloneRepo({ repoUrl: 'https://github.com/owner/repo', localPath: '/tmp/repo' }),
			['symphony:cloneRepo', { repoUrl: 'https://github.com/owner/repo', localPath: '/tmp/repo' }],
		],
		[
			'startContribution',
			() =>
				api.startContribution({
					contributionId: 'contribution-1',
					sessionId: 'session-1',
					repoSlug: 'owner/repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					localPath: '/tmp/repo',
					documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
				}),
			[
				'symphony:startContribution',
				{
					contributionId: 'contribution-1',
					sessionId: 'session-1',
					repoSlug: 'owner/repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					localPath: '/tmp/repo',
					documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
				},
			],
		],
		[
			'createDraftPR',
			() =>
				api.createDraftPR({
					contributionId: 'contribution-1',
					title: 'Fix docs',
					body: 'Details',
				}),
			[
				'symphony:createDraftPR',
				{ contributionId: 'contribution-1', title: 'Fix docs', body: 'Details' },
			],
		],
		[
			'fetchDocumentContent',
			() => api.fetchDocumentContent('https://example.com/doc.md'),
			['symphony:fetchDocumentContent', { url: 'https://example.com/doc.md' }],
		],
		[
			'manualCredit',
			() =>
				api.manualCredit({
					repoSlug: 'owner/repo',
					repoName: 'Repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					prNumber: 3,
					prUrl: 'https://github.com/owner/repo/pull/3',
					wasMerged: true,
					tokenUsage: { inputTokens: 100, outputTokens: 50, totalCost: 0.25 },
				}),
			[
				'symphony:manualCredit',
				{
					repoSlug: 'owner/repo',
					repoName: 'Repo',
					issueNumber: 1,
					issueTitle: 'Issue',
					prNumber: 3,
					prUrl: 'https://github.com/owner/repo/pull/3',
					wasMerged: true,
					tokenUsage: { inputTokens: 100, outputTokens: 50, totalCost: 0.25 },
				},
			],
		],
	])('invokes %s through the expected IPC channel', async (_name, call, expectedArgs) => {
		const response = { success: true };
		mockInvoke.mockResolvedValue(response);

		await expect(call()).resolves.toBe(response);

		expect(mockInvoke).toHaveBeenCalledWith(...expectedArgs);
	});

	it('subscribes to symphony updates and removes the same listener on unsubscribe', () => {
		const callback = vi.fn();

		const unsubscribe = api.onUpdated(callback);
		const handler = mockOn.mock.calls[0][1] as () => void;
		handler();
		unsubscribe();

		expect(mockOn).toHaveBeenCalledWith('symphony:updated', handler);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(mockRemoveListener).toHaveBeenCalledWith('symphony:updated', handler);
	});

	it('forwards contribution-started event payloads and unsubscribes', () => {
		const callback = vi.fn();
		const data = {
			contributionId: 'contribution-1',
			sessionId: 'session-1',
			localPath: '/tmp/repo',
			branchName: 'symphony/issue-1',
		};

		const unsubscribe = api.onContributionStarted(callback);
		const handler = mockOn.mock.calls[0][1] as (_event: unknown, payload: typeof data) => void;
		handler({}, data);
		unsubscribe();

		expect(mockOn).toHaveBeenCalledWith('symphony:contributionStarted', handler);
		expect(callback).toHaveBeenCalledWith(data);
		expect(mockRemoveListener).toHaveBeenCalledWith('symphony:contributionStarted', handler);
	});

	it('forwards PR-created event payloads and unsubscribes', () => {
		const callback = vi.fn();
		const data = {
			contributionId: 'contribution-1',
			prNumber: 3,
			prUrl: 'https://github.com/owner/repo/pull/3',
		};

		const unsubscribe = api.onPRCreated(callback);
		const handler = mockOn.mock.calls[0][1] as (_event: unknown, payload: typeof data) => void;
		handler({}, data);
		unsubscribe();

		expect(mockOn).toHaveBeenCalledWith('symphony:prCreated', handler);
		expect(callback).toHaveBeenCalledWith(data);
		expect(mockRemoveListener).toHaveBeenCalledWith('symphony:prCreated', handler);
	});
});
