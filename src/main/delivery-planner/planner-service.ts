import crypto from 'crypto';

import type {
	WorkGraphActor,
	WorkGraphListResult,
	WorkGraphBroadcastOperation,
	WorkItem,
	WorkItemCreateInput,
	WorkItemDependency,
	WorkItemFilters,
	WorkItemStatus,
	WorkItemUpdateInput,
	WorkItemGithubReference,
} from '../../shared/work-graph-types';
import { WORK_GRAPH_READY_TAG } from '../../shared/work-graph-types';
import { listDeliveryPlannerDashboard, type DeliveryPlannerDashboard } from './dashboard-queries';
import type { DeliveryPlannerDecomposer } from './decomposer';
import { slugifyMirrorSegment } from './path-resolver';
import {
	InMemoryDeliveryPlannerProgressStore,
	type DeliveryPlannerProgressSnapshot,
	type DeliveryPlannerProgressStore,
} from './progress';

export type DeliveryPlannerErrorKind = 'validation' | 'github' | 'mirror-conflict' | 'work-graph';

export class DeliveryPlannerError extends Error {
	constructor(
		public readonly kind: DeliveryPlannerErrorKind,
		message: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'DeliveryPlannerError';
	}
}

export class DeliveryPlannerValidationError extends DeliveryPlannerError {
	constructor(message: string) {
		super('validation', message);
		this.name = 'DeliveryPlannerValidationError';
	}
}

export class DeliveryPlannerGithubError extends DeliveryPlannerError {
	constructor(message: string, cause?: unknown) {
		super('github', message, cause);
		this.name = 'DeliveryPlannerGithubError';
	}
}

export class DeliveryPlannerMirrorConflictError extends DeliveryPlannerError {
	constructor(message: string, cause?: unknown) {
		super('mirror-conflict', message, cause);
		this.name = 'DeliveryPlannerMirrorConflictError';
	}
}

export class DeliveryPlannerWorkGraphError extends DeliveryPlannerError {
	constructor(message: string, cause?: unknown) {
		super('work-graph', message, cause);
		this.name = 'DeliveryPlannerWorkGraphError';
	}
}

export interface DeliveryPlannerWorkGraphStore {
	createItem(input: WorkItemCreateInput, actor?: WorkGraphActor): Promise<WorkItem>;
	updateItem(input: WorkItemUpdateInput): Promise<WorkItem>;
	getItem(id: string): Promise<WorkItem | undefined>;
	listItems(filters?: WorkItemFilters): Promise<WorkGraphListResult>;
	addDependency?(
		dependency: Omit<WorkItemDependency, 'id' | 'createdAt'>
	): Promise<WorkItemDependency>;
}

export interface DeliveryPlannerEventBus {
	publish(operation: WorkGraphBroadcastOperation, payload: unknown): void | Promise<void>;
}

export interface DeliveryPlannerExternalMirror {
	syncPrd?(
		item: WorkItem,
		operation: DeliveryPlannerProgressSnapshot
	): Promise<{ mirrorHash?: string }>;
	syncEpic?(
		item: WorkItem,
		operation: DeliveryPlannerProgressSnapshot
	): Promise<{ mirrorHash?: string }>;
	syncTask?(
		item: WorkItem,
		operation: DeliveryPlannerProgressSnapshot
	): Promise<{ mirrorHash?: string }>;
}

export interface DeliveryPlannerGithubSyncAdapter {
	syncIssue(item: WorkItem): Promise<{ github: WorkItemGithubReference; created: boolean }>;
	syncStatus?(item: WorkItem): Promise<void>;
	addProgressComment?(item: WorkItem, body: string): Promise<void>;
	createLinkedBugIssue?(input: {
		bug: WorkItem;
		related?: WorkItem;
	}): Promise<WorkItemGithubReference>;
}

export interface CreatePrdInput {
	title: string;
	description?: string;
	projectPath: string;
	gitPath: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
	actor?: WorkGraphActor;
}

