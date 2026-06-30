import { describe, expect, it } from 'vitest';
import {
	getRunnableCampaignTasks,
	summarizeCampaign,
	validateCampaign,
	validateCampaignStrict,
	validateCampaignFile,
} from '../../../shared/campaign';
import type { Campaign, CampaignTask } from '../../../shared/campaign';

function makeTask(overrides: Partial<CampaignTask>): CampaignTask {
	return {
		id: 'task-1',
		title: 'Task 1',
		status: 'queued',
		dependsOn: [],
		...overrides,
	};
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
	return {
		id: 'campaign-1',
		title: 'Ship campaign spine',
		createdAt: 100,
		updatedAt: 200,
		status: 'running',
		objective: 'Create a neutral board model',
		runIds: ['run-1'],
		tasks: [makeTask({ id: 'task-1' })],
		source: 'test',
		...overrides,
	};
}

describe('validateCampaign', () => {
	it('accepts a valid campaign and preserves adapter metadata', () => {
		const campaign = validateCampaign({
			...makeCampaign(),
			metadata: {
				adapter: 'pianola',
				nested: { keep: true },
			},
			tasks: [
				{
					...makeTask({ id: 'task-1', runId: 'run-1' }),
					metadata: { externalTaskId: 42 },
				},
			],
		});

		expect(campaign).toEqual({
			id: 'campaign-1',
			title: 'Ship campaign spine',
			createdAt: 100,
			updatedAt: 200,
			status: 'running',
			objective: 'Create a neutral board model',
			runIds: ['run-1'],
			tasks: [
				{
					id: 'task-1',
					title: 'Task 1',
					status: 'queued',
					runId: 'run-1',
					dependsOn: [],
					metadata: { externalTaskId: 42 },
				},
			],
			source: 'test',
			metadata: {
				adapter: 'pianola',
				nested: { keep: true },
			},
		});
	});

	it('drops malformed campaigns from campaign files', () => {
		const result = validateCampaignFile({
			campaigns: [makeCampaign({ id: 'valid-campaign' }), { id: 'missing-required-fields' }, null],
		});

		expect(result.campaigns.map((campaign) => campaign.id)).toEqual(['valid-campaign']);
	});

	it('strict validation rejects malformed tasks instead of dropping them', () => {
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [
					makeTask({ id: 'task-1' }),
					{ id: 'task-2', title: 'Task 2', status: 'not-real', dependsOn: [] },
				],
			})
		).toBeNull();
	});

	it('strict validation rejects malformed optional linkage instead of dropping it', () => {
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [makeTask({ id: 'task-1', runId: 42 as never })],
			})
		).toBeNull();
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				source: 123 as never,
			})
		).toBeNull();
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [makeTask({ id: 'task-1', mergeSummary: 42 as never })],
			})
		).toBeNull();
	});

	it('preserves first-class orchestration fields', () => {
		const campaign = validateCampaignStrict({
			...makeCampaign(),
			tasks: [
				makeTask({
					id: 'task-1',
					prompt: 'Run the parser fix',
					agentType: 'claude-code',
					cwd: '/repo',
					tabId: 'tab-1',
					error: 'blocked by dependency',
				}),
			],
		});

		expect(campaign?.tasks[0]).toMatchObject({
			prompt: 'Run the parser fix',
			agentType: 'claude-code',
			cwd: '/repo',
			tabId: 'tab-1',
			error: 'blocked by dependency',
		});
	});

	it('rejects duplicate, unknown, self, and cyclic task dependencies', () => {
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [makeTask({ id: 'task-1' }), makeTask({ id: 'task-1' })],
			})
		).toBeNull();
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [makeTask({ id: 'task-1', dependsOn: ['missing'] })],
			})
		).toBeNull();
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [makeTask({ id: 'task-1', dependsOn: ['task-1'] })],
			})
		).toBeNull();
		expect(
			validateCampaignStrict({
				...makeCampaign(),
				tasks: [makeTask({ id: 'A', dependsOn: ['B'] }), makeTask({ id: 'B', dependsOn: ['A'] })],
			})
		).toBeNull();
	});
});

describe('getRunnableCampaignTasks', () => {
	it('returns queued tasks whose dependencies are passed or merged', () => {
		const campaign = makeCampaign({
			tasks: [
				makeTask({ id: 'setup', status: 'passed' }),
				makeTask({ id: 'review', status: 'merged' }),
				makeTask({ id: 'deploy', dependsOn: ['setup', 'review'] }),
				makeTask({ id: 'independent' }),
				makeTask({ id: 'already-running', status: 'running' }),
			],
		});

		expect(getRunnableCampaignTasks(campaign).map((task) => task.id)).toEqual([
			'deploy',
			'independent',
		]);
	});

	it('does not return queued tasks with blocked or failed dependencies', () => {
		const campaign = makeCampaign({
			tasks: [
				makeTask({ id: 'blocked-parent', status: 'blocked' }),
				makeTask({ id: 'failed-parent', status: 'failed' }),
				makeTask({ id: 'waiting-on-blocked', dependsOn: ['blocked-parent'] }),
				makeTask({ id: 'waiting-on-failed', dependsOn: ['failed-parent'] }),
			],
		});

		expect(getRunnableCampaignTasks(campaign)).toEqual([]);
	});
});

describe('summarizeCampaign', () => {
	it('summarizes campaign status counts', () => {
		const summary = summarizeCampaign(
			makeCampaign({
				runIds: ['run-1', 'run-2'],
				tasks: [
					makeTask({ id: 'queued-1', status: 'queued' }),
					makeTask({ id: 'queued-2', status: 'queued' }),
					makeTask({ id: 'passed-1', status: 'passed' }),
					makeTask({ id: 'merged-1', status: 'merged' }),
					makeTask({ id: 'failed-1', status: 'failed' }),
					makeTask({ id: 'skipped-1', status: 'skipped' }),
				],
			})
		);

		expect(summary).toEqual({
			id: 'campaign-1',
			title: 'Ship campaign spine',
			status: 'running',
			objective: 'Create a neutral board model',
			createdAt: 100,
			updatedAt: 200,
			runCount: 2,
			totalTasks: 6,
			runnableTaskIds: ['queued-1', 'queued-2'],
			statusCounts: {
				queued: 2,
				running: 0,
				waiting: 0,
				needs_review: 0,
				fixing: 0,
				passed: 1,
				failed: 1,
				blocked: 0,
				merged: 1,
				discarded: 0,
				skipped: 1,
			},
		});
	});
});
