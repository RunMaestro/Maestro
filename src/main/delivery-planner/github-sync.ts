import type { ExecResult } from '../utils/execFile';
import { execFileNoThrow } from '../utils/execFile';
import type {
	WorkItem,
	WorkItemGithubReference,
	WorkItemStatus,
} from '../../shared/work-graph-types';
import { assertForkRepository } from '../../shared/fork-only-github';
import {
	DELIVERY_PLANNER_GITHUB_REPOSITORY,
	assertDeliveryPlannerGithubReference,
	assertDeliveryPlannerGithubRepository,
	makeDeliveryPlannerGithubReference,
} from './github-safety';

export const DELIVERY_PLANNER_GITHUB_PROJECT_OWNER = 'HumpfTech' as const;
export const DELIVERY_PLANNER_GITHUB_PROJECT_NUMBER = 7 as const;
export const DELIVERY_PLANNER_GITHUB_PROJECT_TITLE = 'Humpf Tech Maestro Features' as const;

type ProjectFieldName =
	| 'Maestro Major'
	| 'Work Item Type'
	| 'Parent Work Item'
	| 'External Mirror ID'
	| 'Agent Pickup'
	| 'Status'
	| 'Role'
	| 'Stage'
	| 'Priority';

// Projects v2 custom fields that #430 requires to exist on every project before sync.
// Shape: name → array of option names (for single-select fields) or null (for text fields).
const REQUIRED_PROJECT_FIELDS: Record<string, string[] | null> = {
	Status: [
		'Idea',
		'PRD Draft',
		'Refinement',
		'Tasks Ready',
		'In Progress',
		'In Review',
		'Blocked',
		'Done',
	],
	Role: ['runner', 'fixer', 'reviewer', 'merger'],
	Stage: ['prd', 'epic', 'task'],
	Priority: ['P0', 'P1', 'P2', 'P3'],
	// 'External Mirror ID' is a text field — it may already exist (per #411); null signals text type.
	'External Mirror ID': null,
};

// Label names that carried status before #430. Migration copies them to the Status field and removes them.
const LEGACY_STATUS_LABELS: Record<string, string> = {
	'status:idea': 'Idea',
	'status:prd-draft': 'PRD Draft',
	'status:refinement': 'Refinement',
	'status:tasks-ready': 'Tasks Ready',
	'status:in-progress': 'In Progress',
	'status:in-review': 'In Review',
	'status:blocked': 'Blocked',
	'status:done': 'Done',
};

const CLOSED_STATUSES: WorkItemStatus[] = ['done', 'canceled'];
const OPEN_STATUSES: WorkItemStatus[] = [
	'discovered',
	'planned',
	'ready',
	'claimed',
	'in_progress',
	'blocked',
	'review',
];

export type DeliveryPlannerGithubSyncMode = 'issue' | 'progress-comment' | 'status' | 'bug';

export interface DeliveryPlannerGithubExec {
	(command: string, args: string[], cwd?: string): Promise<ExecResult>;
}

export interface DeliveryPlannerGithubSyncOptions {
	exec?: DeliveryPlannerGithubExec;
	cwd?: string;
}

export interface DeliveryPlannerGithubSyncResult {
	item: WorkItem;
	github: WorkItemGithubReference;
	created: boolean;
	projectItemId?: string;
}

interface GhIssueCreateResult {
	number: number;
	url: string;
}

interface GhProjectView {
	id: string;
	title?: string;
}

interface GhProjectField {
	id: string;
	name: string;
	dataType?: string;
	options?: Array<{ id: string; name: string }>;
}

interface GhProjectItemAddResult {
	id?: string;
	item?: { id?: string };
}

interface GhIssueLabels {
	labels: Array<{ name: string }>;
}

export class DeliveryPlannerGithubSync {
	private readonly exec: DeliveryPlannerGithubExec;
	private readonly cwd?: string;

	constructor(options: DeliveryPlannerGithubSyncOptions = {}) {
		this.exec = options.exec ?? execFileNoThrow;
		this.cwd = options.cwd;
	}

	async syncIssue(item: WorkItem): Promise<DeliveryPlannerGithubSyncResult> {
		assertDeliveryPlannerGithubReference(item.github);

		const existing = item.github?.issueNumber
			? await this.requireIssueReference(item.github)
			: undefined;
		const github = existing ?? (await this.createIssue(item));
		const projectItemId = await this.syncProjectFields(item, github);

		return {
			item,
			github,
			created: existing === undefined,
			projectItemId,
		};
	}