export interface UpdatePrdInput {
	id: string;
	title: string;
	description?: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
	actor?: WorkGraphActor;
}

export interface ConvertPrdToEpicInput {
	prdId: string;
	title?: string;
	description?: string;
	actor?: WorkGraphActor;
}

export interface DecomposeEpicInput {
	epicId: string;
	actor?: WorkGraphActor;
}

export interface DecomposeEpicResult {
	operation: DeliveryPlannerProgressSnapshot;
	tasks: WorkItem[];
}

export interface DependencyReadiness {
	workItemId: string;
	ready: boolean;
	blockingDependencyIds: string[];
	resolvedDependencyIds: string[];
}

export interface DeliveryPlannerServiceOptions {
	workGraph: DeliveryPlannerWorkGraphStore;
	events?: DeliveryPlannerEventBus;
	decomposer?: DeliveryPlannerDecomposer;
	progress?: DeliveryPlannerProgressStore;
	externalMirror?: DeliveryPlannerExternalMirror;
	githubSync?: DeliveryPlannerGithubSyncAdapter;
}

const COMPLETED_STATUSES: WorkItemStatus[] = ['done', 'canceled'];

export class DeliveryPlannerService {
	private readonly workGraph: DeliveryPlannerWorkGraphStore;
	private readonly events?: DeliveryPlannerEventBus;
	private readonly decomposer?: DeliveryPlannerDecomposer;
	private readonly progress: DeliveryPlannerProgressStore;
	private readonly externalMirror?: DeliveryPlannerExternalMirror;
	private readonly githubSync?: DeliveryPlannerGithubSyncAdapter;

	constructor(options: DeliveryPlannerServiceOptions) {
		this.workGraph = options.workGraph;
		this.events = options.events;
		this.decomposer = options.decomposer;
		this.progress = options.progress ?? new InMemoryDeliveryPlannerProgressStore();
		this.externalMirror = options.externalMirror;
		this.githubSync = options.githubSync;
	}

	async createPrd(input: CreatePrdInput): Promise<WorkItem> {
		validateRequired(input.title, 'PRD title');
		validateRequired(input.projectPath, 'project path');
		validateRequired(input.gitPath, 'git path');

		const item = await this.createWorkItem(
			{
				type: 'document',
				status: 'planned',
				title: input.title.trim(),
				description: input.description,
				projectPath: input.projectPath,
				gitPath: input.gitPath,
				source: 'delivery-planner',
				readonly: false,
				tags: uniqueTags(['delivery-planner', 'prd', ...(input.tags ?? [])]),
				metadata: {
					...(input.metadata ?? {}),
					kind: 'prd',
					mirrorSlug:
						typeof input.metadata?.mirrorSlug === 'string' && input.metadata.mirrorSlug.trim()
							? input.metadata.mirrorSlug
							: slugifyMirrorSegment(input.title),
				},
			},
			input.actor
		);

		return this.syncMirror(item, 'prd');
	}

	async updatePrd(input: UpdatePrdInput): Promise<WorkItem> {
		validateRequired(input.id, 'PRD work item id');
		validateRequired(input.title, 'PRD title');

		const existing = await this.requireItem(input.id);
		if (existing.metadata?.kind !== 'prd') {
			throw new DeliveryPlannerValidationError('Only PRD work items can be edited');
		}

		const item = await this.updateWorkItem({
			id: input.id,
			patch: {
				title: input.title.trim(),
				description: input.description,
				tags: uniqueTags(['delivery-planner', 'prd', ...(input.tags ?? [])]),
				metadata: { ...existing.metadata, ...(input.metadata ?? {}), kind: 'prd' },
			},
			actor: input.actor,
		});

		return this.syncMirror(item, 'prd');
	}

