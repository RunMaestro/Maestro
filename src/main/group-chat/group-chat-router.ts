/**
 * @file group-chat-router.ts
 * @description Message routing for the Group Chat feature, bound to the desktop.
 *
 * Routes messages between:
 * - User -> Moderator
 * - Moderator -> Participants (via @mentions)
 * - Participants -> Moderator
 *
 * The engine lives in the library (`src/shared/maestro-lib/groupchat/router.ts`);
 * `desktop-engine.ts` builds the desktop's one instance over its own storage,
 * emitters, prompts and process manager. This module keeps every function name and
 * signature the main process already imports, each a binding to that instance. The
 * two arguments the engine replaced (`processManager`, `agentDetector`) become a
 * launcher here, built per call.
 */

import type { AgentDetector } from '../agents';
import { setGetCustomShellPathCallback } from './group-chat-config';
import {
	createDesktopTurnStopper,
	desktopGroupChatEngine as engine,
	desktopLauncherFor,
} from './desktop-engine';
import type { IProcessManager } from './group-chat-moderator';
import type { SteeringResultFrame } from '../../shared/chatSteering';
import type { GroupChatSteerResult } from '../../shared/groupChatSteering';
import type { AddParticipantByAgentIdResult } from '../../shared/maestro-lib/groupchat/router';
import { generateUUID } from '../../shared/uuid';
import { appendToLog } from './group-chat-log';
import { addGroupChatHistoryEntry, loadGroupChat } from './group-chat-storage';
import { groupChatEmitters } from './emitters';
import {
	extractStageDirective,
	extractWorkflowPlanBlock,
	isWorkflowApproval,
	parseWorkflowPlan,
	renderWorkflowPlanSummary,
} from './workflow-plan-parser';
import {
	abortWorkflowRun,
	approveWorkflowRun,
	cleanupWorkflowRunArtifacts,
	clearWorkflowRun,
	completeWorkflowStage,
	failWorkflowStage,
	getWorkflowRun,
	recordWorkflowStageResponse,
	setWorkflowRun,
} from './workflow-run-registry';
import { createRun } from './workflow-state-machine';
import { classifyHandoff } from './workflow-handoff';
import { writeStageArtifact } from './workflow-artifacts';
import { normalizeMentionName } from '../../shared/group-chat-types';

const workflowStageNudges = new Map<string, { runId: string; stageId: string; count: number }>();
const MAX_WORKFLOW_STAGE_NUDGES = 2;

function nextWorkflowStageNudge(groupChatId: string, runId: string, stageId: string): number {
	const current = workflowStageNudges.get(groupChatId);
	const count = current?.runId === runId && current.stageId === stageId ? current.count + 1 : 1;
	workflowStageNudges.set(groupChatId, { runId, stageId, count });
	return count;
}

export {
	extractMentions,
	extractAllMentions,
	extractAutoRunDirectives,
	findParticipantForMention,
	isDeletedGroupChatFailure,
	type AddParticipantByAgentIdResult,
	type AutoRunDirective,
	type GroupChatSessionInfo,
} from '../../shared/maestro-lib/groupchat/router';

export {
	setGetSessionsCallback,
	setGetCustomEnvVarsCallback,
	setGetAgentConfigCallback,
	setGetModeratorSettingsCallback,
	setSshStore,
	type GetSessionsCallback,
	type GetCustomEnvVarsCallback,
	type GetAgentConfigCallback,
	type GetModeratorSettingsCallback,
} from './desktop-engine';

// Re-export setGetCustomShellPathCallback for index.ts to use
export { setGetCustomShellPathCallback };

/**
 * Records proof of life for whichever moderator or participant owns `sessionId`,
 * restarting its silence budget. Unknown or non-group-chat session ids are
 * ignored, so the caller can hand over every chunk it sees without pre-filtering.
 */
export function noteGroupChatActivity(sessionId: string): void {
	engine.noteActivity(sessionId);
}

/** Puts a room back to rest: clears the running state and releases its power block. */
export function settleGroupChatToIdle(groupChatId: string): void {
	engine.settleGroupChatToIdle(groupChatId);
}