	async addProgressComment(item: WorkItem, body: string): Promise<void> {
		const issueNumber = requireIssueNumber(item.github);
		await this.runGh([
			'issue',
			'comment',
			String(issueNumber),
			'-R',
			DELIVERY_PLANNER_GITHUB_REPOSITORY,
			'--body',
			body,
		]);
	}

	async syncStatus(item: WorkItem): Promise<void> {
		const issueNumber = requireIssueNumber(item.github);
		if (CLOSED_STATUSES.includes(item.status)) {
			await this.runGh([
				'issue',
				'close',
				String(issueNumber),
				'-R',
				DELIVERY_PLANNER_GITHUB_REPOSITORY,
				'--comment',
				`Delivery Planner marked this work item ${item.status}.`,
			]);
			return;
		}

		if (OPEN_STATUSES.includes(item.status)) {
			await this.runGh([
				'issue',
				'reopen',
				String(issueNumber),
				'-R',
				DELIVERY_PLANNER_GITHUB_REPOSITORY,
			]);
		}
	}

	/**
	 * Update the Projects v2 Status field for a single work item by its project item ID.
	 * Used by pm:setStatus and pm:setBlocked IPC handlers (#430).
	 */
	async updateStatusField(
		projectId: string,
		projectItemId: string,
		statusValue: string
	): Promise<void> {
		const fields = await this.readProjectFields();
		await this.setProjectField(projectId, projectItemId, fields, 'Status', statusValue);
	}

	/**
	 * Update the Projects v2 Role field for a single work item by its project item ID.
	 * Used by pm:setRole IPC handler (#430).
	 */
	async updateRoleField(
		projectId: string,
		projectItemId: string,
		roleValue: string
	): Promise<void> {
		const fields = await this.readProjectFields();
		await this.setProjectField(projectId, projectItemId, fields, 'Role', roleValue);
	}

	/** Read the project and return its node ID. Used by pm-tools handlers. */
	async readProjectId(): Promise<string> {
		const project = await this.readProject();
		return project.id;
	}

	async createLinkedBugIssue(input: {
		bug: WorkItem;
		related?: WorkItem;
	}): Promise<WorkItemGithubReference> {
		assertDeliveryPlannerGithubReference(input.bug.github);
		assertDeliveryPlannerGithubReference(input.related?.github);

		const body = renderIssueBody(input.bug, {
			linkedIssueNumber: input.related?.github?.issueNumber,
			linkedWorkItemId: input.related?.id,
		});
		const issue = await this.createIssue(input.bug, body, ['bug-follow-up']);
		if (input.related?.github?.issueNumber) {
			await this.addProgressComment(
				input.related,
				`Bug follow-up created: ${issue.url} (${input.bug.id}).`
			);
		}

		return issue;
	}

	private async createIssue(
		item: WorkItem,
		body = renderIssueBody(item),
		extraLabels: string[] = []
	): Promise<WorkItemGithubReference> {
		const labels = routingLabelsForItem(item, extraLabels);
		const result = await this.runGh([
			'issue',
			'create',
			'-R',
			DELIVERY_PLANNER_GITHUB_REPOSITORY,
			'--title',
			item.title,
			'--body',
			body,
			...labels.flatMap((label) => ['--label', label]),
		]);
		const url = result.stdout.trim();
		const number = parseIssueNumberFromUrl(url);

		return makeDeliveryPlannerGithubReference({
			issueNumber: number,
			url,
		});
	}

	private async requireIssueReference(
		reference: WorkItemGithubReference
	): Promise<WorkItemGithubReference> {
		assertDeliveryPlannerGithubReference(reference);
		const issueNumber = requireIssueNumber(reference);
		const result = await this.runGh([
			'issue',
			'view',
			String(issueNumber),
			'-R',
			DELIVERY_PLANNER_GITHUB_REPOSITORY,
			'--json',
			'number,url',
		]);
		const issue = parseJson<GhIssueCreateResult>(result.stdout, 'GitHub issue view response');

		return makeDeliveryPlannerGithubReference({
			issueNumber: issue.number,
			url: issue.url,
			branch: reference.branch,
			commitSha: reference.commitSha,
			pullRequestNumber: reference.pullRequestNumber,
		});
	}