	async convertPrdToEpic(input: ConvertPrdToEpicInput): Promise<WorkItem> {
		const prd = await this.requireItem(input.prdId);
		if (prd.metadata?.kind !== 'prd') {
			throw new DeliveryPlannerValidationError('Only PRD work items can be converted to epics');
		}

		const epic = await this.createWorkItem(
			{
				type: 'feature',
				status: 'planned',
				title: input.title?.trim() || prd.title,
				description: renderEpicDescription({
					title: input.title?.trim() || prd.title,
					description: input.description ?? prd.description,
				}),
				projectPath: prd.projectPath,
				gitPath: prd.gitPath,
				source: 'delivery-planner',
				readonly: false,
				tags: uniqueTags(['delivery-planner', 'epic', ...prd.tags.filter((tag) => tag !== 'prd')]),
				metadata: {
					kind: 'epic',
					prdWorkItemId: prd.id,
					mirrorSlug: slugifyMirrorSegment(input.title?.trim() || prd.title),
				},
			},
			input.actor
		);

		return this.syncMirror(epic, 'epic');
	}

	async decomposeEpicToTasks(input: DecomposeEpicInput): Promise<DecomposeEpicResult> {
		if (!this.decomposer) {
			throw new DeliveryPlannerValidationError(
				'Delivery Planner decomposition gateway is not configured'
			);
		}

		const epic = await this.requireItem(input.epicId);
		if (epic.metadata?.kind !== 'epic') {
			throw new DeliveryPlannerValidationError('Only epic work items can be decomposed to tasks');
		}

		const operation = this.progress.start('decomposition', { epicId: epic.id }, 3);
		try {
			this.progress.update(operation.id, { message: 'Drafting tasks', completedSteps: 1 });
			const drafts = await this.decomposer.draftTasks({
				epicTitle: epic.title,
				epicDescription: epic.description,
				projectPath: epic.projectPath,
				gitPath: epic.gitPath,
				parentWorkItemId: epic.id,
			});
			const dependencyPreview = drafts.map((draft) => ({
				title: draft.title,
				dependsOnTaskTitles: draft.metadata?.dependsOnTaskTitles ?? [],
				filesLikelyTouched: draft.metadata?.filesLikelyTouched ?? [],
				parallel: draft.metadata?.parallel ?? true,
			}));

			this.progress.update(operation.id, {
				message: 'Persisting decomposed tasks',
				completedSteps: 2,
				totalSteps: drafts.length + 2,
				metadata: { epicId: epic.id, dependencyPreview },
			});

			const created: WorkItem[] = [];
			for (const draft of drafts) {
				const task = await this.createWorkItem(
					{
						...draft,
						metadata: {
							...(draft.metadata ?? {}),
							prdWorkItemId:
								typeof epic.metadata?.prdWorkItemId === 'string'
									? epic.metadata.prdWorkItemId
									: undefined,
							epicWorkItemId: epic.id,
						},
					},
					input.actor
				);
				created.push(task);
				this.progress.update(operation.id, {
					completedSteps: created.length + 2,
					message: `Persisted ${created.length} of ${drafts.length} tasks`,
				});
			}

			await this.createDraftDependencies(created, input.actor);
			const syncedTasks: WorkItem[] = [];
			for (const task of created) {
				const taskWithDependencies = await this.requireItem(task.id);
				syncedTasks.push(await this.syncMirror(taskWithDependencies, 'task'));
			}
			const completedOperation = this.progress.complete(
				operation.id,
				'Epic decomposition completed'
			);
			return { operation: completedOperation, tasks: syncedTasks };
		} catch (error) {
			this.progress.fail(operation.id, error instanceof Error ? error : String(error), true);
			throw normalizePlannerError(error);
		}
	}

	async listDashboard(
		filters: { projectPath?: string; gitPath?: string } = {}
	): Promise<DeliveryPlannerDashboard> {
		return listDeliveryPlannerDashboard(this.workGraph, filters);
	}

	async syncExternalMirror(id: string): Promise<WorkItem> {
		const item = await this.requireItem(id);
		return this.syncMirror(item, inferPlannerItemKind(item));
	}