/** Append a system note to the chat log and immediately deliver it to the renderer. */
export async function announceToChat(
	groupChatId: string,
	logPath: string,
	content: string
): Promise<void> {
	await appendToLog(logPath, 'system', content);
	groupChatEmitters.emitMessage?.(groupChatId, {
		timestamp: new Date().toISOString(),
		from: 'system',
		content,
	});
}

/** Abort only a running workflow, clear its turn state, and dispose of its handoff artifacts. */
export async function abortActiveWorkflowRun(
	groupChatId: string,
	reason: string
): Promise<ReturnType<typeof abortWorkflowRun>> {
	const run = getWorkflowRun(groupChatId);
	if (!run || (run.status !== 'running' && run.status !== 'awaiting-approval')) return undefined;
	const aborted = abortWorkflowRun(groupChatId, reason);
	clearPendingParticipants(groupChatId);
	clearModeratorResponseTimeout(groupChatId);
	if (aborted) await cleanupWorkflowRunArtifacts(groupChatId, aborted);
	settleGroupChatToIdle(groupChatId);
	return aborted;
}

/**
 * Registers a silence budget for the moderator. If it goes quiet (or runs past its
 * single-turn limit), its process is killed and the room is reset to idle.
 */
export function setModeratorResponseTimeout(
	groupChatId: string,
	processManager?: IProcessManager,
	sessionId?: string
): void {
	engine.setModeratorResponseTimeout(
		groupChatId,
		processManager ? createDesktopTurnStopper(processManager) : undefined,
		sessionId
	);
}

/** Cancels the moderator response timeout (called when the moderator process exits). */
export function clearModeratorResponseTimeout(groupChatId: string): void {
	engine.clearModeratorResponseTimeout(groupChatId);
}

/** Gets the current read-only state for a group chat. */
export function getGroupChatReadOnlyState(groupChatId: string): boolean {
	return engine.getGroupChatReadOnlyState(groupChatId);
}

/** Clears all pending participants for a group chat (and their timeouts). */
export function clearPendingParticipants(groupChatId: string): void {
	engine.clearPendingParticipants(groupChatId);
}

/** Clears the active task session tracked for a participant. */
export function clearActiveParticipantTaskSession(
	groupChatId: string,
	participantName: string
): void {
	engine.clearActiveParticipantTaskSession(groupChatId, participantName);
}

/**
 * Marks a participant as having responded (removes from pending, cancels timeout).
 * Returns true if this was the last pending participant.
 */
export function markParticipantResponded(groupChatId: string, participantName: string): boolean {
	return engine.markParticipantResponded(groupChatId, participantName);
}

/** The one process-manager call steering needs. */
export interface GroupChatSteeringChannel {
	steer(processId: string, text: string): Promise<SteeringResultFrame>;
}

/**
 * Types a user message into the round running in a chat (the moderator's turn,
 * or the working participants) and records it in the room when a turn takes it.
 */
export function steerRunningRound(
	groupChatId: string,
	message: { text: string; readOnly?: boolean },
	channel: GroupChatSteeringChannel
): Promise<GroupChatSteerResult> {
	return engine.steerRunningRound(groupChatId, message, (processId, text) =>
		channel.steer(processId, text)
	);
}

/**
 * Settles a steered message with its turn's transcript verdict. Returns the message
 * when no turn it went to took it, so the caller can queue it again.
 */
export function groupChatSteeringVerdict(processId: string, verdict: SteeringResultFrame) {
	return engine.steeringVerdict(processId, verdict);
}

/** The steered messages a turn exited without settling, so the caller can hold them. */
export function unsettledGroupChatSteersOnExit(processId: string) {
	return engine.unsettledSteersOnExit(processId);
}