	private async syncProjectFields(
		item: WorkItem,
		github: WorkItemGithubReference
	): Promise<string | undefined> {
		if (!github.url) {
			return undefined;
		}

		const project = await this.readProject();

		// Idempotently create the five #430 custom fields if they don't yet exist.
		await this.ensureProjectFields(project.id);

		const projectItemId = await this.addIssueToProject(github.url);
		if (!projectItemId) {
			return undefined;
		}

		// Migrate any legacy status labels before we set the authoritative field value.
		if (github.issueNumber) {
			await this.migrateStatusLabels(github.issueNumber, project.id, projectItemId);
		}

		const fields = await this.readProjectFields();
		await this.setProjectField(
			project.id,
			projectItemId,
			fields,
			'Maestro Major',
			majorForItem(item)
		);
		await this.setProjectField(
			project.id,
			projectItemId,
			fields,
			'Work Item Type',
			workItemTypeForProject(item)
		);
		await this.setProjectField(
			project.id,
			projectItemId,
			fields,
			'Parent Work Item',
			parentForProject(item)
		);
		await this.setProjectField(
			project.id,
			projectItemId,
			fields,
			'External Mirror ID',
			externalMirrorIdForProject(item)
		);
		await this.setProjectField(
			project.id,
			projectItemId,
			fields,
			'Agent Pickup',
			agentPickupForProject(item)
		);

		// #430 — set the five new v2 custom fields (Status, Role, Stage, Priority).
		const statusValue = statusFieldForItem(item);
		if (statusValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'Status', statusValue);
		}
		const roleValue = roleFieldForItem(item);
		if (roleValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'Role', roleValue);
		}
		const stageValue = stageFieldForItem(item);
		if (stageValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'Stage', stageValue);
		}
		const priorityValue = priorityFieldForItem(item);
		if (priorityValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'Priority', priorityValue);
		}

		return projectItemId;
	}

	private async readProject(): Promise<GhProjectView> {
		const result = await this.runGh([
			'project',
			'view',
			String(DELIVERY_PLANNER_GITHUB_PROJECT_NUMBER),
			'--owner',
			DELIVERY_PLANNER_GITHUB_PROJECT_OWNER,
			'--format',
			'json',
		]);
		const project = parseJson<GhProjectView>(result.stdout, 'GitHub project view response');
		if (project.title && project.title !== DELIVERY_PLANNER_GITHUB_PROJECT_TITLE) {
			throw new Error(
				`Unexpected GitHub project title "${project.title}"; expected "${DELIVERY_PLANNER_GITHUB_PROJECT_TITLE}"`
			);
		}
		return project;
	}

	private async readProjectFields(): Promise<GhProjectField[]> {
		const result = await this.runGh([
			'project',
			'field-list',
			String(DELIVERY_PLANNER_GITHUB_PROJECT_NUMBER),
			'--owner',
			DELIVERY_PLANNER_GITHUB_PROJECT_OWNER,
			'--format',
			'json',
		]);
		const parsed = parseJson<{ fields?: GhProjectField[] } | GhProjectField[]>(
			result.stdout,
			'GitHub project field-list response'
		);
		return Array.isArray(parsed) ? parsed : (parsed.fields ?? []);
	}

	private async addIssueToProject(url: string): Promise<string | undefined> {
		const result = await this.runGh([
			'project',
			'item-add',
			String(DELIVERY_PLANNER_GITHUB_PROJECT_NUMBER),
			'--owner',
			DELIVERY_PLANNER_GITHUB_PROJECT_OWNER,
			'--url',
			url,
			'--format',
			'json',
		]);
		const parsed = parseJson<GhProjectItemAddResult>(
			result.stdout,
			'GitHub project item-add response'
		);
		return parsed.id ?? parsed.item?.id;
	}

	private async setProjectField(
		projectId: string,
		itemId: string,
		fields: GhProjectField[],
		fieldName: ProjectFieldName,
		value: string
	): Promise<void> {
		if (!value) {
			return;
		}

		const field = fields.find((candidate) => candidate.name === fieldName);
		if (!field) {
			throw new Error(`GitHub project field "${fieldName}" was not found`);
		}

		const args = [
			'project',
			'item-edit',
			'--project-id',
			projectId,
			'--id',
			itemId,
			'--field-id',
			field.id,
		];
		const option = field.options?.find((candidate) => candidate.name === value);
		if (option) {
			await this.runGh([...args, '--single-select-option-id', option.id]);
			return;
		}

		await this.runGh([...args, '--text', value]);
	}

	/**
	 * Idempotently create the Projects v2 custom fields required by #430.
	 * Uses `gh api graphql` — skips any field that already exists by name.
	 *
	 * GraphQL mutation: createProjectV2Field
	 *   input: { projectId, dataType: SINGLE_SELECT | TEXT, name, singleSelectOptions? }
	 */
	private async ensureProjectFields(projectId: string): Promise<void> {
		const existing = await this.readProjectFields();
		const existingNames = new Set(existing.map((f) => f.name));

		for (const [fieldName, options] of Object.entries(REQUIRED_PROJECT_FIELDS)) {
			if (existingNames.has(fieldName)) {
				// Already exists — idempotent, skip.
				continue;
			}

			if (options !== null) {
				// Single-select field with named options.
				const singleSelectOptionsJson = JSON.stringify(
					options.map((name) => ({ name, color: 'GRAY', description: '' }))
				);
				const mutation = `mutation { createProjectV2Field(input: { projectId: "${projectId}", dataType: SINGLE_SELECT, name: "${fieldName}", singleSelectOptions: ${singleSelectOptionsJson} }) { projectV2Field { ... on ProjectV2SingleSelectField { id name } } } }`;
				await this.runGhGraphql(mutation);
			} else {
				// Text field.
				const mutation = `mutation { createProjectV2Field(input: { projectId: "${projectId}", dataType: TEXT, name: "${fieldName}" }) { projectV2Field { ... on ProjectV2Field { id name } } } }`;
				await this.runGhGraphql(mutation);
			}
		}
	}

	/**
	 * Detect legacy status labels on an issue, copy the state into the Projects v2 Status
	 * field, then remove only those state labels (user labels are untouched).
	 *
	 * GraphQL mutation used for field update:
	 *   updateProjectV2ItemFieldValue(input: { projectId, itemId, fieldId, value: { singleSelectOptionId } })
	 *   (executed via gh project item-edit --single-select-option-id, not raw GraphQL)
	 */
	private async migrateStatusLabels(
		issueNumber: number,
		projectId: string,
		projectItemId: string
	): Promise<void> {
		// Read current labels from the issue.
		const result = await this.runGh([
			'issue',
			'view',
			String(issueNumber),
			'-R',
			DELIVERY_PLANNER_GITHUB_REPOSITORY,
			'--json',
			'labels',
		]);
		const parsed = parseJson<GhIssueLabels>(result.stdout, 'GitHub issue labels response');
		const labelNames = parsed.labels.map((l) => l.name);

		const legacyMatches = labelNames.filter((l) => l in LEGACY_STATUS_LABELS);
		if (legacyMatches.length === 0) {
			return;
		}

		// Use the first matching label as the canonical status to migrate.
		const mappedStatus = LEGACY_STATUS_LABELS[legacyMatches[0]];

		// Update the Projects v2 Status field with the mapped value.
		const fields = await this.readProjectFields();
		await this.setProjectField(projectId, projectItemId, fields, 'Status', mappedStatus);

		// Remove legacy status labels (not user labels).
		for (const labelName of legacyMatches) {
			await this.runGh([
				'issue',
				'edit',
				String(issueNumber),
				'-R',
				DELIVERY_PLANNER_GITHUB_REPOSITORY,
				'--remove-label',
				labelName,
			]).catch(() => {
				// Best-effort: label may have already been removed.
			});
		}
	}

	private async runGh(args: string[]): Promise<ExecResult> {
		const repoIndex = args.indexOf('-R');
		if (repoIndex !== -1) {
			// Shared fork-only guard — prevents any GitHub write to RunMaestro/Maestro
			// or any non-fork repository across all sub-systems (Cross-Major 006).
			assertForkRepository(args[repoIndex + 1]);
			// Delivery-Planner-specific guard with richer error context.
			assertDeliveryPlannerGithubRepository(args[repoIndex + 1]);
		}

		const result = await this.exec('gh', args, this.cwd);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`);
		}
		return result;
	}

	/**
	 * Execute an arbitrary GraphQL mutation via `gh api graphql -f query=<mutation>`.
	 * Does NOT route through the -R flag guard (project mutations use projectId, not repo slug).
	 */
	private async runGhGraphql(query: string): Promise<ExecResult> {
		const result = await this.exec('gh', ['api', 'graphql', '-f', `query=${query}`], this.cwd);
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || 'gh api graphql failed');
		}
		return result;
	}
}

function requireIssueNumber(reference: WorkItemGithubReference | undefined): number {
	assertDeliveryPlannerGithubReference(reference);
	if (!reference?.issueNumber) {
		throw new Error('Work item must be synced to a GitHub issue first');
	}

	return reference.issueNumber;
}

function parseJson<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`${label} was not valid JSON`);
	}
}

function parseIssueNumberFromUrl(url: string): number {
	const match = url.match(/github\.com\/HumpfTech\/Maestro\/issues\/(\d+)$/);
	if (!match) {
		throw new Error('GitHub issue create response did not include a fork issue URL');
	}

	return Number(match[1]);
}

function routingLabelsForItem(item: WorkItem, extraLabels: string[]): string[] {
	return [
		'delivery-planner',
		...item.tags.filter((tag) => ['external-mirror', 'symphony', 'agent-ready'].includes(tag)),
		...extraLabels,
	];
}

function renderIssueBody(
	item: WorkItem,
	options: { linkedIssueNumber?: number; linkedWorkItemId?: string } = {}
): string {
	const lines = [
		item.description?.trim() || `Delivery Planner work item ${item.id}.`,
		'',
		'---',
		`Work Graph item: ${item.id}`,
		`External Mirror ID: ${externalMirrorIdForProject(item)}`,
		`Work Item Type: ${workItemTypeForProject(item)}`,
	];
	if (options.linkedIssueNumber) {
		lines.push(`Linked issue: #${options.linkedIssueNumber}`);
	}
	if (options.linkedWorkItemId) {
		lines.push(`Linked Work Graph item: ${options.linkedWorkItemId}`);
	}

	return lines.join('\n');
}

