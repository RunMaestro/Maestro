/**
 * @file groupchat/workflow/controller.ts
 * @description Staged workflows inside a group chat round: the moderator proposes a
 * `maestro-plan`, the user approves it, and the stages run one at a time.
 *
 * The engine owns rounds; this owns the RUN. The engine asks it at four points:
 * a user message (a plan, an approval, a cancel), a moderator reply (a plan, a stage
 * directive), a moderator turn that started no work (a nudge), and a participant
 * reply (the stage's handoff). It lives in the library, not a host, so the desktop
 * and a headless host run the same workflow, and the run is saved in the chat's
 * folder through the chat store, so a restart resumes it.
 */

import {
	normalizeMentionName,
	type GroupChatMessage as GroupChatRoomMessage,
} from '../../../group-chat-types';
import type {
	GroupChatWorkflowHandoff,
	GroupChatWorkflowParticipantHandoff,
	GroupChatWorkflowRun,
	GroupChatWorkflowStage,
} from '../../../group-chat-workflow-types';
import { logger } from '../../host';
import type { GroupChatStore } from '../storage';
import type { GroupChat, GroupChatPromptId } from '../types';
import { classifyHandoff } from './handoff';
import {
	extractStageDirective,
	extractWorkflowPlanBlock,
	isWorkflowApproval,
	parseWorkflowPlan,
	renderWorkflowPlanSummary,
	stripStageDirectives,
	stripWorkflowPlanBlock,
} from './plan';
import { buildCurrentStageContext, buildPlanContextBlock } from './prompt-context';
import { abortRun, approveRun, completeStage, createRun, failStage, isRunActive } from './state';

const LOG_CONTEXT = '[GroupChatWorkflow]';

/** How many times a running stage's moderator is told to act before the run is aborted. */
export const MAX_WORKFLOW_STAGE_NUDGES = 2;

const CANCEL_PATTERN = /^(?:!cancel|cancel|never mind)[.!?]*$/i;

/** What the engine does after a moderator reply the workflow looked at. */
export type WorkflowModeratorStep =
	/** Not the workflow's: route the reply as usual. */
	| { kind: 'continue' }
	/** The workflow consumed the reply and the room goes idle (plan proposed, run ended). */
	| { kind: 'settle' }
	/** A stage finished and another starts: run a moderator turn on the next stage. */
	| { kind: 'next-stage' };

/** What the engine does after a moderator turn that started no participant. */
export type WorkflowIdleStep =
	| { kind: 'none' }
	/** Run another moderator turn with this correction appended. */
	| { kind: 'retry'; correction: string };

export interface GroupChatWorkflowsOptions {
	store: Pick<
		GroupChatStore,
		| 'loadWorkflowRun'
		| 'saveWorkflowRun'
		| 'writeWorkflowArtifact'
		| 'clearWorkflowArtifacts'
		| 'addGroupChatHistoryEntry'
	>;
	prompts: { get(id: GroupChatPromptId): string };
	/** Post a system line to the chat (its log and the windows). */
	announce(groupChatId: string, logPath: string, content: string): Promise<void>;
	/** Post a moderator line to the chat (its log and the windows). */
	postModeratorMessage(groupChatId: string, logPath: string, content: string): Promise<void>;
	/** Tell the windows the run changed. Null when the chat no longer holds one. */
	runChanged?(groupChatId: string, run: GroupChatWorkflowRun | null): void;
	newRunId(): string;
}

function mentionList(names: readonly string[]): string {
	return names.map((name) => `@${normalizeMentionName(name)}`).join(', ');
}

function stageLabel(run: GroupChatWorkflowRun, stage: GroupChatWorkflowStage): string {
	return `stage ${run.currentStageIndex + 1} of ${run.plan.stages.length}, ${stage.name}`;
}