	async syncGithubIssue(id: string): Promise<WorkItem> {
		const item = await this.requireItem(id);
		return this.syncGithub(item);
	}

	async updateStatus(
		id: string,
		status: WorkItemStatus,
		actor?: WorkGraphActor
	): Promise<WorkItem> {
		const item = await this.updateWorkItem({
			id,
			patch: {
				status,
				completedAt: COMPLETED_STATUSES.includes(status) ? new Date().toISOString() : undefined,
			},
			actor,
		});

		await this.events?.publish('workGraph.item.statusChanged', { item });
		if (this.githubSync?.syncStatus && item.github?.issueNumber) {
			await this.githubSync.syncStatus(item);
		}
		await this.refreshAgentReadyTags(item.projectPath, item.gitPath, actor);
		return item;
	}

	async addProgressComment(
		id: string,
		body: string,
		actor?: WorkGraphActor
	): Promise<{
		item: WorkItem;
		comment: { id: string; body: string; createdAt: string; actor?: WorkGraphActor };
	}> {
		const item = await this.requireItem(id);
		const previousComments =
			(item.metadata?.deliveryPlannerProgressComments as
				| Array<{ id: string; body: string; createdAt: string; actor?: WorkGraphActor }>
				| undefined) ?? [];
		const comment = {
			id: crypto.randomUUID(),
			body,
			createdAt: new Date().toISOString(),
			actor,
		};
		const updated = await this.updateWorkItem({
			id: item.id,
			actor,
			patch: {
				metadata: {
					...item.metadata,
					deliveryPlannerProgressComments: [...previousComments, comment],
				},
			},
		});
		if (this.githubSync?.addProgressComment && updated.github?.issueNumber) {
			await this.githubSync.addProgressComment(updated, body);
		}

		return { item: updated, comment };
	}

	async createBugFollowUp(input: {
		title: string;
		description?: string;
		projectPath: string;
		gitPath: string;
		relatedWorkItemId?: string;
		tags?: string[];
		actor?: WorkGraphActor;
	}): Promise<WorkItem> {
		const related = input.relatedWorkItemId
			? await this.requireItem(input.relatedWorkItemId)
			: undefined;
		let item = await this.createWorkItem(
			{
				type: 'bug',
				status: 'planned',
				title: input.title.trim(),
				description: input.description,
				projectPath: input.projectPath,
				gitPath: input.gitPath,
				source: 'delivery-planner',
				readonly: false,
				tags: uniqueTags(['delivery-planner', 'bug-follow-up', ...(input.tags ?? [])]),
				metadata: {
					kind: 'bug-follow-up',
					relatedWorkItemId: input.relatedWorkItemId,
				},
			},
			input.actor
		);

		if (this.githubSync?.createLinkedBugIssue) {
			const github = await this.githubSync.createLinkedBugIssue({ bug: item, related });
			item = await this.updateWorkItem({
				id: item.id,
				actor: input.actor,
				patch: { github },
			});
		}

		await this.refreshAgentReadyTags(item.projectPath, item.gitPath, input.actor);
		return this.requireItem(item.id);
	}

