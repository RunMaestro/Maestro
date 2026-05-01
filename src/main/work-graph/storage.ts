import crypto from 'crypto';
import type Database from 'better-sqlite3';
import {
	WORK_GRAPH_READY_TAG,
	type AgentReadyWorkFilter,
	type TagDefinition,
	type WorkGraphActor,
	type WorkGraphImportInput,
	type WorkGraphImportSummary,
	type WorkGraphListResult,
	type WorkItem,
	type WorkItemClaim,
	type WorkItemClaimCompleteInput,
	type WorkItemClaimInput,
	type WorkItemClaimReleaseInput,
	type WorkItemClaimRenewInput,
	type WorkItemCreateInput,
	type WorkItemDependency,
	type WorkItemEvent,
	type WorkItemEventCreateInput,
	type WorkItemFilters,
	type WorkItemSearchFilters,
	type WorkItemSourceInput,
	type WorkItemUpdateInput,
} from '../../shared/work-graph-types';
import type { DeliveryPlannerWorkGraphStore } from '../delivery-planner/planner-service';
import { resolveInsideRoot } from '../../shared/pathUtils';
import type { WorkGraphDB } from './work-graph-db';
import { getWorkGraphDB } from './singleton';
import type {
	WorkGraphFrontmatterRecord,
	WorkGraphMirrorKind,
	WorkGraphMirrorWriteResult,
} from './disk-mirror';
import {
	mapTagDefinitionRow,
	mapWorkItemClaimRow,
	mapWorkItemDependencyRow,
	mapWorkItemEventRow,
	mapWorkItemRow,
	mapWorkItemMirrorRow,
	type TagDefinitionRow,
	type WorkItemClaimRow,
	type WorkItemDependencyRow,
	type WorkItemEventRow,
	type WorkItemMirror,
	type WorkItemMirrorRow,
	type WorkItemRow,
	type WorkItemSourceReference,
	type WorkItemSourceRow,
	mapWorkItemSourceRow,
} from './row-mappers';

type SqlParam = string | number | null;

interface WorkItemIdRow {
	id: string;
}

export interface WorkItemDependencyGraph {
	item: WorkItem;
	dependencies: WorkItem[];
	dependents: WorkItem[];
	edges: WorkItemDependency[];
}

export interface WorkGraphStorageMirrorWriteInput {
	id: string;
	kind?: WorkGraphMirrorKind;
	mirrorPath?: string;
	slug?: string;
	body?: string;
	frontmatter?: WorkGraphFrontmatterRecord;
	expectedMirrorHash?: string;
	allowOverwrite?: boolean;
}

export interface WorkGraphStorageMirrorSyncInput {
	id: string;
	filePath?: string;
	mirrorPath?: string;
}

export class WorkGraphStorage implements DeliveryPlannerWorkGraphStore {
	constructor(private readonly workGraphDb: WorkGraphDB = getWorkGraphDB()) {}

	async createItem(input: WorkItemCreateInput, actor?: WorkGraphActor): Promise<WorkItem> {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const id = crypto.randomUUID();
		const tags = normalizeTags(input.tags ?? []);
		const slug = makeSlug(input.title);

		const run = db.transaction(() => {
			this.upsertTags(tags, input.source, timestamp);
			db.prepare(
				`
					INSERT INTO work_items (
						id, type, status, title, description, project_path, git_path, mirror_hash,
						source, readonly, slug, parent_work_item_id, owner_json, github_json,
						capabilities_json, priority, due_at, completed_at, metadata_json, created_at, updated_at
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
				`
			).run(
				id,
				input.type,
				input.status ?? 'discovered',
				input.title,
				input.description ?? null,
				input.projectPath,
				input.gitPath,
				input.mirrorHash ?? null,
				input.source,
				input.readonly ? 1 : 0,
				slug,
				input.parentWorkItemId ?? null,
				toJson(input.owner),
				toJson(input.github),
				toJson(input.capabilities ?? []),
				input.priority ?? null,
				input.dueAt ?? null,
				toJson(input.metadata),
				timestamp,
				timestamp
			);
			this.replaceItemTags(id, input.projectPath, input.source, tags, timestamp);
			for (const dependency of input.dependencies ?? []) {
				this.insertDependency({ ...dependency, fromWorkItemId: id }, actor, timestamp);
			}
			this.refreshFts(id);
		});

		run();
		return this.requireItem(id);
	}

