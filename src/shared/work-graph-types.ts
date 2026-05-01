/**
 * Shared Work Graph contracts for Living Wiki, Delivery Planner, Agent Dispatch,
 * MCP tooling, and web broadcasts.
 *
 * Public API fields use the `workGraph` vocabulary. User-facing ownership uses
 * "agent"; "session" is reserved for provider session identifiers only.
 */

export const WORK_GRAPH_READY_TAG = 'agent-ready' as const;
export const WORK_GRAPH_AGENT_READY_TAG = WORK_GRAPH_READY_TAG;
export const WORK_GRAPH_FORK_REPOSITORY = 'HumpfTech/Maestro' as const;

export type WorkGraphReadyTag = typeof WORK_GRAPH_READY_TAG;

export type WorkItemType =
	| 'task'
	| 'bug'
	| 'feature'
	| 'chore'
	| 'document'
	| 'decision'
	| 'milestone';

/**
 * Role within a multi-agent dispatch pipeline (#426).
 * Mirrors `DispatchRole` in agent-dispatch-types — kept here to avoid a
 * circular import (work-graph-types ← agent-dispatch-types).
 */
export type WorkItemPipelineRole = 'runner' | 'fixer' | 'reviewer' | 'merger';

/**
 * Pipeline state for role-based dispatch (#426).
 * Attach to a WorkItem to route it through an ordered multi-agent workflow.
 */
export interface WorkItemPipeline {
	/** The role that must handle this item next. */
	currentRole: WorkItemPipelineRole;
	/** Ordered list of roles that have already completed their stage. */
	completedRoles: WorkItemPipelineRole[];
}

export type WorkItemStatus =
	| 'discovered'
	| 'planned'
	| 'ready'
	| 'claimed'
	| 'in_progress'
	| 'blocked'
	| 'review'
	| 'done'
	| 'archived'
	| 'canceled';

export type WorkItemDependencyType = 'blocks' | 'relates_to' | 'duplicates' | 'parent_child';
export type WorkItemDependencyStatus = 'active' | 'resolved' | 'ignored';
export type WorkItemSource =
	| 'manual'
	| 'living-wiki'
	| 'delivery-planner'
	| 'agent-dispatch'
	| 'github'
	| 'mcp'
	| 'spec-kit'
	| 'openspec'
	| 'playbook'
	| 'director-notes';
export type WorkItemClaimStatus = 'active' | 'released' | 'completed' | 'expired';
export type WorkItemClaimSource = 'manual' | 'auto-pickup';
export type TrackerSyncState = 'unsynced' | 'syncing' | 'synced' | 'error';
export type WorkGraphActorType = 'agent' | 'user' | 'system' | 'github' | 'mcp';
export type WorkGraphImportStatus = 'created' | 'updated' | 'skipped' | 'failed';
export type WorkGraphBroadcastOperation =
	| 'workGraph.item.created'
	| 'workGraph.item.updated'
	| 'workGraph.item.deleted'
	| 'workGraph.item.claimed'
	| 'workGraph.item.released'
	| 'workGraph.item.statusChanged'
	| 'workGraph.tags.updated'
	| 'workGraph.import.completed'
	| 'agentDispatch.fleet.changed'
	| 'agentDispatch.agent.readinessChanged'
	| 'agentDispatch.agent.claimsChanged'
	| 'agentDispatch.agent.pickupChanged';

export interface WorkGraphActor {
	type: WorkGraphActorType;
	id: string;
	name?: string;
	agentId?: string;
	providerSessionId?: string;
}

export interface WorkItemOwner {
	type: 'agent' | 'user' | 'team' | 'system';
	id: string;
	name?: string;
	agentId?: string;
	providerSessionId?: string;
	capabilities?: string[];
}

export interface WorkItemGithubReference {
	owner: 'HumpfTech';
	repo: 'Maestro';
	repository: typeof WORK_GRAPH_FORK_REPOSITORY;
	issueNumber?: number;
	pullRequestNumber?: number;
	url?: string;
	branch?: string;
	commitSha?: string;
	projectOwner?: string;
	projectNumber?: number;
	projectItemId?: string;
	projectFields?: {
		maestroMajor?: string;
		workItemType?: string;
		parentWorkItem?: string;
		externalMirrorId?: string;
		agentPickup?: string;
	};
}

export interface WorkItemDependency {
	id: string;
	fromWorkItemId: string;
	toWorkItemId: string;
	type: WorkItemDependencyType;
	status: WorkItemDependencyStatus;
	createdAt: string;
	createdBy?: WorkGraphActor;
}