	async promoteDocGap(input: {
		docGapWorkItemId: string;
		actor?: WorkGraphActor;
	}): Promise<{ task: WorkItem; created: boolean }> {
		const DOC_GAP_TAG = 'living-wiki-doc-gap';
		const docGapItem = await this.requireItem(input.docGapWorkItemId);

		if (!docGapItem.tags.includes(DOC_GAP_TAG)) {
			throw new DeliveryPlannerValidationError(
				`Work item ${input.docGapWorkItemId} is not tagged "${DOC_GAP_TAG}" and cannot be promoted as a doc gap`
			);
		}

		const { items: existingItems } = await this.workGraph.listItems({
			source: 'delivery-planner',
			projectPath: docGapItem.projectPath,
		});

		const existingPromotion = existingItems.find(
			(item) =>
				item.type === 'task' &&
				isRecord(item.metadata?.livingWiki) &&
				(item.metadata.livingWiki as Record<string, unknown>).sourceDocGapId ===
					input.docGapWorkItemId
		);

		if (existingPromotion) {
			return { task: existingPromotion, created: false };
		}

		const sourceGitPath =
			typeof docGapItem.metadata?.sourceGitPath === 'string'
				? docGapItem.metadata.sourceGitPath
				: docGapItem.gitPath;
		const area =
			typeof docGapItem.metadata?.area === 'string' ? docGapItem.metadata.area : undefined;
		const slug =
			typeof docGapItem.metadata?.slug === 'string' ? docGapItem.metadata.slug : undefined;

		// CRITICAL: Do NOT tag promoted items agent-ready.
		// Living Wiki owns doc-gap discovery; Agent Dispatch + human review own agent-ready promotion.
		const task = await this.createWorkItem(
			{
				type: 'task',
				status: 'discovered',
				title: `Write Living Wiki doc for ${sourceGitPath}`,
				description: docGapItem.description,
				projectPath: docGapItem.projectPath,
				gitPath: docGapItem.gitPath,
				source: 'delivery-planner',
				readonly: false,
				tags: uniqueTags(['delivery-planner', 'living-wiki-doc-gap-promotion']),
				parentWorkItemId: input.docGapWorkItemId,
				metadata: {
					kind: 'task',
					livingWiki: {
						sourceDocGapId: input.docGapWorkItemId,
						sourceGitPath,
						...(area !== undefined ? { area } : {}),
						...(slug !== undefined ? { slug } : {}),
					},
				},
			},
			input.actor
		);

		return { task, created: true };
	}

	async calculateDependencyReadiness(id: string): Promise<DependencyReadiness> {
		const item = await this.requireItem(id);
		const dependencies = item.dependencies ?? [];
		const blockingDependencyIds: string[] = [];
		const resolvedDependencyIds: string[] = [];

		for (const dependency of dependencies) {
			if (dependency.status !== 'active' || !['blocks', 'parent_child'].includes(dependency.type)) {
				continue;
			}

			const upstream = await this.requireItem(dependency.toWorkItemId);
			if (COMPLETED_STATUSES.includes(upstream.status)) {
				resolvedDependencyIds.push(dependency.id);
			} else {
				blockingDependencyIds.push(dependency.id);
			}
		}

		return {
			workItemId: id,
			ready: blockingDependencyIds.length === 0,
			blockingDependencyIds,
			resolvedDependencyIds,
		};
	}

	getProgress(id: string): DeliveryPlannerProgressSnapshot | undefined {
		return this.progress.get(id);
	}

	listProgress(): DeliveryPlannerProgressSnapshot[] {
		return this.progress.list();
	}

	private async createWorkItem(
		input: WorkItemCreateInput,
		actor?: WorkGraphActor
	): Promise<WorkItem> {
		try {
			const item = await this.workGraph.createItem(this.enrichPlannerItemInput(input), actor);
			await this.events?.publish('workGraph.item.created', { item });
			return item;
		} catch (error) {
			throw normalizePlannerError(error);
		}
	}

	private async updateWorkItem(input: WorkItemUpdateInput): Promise<WorkItem> {
		try {
			const item = await this.workGraph.updateItem({
				...input,
				patch: this.enrichPlannerItemPatch(input.patch),
			});
			await this.events?.publish('workGraph.item.updated', { item, patch: input.patch });
			return item;
		} catch (error) {
			throw normalizePlannerError(error);
		}
	}

	private async requireItem(id: string): Promise<WorkItem> {
		validateRequired(id, 'work item id');
		try {
			const item = await this.workGraph.getItem(id);
			if (!item) {
				throw new DeliveryPlannerValidationError(`Unknown work item: ${id}`);
			}

			return item;
		} catch (error) {
			throw normalizePlannerError(error);
		}
	}