	async updateItem(
		input: WorkItemUpdateInput,
		opts?: { expectedVersion?: number }
	): Promise<WorkItem> {
		const db = this.getDb();
		const current = await this.getItem(input.id);
		if (!current) {
			throw new Error(`Unknown Work Graph item: ${input.id}`);
		}
		if (input.expectedUpdatedAt && input.expectedUpdatedAt !== current.updatedAt) {
			throw new Error(`Work Graph item changed since ${input.expectedUpdatedAt}: ${input.id}`);
		}
		if (opts?.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
			const err = new Error(
				`STALE_VERSION: Work Graph item ${input.id} has version ${current.version}, expected ${opts.expectedVersion}`
			);
			(err as Error & { code: string; currentVersion: number }).code = 'STALE_VERSION';
			(err as Error & { code: string; currentVersion: number }).currentVersion = current.version;
			throw err;
		}
		if (current.readonly && input.patch.readonly !== false) {
			throw new Error(`Readonly Work Graph item must be adopted before update: ${input.id}`);
		}

		const timestamp = new Date().toISOString();
		const nextVersion = current.version + 1;
		const next: WorkItem = {
			...current,
			...input.patch,
			readonly: input.patch.readonly ?? current.readonly,
			slug: input.patch.slug ?? (input.patch.title ? makeSlug(input.patch.title) : current.slug),
			version: nextVersion,
			updatedAt: timestamp,
		};

		const run = db.transaction(() => {
			db.prepare(
				`
					UPDATE work_items SET
						type = ?, status = ?, title = ?, description = ?, project_path = ?, git_path = ?,
						mirror_hash = ?, source = ?, readonly = ?, slug = ?, parent_work_item_id = ?,
						owner_json = ?, github_json = ?, capabilities_json = ?, priority = ?, due_at = ?,
						completed_at = ?, metadata_json = ?, version = ?, updated_at = ?
					WHERE id = ?
				`
			).run(
				next.type,
				next.status,
				next.title,
				next.description ?? null,
				next.projectPath,
				next.gitPath,
				next.mirrorHash ?? null,
				next.source,
				next.readonly ? 1 : 0,
				next.slug ?? makeSlug(next.title),
				next.parentWorkItemId ?? null,
				toJson(next.owner),
				toJson(next.github),
				toJson(next.capabilities ?? []),
				next.priority ?? null,
				next.dueAt ?? null,
				next.completedAt ?? null,
				toJson(next.metadata),
				nextVersion,
				timestamp,
				next.id
			);

			if (input.patch.tags) {
				const tags = normalizeTags(input.patch.tags);
				this.upsertTags(tags, next.source, timestamp);
				this.replaceItemTags(next.id, next.projectPath, next.source, tags, timestamp);
			}
			if (input.patch.dependencies) {
				db.prepare('DELETE FROM work_item_dependencies WHERE from_work_item_id = ?').run(next.id);
				for (const dependency of input.patch.dependencies) {
					this.insertDependency(dependency, input.actor, timestamp);
				}
			}
			this.refreshFts(next.id);
		});

		run();
		return this.requireItem(input.id);
	}

	async deleteItem(id: string): Promise<boolean> {
		const db = this.getDb();
		const run = db.transaction(() => {
			db.prepare('DELETE FROM work_item_fts WHERE work_item_id = ?').run(id);
			return db.prepare('DELETE FROM work_items WHERE id = ?').run(id).changes > 0;
		});
		return run();
	}

	async getItem(id: string): Promise<WorkItem | undefined> {
		const db = this.getDb();
		const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as
			| WorkItemRow
			| undefined;
		if (!row) {
			return undefined;
		}
		return this.hydrateItem(row);
	}

	async listItems(filters: WorkItemFilters = {}): Promise<WorkGraphListResult> {
		return this.listByIds(this.queryItemIds(filters), filters);
	}

	async searchItems(filters: WorkItemSearchFilters): Promise<WorkGraphListResult> {
		const db = this.getDb();
		const normalizedTags = normalizeTags(filters.tags ?? []);
		const ftsRows = db
			.prepare(
				`
					SELECT work_item_id AS id
					FROM work_item_fts
					WHERE work_item_fts MATCH ?
					ORDER BY rank
				`
			)
			.all(filters.query) as WorkItemIdRow[];
		const ids = ftsRows.map((row) => row.id);
		const searchFilters = { ...filters, ids, tags: normalizedTags };
		return this.listByIds(this.queryItemIds(searchFilters), searchFilters);
	}

	async getDependencyGraph(id: string): Promise<WorkItemDependencyGraph | undefined> {
		const item = await this.getItem(id);
		if (!item) {
			return undefined;
		}

		const db = this.getDb();
		const dependencyEdges = db
			.prepare('SELECT * FROM work_item_dependencies WHERE from_work_item_id = ?')
			.all(id) as WorkItemDependencyRow[];
		const dependentEdges = db
			.prepare('SELECT * FROM work_item_dependencies WHERE to_work_item_id = ?')
			.all(id) as WorkItemDependencyRow[];
		const edges = [...dependencyEdges, ...dependentEdges].map(mapWorkItemDependencyRow);
		const dependencies = await Promise.all(
			dependencyEdges.map((edge) => this.requireItem(edge.to_work_item_id))
		);
		const dependents = await Promise.all(
			dependentEdges.map((edge) => this.requireItem(edge.from_work_item_id))
		);

		return { item, dependencies, dependents, edges };
	}

	async getUnblockedWorkItems(filters: AgentReadyWorkFilter = {}): Promise<WorkGraphListResult> {
		return this.listItems({
			...filters,
			tags: [...normalizeTags(filters.tags ?? []), WORK_GRAPH_READY_TAG],
			statuses: filters.statuses ?? ['ready', 'planned', 'discovered'],
			capabilityRouting: {
				...filters.capabilityRouting,
				agentCapabilities: filters.capabilityTags ?? filters.capabilityRouting?.agentCapabilities,
				requireReadyTag: true,
				readyTag: WORK_GRAPH_READY_TAG,
			},
		});
	}

