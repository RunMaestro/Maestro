import { describe, expect, it } from 'vitest';
import {
	mapAgentRunStatusToPianolaRunState,
	mapCampaignTaskStatusToPianolaTaskStatus,
	mapPianolaRunStateToAgentRunStatus,
	mapPianolaTaskStatusToCampaignTaskStatus,
	pianolaPlansToCampaigns,
	validatePianolaPlanLike,
} from '../../../shared/agent-run';

describe('Pianola AgentRun adapter', () => {
	it('maps Pianola run states with idle completion context', () => {
		expect(mapPianolaRunStateToAgentRunStatus('connecting')).toBe('running');
		expect(mapPianolaRunStateToAgentRunStatus('busy')).toBe('running');
		expect(mapPianolaRunStateToAgentRunStatus('waiting_input')).toBe('waiting');
		expect(mapPianolaRunStateToAgentRunStatus('error')).toBe('failed');
		expect(mapPianolaRunStateToAgentRunStatus('idle')).toBe('waiting');
		expect(mapPianolaRunStateToAgentRunStatus('idle', { previousState: 'busy' })).toBe('completed');
		expect(mapPianolaRunStateToAgentRunStatus('idle', { failure: true })).toBe('failed');
	});

	it('maps task status vocabularies without breaking dependency readiness', () => {
		expect(mapPianolaTaskStatusToCampaignTaskStatus('pending')).toBe('queued');
		expect(mapPianolaTaskStatusToCampaignTaskStatus('done')).toBe('passed');
		expect(mapPianolaTaskStatusToCampaignTaskStatus('skipped')).toBe('skipped');
		expect(mapCampaignTaskStatusToPianolaTaskStatus('queued')).toBe('pending');
		expect(mapCampaignTaskStatusToPianolaTaskStatus('passed')).toBe('done');
		expect(mapCampaignTaskStatusToPianolaTaskStatus('skipped')).toBe('skipped');
		expect(mapCampaignTaskStatusToPianolaTaskStatus('needs_review')).toBeNull();
	});

	it('maps supported AgentRun statuses back to Pianola run states', () => {
		expect(mapAgentRunStatusToPianolaRunState('running')).toBe('busy');
		expect(mapAgentRunStatusToPianolaRunState('waiting')).toBe('waiting_input');
		expect(mapAgentRunStatusToPianolaRunState('completed')).toBe('idle');
		expect(mapAgentRunStatusToPianolaRunState('failed')).toBe('error');
		expect(mapAgentRunStatusToPianolaRunState('queued')).toBeNull();
	});

	it('converts Pianola plans into campaigns with first-class task payload fields', () => {
		const [campaign] = pianolaPlansToCampaigns({
			plans: [
				{
					id: 'plan-1',
					title: 'Ship plan',
					createdAt: 100,
					tasks: [
						{
							id: 'setup',
							title: 'Setup',
							prompt: 'prepare',
							dependsOn: [],
							status: 'done',
							agentType: 'claude-code',
							cwd: '/repo',
							tabId: 'tab-1',
						},
						{
							id: 'build',
							title: 'Build',
							prompt: 'build it',
							dependsOn: ['setup'],
							status: 'pending',
						},
					],
				},
			],
		});

		expect(campaign).toMatchObject({
			id: 'pianola:plan-1',
			status: 'queued',
			source: { adapter: 'pianola', planId: 'plan-1' },
		});
		expect(campaign.tasks[0]).toMatchObject({
			id: 'setup',
			status: 'passed',
			prompt: 'prepare',
			agentType: 'claude-code',
			cwd: '/repo',
			tabId: 'tab-1',
			metadata: { pianola: { prompt: 'prepare', status: 'done' } },
		});
		expect(campaign.tasks[1]).toMatchObject({
			id: 'build',
			status: 'queued',
			dependsOn: ['setup'],
		});
	});

	it('rejects Pianola plans with duplicate, unknown, self, or cyclic dependencies', () => {
		const baseTask = {
			id: 'A',
			title: 'A',
			prompt: 'A',
			dependsOn: [] as string[],
			status: 'pending',
		};
		expect(
			validatePianolaPlanLike({
				id: 'duplicate',
				title: 'Duplicate',
				createdAt: 1,
				tasks: [baseTask, { ...baseTask }],
			})
		).toBeNull();
		expect(
			validatePianolaPlanLike({
				id: 'unknown',
				title: 'Unknown',
				createdAt: 1,
				tasks: [{ ...baseTask, dependsOn: ['missing'] }],
			})
		).toBeNull();
		expect(
			validatePianolaPlanLike({
				id: 'self',
				title: 'Self',
				createdAt: 1,
				tasks: [{ ...baseTask, dependsOn: ['A'] }],
			})
		).toBeNull();
		expect(
			validatePianolaPlanLike({
				id: 'cycle',
				title: 'Cycle',
				createdAt: 1,
				tasks: [
					{ ...baseTask, id: 'A', dependsOn: ['B'] },
					{ ...baseTask, id: 'B', dependsOn: ['A'] },
				],
			})
		).toBeNull();
	});
});