/**
 * Routes a user message to the moderator.
 *
 * Spawns a batch process for the moderator to handle this specific message.
 * The chat history is included in the system prompt for context.
 *
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 */
export async function routeUserMessage(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager,
	agentDetector?: AgentDetector,
	readOnly?: boolean,
	images?: string[],
	routingRetry?: Parameters<typeof engine.routeUserMessage>[5]
): Promise<void> {
	const currentRun = getWorkflowRun(groupChatId);
	const planBlock = extractWorkflowPlanBlock(message);
	if (planBlock) {
		const chat = await loadGroupChat(groupChatId);
		if (!chat) throw new Error(`Group chat not found: ${groupChatId}`);
		const parsed = parseWorkflowPlan(planBlock, generateUUID());
		if ('error' in parsed) {
			await announceToChat(groupChatId, chat.logPath, `Workflow plan rejected: ${parsed.error}`);
			return;
		}
		if (currentRun?.status === 'running') clearPendingParticipants(groupChatId);
		workflowStageNudges.delete(groupChatId);
		setWorkflowRun(groupChatId, createRun(parsed.plan));
		if (currentRun?.status === 'running') {
			await announceToChat(
				groupChatId,
				chat.logPath,
				'Previous workflow superseded by a new plan; approval is required before execution resumes.'
			);
		}
		await announceToChat(
			groupChatId,
			chat.logPath,
			`${renderWorkflowPlanSummary(parsed.plan)}\n\nReply \`go\` to start, or tell me what to change.`
		);
		if (currentRun) await cleanupWorkflowRunArtifacts(groupChatId, currentRun);
		return;
	}
	if (currentRun?.status === 'awaiting-approval') {
		if (/^(?:!cancel|cancel|never mind)[.!?]*$/i.test(message.trim())) {
			await clearWorkflowRun(groupChatId);
			const chat = await loadGroupChat(groupChatId);
			if (chat) await announceToChat(groupChatId, chat.logPath, 'Workflow cancelled.');
			return;
		}
		if (isWorkflowApproval(message)) {
			const approved = approveWorkflowRun(groupChatId);
			const chat = await loadGroupChat(groupChatId);
			const stage = approved?.plan.stages[approved.currentStageIndex];
			if (chat && stage) {
				await announceToChat(
					groupChatId,
					chat.logPath,
					`Workflow started: stage ${approved.currentStageIndex + 1} of ${approved.plan.stages.length}, ${stage.name}`
				);
			}
		}
	} else if (
		currentRun?.status === 'running' &&
		/^(?:!cancel|cancel|never mind)[.!?]*$/i.test(message.trim())
	) {
		await abortActiveWorkflowRun(groupChatId, 'user-cancelled');
		const chat = await loadGroupChat(groupChatId);
		if (chat) await announceToChat(groupChatId, chat.logPath, 'Workflow cancelled.');
		return;
	}
	await engine.routeUserMessage(
		groupChatId,
		message,
		desktopLauncherFor(processManager, agentDetector),
		readOnly,
		images,
		routingRetry
	);
	// A process manager with no detector can log the message but cannot resolve the
	// moderator's command, which is a caller error rather than a quiet no-op.
	if (processManager && !agentDetector) {
		throw new Error('AgentDetector not available');
	}
}

/**
 * Routes a moderator response, forwarding to mentioned agents.
 *
 * @param processManager - The process manager (optional)
 * @param agentDetector - The agent detector for resolving agent commands (optional)
 * @param readOnly - Optional flag indicating read-only mode (propagates to participants)
 */