	async importItems(input: WorkGraphImportInput): Promise<WorkGraphImportSummary> {
		const startedAt = new Date().toISOString();
		const summary: WorkGraphImportSummary = {
			source: input.source,
			projectPath: input.projectPath,
			gitPath: input.gitPath,
			mirrorHash: input.mirrorHash,
			startedAt,
			completedAt: startedAt,
			created: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			items: [],
		};

		for (const item of input.items) {
			try {
				const {
					capabilityRouting: _capabilityRouting,
					dependencies: _dependencies,
					...itemPatch
				} = item;
				const existing = item.github?.issueNumber
					? (
							await this.listItems({
								githubRepository: item.github.repository,
								githubIssueNumber: item.github.issueNumber,
								limit: 1,
							})
						).items[0]
					: undefined;

				if (existing && input.updateExisting) {
					const updated = await this.updateItem({
						id: existing.id,
						actor: input.actor,
						patch: {
							...itemPatch,
							source: item.source ?? input.source,
							projectPath: item.projectPath ?? input.projectPath,
							gitPath: item.gitPath ?? input.gitPath,
							mirrorHash: item.mirrorHash ?? input.mirrorHash,
						},
					});
					summary.updated += 1;
					summary.items.push({ workItemId: updated.id, title: updated.title, status: 'updated' });
					continue;
				}
				if (existing) {
					summary.skipped += 1;
					summary.items.push({
						workItemId: existing.id,
						title: existing.title,
						status: 'skipped',
						message: 'Matching Work Graph item already exists.',
					});
					continue;
				}

				const created = await this.createItem(
					{
						...item,
						source: item.source ?? input.source,
						projectPath: item.projectPath ?? input.projectPath,
						gitPath: item.gitPath ?? input.gitPath,
						mirrorHash: item.mirrorHash ?? input.mirrorHash,
					},
					input.actor
				);
				summary.created += 1;
				summary.items.push({ workItemId: created.id, title: created.title, status: 'created' });
			} catch (error) {
				summary.failed += 1;
				summary.items.push({
					externalId: item.github?.issueNumber?.toString(),
					title: item.title,
					status: 'failed',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}

		summary.completedAt = new Date().toISOString();
		return summary;
	}

	async addDependency(
		dependency: Omit<WorkItemDependency, 'id' | 'createdAt'>
	): Promise<WorkItemDependency> {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const run = db.transaction(() => {
			const created = this.insertDependency(dependency, dependency.createdBy, timestamp);
			this.touchItem(dependency.fromWorkItemId, timestamp);
			return created;
		});
		return run();
	}

	async recordEvent(input: WorkItemEventCreateInput): Promise<WorkItemEvent> {
		return this.insertEvent(input);
	}

	async listEvents(workItemId: string, limit = 100): Promise<WorkItemEvent[]> {
		const rows = this.getDb()
			.prepare(
				`
					SELECT *
					FROM work_item_events
					WHERE work_item_id = ?
					ORDER BY timestamp DESC, id DESC
					LIMIT ?
				`
			)
			.all(workItemId, Math.max(1, limit)) as WorkItemEventRow[];
		return rows.map(mapWorkItemEventRow);
	}

	async upsertTag(definition: TagDefinition): Promise<TagDefinition> {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const name = normalizeTag(definition.name);
		db.prepare(
			`
				INSERT INTO tag_registry (
					name, description, color, source, readonly, canonical, capabilities_json, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET
					description = excluded.description,
					color = excluded.color,
					source = excluded.source,
					readonly = excluded.readonly,
					canonical = excluded.canonical,
					capabilities_json = excluded.capabilities_json,
					updated_at = excluded.updated_at
			`
		).run(
			name,
			definition.description ?? null,
			definition.color ?? null,
			definition.source,
			definition.readonly ? 1 : 0,
			definition.canonical ? 1 : 0,
			toJson(definition.capabilities ?? []),
			definition.createdAt ?? timestamp,
			timestamp
		);
		return this.requireTag(name);
	}

	async listTags(): Promise<TagDefinition[]> {
		const rows = this.getDb()
			.prepare('SELECT * FROM tag_registry ORDER BY name ASC')
			.all() as TagDefinitionRow[];
		return rows.map(mapTagDefinitionRow);
	}

	async claimItem(input: WorkItemClaimInput, actor?: WorkGraphActor): Promise<WorkItemClaim> {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const claimId = crypto.randomUUID();

		const txn = db.transaction(() => {
			this.expireStaleClaims(input.workItemId, timestamp);

			const itemRow = db
				.prepare('SELECT id, status FROM work_items WHERE id = ?')
				.get(input.workItemId) as { id: string; status: string } | undefined;
			if (!itemRow) {
				throw new Error(`Unknown Work Graph item: ${input.workItemId}`);
			}

			const existing = db
				.prepare(`SELECT id FROM work_item_claims WHERE work_item_id = ? AND status = 'active'`)
				.get(input.workItemId) as { id: string } | undefined;
			if (existing) {
				throw new Error(
					`Work Graph item ${input.workItemId} already has an active claim: ${existing.id}`
				);
			}

			db.prepare(
				`
					INSERT INTO work_item_claims (
						id, work_item_id, owner_type, owner_id, owner_json,
						status, source, claimed_at, expires_at, released_at, completed_at, note
					)
					VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, ?)
				`
			).run(
				claimId,
				input.workItemId,
				input.owner.type,
				input.owner.id,
				toJson(input.owner) ?? '{}',
				input.source ?? 'manual',
				timestamp,
				input.expiresAt ?? null,
				input.note ?? null
			);

			if (
				itemRow.status === 'ready' ||
				itemRow.status === 'planned' ||
				itemRow.status === 'discovered'
			) {
				db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(
					'claimed',
					timestamp,
					input.workItemId
				);
			} else {
				this.touchItem(input.workItemId, timestamp);
			}

			this.insertEvent({
				workItemId: input.workItemId,
				type: 'claimed',
				actor: actor ?? {
					type: input.owner.type === 'user' ? 'user' : 'agent',
					id: input.owner.id,
					name: input.owner.name,
					agentId: input.owner.agentId,
					providerSessionId: input.owner.providerSessionId,
				},
				timestamp,
				after: { claim: { id: claimId } as WorkItemClaim },
				message: input.note,
				newState: { claimId, claimStatus: 'active', claimSource: input.source ?? 'manual' },
				reason: input.note,
			});

			const row = db
				.prepare('SELECT * FROM work_item_claims WHERE id = ?')
				.get(claimId) as WorkItemClaimRow;
			return mapWorkItemClaimRow(row);
		});

		return txn();
	}

	async renewClaim(input: WorkItemClaimRenewInput): Promise<WorkItemClaim> {
		const current = this.requireActiveClaim(input.workItemId, input.claimId, input.owner);
		const timestamp = new Date().toISOString();

		this.getDb()
			.prepare('UPDATE work_item_claims SET expires_at = ?, note = ? WHERE id = ?')
			.run(input.expiresAt, input.note ?? current.note ?? null, current.id);
		this.touchItem(input.workItemId, timestamp);

		return this.requireClaim(current.id);
	}

	async releaseClaim(input: WorkItemClaimReleaseInput): Promise<WorkItemClaim>;
	async releaseClaim(
		workItemId: string,
		options?: { note?: string; actor?: WorkGraphActor; revertStatusTo?: WorkItem['status'] }
	): Promise<WorkItemClaim | undefined>;
	async releaseClaim(
		inputOrWorkItemId: WorkItemClaimReleaseInput | string,
		options: { note?: string; actor?: WorkGraphActor; revertStatusTo?: WorkItem['status'] } = {}
	): Promise<WorkItemClaim | undefined> {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const structuredInput = typeof inputOrWorkItemId !== 'string';
		const workItemId = structuredInput ? inputOrWorkItemId.workItemId : inputOrWorkItemId;
		const note = structuredInput ? inputOrWorkItemId.note : options.note;

		const txn = db.transaction(() => {
			const clauses = ['work_item_id = ?', "status = 'active'"];
			const params = [workItemId];
			if (structuredInput && inputOrWorkItemId.claimId) {
				clauses.push('id = ?');
				params.push(inputOrWorkItemId.claimId);
			}
			if (structuredInput && inputOrWorkItemId.owner) {
				clauses.push('owner_type = ?', 'owner_id = ?');
				params.push(inputOrWorkItemId.owner.type, inputOrWorkItemId.owner.id);
			}

			const claim = db
				.prepare(`SELECT * FROM work_item_claims WHERE ${clauses.join(' AND ')}`)
				.get(...params) as WorkItemClaimRow | undefined;
			if (!claim) {
				if (structuredInput) {
					throw new Error(`No active Work Graph claim found for item: ${workItemId}`);
				}
				return undefined;
			}

			db.prepare(
				`UPDATE work_item_claims SET status = 'released', released_at = ?, note = COALESCE(?, note) WHERE id = ?`
			).run(timestamp, note ?? null, claim.id);

			const itemRow = db
				.prepare('SELECT id, status FROM work_items WHERE id = ?')
				.get(workItemId) as { id: string; status: string } | undefined;
			if (itemRow && itemRow.status === 'claimed') {
				db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?').run(
					options.revertStatusTo ?? 'ready',
					timestamp,
					workItemId
				);
			} else {
				this.touchItem(workItemId, timestamp);
			}

			this.insertEvent({
				workItemId,
				type: 'released',
				actor: options.actor ?? { type: 'system', id: 'work-graph' },
				timestamp,
				before: { claim: mapWorkItemClaimRow(claim) },
				message: note,
				priorState: { claimId: claim.id, claimStatus: 'active' },
				newState: { claimStatus: 'released', revertStatusTo: options.revertStatusTo ?? 'ready' },
				reason: note,
			});

			const updated = db
				.prepare('SELECT * FROM work_item_claims WHERE id = ?')
				.get(claim.id) as WorkItemClaimRow;
			return mapWorkItemClaimRow(updated);
		});

		return txn();
	}

	async completeClaim(input: WorkItemClaimCompleteInput): Promise<WorkItemClaim> {
		const current = this.requireActiveClaim(input.workItemId, input.claimId, input.owner);
		const timestamp = new Date().toISOString();

		this.getDb()
			.prepare(
				`UPDATE work_item_claims SET status = 'completed', completed_at = ?, note = ? WHERE id = ?`
			)
			.run(timestamp, input.note ?? current.note ?? null, current.id);
		this.touchItem(input.workItemId, timestamp);

		return this.requireClaim(current.id);
	}

	async upsertSource(input: WorkItemSourceInput): Promise<WorkItemSourceReference> {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const id = crypto.randomUUID();
		db.prepare(
			`
				INSERT INTO work_item_sources (
					id, work_item_id, source, project_path, git_path, external_type,
					external_id, url, metadata_json, imported_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(source, project_path, external_type, external_id) DO UPDATE SET
					work_item_id = excluded.work_item_id,
					git_path = excluded.git_path,
					url = excluded.url,
					metadata_json = excluded.metadata_json,
					imported_at = excluded.imported_at
			`
		).run(
			id,
			input.workItemId,
			input.source,
			input.projectPath,
			input.gitPath,
			input.externalType,
			input.externalId,
			input.url ?? null,
			toJson(input.metadata),
			timestamp
		);

		const row = db
			.prepare(
				`
					SELECT *
					FROM work_item_sources
					WHERE source = ? AND project_path = ? AND external_type = ? AND external_id = ?
				`
			)
			.get(input.source, input.projectPath, input.externalType, input.externalId) as
			| WorkItemSourceRow
			| undefined;
		if (!row) {
			throw new Error(`Failed to upsert Work Graph source: ${input.externalId}`);
		}
		return mapWorkItemSourceRow(row);
	}

	async getSource(
		input: Pick<WorkItemSourceInput, 'source' | 'projectPath' | 'externalType' | 'externalId'>
	): Promise<WorkItemSourceReference | undefined> {
		const row = this.getDb()
			.prepare(
				`
					SELECT *
					FROM work_item_sources
					WHERE source = ? AND project_path = ? AND external_type = ? AND external_id = ?
				`
			)
			.get(input.source, input.projectPath, input.externalType, input.externalId) as
			| WorkItemSourceRow
			| undefined;
		return row ? mapWorkItemSourceRow(row) : undefined;
	}

	async writeDiskMirror(
		input: WorkGraphStorageMirrorWriteInput
	): Promise<WorkGraphMirrorWriteResult> {
		const { writeWorkGraphMirror } = await import('./disk-mirror');
		const item = await this.requireItem(input.id);
		const result = await writeWorkGraphMirror({
			item,
			kind: input.kind,
			mirrorPath: input.mirrorPath,
			slug: input.slug,
			body: input.body,
			frontmatter: input.frontmatter,
			expectedMirrorHash: input.expectedMirrorHash,
			allowOverwrite: input.allowOverwrite,
		});

		if (result.status !== 'conflict' && result.mirrorHash) {
			this.recordMirror({
				item,
				mirrorPath: result.mirrorPath,
				mirrorHash: result.mirrorHash,
				frontmatter: result.frontmatter,
			});
		}

		return result;
	}

	async syncDiskMirror(input: WorkGraphStorageMirrorSyncInput): Promise<WorkItemMirror> {
		const { importWorkGraphMirror } = await import('./disk-mirror');
		const item = await this.requireItem(input.id);
		const mirrorPath = input.mirrorPath ?? this.getPrimaryMirrorPath(item.id);
		const filePath =
			input.filePath ??
			(mirrorPath ? resolveInsideRoot(item.projectPath, ...mirrorPath.split('/')) : undefined);

		if (!filePath && !mirrorPath) {
			throw new Error(`No Work Graph mirror path recorded for item: ${input.id}`);
		}

		const imported = await importWorkGraphMirror(item.projectPath, filePath!);

		return this.recordMirror({
			item,
			mirrorPath: imported.mirrorPath,
			mirrorHash: imported.mirrorHash,
			frontmatter: imported.frontmatter,
		});
	}

	async listMirrors(id: string): Promise<WorkItemMirror[]> {
		const rows = this.getDb()
			.prepare('SELECT * FROM work_item_mirrors WHERE work_item_id = ? ORDER BY mirror_path ASC')
			.all(id) as WorkItemMirrorRow[];
		return rows.map(mapWorkItemMirrorRow);
	}

	async listActiveClaims(): Promise<WorkItemClaim[]> {
		const rows = this.getDb()
			.prepare(
				`
					SELECT *
					FROM work_item_claims
					WHERE status = 'active'
					ORDER BY claimed_at ASC, id ASC
				`
			)
			.all() as WorkItemClaimRow[];
		return rows.map(mapWorkItemClaimRow);
	}

	private getDb(): Database.Database {
		if (!this.workGraphDb.isReady()) {
			this.workGraphDb.initialize();
		}
		return this.workGraphDb.database;
	}

	private queryItemIds(filters: WorkItemFilters): string[] {
		const db = this.getDb();
		const clauses: string[] = [];
		const params: SqlParam[] = [];

		if (filters.ids && filters.ids.length === 0) {
			return [];
		}

		appendInClause(clauses, params, 'wi.id', filters.ids);
		appendInClause(clauses, params, 'wi.type', filters.types);
		appendInClause(clauses, params, 'wi.status', filters.statuses);
		appendEqualClause(clauses, params, 'wi.project_path', filters.projectPath);
		appendEqualClause(clauses, params, 'wi.git_path', filters.gitPath);
		appendSourceClause(clauses, params, filters.source);
		appendEqualClause(clauses, params, 'wi.readonly', boolToDb(filters.readonly));
		appendEqualClause(clauses, params, 'json_extract(wi.owner_json, "$.id")', filters.ownerId);
		appendEqualClause(clauses, params, 'json_extract(wi.owner_json, "$.type")', filters.ownerType);
		appendEqualClause(
			clauses,
			params,
			'json_extract(wi.github_json, "$.repository")',
			filters.githubRepository
		);
		appendEqualClause(
			clauses,
			params,
			'json_extract(wi.github_json, "$.issueNumber")',
			filters.githubIssueNumber
		);
		appendEqualClause(
			clauses,
			params,
			'json_extract(wi.github_json, "$.pullRequestNumber")',
			filters.githubPullRequestNumber
		);
		if (!filters.statuses) {
			clauses.push('wi.status != ?');
			params.push('archived');
		}
		if (filters.updatedAfter) {
			clauses.push('wi.updated_at > ?');
			params.push(filters.updatedAfter);
		}
		if (filters.updatedBefore) {
			clauses.push('wi.updated_at < ?');
			params.push(filters.updatedBefore);
		}
		for (const tag of normalizeTags(filters.tags ?? [])) {
			clauses.push(
				'EXISTS (SELECT 1 FROM work_item_tags wit WHERE wit.work_item_id = wi.id AND wit.tag = ?)'
			);
			params.push(tag);
		}
		const anyTags = normalizeTags(filters.anyTags ?? []);
		if (anyTags.length > 0) {
			clauses.push(
				`EXISTS (SELECT 1 FROM work_item_tags wit WHERE wit.work_item_id = wi.id AND wit.tag IN (${placeholders(anyTags.length)}))`
			);
			params.push(...anyTags);
		}
		for (const tag of normalizeTags(filters.excludeTags ?? [])) {
			clauses.push(
				'NOT EXISTS (SELECT 1 FROM work_item_tags wit WHERE wit.work_item_id = wi.id AND wit.tag = ?)'
			);
			params.push(tag);
		}
		const agentCapabilities = normalizeTags(filters.capabilityRouting?.agentCapabilities ?? []);
		if (agentCapabilities.length > 0) {
			clauses.push(
				`(
					EXISTS (
						SELECT 1
						FROM work_item_tags wit
						WHERE wit.work_item_id = wi.id
							AND wit.tag IN (${placeholders(agentCapabilities.length)})
					)
					OR EXISTS (
						SELECT 1
						FROM json_each(wi.capabilities_json)
						WHERE json_each.value IN (${placeholders(agentCapabilities.length)})
					)
				)`
			);
			params.push(...agentCapabilities, ...agentCapabilities);
		}
		if (filters.capabilityRouting?.requireReadyTag || filters.capabilityRouting?.readyTag) {
			clauses.push(
				'EXISTS (SELECT 1 FROM work_item_tags wit WHERE wit.work_item_id = wi.id AND wit.tag = ?)'
			);
			params.push(filters.capabilityRouting.readyTag ?? WORK_GRAPH_READY_TAG);
		}
		if (isAgentReadyFilter(filters)) {
			clauses.push('wi.status != ?');
			params.push('archived');
			clauses.push(
				`
					NOT EXISTS (
						SELECT 1
						FROM work_item_dependencies dep
						JOIN work_items blocker ON blocker.id = dep.to_work_item_id
						WHERE dep.from_work_item_id = wi.id
							AND dep.status = 'active'
							AND blocker.status != 'done'
					)
				`
			);
			if (filters.excludeClaimed) {
				if (filters.excludeExpiredClaims) {
					clauses.push(
						`
						NOT EXISTS (
							SELECT 1 FROM work_item_claims claim
							WHERE claim.work_item_id = wi.id AND claim.status = 'active'
								AND (claim.expires_at IS NULL OR claim.expires_at > ?)
						)
					`
					);
					params.push(new Date().toISOString());
				} else {
					clauses.push(
						`
						NOT EXISTS (
							SELECT 1 FROM work_item_claims claim
							WHERE claim.work_item_id = wi.id AND claim.status = 'active'
						)
					`
					);
				}
			}
		}

		const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
		const limit = filters.limit && filters.limit > 0 ? filters.limit : undefined;
		const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) || 0 : 0;
		const rows = db
			.prepare(
				`
					SELECT wi.id
					FROM work_items wi
					${where}
					ORDER BY wi.updated_at DESC, wi.created_at DESC, wi.id ASC
					${limit ? 'LIMIT ? OFFSET ?' : ''}
				`
			)
			.all(...(limit ? [...params, limit, offset] : params)) as WorkItemIdRow[];
		return rows.map((row) => row.id);
	}

	private async listByIds(ids: string[], filters: WorkItemFilters): Promise<WorkGraphListResult> {
		const items = await Promise.all(ids.map((id) => this.requireItem(id)));
		const total = this.countItems(filters);
		const limit = filters.limit && filters.limit > 0 ? filters.limit : undefined;
		const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) || 0 : 0;
		const nextCursor = limit && offset + limit < total ? String(offset + limit) : undefined;
		return { items, nextCursor, total };
	}

