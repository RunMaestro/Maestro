/**
 * @file workflow-plan-parser.ts
 * @description Extraction, validation, and rendering for Group Chat workflow plans.
 */

import { normalizeMentionName } from '../../shared/group-chat-types';
import {
	MAX_WORKFLOW_STAGES,
	WORKFLOW_PLAN_FENCE_LANG,
	type GroupChatWorkflowPlan,
	type GroupChatWorkflowStage,
} from '../../shared/group-chat-workflow-types';

type ParseWorkflowPlanResult = { plan: GroupChatWorkflowPlan } | { error: string };

export type StageDirective = { kind: 'complete' | 'failed'; body: string };

const WORKFLOW_APPROVAL_MAX_LENGTH = 40;
const WORKFLOW_APPROVAL_INTENTS = new Set([
	'go',
	'run it',
	'start',
	'approved',
	'yes go',
	'ship it',
]);
const STAGE_DIRECTIVE_LINE_SOURCE =
	'^[\\t ]*(?:\\*\\*|__)?!stage-(complete|failed)(?:\\*\\*|__)?[\\t ]*\\r?$';

/** Extract the first stage directive and the prose following its line. */
export function extractStageDirective(text: string): StageDirective | null {
	const pattern = new RegExp(STAGE_DIRECTIVE_LINE_SOURCE, 'm');
	const match = pattern.exec(text);
	if (!match) return null;

	return {
		kind: match[1] as StageDirective['kind'],
		body: text.slice(match.index + match[0].length).trim(),
	};
}

/** Remove stage directive lines while preserving the surrounding prose. */
export function stripStageDirectives(text: string): string {
	const pattern = new RegExp(STAGE_DIRECTIVE_LINE_SOURCE, 'gm');
	return text.replace(pattern, '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** Return whether a short user message explicitly approves a pending workflow. */
export function isWorkflowApproval(text: string): boolean {
	const trimmed = text.trim();
	if (/^!go(?:[.!?]+)?$/i.test(trimmed)) return true;
	if (trimmed.length >= WORKFLOW_APPROVAL_MAX_LENGTH) return false;

	const normalized = trimmed
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
	return WORKFLOW_APPROVAL_INTENTS.has(normalized);
}

/** Extract the first `maestro-plan` fenced block from Markdown text. */
export function extractWorkflowPlanBlock(text: string): string | null {
	const pattern = new RegExp(
		'^[\\t ]*```' +
			WORKFLOW_PLAN_FENCE_LANG +
			'[\\t ]*\\r?\\n([\\s\\S]*?)^[\\t ]*```[\\t ]*(?:\\r?$)',
		'm'
	);
	const match = pattern.exec(text);
	return match ? match[1].trim() : null;
}

function parseAgents(
	value: unknown,
	stageNumber: number
): { agents: string[] } | { error: string } {
	if (value === undefined) return { agents: [] };
	if (!Array.isArray(value)) {
		return { error: `Stage ${stageNumber} field "agents" must be an array.` };
	}

	const agents: string[] = [];
	for (const agent of value) {
		const name = nonEmptyString(agent);
		if (!name) {
			return { error: `Stage ${stageNumber} agents must all be non-empty strings.` };
		}
		agents.push(normalizeMentionName(name));
	}
	return { agents };
}

function parseAutoRun(
	value: unknown,
	stageNumber: number
): { autoRun?: GroupChatWorkflowStage['autoRun'] } | { error: string } {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		return { error: `Stage ${stageNumber} field "autoRun" must be an object.` };
	}

	const participantName = nonEmptyString(value.participantName);
	if (!participantName) {
		return {
			error: `Stage ${stageNumber} autoRun target must have a non-empty "participantName".`,
		};
	}
	if (value.filename !== undefined && !nonEmptyString(value.filename)) {
		return { error: `Stage ${stageNumber} autoRun "filename" must be a non-empty string.` };
	}

	return {
		autoRun: {
			participantName: normalizeMentionName(participantName),
			...(value.filename === undefined ? {} : { filename: nonEmptyString(value.filename)! }),
		},
	};
}

function parseStage(
	value: unknown,
	index: number
): { stage: GroupChatWorkflowStage } | { error: string } {
	const stageNumber = index + 1;
	if (!isRecord(value)) return { error: `Stage ${stageNumber} must be an object.` };

	const name = nonEmptyString(value.name);
	if (!name) return { error: `Stage ${stageNumber} must have a non-empty "name".` };

	const instruction = nonEmptyString(value.instruction);
	if (!instruction) {
		return { error: `Stage ${stageNumber} must have a non-empty "instruction".` };
	}

	const parsedAgents = parseAgents(value.agents, stageNumber);
	if ('error' in parsedAgents) return parsedAgents;
	const parsedAutoRun = parseAutoRun(value.autoRun, stageNumber);
	if ('error' in parsedAutoRun) return parsedAutoRun;
	if (parsedAgents.agents.length === 0 && !parsedAutoRun.autoRun) {
		return { error: `Stage ${stageNumber} must have at least one agent or an autoRun target.` };
	}

	const id = value.id === undefined ? `stage-${stageNumber}` : nonEmptyString(value.id);
	if (!id) return { error: `Stage ${stageNumber} field "id" must be a non-empty string.` };

	const expects = value.expects === undefined ? undefined : nonEmptyString(value.expects);
	if (value.expects !== undefined && !expects) {
		return { error: `Stage ${stageNumber} field "expects" must be a non-empty string.` };
	}

	return {
		stage: {
			id,
			name,
			agents: parsedAgents.agents,
			mode: value.mode === 'parallel' && parsedAgents.agents.length > 1 ? 'parallel' : 'serial',
			instruction,
			...(expects ? { expects } : {}),
			...(parsedAutoRun.autoRun ? { autoRun: parsedAutoRun.autoRun } : {}),
		},
	};
}

/** Parse and validate a JSON workflow plan without throwing. */
export function parseWorkflowPlan(body: string, runId: string): ParseWorkflowPlanResult {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { error: `Workflow plan is not valid JSON: ${detail}` };
	}

	if (!isRecord(value)) return { error: 'Workflow plan must be a JSON object.' };
	if (!Array.isArray(value.stages)) {
		return { error: 'Workflow plan field "stages" must be an array.' };
	}
	if (value.stages.length === 0) return { error: 'Workflow plan must contain at least one stage.' };
	if (value.stages.length > MAX_WORKFLOW_STAGES) {
		return { error: `Workflow plan cannot contain more than ${MAX_WORKFLOW_STAGES} stages.` };
	}

	const title = nonEmptyString(value.title) ?? 'Workflow Plan';
	const notes = value.notes === undefined ? undefined : nonEmptyString(value.notes);
	if (value.notes !== undefined && !notes) {
		return { error: 'Workflow plan field "notes" must be a non-empty string.' };
	}

	const stages: GroupChatWorkflowStage[] = [];
	for (let index = 0; index < value.stages.length; index++) {
		const parsedStage = parseStage(value.stages[index], index);
		if ('error' in parsedStage) return parsedStage;
		stages.push(parsedStage.stage);
	}

	return {
		plan: {
			runId,
			title,
			createdAt: Date.now(),
			stages,
			...(notes ? { notes } : {}),
		},
	};
}

