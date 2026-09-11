/**
 * @file workflow-prompt-context.ts
 * @description Compact prompt context for an active Group Chat workflow run.
 */

import type {
	GroupChatWorkflowRun,
	GroupChatWorkflowStage,
} from '../../shared/group-chat-workflow-types';

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
	const handoffs = run.handoffs.map(
		(handoff) => `- ${handoff.stageName}: ${asOneLine(handoff.summary)}`
	);

	return `## Active Workflow Plan
Title: ${run.plan.title}
Run status: ${run.status}
Current stage: ${currentStage}

### Stages
${stages.join('\n')}

### Handoff Summaries
${handoffs.length > 0 ? handoffs.join('\n') : '(none)'}`;
}