	private countItems(filters: WorkItemFilters): number {
		const countFilters = { ...filters, limit: undefined, cursor: undefined };
		return this.queryItemIds(countFilters).length;
	}

	private async requireItem(id: string): Promise<WorkItem> {
		const item = await this.getItem(id);
		if (!item) {
			throw new Error(`Unknown Work Graph item: ${id}`);
		}
		return item;
	}

	private hydrateItem(row: WorkItemRow): WorkItem {
		const db = this.getDb();
		const tags = db
			.prepare('SELECT tag FROM work_item_tags WHERE work_item_id = ? ORDER BY tag ASC')
			.all(row.id) as Array<{ tag: string }>;
		const dependencies = db
			.prepare(
				'SELECT * FROM work_item_dependencies WHERE from_work_item_id = ? ORDER BY created_at ASC'
			)
			.all(row.id) as WorkItemDependencyRow[];
		const claim = db
			.prepare('SELECT * FROM work_item_claims WHERE work_item_id = ? AND status = ?')
			.get(row.id, 'active') as WorkItemClaimRow | undefined;

		return mapWorkItemRow(row, {
			tags: tags.map((tagRow) => tagRow.tag),
			dependencies: dependencies.map(mapWorkItemDependencyRow),
			claim: claim ? mapWorkItemClaimRow(claim) : undefined,
		});
	}

