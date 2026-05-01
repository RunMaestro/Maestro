import type {
	WorkGraphActor,
	WorkGraphBroadcastEnvelope,
	WorkGraphImportSummary,
	WorkGraphReadyTag,
	WorkItem,
	WorkItemDependency,
	WorkItemFilters,
	WorkItemGithubReference,
	WorkItemStatus,
	WorkItemType,
} from './work-graph-types';
import { WORK_GRAPH_READY_TAG } from './work-graph-types';

export type DeliveryPlannerConcept = 'prd' | 'epic' | 'task' | 'issue' | 'bug-follow-up';

export type DeliveryPlannerConceptWorkItemType = Extract<
	WorkItemType,
	'feature' | 'milestone' | 'task' | 'bug'
>;

export const DELIVERY_PLANNER_CONCEPT_TO_WORK_ITEM_TYPE: Record<
	DeliveryPlannerConcept,
	DeliveryPlannerConceptWorkItemType
> = {
	prd: 'feature',
	epic: 'milestone',
	task: 'task',
	issue: 'task',
	'bug-follow-up': 'bug',
};

export const DELIVERY_PLANNER_DEFAULT_STATUS_BY_CONCEPT: Record<
	DeliveryPlannerConcept,
	WorkItemStatus
> = {
	prd: 'planned',
	epic: 'planned',
	task: 'planned',
	issue: 'planned',
	'bug-follow-up': 'planned',
};

export type AgentReadyWorkGraphTag = WorkGraphReadyTag;

export interface DeliveryPlannerWorkGraphContractRequest {
	field: string;
	reason: string;
	temporaryRepresentation: string;
}

export const DELIVERY_PLANNER_WORK_GRAPH_CONTRACT_REQUESTS: DeliveryPlannerWorkGraphContractRequest[] =
	[
		{
			field: 'WorkItem.metadata.deliveryPlannerConcept',
			reason:
				'Delivery Planner distinguishes PRDs, epics, tasks, issues, and bug follow-ups while Work Graph keeps the canonical type vocabulary narrower.',
			temporaryRepresentation:
				'Use canonical WorkItem.type values from DELIVERY_PLANNER_CONCEPT_TO_WORK_ITEM_TYPE and store the planner concept in metadata.',
		},
		{
			field: 'WorkItem.metadata.deliveryPlannerDependencyHints',
			reason:
				'Dependency previews need explainable planner hints before dependencies are committed to WorkItem.dependencies.',
			temporaryRepresentation:
				'Return hints in DeliveryPlannerDependencyPreview and persist only committed graph edges in WorkItem.dependencies.',
		},
		{
			field: 'WorkItem.metadata.deliveryPlannerConflictHints',
			reason:
				'Planner conflict previews can point at files or work items without creating a lifecycle status.',
			temporaryRepresentation:
				'Return hints in DeliveryPlannerDependencyPreview and store durable planner-only hints under WorkItem.metadata if needed.',
		},
	];

/**
 * Delivery Planner exposes PRD/epic/task traceability and dispatch hints through
 * Work Graph item metadata only. Living Wiki may read those metadata links for
 * artifact references; Agent Dispatch owns ready/idle agent matching, claims,
 * and execution after Work Graph dependency state plus `agent-ready` eligibility.
 */
export const DELIVERY_PLANNER_CROSS_MAJOR_OWNERSHIP =
	'delivery-planner-work-graph-metadata-only' as const;

export interface DeliveryPlannerPrdCreateRequest {
	title: string;
	projectPath: string;
	gitPath: string;
	body: string;
	slug?: string;
	tags?: string[];
	github?: WorkItemGithubReference;
}

export interface DeliveryPlannerPrdCreateResult {
	prd: WorkItem & { type: 'document'; source: 'delivery-planner' };
	github?: WorkItemGithubReference;
}

export interface DeliveryPlannerPrdFields {
	problem: string;
	users: string;
	successCriteria: string;
	scope: string;
	constraints: string;
	dependencies: string;
	outOfScope: string;
}

export interface DeliveryPlannerPrdSaveRequest {
	id?: string;
	title: string;
	slug: string;
	projectPath: string;
	gitPath: string;
	fields: DeliveryPlannerPrdFields;
	tags?: string[];
}

export interface DeliveryPlannerPrdSaveResult {
	prd: WorkItem & { type: 'document'; source: 'delivery-planner' };
	mirrorPath?: string;
}

export interface DeliveryPlannerDecompositionRequest {
	prdItemId: WorkItem['id'];
	projectPath: string;
	gitPath?: string;
	targetConcepts?: Exclude<DeliveryPlannerConcept, 'prd'>[];
	includeDependencyPreview?: boolean;
}