	private async createDraftDependencies(items: WorkItem[], actor?: WorkGraphActor): Promise<void> {
		if (!this.workGraph.addDependency) {
			return;
		}

		const titleToItem = new Map(items.map((item) => [item.title, item]));
		for (const item of items) {
			const dependencyTitles = (item.metadata?.dependsOnTaskTitles as string[] | undefined) ?? [];
			for (const title of dependencyTitles) {
				const upstream = titleToItem.get(title);
				if (!upstream) {
					continue;
				}

				const dependency = await this.workGraph.addDependency({
					fromWorkItemId: item.id,
					toWorkItemId: upstream.id,
					type: 'blocks',
					status: 'active',
					createdBy: actor,
				});
				await this.events?.publish('workGraph.item.updated', { item, dependency });
			}
		}

		if (items[0]) {
			await this.refreshAgentReadyTags(items[0].projectPath, items[0].gitPath, actor);
		}
	}

	private async syncMirror(item: WorkItem, kind: 'prd' | 'epic' | 'task'): Promise<WorkItem> {
		const sync = {
			prd: this.externalMirror?.syncPrd,
			epic: this.externalMirror?.syncEpic,
			task: this.externalMirror?.syncTask,
		}[kind];

		if (!sync) {
			return item;
		}

		const operation = this.progress.start('external-mirror-sync', { workItemId: item.id, kind }, 1);
		try {
			const result = await sync.call(this.externalMirror, item, operation);
			let syncedItem = item;
			if (result.mirrorHash && result.mirrorHash !== item.mirrorHash) {
				syncedItem = await this.updateWorkItem({
					id: item.id,
					patch: { mirrorHash: result.mirrorHash },
				});
			}
			this.progress.complete(operation.id, 'External mirror sync completed');
			return syncedItem;
		} catch (error) {
			this.progress.fail(operation.id, error instanceof Error ? error : String(error), true);
			if (error instanceof DeliveryPlannerMirrorConflictError) {
				throw error;
			}
			throw new DeliveryPlannerMirrorConflictError('External mirror sync failed', error);
		}
	}

	private async syncGithub(item: WorkItem): Promise<WorkItem> {
		if (!this.githubSync) {
			return item;
		}

		const operation = this.progress.start('github-sync', { workItemId: item.id }, 3);
		try {
			this.progress.update(operation.id, {
				message: 'Syncing GitHub issue',
				completedSteps: 1,
			});
			const result = await this.githubSync.syncIssue(item);
			let syncedItem = item;
			if (
				result.github.issueNumber !== item.github?.issueNumber ||
				result.github.url !== item.github?.url
			) {
				syncedItem = await this.updateWorkItem({
					id: item.id,
					patch: { github: result.github },
				});
			}
			this.progress.update(operation.id, {
				message: 'Syncing GitHub issue status',
				completedSteps: 2,
			});
			if (this.githubSync.syncStatus && syncedItem.github?.issueNumber) {
				await this.githubSync.syncStatus(syncedItem);
			}
			this.progress.complete(operation.id, 'GitHub sync completed');
			return syncedItem;
		} catch (error) {
			this.progress.fail(operation.id, error instanceof Error ? error : String(error), true);
			throw new DeliveryPlannerGithubError('GitHub sync failed', error);
		}
	}

	private enrichPlannerItemInput(input: WorkItemCreateInput): WorkItemCreateInput {
		if (input.source !== 'delivery-planner') {
			return input;
		}

		const capabilities = deliveryPlannerCapabilityHints(input);
		return {
			...input,
			tags: uniqueTags(input.tags ?? []),
			capabilities,
			metadata: enrichPlannerMetadata(input.metadata, {
				id: undefined,
				type: input.type,
				parentWorkItemId: input.parentWorkItemId,
				github: input.github,
				capabilities,
			}),
		};
	}

