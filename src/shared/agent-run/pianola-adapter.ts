import type { AgentRunState as PianolaAgentRunState } from '../pianola/pianola-completion-detector';
import { validatePlan, type PianolaPlan, type PianolaTaskStatus } from '../pianola/pianola-tasks';
import { PIANOLA_PLANS_FILENAME } from '../pianola/storage';
import type { Campaign, CampaignStatus, CampaignTask, CampaignTaskStatus } from '../campaign';
import type { AgentRunStatus } from './types';

export const PIANOLA_PLANS_FILE = PIANOLA_PLANS_FILENAME;

export const PIANOLA_AGENT_RUN_STATES: readonly PianolaAgentRunState[] = [
	'idle',
	'busy',
	'waiting_input',
	'connecting',
	'error',
] as const;

export const PIANOLA_TASK_STATUSES: readonly PianolaTaskStatus[] = [
	'pending',
	'running',
	'done',
	'failed',
	'blocked',
	'skipped',
] as const;

export type { PianolaAgentRunState, PianolaTaskStatus };
export type PianolaTaskLike = PianolaPlan['tasks'][number];
export type PianolaPlanLike = PianolaPlan;

export interface PianolaStateMappingOptions {
	previousState?: PianolaAgentRunState;
	failure?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkingPianolaState(state: PianolaAgentRunState | undefined): boolean {
	return state === 'busy' || state === 'connecting';
}

export function mapPianolaRunStateToAgentRunStatus(
	state: PianolaAgentRunState,
	options: PianolaStateMappingOptions = {}
): AgentRunStatus {
	if (state === 'error' || options.failure) return 'failed';
	if (state === 'busy' || state === 'connecting') return 'running';
	if (state === 'waiting_input') return 'waiting';
	if (state === 'idle' && isWorkingPianolaState(options.previousState)) return 'completed';
	return 'waiting';
}

export function mapAgentRunStatusToPianolaRunState(
	status: AgentRunStatus
): PianolaAgentRunState | null {
	switch (status) {
		case 'running':
		case 'fixing':
			return 'busy';
		case 'waiting':
		case 'needs_review':
			return 'waiting_input';
		case 'completed':
		case 'merged':
			return 'idle';
		case 'failed':
			return 'error';
		case 'queued':
		case 'cancelled':
		case 'discarded':
			return null;
	}
}

export function mapPianolaTaskStatusToCampaignTaskStatus(
	status: PianolaTaskStatus
): CampaignTaskStatus {
	switch (status) {
		case 'pending':
			return 'queued';
		case 'running':
			return 'running';
		case 'done':
			return 'passed';
		case 'failed':
			return 'failed';
		case 'blocked':
			return 'blocked';
		case 'skipped':
			return 'skipped';
	}
}

export function mapCampaignTaskStatusToPianolaTaskStatus(
	status: CampaignTaskStatus
): PianolaTaskStatus | null {
	switch (status) {
		case 'queued':
			return 'pending';
		case 'running':
			return 'running';
		case 'passed':
		case 'merged':
			return 'done';
		case 'failed':
			return 'failed';
		case 'blocked':
			return 'blocked';
		case 'skipped':
		case 'discarded':
			return 'skipped';
		case 'waiting':
		case 'needs_review':
		case 'fixing':
			return null;
	}
}

export function validatePianolaPlanLike(raw: unknown): PianolaPlanLike | null {
	return validatePlan(raw).plan;
}

function inferCampaignStatus(tasks: readonly PianolaTaskLike[]): CampaignStatus {
	if (tasks.some((task) => task.status === 'failed' || task.status === 'blocked')) return 'blocked';
	if (tasks.some((task) => task.status === 'running')) return 'running';
	if (tasks.every((task) => task.status === 'done' || task.status === 'skipped')) return 'complete';
	return 'queued';
}

function toPianolaMetadata(task: PianolaTaskLike): Record<string, unknown> {
	const pianola: Record<string, unknown> = {
		prompt: task.prompt,
		status: task.status,
	};
	if (task.agentId !== undefined) pianola.agentId = task.agentId;
	if (task.agentType !== undefined) pianola.agentType = task.agentType;
	if (task.cwd !== undefined) pianola.cwd = task.cwd;
	if (task.tabId !== undefined) pianola.tabId = task.tabId;
	if (task.error !== undefined) pianola.error = task.error;
	return { pianola };
}

export function pianolaPlanToCampaign(plan: PianolaPlanLike): Campaign {
	const tasks: CampaignTask[] = plan.tasks.map((task) => ({
		id: task.id,
		title: task.title,
		status: mapPianolaTaskStatusToCampaignTaskStatus(task.status),
		dependsOn: [...task.dependsOn],
		prompt: task.prompt,
		...(task.agentType !== undefined ? { agentType: task.agentType } : {}),
		...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
		...(task.tabId !== undefined ? { tabId: task.tabId } : {}),
		...(task.error !== undefined ? { error: task.error } : {}),
		metadata: toPianolaMetadata(task),
	}));
	return {
		id: `pianola:${plan.id}`,
		title: plan.title,
		createdAt: plan.createdAt,
		updatedAt: plan.createdAt,
		status: inferCampaignStatus(plan.tasks),
		objective: plan.title,
		runIds: [],
		tasks,
		source: {
			adapter: 'pianola',
			planId: plan.id,
			filename: PIANOLA_PLANS_FILE,
		},
		metadata: {
			pianola: {
				planId: plan.id,
			},
		},
	};
}

export function pianolaPlansToCampaigns(raw: unknown): Campaign[] {
	if (!isRecord(raw) || !Array.isArray(raw.plans)) return [];
	return raw.plans.flatMap((plan) => {
		const validated = validatePianolaPlanLike(plan);
		return validated ? [pianolaPlanToCampaign(validated)] : [];
	});
}