	private insertDependency(
		dependency: Omit<WorkItemDependency, 'id' | 'createdAt'>,
		actor: WorkGraphActor | undefined,
		timestamp: string
	): WorkItemDependency {
		const created: WorkItemDependency = {
			...dependency,
			id: crypto.randomUUID(),
			createdAt: timestamp,
			createdBy: dependency.createdBy ?? actor,
		};
		this.getDb()
			.prepare(
				`
					INSERT INTO work_item_dependencies (
						id, from_work_item_id, to_work_item_id, type, status, created_at, created_by_json
					)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(from_work_item_id, to_work_item_id, type) DO UPDATE SET
						status = excluded.status,
						created_by_json = excluded.created_by_json
				`
			)
			.run(
				created.id,
				created.fromWorkItemId,
				created.toWorkItemId,
				created.type,
				created.status,
				created.createdAt,
				toJson(created.createdBy)
			);
		return created;
	}

	private upsertTags(tags: string[], source: string, timestamp: string): void {
		for (const tag of tags) {
			this.getDb()
				.prepare(
					`
						INSERT INTO tag_registry (
							name, source, readonly, canonical, capabilities_json, created_at, updated_at
						)
						VALUES (?, ?, 0, 0, '[]', ?, ?)
						ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at
					`
				)
				.run(tag, source, timestamp, timestamp);
		}
	}