function majorForItem(item: WorkItem): string {
	const metadataMajor = item.metadata?.maestroMajor;
	if (typeof metadataMajor === 'string' && metadataMajor.trim()) {
		return metadataMajor.trim();
	}

	return item.tags.includes('delivery-planner') ? 'Delivery Planner' : 'Maestro';
}

function workItemTypeForProject(item: WorkItem): string {
	const kind = item.metadata?.kind;
	if (kind === 'prd' || kind === 'epic' || kind === 'task' || kind === 'bug-follow-up') {
		return kind === 'bug-follow-up' ? 'Bug' : capitalize(kind);
	}

	return capitalize(item.type);
}

function parentForProject(item: WorkItem): string {
	const parent =
		item.parentWorkItemId ??
		(typeof item.metadata?.parentWorkItemId === 'string'
			? item.metadata.parentWorkItemId
			: undefined) ??
		(typeof item.metadata?.prdWorkItemId === 'string' ? item.metadata.prdWorkItemId : undefined) ??
		(typeof item.metadata?.relatedWorkItemId === 'string'
			? item.metadata.relatedWorkItemId
			: undefined);
	return parent ?? '';
}

function externalMirrorIdForProject(item: WorkItem): string {
	const taskId = item.metadata?.mirrorTaskId;
	const bugId = item.metadata?.mirrorBugId;
	const slug = item.metadata?.mirrorSlug;
	if (bugId !== undefined) {
		return `${slug ?? item.id}#bug-${bugId}`;
	}
	if (taskId !== undefined) {
		return `${slug ?? item.id}#task-${taskId}`;
	}
	return typeof slug === 'string' && slug.trim() ? slug : item.id;
}

