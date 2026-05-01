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

// Legacy fallback constants — kept only for the HumpfTech/Maestro repository
// when no projectGithubMap entry has been stored yet (defensive migration).
// All active code now uses the per-project coordinates injected at construction time.
// See: discoverGithubProject() in github-project-discovery.ts (#447).
const LEGACY_FALLBACK_OWNER = 'HumpfTech' as const;
const LEGACY_FALLBACK_PROJECT_NUMBER = 7 as const;
const LEGACY_FALLBACK_PROJECT_TITLE = 'Humpf Tech Maestro Features' as const;

type ProjectFieldName =
	| 'Maestro Major'
	| 'Work Item Type'
	| 'Parent Work Item'
	| 'External Mirror ID'
	| 'Agent Pickup'
	| 'AI Status'
	| 'AI Role'
	| 'AI Stage'
	| 'AI Priority'
	| 'AI Parent PRD'
	| 'AI Parent Epic'
	| 'AI Assigned Slot'
	| 'AI Last Heartbeat'
	| 'AI Project';

// Projects v2 custom fields that #430 requires to exist on every project before sync.
// Shape: name → array of option names (for single-select fields) or null (for text fields).
const REQUIRED_PROJECT_FIELDS: Record<string, string[] | null> = {
	'AI Status': [
		'Backlog',
		'Idea',
		'PRD Draft',
		'Refinement',
		'Tasks Ready',
		'In Progress',
		'In Review',
		'Blocked',
		'Done',
	],
	'AI Role': ['runner', 'fixer', 'reviewer', 'merger'],
	'AI Stage': ['prd', 'epic', 'task'],
	'AI Priority': ['P0', 'P1', 'P2', 'P3'],
	// New fields added in #438 (idempotent ensure-create)
	'AI Parent PRD': null, // Text field — work-item id or issue link
	'AI Parent Epic': null, // Text field — work-item id or issue link
	'AI Assigned Slot': null, // Text field — agent id
	'AI Last Heartbeat': null, // Text field — timestamp
	'AI Project': null, // Text field — project root path
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
	/** Per-project GitHub project coordinates (#447). Falls back to legacy HumpfTech values when omitted. */
	projectOwner?: string;
	projectNumber?: number;
	projectTitle?: string;
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
	/** Per-project GitHub project owner (#447). */
	private readonly projectOwner: string;
	/** Per-project GitHub project number (#447). */
	private readonly projectNumber: number;
	/** Per-project GitHub project title used for validation (#447). */
	private readonly projectTitle: string | undefined;

	constructor(options: DeliveryPlannerGithubSyncOptions = {}) {
		this.exec = options.exec ?? execFileNoThrow;
		this.cwd = options.cwd;
		this.projectOwner = options.projectOwner ?? LEGACY_FALLBACK_OWNER;
		this.projectNumber = options.projectNumber ?? LEGACY_FALLBACK_PROJECT_NUMBER;
		// Title is optional — only validated when provided.
		this.projectTitle = options.projectTitle ?? LEGACY_FALLBACK_PROJECT_TITLE;
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
	 * Update the Projects v2 AI Status field for a single work item by its project item ID.
	 * Used by pm:setStatus and pm:setBlocked IPC handlers (#430).
	 */
	async updateStatusField(
		projectId: string,
		projectItemId: string,
		statusValue: string
	): Promise<void> {
		const fields = await this.readProjectFields();
		await this.setProjectField(projectId, projectItemId, fields, 'AI Status', statusValue);
	}

	/**
	 * Update the Projects v2 AI Role field for a single work item by its project item ID.
	 * Used by pm:setRole IPC handler (#430).
	 */
	async updateRoleField(
		projectId: string,
		projectItemId: string,
		roleValue: string
	): Promise<void> {
		const fields = await this.readProjectFields();
		await this.setProjectField(projectId, projectItemId, fields, 'AI Role', roleValue);
	}

	/** Read the project and return its node ID. Used by pm-tools handlers. */
	async readProjectId(): Promise<string> {
		const project = await this.readProject();
		return project.id;
	}

	/**
	 * Public entry-point for /PM-init (#445).
	 *
	 * Idempotently ensures all REQUIRED_PROJECT_FIELDS exist on the project.
	 * Returns a structured report suitable for the pm:initRepo IPC response.
	 */
	async initProjectFields(): Promise<{ created: string[]; existing: string[]; errors: string[] }> {
		const created: string[] = [];
		const existing: string[] = [];
		const errors: string[] = [];

		const project = await this.readProject();
		const currentFields = await this.readProjectFields();
		const existingNames = new Set(currentFields.map((f) => f.name));

		for (const [fieldName, options] of Object.entries(REQUIRED_PROJECT_FIELDS)) {
			if (existingNames.has(fieldName)) {
				existing.push(fieldName);
				continue;
			}
			try {
				if (options !== null) {
					const singleSelectOptionsJson = JSON.stringify(
						options.map((name) => ({ name, color: 'GRAY', description: '' }))
					);
					const mutation = `mutation { createProjectV2Field(input: { projectId: "${project.id}", dataType: SINGLE_SELECT, name: "${fieldName}", singleSelectOptions: ${singleSelectOptionsJson} }) { projectV2Field { ... on ProjectV2SingleSelectField { id name } } } }`;
					await this.runGhGraphql(mutation);
				} else {
					const mutation = `mutation { createProjectV2Field(input: { projectId: "${project.id}", dataType: TEXT, name: "${fieldName}" }) { projectV2Field { ... on ProjectV2Field { id name } } } }`;
					await this.runGhGraphql(mutation);
				}
				created.push(fieldName);
			} catch (err) {
				errors.push(`${fieldName}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { created, existing, errors };
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

		// #430 — set the v2 custom fields (AI Status, AI Role, AI Stage, AI Priority).
		const statusValue = statusFieldForItem(item);
		if (statusValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'AI Status', statusValue);
		}
		const roleValue = roleFieldForItem(item);
		if (roleValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'AI Role', roleValue);
		}
		const stageValue = stageFieldForItem(item);
		if (stageValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'AI Stage', stageValue);
		}
		const priorityValue = priorityFieldForItem(item);
		if (priorityValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'AI Priority', priorityValue);
		}

		// #438 — populate new fields when available
		const parentPrdValue = parentPrdForProject(item);
		if (parentPrdValue) {
			await this.setProjectField(
				project.id,
				projectItemId,
				fields,
				'AI Parent PRD',
				parentPrdValue
			);
		}
		const parentEpicValue = parentEpicForProject(item);
		if (parentEpicValue) {
			await this.setProjectField(
				project.id,
				projectItemId,
				fields,
				'AI Parent Epic',
				parentEpicValue
			);
		}
		const assignedSlotValue = assignedSlotForProject(item);
		if (assignedSlotValue) {
			await this.setProjectField(
				project.id,
				projectItemId,
				fields,
				'AI Assigned Slot',
				assignedSlotValue
			);
		}
		const lastHeartbeatValue = lastHeartbeatForProject(item);
		if (lastHeartbeatValue) {
			await this.setProjectField(
				project.id,
				projectItemId,
				fields,
				'AI Last Heartbeat',
				lastHeartbeatValue
			);
		}
		const projectValue = projectForProject(item);
		if (projectValue) {
			await this.setProjectField(project.id, projectItemId, fields, 'AI Project', projectValue);
		}

		return projectItemId;
	}

	private async readProject(): Promise<GhProjectView> {
		const result = await this.runGh([
			'project',
			'view',
			String(this.projectNumber),
			'--owner',
			this.projectOwner,
			'--format',
			'json',
		]);
		const project = parseJson<GhProjectView>(result.stdout, 'GitHub project view response');
		if (this.projectTitle && project.title && project.title !== this.projectTitle) {
			throw new Error(
				`Unexpected GitHub project title "${project.title}"; expected "${this.projectTitle}"`
			);
		}
		return project;
	}

	private async readProjectFields(): Promise<GhProjectField[]> {
		const result = await this.runGh([
			'project',
			'field-list',
			String(this.projectNumber),
			'--owner',
			this.projectOwner,
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
			String(this.projectNumber),
			'--owner',
			this.projectOwner,
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
	 * Detect legacy status labels on an issue, copy the state into the Projects v2 AI Status
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

		// Update the Projects v2 AI Status field with the mapped value.
		const fields = await this.readProjectFields();
		await this.setProjectField(projectId, projectItemId, fields, 'AI Status', mappedStatus);

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
	// Accept any GitHub issues URL: github.com/<owner>/<repo>/issues/<number>
	const match = url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)$/);
	if (!match) {
		throw new Error('GitHub issue create response did not include a valid GitHub issue URL');
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

/**
 * Maps WorkItem parentPrdId to the Projects v2 AI Parent PRD field value (#438).
 * Returns work-item id or empty string.
 */
function parentPrdForProject(item: WorkItem): string {
	return (typeof item.metadata?.parentPrdId === 'string' ? item.metadata.parentPrdId : '') ?? '';
}

/**
 * Maps WorkItem parentEpicId to the Projects v2 AI Parent Epic field value (#438).
 * Returns work-item id or empty string.
 */
function parentEpicForProject(item: WorkItem): string {
	return (typeof item.metadata?.parentEpicId === 'string' ? item.metadata.parentEpicId : '') ?? '';
}

/**
 * Maps WorkItem assignedSlot to the Projects v2 AI Assigned Slot field value (#438).
 * Returns agent id or empty string.
 */
function assignedSlotForProject(item: WorkItem): string {
	return (typeof item.metadata?.assignedSlot === 'string' ? item.metadata.assignedSlot : '') ?? '';
}

/**
 * Maps WorkItem claim.lastHeartbeat to the Projects v2 AI Last Heartbeat field value (#438).
 * Returns timestamp or empty string. Note: lastHeartbeat field may not yet exist on WorkItemClaim.
 * This function is future-proof for when heartbeat machinery is implemented.
 */
function lastHeartbeatForProject(item: WorkItem): string {
	// Check metadata as a fallback since lastHeartbeat may not be on the claim yet
	const heartbeat =
		typeof item.metadata?.lastHeartbeat === 'string'
			? item.metadata.lastHeartbeat
			: (item.claim as any)?.lastHeartbeat;
	return (typeof heartbeat === 'string' ? heartbeat : '') ?? '';
}

/**
 * Maps WorkItem projectPath to the Projects v2 AI Project field value (#438).
 * Returns project root path or empty string.
 */
function projectForProject(item: WorkItem): string {
	return item.projectPath ?? '';
}