	private enrichPlannerItemPatch(
		patch: WorkItemUpdateInput['patch']
	): WorkItemUpdateInput['patch'] {
		if (!patch.metadata && !patch.capabilities && !patch.tags && !patch.github) {
			return patch;
		}

		const capabilities = normalizeStringList(patch.capabilities ?? []);
		const shouldEnrichMetadata = Boolean(
			patch.capabilities || patch.github || patch.type || patch.parentWorkItemId
		);
		const next: WorkItemUpdateInput['patch'] = {
			...patch,
			...(patch.tags ? { tags: uniqueTags(patch.tags) } : {}),
			...(patch.capabilities ? { capabilities } : {}),
			...(patch.metadata && shouldEnrichMetadata
				? {
						metadata: enrichPlannerMetadata(patch.metadata, {
							id: undefined,
							type: patch.type,
							parentWorkItemId: patch.parentWorkItemId,
							github: patch.github,
							capabilities,
						}),
					}
				: patch.metadata
					? { metadata: patch.metadata }
					: {}),
		};
		return next;
	}

	private async refreshAgentReadyTags(
		projectPath: string,
		gitPath: string,
		actor?: WorkGraphActor
	): Promise<void> {
		const { items } = await this.workGraph.listItems({
			source: 'delivery-planner',
			projectPath,
			gitPath,
		});

		for (const item of items) {
			if (!['task', 'bug'].includes(item.type)) {
				continue;
			}

			const readiness = await this.calculateDependencyReadiness(item.id);
			const shouldHaveReadyTag = readiness.ready && isSufficientlySpecifiedForDispatch(item);
			const hasReadyTag = item.tags.includes(WORK_GRAPH_READY_TAG);
			if (shouldHaveReadyTag === hasReadyTag) {
				continue;
			}

			await this.updateWorkItem({
				id: item.id,
				actor,
				patch: {
					tags: shouldHaveReadyTag
						? uniqueTags([...item.tags, WORK_GRAPH_READY_TAG])
						: item.tags.filter((tag) => tag !== WORK_GRAPH_READY_TAG),
					metadata: {
						...item.metadata,
						deliveryPlannerAgentReady: {
							tag: WORK_GRAPH_READY_TAG,
							ready: shouldHaveReadyTag,
							evaluatedAt: new Date().toISOString(),
							reason: shouldHaveReadyTag
								? 'Unblocked and sufficiently specified for Agent Dispatch capability matching.'
								: 'Blocked or missing dispatch specification.',
						},
					},
				},
			});
		}
	}
}

export function normalizePlannerError(error: unknown): DeliveryPlannerError {
	if (error instanceof DeliveryPlannerError) {
		return error;
	}

	return new DeliveryPlannerWorkGraphError(
		error instanceof Error ? error.message : 'Work Graph operation failed',
		error
	);
}

const validateRequired = (value: string | undefined, label: string) => {
	if (!value?.trim()) {
		throw new DeliveryPlannerValidationError(`${label} is required`);
	}
};

const uniqueTags = (tags: string[]) => [...new Set(tags.filter(Boolean))];

const normalizeStringList = (values: unknown): string[] => {
	if (!Array.isArray(values)) {
		return [];
	}

	return uniqueTags(
		values
			.filter((value): value is string => typeof value === 'string')
			.map((value) => value.trim().toLowerCase())
			.filter(Boolean)
	);
};

const deliveryPlannerCapabilityHints = (
	input: Pick<WorkItemCreateInput, 'type' | 'tags' | 'capabilities' | 'metadata'>
): string[] => {
	const explicit = normalizeStringList(input.capabilities ?? []);
	if (explicit.length > 0) {
		return explicit;
	}

	const tags = normalizeStringList(input.tags ?? []);
	const metadata = input.metadata ?? {};
	const filesLikelyTouched = normalizeStringList(metadata.filesLikelyTouched ?? []);
	const hints = new Set<string>();

	if (tags.some((tag) => ['validation', 'test', 'tests', 'qa'].includes(tag))) {
		hints.add('tests');
	}
	if (tags.some((tag) => ['docs', 'documentation', 'task-preview', 'design'].includes(tag))) {
		hints.add('docs');
	}
	if (
		input.type === 'bug' ||
		tags.some((tag) => ['implementation', 'code', 'bug-follow-up'].includes(tag)) ||
		filesLikelyTouched.some((filePath) => /\.(ts|tsx|js|jsx|mjs|cjs|css|scss|json)$/.test(filePath))
	) {
		hints.add('code');
	}

	return [...hints];
};