function agentPickupForProject(item: WorkItem): string {
	if (item.claim) {
		return item.claim.status === 'active' ? 'Claimed' : capitalize(item.claim.status);
	}
	if (item.tags.includes('agent-ready') || item.status === 'ready') {
		return 'Ready';
	}
	return 'Not Ready';
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ');
}

/**
 * Maps a WorkItem status to the Projects v2 Status field value (#430).
 * Returns empty string when no mapping exists (field update will be skipped).
 */
function statusFieldForItem(item: WorkItem): string {
	const map: Partial<Record<WorkItemStatus, string>> = {
		discovered: 'Idea',
		planned: 'PRD Draft',
		ready: 'Tasks Ready',
		claimed: 'In Progress',
		in_progress: 'In Progress',
		blocked: 'Blocked',
		review: 'In Review',
		done: 'Done',
	};
	return map[item.status] ?? '';
}

/**
 * Maps WorkItem pipeline role to the Projects v2 Role field value (#430).
 */
function roleFieldForItem(item: WorkItem): string {
	return item.pipeline?.currentRole ?? '';
}

/**
 * Maps WorkItem metadata kind to the Projects v2 Stage field value (#430).
 */
function stageFieldForItem(item: WorkItem): string {
	const kind = item.metadata?.kind;
	if (kind === 'prd') return 'prd';
	if (kind === 'epic') return 'epic';
	if (kind === 'task') return 'task';
	return '';
}

/**
 * Maps WorkItem priority number to the Projects v2 Priority field value (#430).
 * Maestro uses 0–3 matching P0–P3.
 */
function priorityFieldForItem(item: WorkItem): string {
	if (typeof item.priority !== 'number') return '';
	const labels: Record<number, string> = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };
	return labels[item.priority] ?? '';
}
