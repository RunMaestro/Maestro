/**
 * @file workflow-prompt-context.ts
 * @description Compact prompt context for an active Group Chat workflow run.
 */

import type {
	GroupChatWorkflowHandoff,
	GroupChatWorkflowRun,
	GroupChatWorkflowStage,
} from '../../shared/group-chat-workflow-types';
import { formatHandoffForPrompt } from './workflow-handoff';

function asOneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function formatStageTargets(stage: GroupChatWorkflowStage): string {
	const targets = stage.agents.map((agent) => `@${agent}`);
	if (stage.autoRun) {
		targets.push(
			`Auto Run @${stage.autoRun.participantName}${stage.autoRun.filename ? ` (${stage.autoRun.filename})` : ''}`
		);
	}
	return targets.join(', ');
}

function formatParticipantHandoffs(handoff: GroupChatWorkflowHandoff): string {
	const participantHandoffs = (handoff.participantHandoffs ?? [])
		.map((response) =>
			response.mode === 'inline'
				? formatHandoffForPrompt({
						participantName: response.participantName,
						mode: 'inline',
						content: response.content,
					})
				: formatHandoffForPrompt({
						participantName: response.participantName,
						mode: 'artifact',
						digest: response.digest,
						artifactPath: response.artifactPath,
					})
		)
		.join('\n\n');
	if (participantHandoffs || !handoff.artifactPaths?.length) return participantHandoffs;

	return handoff.artifactPaths
		.map((artifactPath) =>
			formatHandoffForPrompt({
				participantName: handoff.stageName,
				mode: 'artifact',
				digest: handoff.summary,
				artifactPath,
			})
		)
		.join('\n\n');
}

/** Render the durable workflow state injected into moderator prompts. */
export function buildPlanContextBlock(run: GroupChatWorkflowRun): string {
	const stageCount = run.plan.stages.length;
	const currentStage =
		run.currentStageIndex < stageCount
			? `${run.currentStageIndex + 1} of ${stageCount}`
			: `complete (${stageCount} of ${stageCount})`;
	const stages = run.plan.stages.map((stage, index) => {
		const status = run.stageStatuses[stage.id] ?? 'pending';
		return `${index + 1}. [${status}] ${stage.name} — Agents: ${formatStageTargets(stage)} — ${asOneLine(stage.instruction)}`;
	});
	const handoffs = run.handoffs
		.filter((handoff) => handoff.summary)
		.map((handoff) => `- ${handoff.stageName}: ${asOneLine(handoff.summary)}`);

	return `## Active Workflow Plan
Title: ${run.plan.title}
Run status: ${run.status}
Current stage: ${currentStage}

### Stages
${stages.join('\n')}

### Handoff Summaries
${handoffs.length > 0 ? handoffs.join('\n') : '(none)'}`;
}

/** Render current-stage responses and the completed stage immediately before it. */
export function buildCurrentStageContext(run: GroupChatWorkflowRun): string {
	const stage = run.plan.stages[run.currentStageIndex];
	if (!stage) return '';

	const currentHandoff = run.handoffs.find((handoff) => handoff.stageId === stage.id);
	const previousStage = run.plan.stages[run.currentStageIndex - 1];
	const previousHandoff = previousStage
		? run.handoffs.find((handoff) => handoff.stageId === previousStage.id)
		: undefined;
	const previousParticipantContext = previousHandoff
		? formatParticipantHandoffs(previousHandoff)
		: '';
	const previousHandoffContext = previousHandoff
		? `From ${previousHandoff.stageName}: ${previousHandoff.summary || '(no moderator summary)'}${
				previousParticipantContext ? `\n\n${previousParticipantContext}` : ''
			}`
		: '(none; this is the first stage)';
	const currentResponseContext = currentHandoff ? formatParticipantHandoffs(currentHandoff) : '';

	return `## Current Stage
Stage ${run.currentStageIndex + 1} of ${run.plan.stages.length}: ${stage.name}
Mode: ${stage.mode}
Agents: ${stage.agents.map((agent) => `@${agent}`).join(', ') || '(none)'}
${stage.autoRun ? `Auto Run: @${stage.autoRun.participantName}${stage.autoRun.filename ? ` (${stage.autoRun.filename})` : ''}\n` : ''}Instruction: ${stage.instruction}
Expected output: ${stage.expects || '(not specified)'}

### Previous Stage Handoff
${previousHandoffContext}

### Current Stage Responses
${currentResponseContext || '(none yet)'}`;
}