export function createGroupChatWorkflows(options: GroupChatWorkflowsOptions) {
	const { store, prompts } = options;

	/** The run each chat holds, once read from its folder. Null: read, and none. */
	const runs = new Map<string, GroupChatWorkflowRun | null>();
	/** Reads in flight, so two callers in one tick read the file once. */
	const loading = new Map<string, Promise<GroupChatWorkflowRun | null>>();
	/** Nudges spent on the current stage of each chat's run. */
	const nudges = new Map<string, { runId: string; stageId: string; count: number }>();

	/** Post a system line to a chat. */
	const announce = (chat: GroupChat, content: string): Promise<void> =>
		options.announce(chat.id, chat.logPath, content);

	/** The run a chat holds, or null. Read from the chat's folder the first time. */
	async function get(groupChatId: string): Promise<GroupChatWorkflowRun | null> {
		if (runs.has(groupChatId)) return runs.get(groupChatId) ?? null;
		const pending = loading.get(groupChatId);
		if (pending) return pending;
		const read = (async () => {
			const run = await store.loadWorkflowRun(groupChatId);
			// A run that ended, or a crash between writing an artifact and its run,
			// leaves directories no run points at. Keep only the active run's.
			await store
				.clearWorkflowArtifacts(groupChatId, {
					keepRunId: run && isRunActive(run) ? run.plan.runId : undefined,
				})
				.catch((error) =>
					logger.warn(`${LOG_CONTEXT} Could not sweep workflow artifacts: ${String(error)}`)
				);
			if (!runs.has(groupChatId)) runs.set(groupChatId, run);
			return runs.get(groupChatId) ?? null;
		})();
		loading.set(groupChatId, read);
		try {
			return await read;
		} finally {
			loading.delete(groupChatId);
		}
	}

	/** Save a run (or its absence), then tell the windows. */
	async function put(groupChatId: string, run: GroupChatWorkflowRun | null): Promise<void> {
		runs.set(groupChatId, run);
		await store.saveWorkflowRun(groupChatId, run);
		options.runChanged?.(groupChatId, run);
		if (run) {
			logger.info(
				`${LOG_CONTEXT} Run ${run.plan.runId} is ${run.status} at stage ${run.currentStageIndex + 1}`
			);
		}
	}

	/** Remove a run's handoff artifacts without letting a cleanup failure fail the workflow. */
	async function dropArtifacts(groupChatId: string, run: GroupChatWorkflowRun): Promise<void> {
		await store
			.clearWorkflowArtifacts(groupChatId, { runId: run.plan.runId })
			.catch((error) =>
				logger.warn(`${LOG_CONTEXT} Could not clear workflow artifacts: ${String(error)}`)
			);
	}

	/** Store a plan as a run that waits for approval, replacing any run the chat held. */
	async function proposePlan(
		chat: GroupChat,
		block: string,
		proposal: { moderatorProse?: string; readOnly?: boolean } = {}
	): Promise<boolean> {
		const parsed = parseWorkflowPlan(block, options.newRunId());
		if ('error' in parsed) {
			await announce(chat, `Workflow plan rejected: ${parsed.error}`);
			return false;
		}
		const prior = await get(chat.id);
		nudges.delete(chat.id);
		const run = createRun(parsed.plan);
		await put(chat.id, proposal.readOnly ? { ...run, readOnly: true } : run);
		if (prior && isRunActive(prior)) {
			await announce(
				chat,
				'The previous workflow was replaced by a new plan. It needs approval before it runs.'
			);
		}
		if (prior) await dropArtifacts(chat.id, prior);
		await announce(
			chat,
			`${renderWorkflowPlanSummary(parsed.plan, {
				// The moderator draws its own diagram in the prose; one is enough.
				diagram: !proposal.moderatorProse,
			})}\n\nReply \`go\` to start, \`cancel\` to drop it, or tell the moderator what to change.`
		);
		return true;
	}

	/**
	 * A user message, before the moderator sees it. Returns true when the workflow
	 * consumed it (a plan the user pasted, a cancel): the engine records it and stops.
	 * An approval starts the run and returns false, so the moderator's turn runs the
	 * first stage.
	 */
	async function onUserMessage(
		chat: GroupChat,
		message: string,
		readOnly?: boolean
	): Promise<boolean> {
		const block = extractWorkflowPlanBlock(message);
		if (block) {
			await proposePlan(chat, block, { readOnly });
			return true;
		}
		const run = await get(chat.id);
		if (!run || !isRunActive(run)) return false;
		if (CANCEL_PATTERN.test(message.trim())) {
			await cancel(chat, 'user-cancelled');
			return true;
		}
		if (run.status === 'awaiting-approval' && isWorkflowApproval(message)) {
			const approved = approveRun(run);
			await put(chat.id, approved);
			const stage = approved.plan.stages[approved.currentStageIndex];
			if (stage) await announce(chat, `Workflow started: ${stageLabel(approved, stage)}.`);
		}
		return false;
	}

	/** End an active run on the user's word or a Stop. Returns the ended run, or null. */
	async function cancel(chat: GroupChat, reason: string): Promise<GroupChatWorkflowRun | null> {
		const run = await get(chat.id);
		if (!run || !isRunActive(run)) return null;
		const aborted = abortRun(run, reason);
		nudges.delete(chat.id);
		await put(chat.id, aborted);
		await dropArtifacts(chat.id, aborted);
		await announce(chat, 'Workflow cancelled.');
		return aborted;
	}

	/** Fail the running stage: a turn timed out, or the moderator said so. */
	async function failRunningStage(chat: GroupChat, reason: string): Promise<boolean> {
		const run = await get(chat.id);
		if (run?.status !== 'running') return false;
		const stage = run.plan.stages[run.currentStageIndex];
		const failed = failStage(run, reason);
		nudges.delete(chat.id);
		await put(chat.id, failed);
		await dropArtifacts(chat.id, failed);
		await announce(
			chat,
			`Workflow stopped: ${stage ? stageLabel(run, stage) : 'the current stage'} failed. ${reason}`
		);
		return true;
	}

	/**
	 * A moderator reply, before it is routed. A plan becomes a run that waits for
	 * approval; a stage directive ends the stage. Either way the reply is posted
	 * here, without the plan block or directive line, since the engine does not
	 * route it.
	 */
	async function onModeratorResponse(
		chat: GroupChat,
		message: string,
		readOnly?: boolean
	): Promise<WorkflowModeratorStep> {
		const block = extractWorkflowPlanBlock(message);
		if (block) {
			const prose = stripWorkflowPlanBlock(message);
			if (prose) await options.postModeratorMessage(chat.id, chat.logPath, prose);
			await proposePlan(chat, block, { moderatorProse: prose, readOnly });
			return { kind: 'settle' };
		}

		const run = await get(chat.id);
		const directive = run?.status === 'running' ? extractStageDirective(message) : null;
		if (!run || !directive) return { kind: 'continue' };
		const stage = run.plan.stages[run.currentStageIndex];
		const prose = stripStageDirectives(message);
		if (prose && prose !== directive.body) {
			await options.postModeratorMessage(chat.id, chat.logPath, prose);
		}

		if (directive.kind === 'failed') {
			await failRunningStage(chat, directive.body || 'The moderator marked the stage failed.');
			return { kind: 'settle' };
		}

		const advanced = completeStage(run, {
			stageId: stage.id,
			stageName: stage.name,
			summary: directive.body,
		});
		nudges.delete(chat.id);
		await put(chat.id, advanced);
		await store.addGroupChatHistoryEntry(chat.id, {
			timestamp: Date.now(),
			summary: `Stage ${run.currentStageIndex + 1} of ${run.plan.stages.length} complete: ${stage.name}.`,
			participantName: 'Moderator',
			participantColor: '#808080',
			type: 'synthesis',
			fullResponse: directive.body,
		});
		if (advanced.status === 'complete') {
			await dropArtifacts(chat.id, advanced);
			await announce(
				chat,
				`Workflow complete: all ${run.plan.stages.length} stages finished.${directive.body ? `\n\n${directive.body}` : ''}`
			);
			return { kind: 'settle' };
		}
		const next = advanced.plan.stages[advanced.currentStageIndex];
		await announce(
			chat,
			`Stage ${run.currentStageIndex + 1} of ${run.plan.stages.length} complete: ${stage.name}. Starting ${stageLabel(advanced, next)}.`
		);
		return { kind: 'next-stage' };
	}

	/** Note a moderator that engaged agents the running stage does not list. */
	async function noteOffRosterMentions(
		chat: GroupChat,
		mentions: readonly string[]
	): Promise<void> {
		const run = await get(chat.id);
		if (run?.status !== 'running' || mentions.length === 0) return;
		const stage = run.plan.stages[run.currentStageIndex];
		const roster = new Set(stage.agents.map(normalizeMentionName));
		const offRoster = mentions.filter((name) => !roster.has(normalizeMentionName(name)));
		if (offRoster.length === 0) return;
		await announce(
			chat,
			`Note: stage ${run.currentStageIndex + 1} lists ${mentionList(stage.agents) || 'no agents'}, but ${mentionList(offRoster)} was engaged.`
		);
	}

	/**
	 * A moderator turn that started no participant. While a stage runs, that is a
	 * stall: the moderator is told to act, twice, and then the run is aborted. An
	 * Auto Run stage whose directive was given but could not start (no Auto Run
	 * folder, no such participant) fails at once: asking again cannot fix it.
	 */
	async function onIdleModeratorTurn(
		chat: GroupChat,
		turn: { autoRunAttempted?: boolean; queuedForBusyAgents?: boolean } = {}
	): Promise<WorkflowIdleStep> {
		const run = await get(chat.id);
		// Work held for a busy agent starts when the agent is free: not a stall.
		if (run?.status !== 'running' || turn.queuedForBusyAgents) return { kind: 'none' };
		const stage = run.plan.stages[run.currentStageIndex];
		if (stage.autoRun && turn.autoRunAttempted) {
			await failRunningStage(
				chat,
				`The Auto Run of @${normalizeMentionName(stage.autoRun.participantName)} could not start.`
			);
			return { kind: 'none' };
		}
		const current = nudges.get(chat.id);
		const count =
			current?.runId === run.plan.runId && current.stageId === stage.id ? current.count + 1 : 1;
		nudges.set(chat.id, { runId: run.plan.runId, stageId: stage.id, count });
		const action = stage.autoRun
			? `emit the stage's Auto Run directive`
			: `mention ${mentionList(stage.agents)}`;
		if (count <= MAX_WORKFLOW_STAGE_NUDGES) {
			await announce(
				chat,
				`Workflow ${stageLabel(run, stage)} needs a moderator action. Retrying (${count} of ${MAX_WORKFLOW_STAGE_NUDGES}).`
			);
			return {
				kind: 'retry',
				correction: `## Immediate Workflow Correction\nEither ${action} now, or emit !stage-complete or !stage-failed.`,
			};
		}
		const aborted = abortRun(run, 'moderator-stage-guidance-exhausted');
		nudges.delete(chat.id);
		await put(chat.id, aborted);
		await dropArtifacts(chat.id, aborted);
		await announce(
			chat,
			`Workflow aborted: the moderator started no work and gave no stage directive after ${MAX_WORKFLOW_STAGE_NUDGES} retries during ${stageLabel(run, stage)}.`
		);
		return { kind: 'none' };
	}

	/**
	 * A participant reply during a running stage becomes the stage's handoff: kept
	 * inline when short, saved to a file with a digest when long.
	 */
	async function recordStageResponse(
		groupChatId: string,
		participantName: string,
		message: string
	): Promise<void> {
		const run = await get(groupChatId);
		if (run?.status !== 'running') return;
		const stage = run.plan.stages[run.currentStageIndex];
		if (!stage) return;
		const classification = classifyHandoff(message);
		const response: GroupChatWorkflowParticipantHandoff =
			classification.mode === 'inline'
				? { participantName, mode: 'inline', content: message }
				: {
						participantName,
						mode: 'artifact',
						digest: classification.digest,
						artifactPath: await store.writeWorkflowArtifact({
							groupChatId,
							runId: run.plan.runId,
							stageId: stage.id,
							participantName,
							content: message,
						}),
					};
		// The run may have moved while the artifact was written.
		const latest = await get(groupChatId);
		if (latest?.plan.runId !== run.plan.runId || latest.status !== 'running') return;
		await put(groupChatId, withStageResponse(latest, response));
	}

	/** The read-only mode a message that names none runs in: its active run's. */
	async function readOnlyFor(
		groupChatId: string,
		readOnly?: boolean
	): Promise<boolean | undefined> {
		if (readOnly !== undefined) return readOnly;
		const run = await get(groupChatId);
		return run && isRunActive(run) && run.readOnly ? true : undefined;
	}

	/**
	 * The workflow's part of a moderator prompt: how to plan when no run is active,
	 * how to revise a plan that waits, or the stage to run.
	 */
	function promptSection(run: GroupChatWorkflowRun | null): string {
		if (run?.status === 'running') {
			return `${prompts.get('group-chat-workflow-stage')}\n\n## Approved Workflow Stage\n\n${buildPlanContextBlock(run)}\n\n${buildCurrentStageContext(run)}`;
		}
		if (run?.status === 'awaiting-approval') {
			return `${prompts.get('group-chat-workflow-planning')}\n\n## Workflow Plan Revision\nThe user is giving feedback on the pending plan below. Do not dispatch participants. Revise the plan in response, then emit a replacement \`maestro-plan\` block and end the turn as the planning instructions require.\n\n${buildPlanContextBlock(run)}\n\nCurrent workflow plan JSON:\n\`\`\`json\n${JSON.stringify(run.plan, null, 2)}\n\`\`\``;
		}
		return prompts.get('group-chat-workflow-planning');
	}

	/**
	 * The chat history a moderator prompt carries while a stage runs. Stage replies
	 * already reach the prompt as handoffs (inline or by file), so the raw lines
	 * are left out rather than sent twice. Undefined: use the plain history.
	 */
	function projectHistory(
		run: GroupChatWorkflowRun | null,
		history: GroupChatRoomMessage[],
		limit: number
	): string | undefined {
		if (run?.status !== 'running') return undefined;
		const handedOff = new Set(
			run.handoffs.flatMap((handoff) =>
				(handoff.participantHandoffs ?? []).map((response) => response.participantName)
			)
		);
		if (handedOff.size === 0) return undefined;
		return history
			.filter((message) => !handedOff.has(message.from))
			.slice(-limit)
			.map((message) => `[${message.from}]: ${message.content}`)
			.join('\n');
	}

	/** A participant left the chat: warn when a later stage still lists it. */
	async function noteParticipantRemoved(chat: GroupChat, name: string): Promise<void> {
		const run = await get(chat.id);
		if (!run || !isRunActive(run)) return;
		const removed = normalizeMentionName(name);
		const laterStages = run.plan.stages
			.slice(run.status === 'running' ? run.currentStageIndex + 1 : 0)
			.filter(
				(stage) =>
					stage.agents.some((agent) => normalizeMentionName(agent) === removed) ||
					(stage.autoRun && normalizeMentionName(stage.autoRun.participantName) === removed)
			)
			.map((stage) => stage.name);
		if (laterStages.length === 0) return;
		await announce(
			chat,
			`Note: @${removed} was removed but is assigned to workflow stages: ${laterStages.join(', ')}. Add a replacement before those stages begin.`
		);
	}

	/** Forget a chat's run: it was deleted or archived. Its folder goes with it or stays put. */
	async function forget(groupChatId: string): Promise<void> {
		const run = await get(groupChatId).catch(() => null);
		nudges.delete(groupChatId);
		if (run) await put(groupChatId, null).catch(() => runs.set(groupChatId, null));
		if (run) await dropArtifacts(groupChatId, run);
		runs.delete(groupChatId);
	}

	return {
		get,
		readOnlyFor,
		onUserMessage,
		onModeratorResponse,
		onIdleModeratorTurn,
		noteOffRosterMentions,
		recordStageResponse,
		failRunningStage,
		cancel,
		promptSection,
		projectHistory,
		noteParticipantRemoved,
		forget,
	};
}

