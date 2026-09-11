/**
 * @file workflow-run-registry.test.ts
 * @description Unit tests for the in-memory Group Chat workflow run registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupChatWorkflowPlan } from '../../../shared/group-chat-workflow-types';
import { createRun } from '../../../main/group-chat/workflow-state-machine';
import {
	abortWorkflowRun,
	approveWorkflowRun,
	clearWorkflowRun,
	completeWorkflowStage,
	failWorkflowStage,
	getWorkflowRun,
	resetAllWorkflowRuns,
	setWorkflowRun,
} from '../../../main/group-chat/workflow-run-registry';
import { logger } from '../../../main/utils/logger';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn() },
}));

function createPlan(runId = 'run-123'): GroupChatWorkflowPlan {
	return {
		runId,
		title: 'Release workflow',
		createdAt: 1,
		stages: [
			{
				id: 'stage-1',
				name: 'Build',
				agents: ['Builder'],
				mode: 'serial',
				instruction: 'Build the release.',
			},
			{
				id: 'stage-2',
				name: 'Verify',
				agents: ['Reviewer'],
				mode: 'serial',
				instruction: 'Verify the release.',
			},
		],
	};
}

describe('workflow-run-registry', () => {
	beforeEach(() => {
		resetAllWorkflowRuns();
		vi.mocked(logger.info).mockClear();
	});

	afterEach(() => {
		resetAllWorkflowRuns();
	});

	it('stores runs independently by group chat and clears one without affecting another', () => {
		const firstRun = createRun(createPlan('run-1'));
		const secondRun = createRun(createPlan('run-2'));

		setWorkflowRun('chat-1', firstRun);
		setWorkflowRun('chat-2', secondRun);
		expect(getWorkflowRun('chat-1')).toBe(firstRun);
		expect(getWorkflowRun('chat-2')).toBe(secondRun);

		clearWorkflowRun('chat-1');
		expect(getWorkflowRun('chat-1')).toBeUndefined();
		expect(getWorkflowRun('chat-2')).toBe(secondRun);
	});

	it('applies and stores each state-machine transition', () => {
		const initial = createRun(createPlan());
		setWorkflowRun('chat-1', initial);

		const approved = approveWorkflowRun('chat-1');
		expect(approved).toMatchObject({ status: 'running', currentStageIndex: 0 });
		expect(approved).not.toBe(initial);
		expect(getWorkflowRun('chat-1')).toBe(approved);

		const advanced = completeWorkflowStage('chat-1', {
			stageId: 'stage-1',
			stageName: 'Build',
			summary: 'Build finished.',
		});
		expect(advanced).toMatchObject({ status: 'running', currentStageIndex: 1 });
		expect(getWorkflowRun('chat-1')).toBe(advanced);

		const failed = failWorkflowStage('chat-1', 'Verification failed');
		expect(failed).toMatchObject({ status: 'aborted', abortReason: 'Verification failed' });
		expect(getWorkflowRun('chat-1')).toBe(failed);

		setWorkflowRun('chat-1', createRun(createPlan('run-456')));
		const aborted = abortWorkflowRun('chat-1', 'User cancelled');
		expect(aborted).toMatchObject({ status: 'aborted', abortReason: 'User cancelled' });
		expect(getWorkflowRun('chat-1')).toBe(aborted);
	});

	it('returns undefined without creating state when a chat has no run', () => {
		expect(approveWorkflowRun('missing')).toBeUndefined();
		expect(
			completeWorkflowStage('missing', {
				stageId: 'stage-1',
				stageName: 'Build',
				summary: 'Done.',
			})
		).toBeUndefined();
		expect(failWorkflowStage('missing', 'Failed')).toBeUndefined();
		expect(abortWorkflowRun('missing', 'Cancelled')).toBeUndefined();
		expect(getWorkflowRun('missing')).toBeUndefined();
	});

	it('logs stored runs and every applied transition with registry context', () => {
		setWorkflowRun('chat-1', createRun(createPlan()));
		approveWorkflowRun('chat-1');
		completeWorkflowStage('chat-1', {
			stageId: 'stage-1',
			stageName: 'Build',
			summary: 'Done.',
		});

		expect(logger.info).toHaveBeenCalledTimes(3);
		for (const call of vi.mocked(logger.info).mock.calls) {
			expect(call[1]).toBe('[WorkflowRunRegistry]');
			expect(call[2]).toMatchObject({ groupChatId: 'chat-1', runId: 'run-123' });
		}
	});
});
