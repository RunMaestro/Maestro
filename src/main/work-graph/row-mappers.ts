import type {
	TagDefinition,
	TrackerSyncState,
	WorkGraphActor,
	WorkItem,
	WorkItemClaim,
	WorkItemDependency,
	WorkItemEvent,
	WorkItemGithubReference,
	WorkItemOwner,
	WorkItemSource,
} from '../../shared/work-graph-types';

export interface WorkItemRow {
	id: string;
	type: WorkItem['type'];
	status: WorkItem['status'];
	title: string;
	description: string | null;
	slug: string | null;
	parent_work_item_id: string | null;
	project_path: string;
	git_path: string;
	mirror_hash: string | null;
	source: WorkItemSource;
	readonly: number;
	owner_json: string | null;
	github_json: string | null;
	capabilities_json: string | null;
	priority: number | null;
	due_at: string | null;
	completed_at: string | null;
	metadata_json: string | null;
	version: number;
	created_at: string;
	updated_at: string;
	tracker_backend_id: string | null;
	tracker_sync_state: TrackerSyncState;
	tracker_external_id: string | null;
	tracker_external_url: string | null;
	tracker_last_synced_at: number | null;
	tracker_last_error: string | null;
	tracker_hash: string | null;
}

export interface WorkItemDependencyRow {
	id: string;
	from_work_item_id: string;
	to_work_item_id: string;
	type: WorkItemDependency['type'];
	status: WorkItemDependency['status'];
	created_at: string;
	created_by_json: string | null;
}

export interface WorkItemClaimRow {
	id: string;
	work_item_id: string;
	owner_json: string;
	status: WorkItemClaim['status'];
	source: WorkItemClaim['source'];
	claimed_at: string;
	expires_at: string | null;
	released_at: string | null;
	completed_at: string | null;
	note: string | null;
}

export interface WorkItemEventRow {
	id: string;
	work_item_id: string;
	type: WorkItemEvent['type'];
	actor_json: string;
	timestamp: string;
	before_json: string | null;
	after_json: string | null;
	message: string | null;
	prior_state_json: string | null;
	new_state_json: string | null;
	reason: string | null;
	artifact_link: string | null;
}

export interface TagDefinitionRow {
	name: string;
	description: string | null;
	color: string | null;
	source: WorkItemSource;
	readonly: number;
	canonical: number;
	capabilities_json: string | null;
	created_at: string | null;
	updated_at: string | null;
}

export interface WorkItemSourceRow {
	id: string;
	work_item_id: string;
	source: WorkItemSource;
	project_path: string;
	git_path: string;
	external_type: string;
	external_id: string;
	url: string | null;
	metadata_json: string | null;
	imported_at: string;
}

export interface WorkItemMirrorRow {
	id: string;
	work_item_id: string;
	project_path: string;
	git_path: string;
	mirror_path: string;
	mirror_hash: string | null;
	frontmatter_json: string | null;
	synced_at: string;
}

export interface WorkItemRelations {
	tags?: string[];
	claim?: WorkItemClaim;
	dependencies?: WorkItemDependency[];
}

export interface WorkItemSourceReference {
	id: string;
	workItemId: string;
	source: WorkItemSource;
	projectPath: string;
	gitPath: string;
	externalType: string;
	externalId: string;
	url?: string;
	metadata?: Record<string, unknown>;
	importedAt: string;
}

export interface WorkItemMirror {
	id: string;
	workItemId: string;
	projectPath: string;
	gitPath: string;
	mirrorPath: string;
	mirrorHash?: string;
	frontmatter?: Record<string, unknown>;
	syncedAt: string;
}

export function mapWorkItemRow(row: WorkItemRow, relations: WorkItemRelations = {}): WorkItem {
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		title: row.title,
		description: row.description ?? undefined,
		slug: row.slug ?? undefined,
		parentWorkItemId: row.parent_work_item_id ?? undefined,
		projectPath: row.project_path,
		gitPath: row.git_path,
		mirrorHash: row.mirror_hash ?? undefined,
		source: row.source,
		readonly: row.readonly === 1,
		tags: relations.tags ?? [],
		owner: parseOptionalObject<WorkItemOwner>(row.owner_json, 'work_items.owner_json'),
		claim: relations.claim,
		dependencies: relations.dependencies,
		github: parseOptionalObject<WorkItemGithubReference>(row.github_json, 'work_items.github_json'),
		capabilities: parseStringArray(row.capabilities_json, 'work_items.capabilities_json'),
		priority: row.priority ?? undefined,
		version: row.version ?? 0,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		dueAt: row.due_at ?? undefined,
		completedAt: row.completed_at ?? undefined,
		metadata: parseOptionalObject<Record<string, unknown>>(
			row.metadata_json,
			'work_items.metadata_json'
		),
		trackerBackendId: row.tracker_backend_id ?? undefined,
		trackerSyncState: row.tracker_sync_state ?? 'unsynced',
		trackerExternalId: row.tracker_external_id ?? undefined,
		trackerExternalUrl: row.tracker_external_url ?? undefined,
		trackerLastSyncedAt: row.tracker_last_synced_at ?? undefined,
		trackerLastError: row.tracker_last_error ?? undefined,
		trackerHash: row.tracker_hash ?? undefined,
	};
}