export interface DeliveryPlannerDecompositionResult {
	prdItemId: WorkItem['id'];
	createdItems: WorkItem[];
	updatedItems: WorkItem[];
	dependencyPreview?: DeliveryPlannerDependencyPreview;
}

export interface DeliveryPlannerDependencyPreviewRequest {
	itemIds: WorkItem['id'][];
	projectPath?: string;
	gitPath?: string;
}

export interface DeliveryPlannerDependencyHint {
	fromWorkItemId: WorkItem['id'];
	toWorkItemId: WorkItem['id'];
	type: WorkItemDependency['type'];
	reason?: string;
	blocking: boolean;
}

export interface DeliveryPlannerConflictHint {
	workItemId?: WorkItem['id'];
	gitPath?: string;
	reason: string;
	severity: 'info' | 'warning' | 'blocking';
}

export interface DeliveryPlannerDependencyPreview {
	items: Array<{
		itemId: WorkItem['id'];
		status: WorkItemStatus;
		tags: string[];
		dependencies: WorkItemDependency[];
		dependencyHints: DeliveryPlannerDependencyHint[];
		conflictHints: DeliveryPlannerConflictHint[];
		agentReadyTagRecommendation?: {
			tag: AgentReadyWorkGraphTag;
			action: 'add' | 'remove' | 'keep';
			reason?: string;
		};
	}>;
}

export interface DeliveryPlannerGithubSyncSummary extends Pick<
	WorkGraphImportSummary,
	| 'source'
	| 'projectPath'
	| 'gitPath'
	| 'mirrorHash'
	| 'startedAt'
	| 'completedAt'
	| 'created'
	| 'updated'
	| 'skipped'
	| 'failed'
	| 'items'
> {
	githubReferences: WorkItemGithubReference[];
	errors?: Array<{
		itemId?: WorkItem['id'];
		github?: WorkItemGithubReference;
		message: string;
	}>;
}

export interface DeliveryPlannerDashboardFilters extends WorkItemFilters {
	query?: string;
	concepts?: DeliveryPlannerConcept[];
	hasGithubReference?: boolean;
	hasDependencies?: boolean;
	hasDependencyHints?: boolean;
	hasConflictHints?: boolean;
}

export interface DeliveryPlannerDashboardSnapshot {
	filters: DeliveryPlannerDashboardFilters;
	items: WorkItem[];
	githubSync?: DeliveryPlannerGithubSyncSummary;
	readyTag: typeof WORK_GRAPH_READY_TAG;
}

export type DeliveryPlannerOperationType = 'ccpm-sync' | 'decomposition' | 'github-sync';
export type DeliveryPlannerOperationStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DeliveryPlannerProgressSnapshot {
	id: string;
	type: DeliveryPlannerOperationType;
	status: DeliveryPlannerOperationStatus;
	attempt: number;
	retryable: boolean;
	message?: string;
	totalSteps?: number;
	completedSteps: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	error?: string;
	metadata?: Record<string, unknown>;
}

export type DeliveryPlannerProgressEvent = DeliveryPlannerProgressSnapshot;

export interface DeliveryPlannerCreatePrdRequest {
	title: string;
	description?: string;
	projectPath: string;
	gitPath: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerDecomposePrdRequest {
	prdId: WorkItem['id'];
	title?: string;
	description?: string;
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerDecomposeEpicRequest {
	epicId: WorkItem['id'];
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerSyncRequest {
	workItemId: WorkItem['id'];
	target?: 'ccpm' | 'github' | 'all';
}

export interface DeliveryPlannerBugFollowUpRequest {
	title: string;
	description?: string;
	projectPath: string;
	gitPath: string;
	relatedWorkItemId?: WorkItem['id'];
	tags?: string[];
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerProgressCommentRequest {
	workItemId: WorkItem['id'];
	body: string;
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerProgressComment {
	id: string;
	body: string;
	createdAt: string;
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerPathResolutionRequest {
	projectPath?: string;
	gitPath?: string;
}

export interface DeliveryPlannerPathResolutionResult {
	projectPath: string;
	gitPath: string;
}

export type WorkGraphChangeEvent = WorkGraphBroadcastEnvelope;

// ---------------------------------------------------------------------------
// Doc-gap promotion
// ---------------------------------------------------------------------------

/** Request to promote a Living Wiki doc-gap item to a Delivery Planner task. */
export interface DeliveryPlannerPromoteDocGapRequest {
	/** Work Graph ID of the living-wiki-doc-gap item to promote. */
	docGapWorkItemId: string;
	actor?: WorkGraphActor;
}

/** Result of a doc-gap promotion. */
export interface DeliveryPlannerPromoteDocGapResult {
	/** The Delivery Planner task that was created or already existed. */
	task: WorkItem;
	/** True when a new task was created; false when one already existed. */
	created: boolean;
}