	private replaceItemTags(
		workItemId: string,
		projectPath: string,
		source: string,
		tags: string[],
		timestamp: string
	): void {
		const db = this.getDb();
		db.prepare('DELETE FROM work_item_tags WHERE work_item_id = ?').run(workItemId);
		for (const tag of tags) {
			db.prepare(
				`
					INSERT OR IGNORE INTO work_item_tags (work_item_id, project_path, tag, source, created_at)
					VALUES (?, ?, ?, ?, ?)
				`
			).run(workItemId, projectPath, tag, source, timestamp);
		}
	}

	private refreshFts(workItemId: string): void {
		const db = this.getDb();
		const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItemId) as
			| WorkItemRow
			| undefined;
		if (!item) {
			return;
		}
		const tags = db
			.prepare('SELECT tag FROM work_item_tags WHERE work_item_id = ? ORDER BY tag ASC')
			.all(workItemId) as Array<{ tag: string }>;
		db.prepare('DELETE FROM work_item_fts WHERE work_item_id = ?').run(workItemId);
		db.prepare(
			`
				INSERT INTO work_item_fts (work_item_id, title, description, tags, metadata)
				VALUES (?, ?, ?, ?, ?)
			`
		).run(
			workItemId,
			item.title,
			item.description ?? '',
			tags.map((tag) => tag.tag).join(' '),
			item.metadata_json ?? ''
		);
	}

	private touchItem(workItemId: string, timestamp: string): void {
		this.getDb()
			.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?')
			.run(timestamp, workItemId);
	}

	private insertEvent(params: WorkItemEventCreateInput): WorkItemEvent {
		const event: WorkItemEvent = {
			id: crypto.randomUUID(),
			workItemId: params.workItemId,
			type: params.type,
			actor: params.actor,
			timestamp: params.timestamp ?? new Date().toISOString(),
			before: params.before,
			after: params.after,
			message: params.message,
			priorState: params.priorState,
			newState: params.newState,
			reason: params.reason,
			artifactLink: params.artifactLink,
		};

		this.getDb()
			.prepare(
				`
					INSERT INTO work_item_events (
						id, work_item_id, type, actor_json, timestamp, before_json, after_json, message,
						prior_state_json, new_state_json, reason, artifact_link
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`
			)
			.run(
				event.id,
				event.workItemId,
				event.type,
				toJson(event.actor),
				event.timestamp,
				toJson(event.before),
				toJson(event.after),
				event.message ?? null,
				toJson(event.priorState),
				toJson(event.newState),
				event.reason ?? null,
				event.artifactLink ?? null
			);
		return event;
	}

	private requireTag(name: string): TagDefinition {
		const row = this.getDb().prepare('SELECT * FROM tag_registry WHERE name = ?').get(name) as
			| TagDefinitionRow
			| undefined;
		if (!row) {
			throw new Error(`Unknown Work Graph tag: ${name}`);
		}
		return mapTagDefinitionRow(row);
	}

	private requireActiveClaim(
		workItemId: string,
		claimId?: string,
		owner?: WorkItemClaim['owner']
	): WorkItemClaim {
		const clauses = ['work_item_id = ?', "status = 'active'"];
		const params: string[] = [workItemId];
		if (claimId) {
			clauses.push('id = ?');
			params.push(claimId);
		}
		if (owner) {
			clauses.push('owner_type = ?', 'owner_id = ?');
			params.push(owner.type, owner.id);
		}
		const row = this.getDb()
			.prepare(`SELECT * FROM work_item_claims WHERE ${clauses.join(' AND ')}`)
			.get(...params) as WorkItemClaimRow | undefined;
		if (!row) {
			throw new Error(`No active Work Graph claim found for item: ${workItemId}`);
		}
		return mapWorkItemClaimRow(row);
	}

	private requireClaim(id: string): WorkItemClaim {
		const row = this.getDb().prepare('SELECT * FROM work_item_claims WHERE id = ?').get(id) as
			| WorkItemClaimRow
			| undefined;
		if (!row) {
			throw new Error(`Unknown Work Graph claim: ${id}`);
		}
		return mapWorkItemClaimRow(row);
	}

	private expireStaleClaims(workItemId: string, timestamp: string): void {
		this.getDb()
			.prepare(
				`
					UPDATE work_item_claims
					SET status = 'expired'
					WHERE work_item_id = ?
						AND status = 'active'
						AND expires_at IS NOT NULL
						AND expires_at <= ?
				`
			)
			.run(workItemId, timestamp);
	}

	private recordMirror(input: {
		item: WorkItem;
		mirrorPath: string;
		mirrorHash: string;
		frontmatter?: Record<string, unknown>;
	}): WorkItemMirror {
		const db = this.getDb();
		const timestamp = new Date().toISOString();
		const id = crypto.randomUUID();
		const run = db.transaction(() => {
			db.prepare('UPDATE work_items SET mirror_hash = ?, updated_at = ? WHERE id = ?').run(
				input.mirrorHash,
				timestamp,
				input.item.id
			);
			db.prepare(
				`
					INSERT INTO work_item_mirrors (
						id, work_item_id, project_path, git_path, mirror_path, mirror_hash,
						frontmatter_json, synced_at
					)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(project_path, mirror_path) DO UPDATE SET
						work_item_id = excluded.work_item_id,
						git_path = excluded.git_path,
						mirror_hash = excluded.mirror_hash,
						frontmatter_json = excluded.frontmatter_json,
						synced_at = excluded.synced_at
				`
			).run(
				id,
				input.item.id,
				input.item.projectPath,
				input.item.gitPath,
				input.mirrorPath,
				input.mirrorHash,
				toJson(input.frontmatter),
				timestamp
			);
		});
		run();

		const row = db
			.prepare(
				`
					SELECT *
					FROM work_item_mirrors
					WHERE project_path = ? AND mirror_path = ?
				`
			)
			.get(input.item.projectPath, input.mirrorPath) as WorkItemMirrorRow | undefined;
		if (!row) {
			throw new Error(`Failed to record Work Graph mirror: ${input.mirrorPath}`);
		}
		return mapWorkItemMirrorRow(row);
	}

	private getPrimaryMirrorPath(workItemId: string): string | undefined {
		const row = this.getDb()
			.prepare(
				`
					SELECT mirror_path
					FROM work_item_mirrors
					WHERE work_item_id = ?
					ORDER BY synced_at DESC, mirror_path ASC
					LIMIT 1
				`
			)
			.get(workItemId) as { mirror_path: string } | undefined;
		return row?.mirror_path;
	}
}

