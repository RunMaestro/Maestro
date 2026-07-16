import { hasInvalidOptionalStrings } from '../validation';
import type {
	Campaign,
	CampaignMetadata,
	CampaignSource,
	CampaignStatus,
	CampaignSummary,
	CampaignSummaryValue,
	CampaignTask,
	CampaignTaskStatus,
	CampaignTaskStatusCounts,
} from './types';

const CAMPAIGN_STATUSES = [
	'queued',
	'running',
	'needs_review',
	'blocked',
	'complete',
	'archived',
] as const;

const CAMPAIGN_TASK_STATUSES = [
	'queued',
	'running',
	'waiting',
	'needs_review',
	'fixing',
	'passed',
	'failed',
	'blocked',
	'merged',
	'discarded',
	'skipped',
] as const;

const READY_DEPENDENCY_STATUSES = new Set<CampaignTaskStatus>(['passed', 'merged']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function validateOptionalString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function validateStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((item) => typeof item === 'string')) return null;
	return [...value];
}

function normalizeTimestamp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function validateCampaignStatus(value: unknown): CampaignStatus | null {
	return CAMPAIGN_STATUSES.includes(value as CampaignStatus) ? (value as CampaignStatus) : null;
}

function validateCampaignTaskStatus(value: unknown): CampaignTaskStatus | null {
	return CAMPAIGN_TASK_STATUSES.includes(value as CampaignTaskStatus)
		? (value as CampaignTaskStatus)
		: null;
}

function validateMetadata(value: unknown): CampaignMetadata | undefined {
	return isRecord(value) ? { ...value } : undefined;
}

function validateSource(value: unknown): CampaignSource | undefined {
	if (typeof value === 'string') return value;
	return validateMetadata(value);
}

function validateSummaryValue(value: unknown): CampaignSummaryValue | undefined {
	if (typeof value === 'string') return value;
	return validateMetadata(value);
}

function hasInvalidOptionalMetadata(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.some((key) => raw[key] !== undefined && !isRecord(raw[key]));
}

function hasInvalidOptionalSummaryValues(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.some((key) => {
		const value = raw[key];
		return value !== undefined && typeof value !== 'string' && !isRecord(value);
	});
}

function hasInvalidOptionalSource(raw: Record<string, unknown>): boolean {
	return raw.source !== undefined && typeof raw.source !== 'string' && !isRecord(raw.source);
}

function assignOptionalTaskString(
	target: CampaignTask,
	key:
		| 'runId'
		| 'worktreePath'
		| 'branch'
		| 'pullRequestUrl'
		| 'prompt'
		| 'agentType'
		| 'cwd'
		| 'tabId'
		| 'error',
	value: unknown
): void {
	const validated = validateOptionalString(value);
	if (validated !== undefined) {
		target[key] = validated;
	}
}

function assignOptionalCampaignString(target: Campaign, key: 'objective', value: unknown): void {
	const validated = validateOptionalString(value);
	if (validated !== undefined) {
		target[key] = validated;
	}
}

function assignOptionalSummaryValue(
	target: CampaignTask,
	key: 'checkSummary' | 'reviewSummary' | 'mergeSummary',
	value: unknown
): void {
	const validated = validateSummaryValue(value);
	if (validated !== undefined) {
		target[key] = validated;
	}
}

function validateCampaignTask(
	raw: unknown,
	options: { strictOptional: boolean }
): CampaignTask | null {
	if (!isRecord(raw)) return null;

	if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.title)) return null;

	const status = validateCampaignTaskStatus(raw.status);
	if (!status) return null;

	const dependsOn = validateStringArray(raw.dependsOn);
	if (!dependsOn) return null;
	if (
		options.strictOptional &&
		(hasInvalidOptionalStrings(raw, [
			'runId',
			'worktreePath',
			'branch',
			'pullRequestUrl',
			'prompt',
			'agentType',
			'cwd',
			'tabId',
			'error',
		]) ||
			hasInvalidOptionalSummaryValues(raw, ['checkSummary', 'reviewSummary', 'mergeSummary']) ||
			hasInvalidOptionalMetadata(raw, ['metadata']))
	) {
		return null;
	}

	const task: CampaignTask = {
		id: raw.id,
		title: raw.title,
		status,
		dependsOn,
	};

	assignOptionalTaskString(task, 'runId', raw.runId);
	assignOptionalTaskString(task, 'worktreePath', raw.worktreePath);
	assignOptionalTaskString(task, 'branch', raw.branch);
	assignOptionalTaskString(task, 'pullRequestUrl', raw.pullRequestUrl);
	assignOptionalTaskString(task, 'prompt', raw.prompt);
	assignOptionalTaskString(task, 'agentType', raw.agentType);
	assignOptionalTaskString(task, 'cwd', raw.cwd);
	assignOptionalTaskString(task, 'tabId', raw.tabId);
	assignOptionalTaskString(task, 'error', raw.error);
	assignOptionalSummaryValue(task, 'checkSummary', raw.checkSummary);
	assignOptionalSummaryValue(task, 'reviewSummary', raw.reviewSummary);
	assignOptionalSummaryValue(task, 'mergeSummary', raw.mergeSummary);

	const metadata = validateMetadata(raw.metadata);
	if (metadata) task.metadata = metadata;

	return task;
}

