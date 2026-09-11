/**
 * @file workflow-run-registry.ts
 * @description In-memory, per-chat ownership of Group Chat workflow runs.
 */

import type {
	GroupChatWorkflowHandoff,
	GroupChatWorkflowParticipantHandoff,
	GroupChatWorkflowRun,
} from '../../shared/group-chat-workflow-types';
import { logger } from '../utils/logger';
import { clearWorkflowRunDir } from './workflow-artifacts';
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

/** Remove disposable artifacts for a run without allowing cleanup to fail its workflow. */
export async function cleanupWorkflowRunArtifacts(
	groupChatId: string,
	run: GroupChatWorkflowRun
): Promise<void> {
	try {
		await clearWorkflowRunDir(groupChatId, run.plan.runId);
	} catch (error) {
		logger.warn('Failed to clear workflow run artifacts', LOG_CONTEXT, {
			groupChatId,
			runId: run.plan.runId,
			error,
		});
	}
}

/** Remove the workflow run owned by a group chat and its disposable artifacts. */
export async function clearWorkflowRun(groupChatId: string): Promise<void> {
	const run = workflowRuns.get(groupChatId);
	workflowRuns.delete(groupChatId);
	if (run) {
		logger.info('Workflow run cleared', LOG_CONTEXT, {
			groupChatId,
			runId: run.plan.runId,
			status: run.status,
		});
		await cleanupWorkflowRunArtifacts(groupChatId, run);
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

/** Record one participant response against the currently running stage. */
export function recordWorkflowStageResponse(
	groupChatId: string,
	response: GroupChatWorkflowParticipantHandoff
): GroupChatWorkflowRun | undefined {
	const currentRun = workflowRuns.get(groupChatId);
	if (!currentRun || currentRun.status !== 'running') return currentRun;

	const currentStage = currentRun.plan.stages[currentRun.currentStageIndex];
	if (!currentStage) return currentRun;

	const handoffs = currentRun.handoffs.map((handoff) => ({
		...handoff,
		...(handoff.artifactPaths ? { artifactPaths: [...handoff.artifactPaths] } : {}),
		...(handoff.participantHandoffs
			? { participantHandoffs: handoff.participantHandoffs.map((item) => ({ ...item })) }
			: {}),
	}));
	let stageHandoff = handoffs.find((handoff) => handoff.stageId === currentStage.id);
	if (!stageHandoff) {
		stageHandoff = {
			stageId: currentStage.id,
			stageName: currentStage.name,
			summary: '',
		};
		handoffs.push(stageHandoff);
	}

	const participantHandoffs = [...(stageHandoff.participantHandoffs ?? [])];
	const existingResponseIndex = participantHandoffs.findIndex(
		(item) => item.participantName === response.participantName
	);
	const existingResponse =
		existingResponseIndex >= 0 ? participantHandoffs[existingResponseIndex] : undefined;
	if (existingResponseIndex >= 0) {
		participantHandoffs[existingResponseIndex] = response;
	} else {
		participantHandoffs.push(response);
	}
	stageHandoff.participantHandoffs = participantHandoffs;
	if (response.mode === 'artifact') {
		stageHandoff.artifactPaths = [
			...(stageHandoff.artifactPaths ?? []),
			response.artifactPath,
		].filter((artifactPath, index, paths) => paths.indexOf(artifactPath) === index);
	} else if (existingResponse?.mode === 'artifact') {
		stageHandoff.artifactPaths = stageHandoff.artifactPaths?.filter(
			(artifactPath) => artifactPath !== existingResponse.artifactPath
		);
	}

	const nextRun = { ...currentRun, handoffs };
	workflowRuns.set(groupChatId, nextRun);
	logger.info('Workflow stage response recorded', LOG_CONTEXT, {
		groupChatId,
		runId: nextRun.plan.runId,
		stageId: currentStage.id,
		participantName: response.participantName,
		mode: response.mode,
	});
	return nextRun;
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
