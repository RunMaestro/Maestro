/**
 * @file workflow-run-registry.ts
 * @description In-memory, per-chat ownership of Group Chat workflow runs.
 */

import type {
	GroupChatWorkflowHandoff,
	GroupChatWorkflowRun,
} from '../../shared/group-chat-workflow-types';
import { logger } from '../utils/logger';
import { abortRun, approveRun, completeStage, failStage } from './workflow-state-machine';

const LOG_CONTEXT = '[WorkflowRunRegistry]';

/** Active and recently completed workflow runs, keyed by group chat id. */
const workflowRuns = new Map<string, GroupChatWorkflowRun>();

/** Store the workflow run owned by a group chat. */
export function setWorkflowRun(groupChatId: string, run: GroupChatWorkflowRun): void {
	workflowRuns.set(groupChatId, run);
	logger.info('Workflow run stored', LOG_CONTEXT, {
		groupChatId,
		runId: run.plan.runId,
		status: run.status,
	});
}

/** Return the workflow run owned by a group chat, if one exists. */
export function getWorkflowRun(groupChatId: string): GroupChatWorkflowRun | undefined {
	return workflowRuns.get(groupChatId);
}

/** Remove the workflow run owned by a group chat. */
export function clearWorkflowRun(groupChatId: string): void {
	const run = workflowRuns.get(groupChatId);
	workflowRuns.delete(groupChatId);
	if (run) {
		logger.info('Workflow run cleared', LOG_CONTEXT, {
			groupChatId,
			runId: run.plan.runId,
			status: run.status,
		});
	}
}

function applyTransition(
	groupChatId: string,
	transition: string,
	apply: (run: GroupChatWorkflowRun) => GroupChatWorkflowRun
): GroupChatWorkflowRun | undefined {
	const currentRun = workflowRuns.get(groupChatId);
	if (!currentRun) return undefined;

	const nextRun = apply(currentRun);
	workflowRuns.set(groupChatId, nextRun);
	logger.info(`Workflow run ${transition}`, LOG_CONTEXT, {
		groupChatId,
		runId: nextRun.plan.runId,
		previousStatus: currentRun.status,
		status: nextRun.status,
		currentStageIndex: nextRun.currentStageIndex,
	});
	return nextRun;
}

/** Approve and start the workflow run owned by a group chat. */
export function approveWorkflowRun(groupChatId: string): GroupChatWorkflowRun | undefined {
	return applyTransition(groupChatId, 'approved', approveRun);
}

/** Complete the current workflow stage and advance the owning run. */
export function completeWorkflowStage(
	groupChatId: string,
	handoff: GroupChatWorkflowHandoff
): GroupChatWorkflowRun | undefined {
	return applyTransition(groupChatId, 'stage completed', (run) => completeStage(run, handoff));
}

/** Fail the current workflow stage and abort the owning run. */
export function failWorkflowStage(
	groupChatId: string,
	reason: string
): GroupChatWorkflowRun | undefined {
	return applyTransition(groupChatId, 'stage failed', (run) => failStage(run, reason));
}

/** Abort the workflow run owned by a group chat. */
export function abortWorkflowRun(
	groupChatId: string,
	reason: string
): GroupChatWorkflowRun | undefined {
	return applyTransition(groupChatId, 'aborted', (run) => abortRun(run, reason));
}

/** Clear every workflow run. Intended for test teardown. */
export function resetAllWorkflowRuns(): void {
	workflowRuns.clear();
}