/** The functions the workflow controller offers the engine. */
export type GroupChatWorkflows = ReturnType<typeof createGroupChatWorkflows>;

/** A run with one more participant reply recorded against its running stage. */
export function withStageResponse(
	run: GroupChatWorkflowRun,
	response: GroupChatWorkflowParticipantHandoff
): GroupChatWorkflowRun {
	const stage = run.plan.stages[run.currentStageIndex];
	if (run.status !== 'running' || !stage) return run;
	const handoffs: GroupChatWorkflowHandoff[] = run.handoffs.map((handoff) => ({
		...handoff,
		...(handoff.artifactPaths ? { artifactPaths: [...handoff.artifactPaths] } : {}),
		...(handoff.participantHandoffs
			? { participantHandoffs: handoff.participantHandoffs.map((item) => ({ ...item })) }
			: {}),
	}));
	let stageHandoff = handoffs.find((handoff) => handoff.stageId === stage.id);
	if (!stageHandoff) {
		stageHandoff = { stageId: stage.id, stageName: stage.name, summary: '' };
		handoffs.push(stageHandoff);
	}
	const responses = [...(stageHandoff.participantHandoffs ?? [])];
	const existingIndex = responses.findIndex(
		(item) => item.participantName === response.participantName
	);
	const existing = existingIndex >= 0 ? responses[existingIndex] : undefined;
	if (existingIndex >= 0) responses[existingIndex] = response;
	else responses.push(response);
	stageHandoff.participantHandoffs = responses;
	if (response.mode === 'artifact') {
		stageHandoff.artifactPaths = [
			...(stageHandoff.artifactPaths ?? []),
			response.artifactPath,
		].filter((artifactPath, index, paths) => paths.indexOf(artifactPath) === index);
	} else if (existing?.mode === 'artifact') {
		stageHandoff.artifactPaths = stageHandoff.artifactPaths?.filter(
			(artifactPath) => artifactPath !== existing.artifactPath
		);
	}
	return { ...run, handoffs };
}