export interface WorkItemClaim {
	id: string;
	workItemId: string;
	owner: WorkItemOwner;
	status: WorkItemClaimStatus;
	source: WorkItemClaimSource;
	claimedAt: string;
	expiresAt?: string;
	releasedAt?: string;
	completedAt?: string;
	note?: string;
}

export interface WorkItem {
	id: string;
	type: WorkItemType;
	status: WorkItemStatus;
	title: string;
	description?: string;
	slug?: string;
	parentWorkItemId?: string;
	projectPath: string;
	gitPath: string;
	mirrorHash?: string;
	source: WorkItemSource;
	readonly: boolean;
	tags: string[];
	owner?: WorkItemOwner;
	claim?: WorkItemClaim;
	dependencies?: WorkItemDependency[];
	github?: WorkItemGithubReference;
	capabilities?: string[];
	priority?: number;
	/** Optimistic-lock counter. Incremented on every update. Default 0. (#435) */
	version: number;
	createdAt: string;
	updatedAt: string;
	dueAt?: string;
	completedAt?: string;
	metadata?: Record<string, unknown>;
	/**
	 * Role-based pipeline state (#426). When set, only agents whose
	 * `dispatchProfile.roles` includes `pipeline.currentRole` are eligible for
	 * auto-pickup. Omit to use the legacy capability-tag-only matching.
	 */
	pipeline?: WorkItemPipeline;
	// Tracker sync columns — populated by the local-first tracker backend; read-only to all other subsystems
	trackerBackendId?: string;
	trackerSyncState?: TrackerSyncState;
	trackerExternalId?: string;
	trackerExternalUrl?: string;
	trackerLastSyncedAt?: number;
	trackerLastError?: string;
	trackerHash?: string;
}

export interface WorkItemEvent {
	id: string;
	workItemId: string;
	type:
		| 'created'
		| 'updated'
		| 'status_changed'
		| 'tagged'
		| 'untagged'
		| 'claimed'
		| 'released'
		| 'dependency_added'
		| 'dependency_resolved'
		| 'imported'
		| 'deleted';
	actor: WorkGraphActor;
	timestamp: string;
	before?: Partial<WorkItem>;
	after?: Partial<WorkItem>;
	message?: string;
	/** Prior state snapshot for status/role changes (#435 audit richness). */
	priorState?: Record<string, unknown>;
	/** New state snapshot for status/role changes (#435 audit richness). */
	newState?: Record<string, unknown>;
	/** Reason for the state change, if available (#435 audit richness). */
	reason?: string;
	/** External artifact link (PR/commit/doc URL) for traceability (#435 audit richness). */
	artifactLink?: string;
}

export interface WorkItemEventCreateInput {
	workItemId: string;
	type: WorkItemEvent['type'];
	actor: WorkGraphActor;
	timestamp?: string;
	before?: Partial<WorkItem>;
	after?: Partial<WorkItem>;
	message?: string;
	/** Prior state snapshot for status/role changes (#435 audit richness). */
	priorState?: Record<string, unknown>;
	/** New state snapshot for status/role changes (#435 audit richness). */
	newState?: Record<string, unknown>;
	/** Reason for the state change, if available (#435 audit richness). */
	reason?: string;
	/** External artifact link (PR/commit/doc URL) for traceability (#435 audit richness). */
	artifactLink?: string;
}

export interface TagDefinition {
	name: string;
	description?: string;
	color?: string;
	source: WorkItemSource;
	readonly: boolean;
	canonical?: boolean;
	capabilities?: string[];
	createdAt?: string;
	updatedAt?: string;
}

export interface WorkGraphCapabilityRouting {
	agentId?: string;
	agentCapabilities?: string[];
	requireReadyTag?: boolean;
	readyTag?: WorkGraphReadyTag;
}

export interface WorkItemFilters {
	ids?: string[];
	types?: WorkItemType[];
	statuses?: WorkItemStatus[];
	tags?: string[];
	anyTags?: string[];
	excludeTags?: string[];
	projectPath?: string;
	gitPath?: string;
	source?: WorkItemSource | WorkItemSource[];
	readonly?: boolean;
	ownerId?: string;
	ownerType?: WorkItemOwner['type'];
	githubRepository?: typeof WORK_GRAPH_FORK_REPOSITORY;
	githubIssueNumber?: number;
	githubPullRequestNumber?: number;
	capabilityRouting?: WorkGraphCapabilityRouting;
	updatedAfter?: string;
	updatedBefore?: string;
	limit?: number;
	cursor?: string;
}

export interface AgentReadyWorkFilter extends WorkItemFilters {
	excludeClaimed?: boolean;
	excludeExpiredClaims?: boolean;
	capabilityTags?: string[];
	agentId?: string;
	requireUnblocked?: boolean;
}