const enrichPlannerMetadata = (
	metadata: Record<string, unknown> | undefined,
	context: {
		id?: string;
		type?: WorkItem['type'];
		parentWorkItemId?: string;
		github?: WorkItemGithubReference;
		capabilities?: string[];
	}
): Record<string, unknown> => {
	const next = { ...(metadata ?? {}) };
	const kind = typeof next.kind === 'string' ? next.kind : undefined;
	const parentWorkItemId =
		context.parentWorkItemId ??
		(typeof next.parentWorkItemId === 'string' ? next.parentWorkItemId : undefined);
	const prdWorkItemId =
		typeof next.prdWorkItemId === 'string'
			? next.prdWorkItemId
			: kind === 'prd'
				? context.id
				: undefined;
	const epicWorkItemId =
		kind === 'epic'
			? context.id
			: (parentWorkItemId ??
				(typeof next.epicWorkItemId === 'string' ? next.epicWorkItemId : undefined));

	next.deliveryPlannerTraceability = {
		...(isRecord(next.deliveryPlannerTraceability) ? next.deliveryPlannerTraceability : {}),
		prdWorkItemId,
		epicWorkItemId,
		parentWorkItemId,
		github: context.github,
		livingWiki: {
			workGraphSource: 'delivery-planner',
			artifactKind: kind ?? context.type,
		},
	};

	next.deliveryPlannerDispatch = {
		...(isRecord(next.deliveryPlannerDispatch) ? next.deliveryPlannerDispatch : {}),
		capabilityHints: normalizeStringList(context.capabilities ?? []),
		ownership:
			'Delivery Planner marks unblocked, specified work with agent-ready; Agent Dispatch owns agent matching, claims, and execution.',
	};

	return next;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isSufficientlySpecifiedForDispatch = (item: WorkItem): boolean => {
	const acceptanceCriteria = normalizeStringList(item.metadata?.acceptanceCriteria ?? []);
	const hasAcceptanceCriteria =
		acceptanceCriteria.length > 0 || item.description?.includes('## Acceptance Criteria') === true;
	const capabilityHints =
		normalizeStringList(item.capabilities ?? []).length > 0 ||
		normalizeStringList(
			isRecord(item.metadata?.deliveryPlannerDispatch)
				? item.metadata.deliveryPlannerDispatch.capabilityHints
				: []
		).length > 0;

	return Boolean(
		item.title.trim() && item.description?.trim() && hasAcceptanceCriteria && capabilityHints
	);
};

function renderEpicDescription(input: { title: string; description?: string }): string {
	const source = input.description?.trim() || `Deliver ${input.title}.`;
	return [
		source,
		'## Architecture Decisions',
		'- Preserve existing Work Graph item semantics and store Delivery Planner details in metadata.',
		'- Mirror PRDs, epics, and tasks to `.maestro/external-mirror/` markdown paths under the project root.',
		'## Implementation Strategy',
		'- Decompose work into dependency-ordered tasks with acceptance criteria and risk notes.',
		'- Validate dependencies before persisting graph edges so previews remain deterministic.',
		'## Dependencies',
		'- Tasks generated from this epic must not introduce circular dependencies.',
		'## Task Preview',
		'- Design the workflow and dependency boundaries.',
		'- Implement the scoped Work Graph and external mirror changes.',
		'- Validate generated tasks and dependency previews.',
	].join('\n\n');
}

const inferPlannerItemKind = (item: WorkItem): 'prd' | 'epic' | 'task' => {
	if (item.metadata?.kind === 'prd' || item.metadata?.kind === 'epic') {
		return item.metadata.kind;
	}

	return 'task';
};
