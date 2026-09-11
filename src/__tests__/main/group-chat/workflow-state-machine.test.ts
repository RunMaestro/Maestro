/**
 * @file workflow-state-machine.test.ts
 * @description Unit tests for pure Group Chat workflow run transitions.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	abortRun,
	approveRun,
	completeStage,
	createRun,
	failStage,
	getCurrentStage,
	isRunActive,
} from '../../../main/group-chat/workflow-state-machine';
import type {
	GroupChatWorkflowHandoff,
	GroupChatWorkflowPlan,
} from '../../../shared/group-chat-workflow-types';

function createPlan(): GroupChatWorkflowPlan {
	return {
		runId: 'run-123',
		title: 'Release workflow',
		createdAt: 1,
		stages: [
			{
				id: 'stage-1',
				name: 'Plan',
				agents: ['Planner'],
				mode: 'serial',
				instruction: 'Plan the change.',
			},
			{
				id: 'stage-2',
				name: 'Build',
				agents: ['Builder'],
				mode: 'serial',
				instruction: 'Build the change.',
			},
			{
				id: 'stage-3',
				name: 'Verify',
				agents: ['Reviewer'],
				mode: 'serial',
				instruction: 'Verify the change.',
			},
		],
	};
}

function handoff(stageId: string, stageName: string): GroupChatWorkflowHandoff {
	return { stageId, stageName, summary: `${stageName} finished.` };
}

describe('workflow-state-machine', () => {
	it('runs a three-stage workflow through completion', () => {
		vi.useFakeTimers();
		vi.setSystemTime(100);

		const created = createRun(createPlan());
		expect(created).toMatchObject({
			status: 'awaiting-approval',
			currentStageIndex: 0,
			stageStatuses: {
				'stage-1': 'pending',
				'stage-2': 'pending',
				'stage-3': 'pending',
			},
			handoffs: [],
		});

		const approved = approveRun(created);
		expect(approved).toMatchObject({
			status: 'running',
			startedAt: 100,
			stageStatuses: { 'stage-1': 'running' },
		});
		expect(getCurrentStage(approved)?.id).toBe('stage-1');

		const afterPlan = completeStage(approved, handoff('stage-1', 'Plan'));
		expect(afterPlan.currentStageIndex).toBe(1);
		expect(afterPlan.stageStatuses).toMatchObject({
			'stage-1': 'complete',
			'stage-2': 'running',
		});

		const afterBuild = completeStage(afterPlan, handoff('stage-2', 'Build'));
		expect(afterBuild.currentStageIndex).toBe(2);
		expect(afterBuild.stageStatuses).toMatchObject({
			'stage-2': 'complete',
			'stage-3': 'running',
		});

		vi.setSystemTime(200);
		const complete = completeStage(afterBuild, handoff('stage-3', 'Verify'));
		expect(complete).toMatchObject({
			status: 'complete',
			currentStageIndex: 3,
			endedAt: 200,
			stageStatuses: { 'stage-3': 'complete' },
		});
		expect(complete.handoffs).toHaveLength(3);
		expect(getCurrentStage(complete)).toBeNull();
		expect(isRunActive(complete)).toBe(false);

		vi.useRealTimers();
	});

	it('returns a fresh unchanged run when approval is no longer pending', () => {
		const running = approveRun(createRun(createPlan()));
		const result = approveRun(running);

		expect(result).not.toBe(running);
		expect(result).toEqual(running);
	});

	it('aborts on stage failure and records the reason', () => {
		const running = approveRun(createRun(createPlan()));
		const failed = failStage(running, 'Tests failed');

		expect(failed.status).toBe('aborted');
		expect(failed.abortReason).toBe('Tests failed');
		expect(failed.endedAt).toEqual(expect.any(Number));
		expect(failed.stageStatuses['stage-1']).toBe('failed');
		expect(isRunActive(failed)).toBe(false);
	});

	it('aborts an approval-pending run without changing stage statuses', () => {
		const created = createRun(createPlan());
		const aborted = abortRun(created, 'User cancelled');

		expect(aborted).toMatchObject({
			status: 'aborted',
			abortReason: 'User cancelled',
			stageStatuses: created.stageStatuses,
		});
	});

	it('does not mutate transition inputs or nested handoff arrays', () => {
		const created = createRun(createPlan());
		const approved = approveRun(created);
		const createdSnapshot = structuredClone(created);
		const approvedSnapshot = structuredClone(approved);
		const artifactPaths = ['report.md'];
		const stageHandoff = { ...handoff('stage-1', 'Plan'), artifactPaths };
		const completed = completeStage(approved, stageHandoff);
		const failed = failStage(approved, 'Tests failed');
		const aborted = abortRun(approved, 'User cancelled');

		expect(created).toEqual(createdSnapshot);
		expect(approved).toEqual(approvedSnapshot);
		expect(failed).not.toBe(approved);
		expect(aborted).not.toBe(approved);

		artifactPaths.push('late-change.md');
		expect(completed.handoffs[0].artifactPaths).toEqual(['report.md']);
	});

	it('completes an in-progress handoff without losing participant artifacts', () => {
		const running = approveRun(createRun(createPlan()));
		const withResponse = {
			...running,
			handoffs: [
				{
					stageId: 'stage-1',
					stageName: 'Plan',
					summary: '',
					artifactPaths: ['/tmp/Planner.md'],
					participantHandoffs: [
						{
							participantName: 'Planner',
							mode: 'artifact' as const,
							digest: 'Plan digest.',
							artifactPath: '/tmp/Planner.md',
						},
					],
				},
			],
		};

		const completed = completeStage(withResponse, handoff('stage-1', 'Plan'));

		expect(completed.handoffs).toHaveLength(1);
		expect(completed.handoffs[0]).toMatchObject({
			summary: 'Plan finished.',
			artifactPaths: ['/tmp/Planner.md'],
			participantHandoffs: [expect.objectContaining({ participantName: 'Planner' })],
		});
	});
});