export async function routeModeratorResponse(
	groupChatId: string,
	message: string,
	processManager?: IProcessManager,
	agentDetector?: AgentDetector,
	readOnly?: boolean
): Promise<void> {
	const planBlock = extractWorkflowPlanBlock(message);
	if (planBlock) {
		const parsed = parseWorkflowPlan(planBlock, generateUUID());
		const chat = await loadGroupChat(groupChatId);
		if (!chat) throw new Error(`Group chat not found: ${groupChatId}`);
		if ('error' in parsed) {
			await announceToChat(groupChatId, chat.logPath, `Workflow plan rejected: ${parsed.error}`);
			return;
		}
		const prior = getWorkflowRun(groupChatId);
		if (prior?.status === 'running') clearPendingParticipants(groupChatId);
		workflowStageNudges.delete(groupChatId);
		setWorkflowRun(groupChatId, createRun(parsed.plan));
		if (prior?.status === 'running') {
			await announceToChat(
				groupChatId,
				chat.logPath,
				'Previous workflow superseded by a new plan; approval is required before execution resumes.'
			);
		}
		await announceToChat(
			groupChatId,
			chat.logPath,
			`${renderWorkflowPlanSummary(parsed.plan)}\n\nReply \`go\` to start, or tell me what to change.`
		);
		if (prior) await cleanupWorkflowRunArtifacts(groupChatId, prior);
		return;
	}

	const run = getWorkflowRun(groupChatId);
	const directive = run?.status === 'running' ? extractStageDirective(message) : null;
	if (run && directive) {
		const chat = await loadGroupChat(groupChatId);
		if (!chat) throw new Error(`Group chat not found: ${groupChatId}`);
		if (directive.kind === 'failed') {
			failWorkflowStage(
				groupChatId,
				directive.body || 'The moderator marked this stage as failed.'
			);
			clearPendingParticipants(groupChatId);
			await announceToChat(
				groupChatId,
				chat.logPath,
				`Stage ${run.currentStageIndex + 1} of ${run.plan.stages.length} failed: ${run.plan.stages[run.currentStageIndex].name}. ${directive.body}`
			);
			const failed = getWorkflowRun(groupChatId);
			if (failed) await cleanupWorkflowRunArtifacts(groupChatId, failed);
			settleGroupChatToIdle(groupChatId);
			return;
		}
		const advanced = completeWorkflowStage(groupChatId, {
			stageId: run.plan.stages[run.currentStageIndex].id,
			stageName: run.plan.stages[run.currentStageIndex].name,
			summary: directive.body,
		});
		if (advanced?.status === 'complete') {
			await announceToChat(
				groupChatId,
				chat.logPath,
				`Workflow complete: all ${run.plan.stages.length} stages finished.`
			);
			await cleanupWorkflowRunArtifacts(groupChatId, advanced);
			settleGroupChatToIdle(groupChatId);
			return;
		}
		await announceToChat(
			groupChatId,
			chat.logPath,
			`Stage ${run.currentStageIndex + 1} of ${run.plan.stages.length} complete: ${run.plan.stages[run.currentStageIndex].name}. Starting stage ${run.currentStageIndex + 2}: ${advanced?.plan.stages[advanced.currentStageIndex]?.name}.`
		);
		await addGroupChatHistoryEntry(groupChatId, {
			timestamp: Date.now(),
			summary: `Stage ${run.currentStageIndex + 1} of ${run.plan.stages.length} complete: ${run.plan.stages[run.currentStageIndex].name}. Starting stage ${run.currentStageIndex + 2}: ${advanced?.plan.stages[advanced.currentStageIndex]?.name}.`,
			participantName: 'Moderator',
			participantColor: '#808080',
			type: 'synthesis',
			fullResponse: directive.body,
		});
		if (processManager && agentDetector) {
			await spawnModeratorSynthesis(groupChatId, processManager, agentDetector);
		}
		return;
	}
	if (run?.status === 'running') {
		const currentStage = run.plan.stages[run.currentStageIndex];
		const chat = await loadGroupChat(groupChatId);
		const engaged =
			chat?.participants
				.filter((participant) => message.includes(`@${normalizeMentionName(participant.name)}`))
				.map((participant) => participant.name) ?? [];
		if (chat && engaged.length > 0) {
			const offRoster = engaged.filter((agent) => !currentStage.agents.includes(agent));
			if (offRoster.length > 0) {
				await announceToChat(
					groupChatId,
					chat.logPath,
					`Note: stage ${run.currentStageIndex + 1} lists ${currentStage.agents.map((agent) => `@${normalizeMentionName(agent)}`).join(', ')}, but ${offRoster.map((agent) => `@${normalizeMentionName(agent)}`).join(', ')} was engaged.`
				);
			}
		}
		if (engaged.length === 0 && !currentStage.autoRun) {
			const retry = nextWorkflowStageNudge(groupChatId, run.plan.runId, currentStage.id);
			if (retry <= MAX_WORKFLOW_STAGE_NUDGES && processManager && agentDetector && chat) {
				await announceToChat(
					groupChatId,
					chat.logPath,
					`Workflow stage ${run.currentStageIndex + 1} needs a moderator action. Retrying (${retry} of ${MAX_WORKFLOW_STAGE_NUDGES}): mention ${currentStage.agents.map((agent) => `@${normalizeMentionName(agent)}`).join(', ')} or emit a stage directive.`
				);
				await spawnModeratorSynthesis(
					groupChatId,
					processManager,
					agentDetector,
					`## Immediate Workflow Correction\nEither mention ${currentStage.agents.map((agent) => `@${normalizeMentionName(agent)}`).join(', ')} now or emit !stage-complete or !stage-failed.`
				);
				return;
			}
			if (retry > MAX_WORKFLOW_STAGE_NUDGES && chat) {
				const reason = 'moderator-stage-guidance-exhausted';
				abortWorkflowRun(groupChatId, reason);
				await announceToChat(
					groupChatId,
					chat.logPath,
					`Workflow aborted: the moderator produced no participant mentions or stage directive after ${MAX_WORKFLOW_STAGE_NUDGES} retries during stage ${run.currentStageIndex + 1}, ${currentStage.name}.`
				);
				const aborted = getWorkflowRun(groupChatId);
				if (aborted) await cleanupWorkflowRunArtifacts(groupChatId, aborted);
				settleGroupChatToIdle(groupChatId);
				return;
			}
		}
	}
	await engine.routeModeratorResponse(
		groupChatId,
		message,
		desktopLauncherFor(processManager, agentDetector),
		readOnly
	);
}

