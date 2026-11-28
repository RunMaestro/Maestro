/**
 * @file workflow-prompt-context.test.ts
 * @description The plan and current-stage context a staged workflow puts in a moderator prompt.
 */

import { describe, expect, it } from 'vitest';
import { buildCurrentStageContext, buildPlanContextBlock } from '../workflow/prompt-context';
import type { GroupChatWorkflowRun } from '../../../group-chat-workflow-types';

function createRun(): GroupChatWorkflowRun {
	return {
		plan: {
			runId: 'run-context',
			title: 'Release workflow',
			createdAt: 1,
			stages: [
				{
					id: 'stage-1',
					name: 'Plan',
					agents: ['Planner'],
					mode: 'serial',
					instruction: 'Plan the release.\n  Keep it focused.',
				},
				{
					id: 'stage-2',
					name: 'Build',
					agents: ['Builder', 'Reviewer'],
					mode: 'parallel',
					instruction: 'Build and review the release.',
				},
				{
					id: 'stage-3',
					name: 'Publish',
					agents: [],
					mode: 'serial',
					instruction: 'Publish the approved artifact.',
					autoRun: { participantName: 'Publisher', filename: 'Release.md' },
				},
			],
		},
		status: 'running',
		currentStageIndex: 1,
		stageStatuses: {
			'stage-1': 'complete',
			'stage-2': 'running',
			'stage-3': 'pending',
		},
		handoffs: [
			{
				stageId: 'stage-1',
				stageName: 'Plan',
				summary: 'Plan complete.\nRelease scope agreed.',
				artifactPaths: ['full-body-must-not-render.md'],
			},
		],
	};
}

describe('buildPlanContextBlock', () => {
	it('renders compact stage state and handoff summaries', () => {
		const context = buildPlanContextBlock(createRun());

		expect(context).toContain('## Active Workflow Plan');
		expect(context).toContain('Current stage: 2 of 3');
		expect(context).toContain(
			'1. [complete] Plan (Agents: @Planner) - Plan the release. Keep it focused.'
		);
		expect(context).toContain(
			'2. [running] Build (Agents: @Builder, @Reviewer) - Build and review the release.'
		);
		expect(context).toContain(
			'3. [pending] Publish (Agents: Auto Run @Publisher (Release.md)) - Publish the approved artifact.'
		);
		expect(context).toContain('- Plan: Plan complete. Release scope agreed.');
		expect(context).not.toContain('full-body-must-not-render.md');
	});

	it('marks a finished cursor and an empty handoff list explicitly', () => {
		const run = createRun();
		run.status = 'complete';
		run.currentStageIndex = run.plan.stages.length;
		run.handoffs = [];

		const context = buildPlanContextBlock(run);

		expect(context).toContain('Current stage: complete (3 of 3)');
		expect(context).toContain('### Handoff Summaries\n(none)');
	});
});

describe('buildCurrentStageContext', () => {
	it('formats inline and artifact responses without expanding artifact bodies', () => {
		const run = createRun();
		run.handoffs.push({
			stageId: 'stage-2',
			stageName: 'Build',
			summary: '',
			artifactPaths: ['/tmp/run/stage-2/Reviewer.md'],
			participantHandoffs: [
				{ participantName: 'Builder', mode: 'inline', content: 'The patch is ready.' },
				{
					participantName: 'Reviewer',
					mode: 'artifact',
					digest: 'The detailed review found two follow-ups.',
					artifactPath: '/tmp/run/stage-2/Reviewer.md',
				},
			],
		});

		const context = buildCurrentStageContext(run);

		expect(context).toContain('### Builder\n\nThe patch is ready.');
		expect(context).toContain('### Reviewer\n\nThe detailed review found two follow-ups.');
		expect(context).toContain('Full output: /tmp/run/stage-2/Reviewer.md');
	});
});