export const WorkGraphItemStore = WorkGraphStorage;

let workGraphItemStore: WorkGraphStorage | null = null;

export function getWorkGraphItemStore(): WorkGraphStorage {
	if (!workGraphItemStore) {
		workGraphItemStore = new WorkGraphStorage();
	}
	return workGraphItemStore;
}

export function normalizeTag(tag: string): string {
	return tag
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function normalizeTags(tags: string[]): string[] {
	return [...new Set(tags.map(normalizeTag).filter(Boolean))].sort();
}

function makeSlug(title: string): string {
	return normalizeTag(title) || crypto.randomUUID();
}

function toJson(value: unknown): string | null {
	return value === undefined ? null : JSON.stringify(value);
}

function boolToDb(value: boolean | undefined): number | undefined {
	return value === undefined ? undefined : value ? 1 : 0;
}

function appendInClause(
	clauses: string[],
	params: SqlParam[],
	column: string,
	values: readonly string[] | undefined
): void {
	if (!values?.length) {
		return;
	}
	clauses.push(`${column} IN (${placeholders(values.length)})`);
	params.push(...values);
}

function appendEqualClause(
	clauses: string[],
	params: SqlParam[],
	column: string,
	value: SqlParam | undefined
): void {
	if (value === undefined) {
		return;
	}
	clauses.push(`${column} = ?`);
	params.push(value);
}

function appendSourceClause(
	clauses: string[],
	params: SqlParam[],
	source: WorkItemFilters['source']
): void {
	if (!source) {
		return;
	}
	const sources = Array.isArray(source) ? source : [source];
	appendInClause(clauses, params, 'wi.source', sources);
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => '?').join(', ');
}

function isAgentReadyFilter(filters: WorkItemFilters): filters is AgentReadyWorkFilter {
	return (
		filters.capabilityRouting?.requireReadyTag === true ||
		(filters as AgentReadyWorkFilter).requireUnblocked === true
	);
}