export type WorkGraphEventType = WorkGraphBroadcastOperation;

export interface WorkItemCreateInput {
	type: WorkItemType;
	title: string;
	description?: string;
	status?: WorkItemStatus;
	parentWorkItemId?: string;
	projectPath: string;
	gitPath: string;
	mirrorHash?: string;
	source: WorkItemSource;
	readonly?: boolean;
	tags?: string[];
	owner?: WorkItemOwner;
	dependencies?: Omit<WorkItemDependency, 'id' | 'createdAt'>[];
	github?: WorkItemGithubReference;
	capabilities?: string[];
	priority?: number;
	dueAt?: string;
	metadata?: Record<string, unknown>;
	capabilityRouting?: WorkGraphCapabilityRouting;
}

export type WorkItemPatch = Partial<
	Pick<
		WorkItem,
		| 'type'
		| 'status'
		| 'title'
		| 'description'
		| 'slug'
		| 'parentWorkItemId'
		| 'projectPath'
		| 'gitPath'
		| 'mirrorHash'
		| 'source'
		| 'readonly'
		| 'tags'
		| 'owner'
		| 'claim'
		| 'dependencies'
		| 'github'
		| 'capabilities'
		| 'priority'
		| 'dueAt'
		| 'completedAt'
		| 'metadata'
	>
>;

export interface WorkItemUpdateInput {
	id: string;
	patch: WorkItemPatch;
	actor?: WorkGraphActor;
	expectedUpdatedAt?: string;
	capabilityRouting?: WorkGraphCapabilityRouting;
}

export interface WorkItemClaimInput {
	workItemId: string;
	owner: WorkItemOwner;
	source: WorkItemClaimSource;
	expiresAt?: string;
	note?: string;
	expectedUpdatedAt?: string;
	capabilityRouting?: WorkGraphCapabilityRouting;
}

export interface WorkItemClaimRenewInput {
	workItemId: string;
	claimId?: string;
	owner?: WorkItemOwner;
	expiresAt: string;
	note?: string;
}

export interface WorkItemClaimReleaseInput {
	workItemId: string;
	claimId?: string;
	owner?: WorkItemOwner;
	note?: string;
}

export interface WorkItemClaimCompleteInput {
	workItemId: string;
	claimId?: string;
	owner?: WorkItemOwner;
	note?: string;
}

export interface WorkItemSourceInput {
	workItemId: string;
	source: WorkItemSource;
	projectPath: string;
	gitPath: string;
	externalType: string;
	externalId: string;
	url?: string;
	metadata?: Record<string, unknown>;
}

export interface WorkItemSearchFilters extends WorkItemFilters {
	query: string;
}

export interface WorkGraphImportItemSummary {
	externalId?: string;
	workItemId?: string;
	title?: string;
	status: WorkGraphImportStatus;
	message?: string;
}

export interface WorkGraphImportSummary {
	source: WorkItemSource;
	projectPath: string;
	gitPath: string;
	mirrorHash?: string;
	startedAt: string;
	completedAt: string;
	created: number;
	updated: number;
	skipped: number;
	failed: number;
	items: WorkGraphImportItemSummary[];
}

export type WorkGraphImportItemInput = Omit<
	WorkItemCreateInput,
	'source' | 'projectPath' | 'gitPath' | 'mirrorHash'
> &
	Partial<Pick<WorkItemCreateInput, 'source' | 'projectPath' | 'gitPath' | 'mirrorHash'>>;

export interface WorkGraphImportInput {
	source: WorkItemSource;
	projectPath: string;
	gitPath: string;
	mirrorHash?: string;
	items: WorkGraphImportItemInput[];
	updateExisting?: boolean;
	actor?: WorkGraphActor;
}

export interface WorkGraphListResult {
	items: WorkItem[];
	nextCursor?: string;
	total?: number;
}

export interface WorkGraphBroadcastEnvelope<TPayload = unknown> {
	type: 'workGraph';
	operation: WorkGraphBroadcastOperation;
	sequence: number;
	timestamp: string;
	projectPath?: string;
	gitPath?: string;
	payload: TPayload;
}

export interface WorkGraphItemBroadcastPayload {
	item: WorkItem;
	previous?: Partial<WorkItem>;
	event?: WorkItemEvent;
}

export const WORK_GRAPH_READY_TAG_DEFINITION: TagDefinition = {
	name: WORK_GRAPH_READY_TAG,
	description: 'Marks unblocked work eligible for agent auto-pickup.',
	source: 'agent-dispatch',
	readonly: false,
	canonical: true,
};