export function mapWorkItemDependencyRow(row: WorkItemDependencyRow): WorkItemDependency {
	return {
		id: row.id,
		fromWorkItemId: row.from_work_item_id,
		toWorkItemId: row.to_work_item_id,
		type: row.type,
		status: row.status,
		createdAt: row.created_at,
		createdBy: parseOptionalObject<WorkGraphActor>(
			row.created_by_json,
			'work_item_dependencies.created_by_json'
		),
	};
}

export function mapWorkItemClaimRow(row: WorkItemClaimRow): WorkItemClaim {
	return {
		id: row.id,
		workItemId: row.work_item_id,
		owner: parseObject<WorkItemOwner>(row.owner_json, 'work_item_claims.owner_json'),
		status: row.status,
		source: row.source,
		claimedAt: row.claimed_at,
		expiresAt: row.expires_at ?? undefined,
		releasedAt: row.released_at ?? undefined,
		completedAt: row.completed_at ?? undefined,
		note: row.note ?? undefined,
	};
}

export function mapWorkItemEventRow(row: WorkItemEventRow): WorkItemEvent {
	return {
		id: row.id,
		workItemId: row.work_item_id,
		type: row.type,
		actor: parseObject<WorkGraphActor>(row.actor_json, 'work_item_events.actor_json'),
		timestamp: row.timestamp,
		before: parseOptionalObject<Partial<WorkItem>>(row.before_json, 'work_item_events.before_json'),
		after: parseOptionalObject<Partial<WorkItem>>(row.after_json, 'work_item_events.after_json'),
		message: row.message ?? undefined,
		priorState: parseOptionalObject<Record<string, unknown>>(
			row.prior_state_json,
			'work_item_events.prior_state_json'
		),
		newState: parseOptionalObject<Record<string, unknown>>(
			row.new_state_json,
			'work_item_events.new_state_json'
		),
		reason: row.reason ?? undefined,
		artifactLink: row.artifact_link ?? undefined,
	};
}

export function mapTagDefinitionRow(row: TagDefinitionRow): TagDefinition {
	return {
		name: row.name,
		description: row.description ?? undefined,
		color: row.color ?? undefined,
		source: row.source,
		readonly: row.readonly === 1,
		canonical: row.canonical === 1,
		capabilities: parseStringArray(row.capabilities_json, 'tag_registry.capabilities_json'),
		createdAt: row.created_at ?? undefined,
		updatedAt: row.updated_at ?? undefined,
	};
}

export function mapWorkItemSourceRow(row: WorkItemSourceRow): WorkItemSourceReference {
	return {
		id: row.id,
		workItemId: row.work_item_id,
		source: row.source,
		projectPath: row.project_path,
		gitPath: row.git_path,
		externalType: row.external_type,
		externalId: row.external_id,
		url: row.url ?? undefined,
		metadata: parseOptionalObject<Record<string, unknown>>(
			row.metadata_json,
			'work_item_sources.metadata_json'
		),
		importedAt: row.imported_at,
	};
}

export function mapWorkItemMirrorRow(row: WorkItemMirrorRow): WorkItemMirror {
	return {
		id: row.id,
		workItemId: row.work_item_id,
		projectPath: row.project_path,
		gitPath: row.git_path,
		mirrorPath: row.mirror_path,
		mirrorHash: row.mirror_hash ?? undefined,
		frontmatter: parseOptionalObject<Record<string, unknown>>(
			row.frontmatter_json,
			'work_item_mirrors.frontmatter_json'
		),
		syncedAt: row.synced_at,
	};
}

function parseStringArray(value: string | null, column: string): string[] {
	if (!value) {
		return [];
	}

	const parsed = parseJson(value, column);
	if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
		throw new Error(`Expected ${column} to contain a JSON string array`);
	}

	return parsed;
}

function parseOptionalObject<T>(value: string | null, column: string) {
	if (!value) {
		return undefined;
	}

	return parseObject<T>(value, column);
}

function parseObject<T>(value: string, column: string): T {
	const parsed = parseJson(value, column);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`Expected ${column} to contain a JSON object`);
	}

	return parsed as T;
}

function parseJson(value: string, column: string): unknown {
	try {
		return JSON.parse(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in ${column}: ${message}`);
	}
}