/**
 * Routes an agent's response back to the moderator: logs it, updates the
 * participant's stats, and records the history entry. The process manager is
 * accepted for API compatibility and unused.
 */
export async function routeAgentResponse(
	groupChatId: string,
	participantName: string,
	message: string,
	_processManager?: IProcessManager
): Promise<void> {
	const run = getWorkflowRun(groupChatId);
	const stage = run?.status === 'running' ? run.plan.stages[run.currentStageIndex] : undefined;
	if (run && stage) {
		const classification = classifyHandoff(message);
		const response =
			classification.mode === 'inline'
				? { participantName, mode: 'inline' as const, content: message }
				: {
						participantName,
						mode: 'artifact' as const,
						digest: classification.digest,
						artifactPath: await writeStageArtifact({
							groupChatId,
							runId: run.plan.runId,
							stageId: stage.id,
							participantName,
							content: message,
						}),
					};
		recordWorkflowStageResponse(groupChatId, response);
	}
	await engine.routeAgentResponse(groupChatId, participantName, message);
}

/**
 * Spawns a moderator synthesis round to summarize participant responses.
 * Called when the last pending participant has responded.
 */
export async function spawnModeratorSynthesis(
	groupChatId: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector,
	workflowCorrection?: string
): Promise<void> {
	const launcher = desktopLauncherFor(processManager, agentDetector);
	if (!launcher) throw new Error('Cannot spawn synthesis without a process manager and detector');
	await engine.spawnModeratorSynthesis(groupChatId, launcher, workflowCorrection);
}

/**
 * Re-spawn a participant with session recovery context, after its provider session
 * was deleted out of band.
 */
export async function respawnParticipantWithRecovery(
	groupChatId: string,
	participantName: string,
	processManager: IProcessManager,
	agentDetector: AgentDetector
): Promise<void> {
	const launcher = desktopLauncherFor(processManager, agentDetector);
	if (!launcher)
		throw new Error('Cannot respawn a participant without a process manager and detector');
	await engine.respawnParticipantWithRecovery(groupChatId, participantName, launcher);
}

/**
 * Add the agent with this exact GUID to a group chat, without an @mention
 * (`maestro-cli group-chat add`). Links the participant by GUID so a later
 * rename does not break it.
 */
export async function addParticipantByAgentId(
	groupChatId: string,
	agentId: string
): Promise<AddParticipantByAgentIdResult> {
	return engine.addParticipantByAgentId(groupChatId, agentId);
}