function escapeMermaidLabel(value: string, fallback: string): string {
	const escaped = value
		.replace(/[\r\n]+/g, ' ')
		.replace(/["'()[\]{}]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return escaped || fallback;
}

function stageAssignees(stage: GroupChatWorkflowStage): string[] {
	const agents = stage.agents.map((agent) => `@${agent}`);
	if (stage.autoRun) agents.push(`!autorun @${stage.autoRun.participantName}`);
	return agents;
}

/** Render a chat-visible stage list and Mermaid flowchart for a validated plan. */
export function renderWorkflowPlanSummary(plan: GroupChatWorkflowPlan): string {
	const lines = [`## ${plan.title}`, ''];
	for (let index = 0; index < plan.stages.length; index++) {
		const stage = plan.stages[index];
		const assignees = stageAssignees(stage).join(', ');
		lines.push(`${index + 1}. **${stage.name}** (${assignees})`);
		lines.push(`   Produces: ${stage.expects ?? stage.instruction}`);
	}

	lines.push('', '```mermaid', 'flowchart LR');
	let previousExit: string | null = null;
	for (let index = 0; index < plan.stages.length; index++) {
		const stage = plan.stages[index];
		const stageNode = `stage_${index + 1}`;
		const stageLabel = escapeMermaidLabel(stage.name, `Stage ${index + 1}`);
		lines.push(`\t${stageNode}["${index + 1}. ${stageLabel}"]`);

		if (previousExit) lines.push(`\t${previousExit} --> ${stageNode}`);
		if (stage.mode !== 'parallel') {
			previousExit = stageNode;
			continue;
		}

		const joinNode = `${stageNode}_join`;
		for (let agentIndex = 0; agentIndex < stage.agents.length; agentIndex++) {
			const agentNode = `${stageNode}_agent_${agentIndex + 1}`;
			const agentLabel = escapeMermaidLabel(stage.agents[agentIndex], `Agent ${agentIndex + 1}`);
			lines.push(`\t${agentNode}["@${agentLabel}"]`);
			lines.push(`\t${stageNode} --> ${agentNode}`);
			lines.push(`\t${agentNode} --> ${joinNode}`);
		}
		lines.push(`\t${joinNode}((join))`);
		previousExit = joinNode;
	}
	lines.push('```');

	return lines.join('\n');
}