function validateCampaignTasks(
	value: unknown,
	options: { strictChildren: boolean }
): CampaignTask[] | null {
	if (!Array.isArray(value)) return null;
	const tasks = value.flatMap((item) => {
		const task = validateCampaignTask(item, { strictOptional: options.strictChildren });
		return task ? [task] : [];
	});
	if (options.strictChildren && tasks.length !== value.length) return null;
	return tasks;
}

function hasValidTaskGraph(tasks: CampaignTask[]): boolean {
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.id) || task.dependsOn.includes(task.id)) return false;
		ids.add(task.id);
	}
	for (const task of tasks) {
		if (task.dependsOn.some((dependencyId) => !ids.has(dependencyId))) return false;
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const visit = (taskId: string): boolean => {
		if (visiting.has(taskId)) return false;
		if (visited.has(taskId)) return true;
		visiting.add(taskId);
		const task = tasksById.get(taskId);
		for (const dependencyId of task?.dependsOn ?? []) {
			if (!visit(dependencyId)) return false;
		}
		visiting.delete(taskId);
		visited.add(taskId);
		return true;
	};
	return tasks.every((task) => visit(task.id));
}

function validateCampaignWithOptions(
	raw: unknown,
	options: { strictChildren: boolean }
): Campaign | null {
	if (!isRecord(raw)) return null;

	if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.title)) return null;

	const createdAt = normalizeTimestamp(raw.createdAt);
	const updatedAt = normalizeTimestamp(raw.updatedAt);
	if (createdAt === null || updatedAt === null) return null;

	const status = validateCampaignStatus(raw.status);
	if (!status) return null;

	const runIds = validateStringArray(raw.runIds);
	const tasks = validateCampaignTasks(raw.tasks, options);
	if (!runIds || !tasks || !hasValidTaskGraph(tasks)) return null;
	if (
		options.strictChildren &&
		(hasInvalidOptionalStrings(raw, ['objective']) ||
			hasInvalidOptionalSource(raw) ||
			hasInvalidOptionalMetadata(raw, ['metadata']))
	) {
		return null;
	}

	const campaign: Campaign = {
		id: raw.id,
		title: raw.title,
		createdAt,
		updatedAt,
		status,
		runIds,
		tasks,
	};

	assignOptionalCampaignString(campaign, 'objective', raw.objective);

	const source = validateSource(raw.source);
	if (source !== undefined) campaign.source = source;

	const metadata = validateMetadata(raw.metadata);
	if (metadata) campaign.metadata = metadata;

	return campaign;
}

export function validateCampaign(raw: unknown): Campaign | null {
	return validateCampaignWithOptions(raw, { strictChildren: false });
}

export function validateCampaignStrict(raw: unknown): Campaign | null {
	return validateCampaignWithOptions(raw, { strictChildren: true });
}

export function validateCampaignFile(raw: unknown): { campaigns: Campaign[] } {
	const campaignsRaw = isRecord(raw) ? raw.campaigns : undefined;
	if (!Array.isArray(campaignsRaw)) return { campaigns: [] };

	return {
		campaigns: campaignsRaw.flatMap((item) => {
			const campaign = validateCampaign(item);
			return campaign ? [campaign] : [];
		}),
	};
}

function makeEmptyStatusCounts(): CampaignTaskStatusCounts {
	return CAMPAIGN_TASK_STATUSES.reduce((counts, status) => {
		counts[status] = 0;
		return counts;
	}, {} as CampaignTaskStatusCounts);
}

export function getRunnableCampaignTasks(campaign: Campaign): CampaignTask[] {
	const tasksById = new Map(campaign.tasks.map((task) => [task.id, task]));

	return campaign.tasks.filter((task) => {
		if (task.status !== 'queued') return false;
		return task.dependsOn.every((dependencyId) => {
			const dependency = tasksById.get(dependencyId);
			return dependency ? READY_DEPENDENCY_STATUSES.has(dependency.status) : false;
		});
	});
}

export function summarizeCampaign(campaign: Campaign): CampaignSummary {
	const statusCounts = makeEmptyStatusCounts();
	for (const task of campaign.tasks) {
		statusCounts[task.status] += 1;
	}

	const summary: CampaignSummary = {
		id: campaign.id,
		title: campaign.title,
		status: campaign.status,
		createdAt: campaign.createdAt,
		updatedAt: campaign.updatedAt,
		runCount: campaign.runIds.length,
		totalTasks: campaign.tasks.length,
		runnableTaskIds: getRunnableCampaignTasks(campaign).map((task) => task.id),
		statusCounts,
	};

	if (campaign.objective !== undefined) summary.objective = campaign.objective;

	return summary;
}
