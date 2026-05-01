import { describe, expect, it } from 'vitest';
import type {
	WorkGraphListResult,
	WorkItem,
	WorkItemCreateInput,
	WorkItemDependency,
	WorkItemFilters,
	WorkItemUpdateInput,
} from '../../../shared/work-graph-types';
import { LIVING_WIKI_DOC_GAP_TAG } from '../../../shared/living-wiki-types';
import {
	DeliveryPlannerService,
	DeliveryPlannerValidationError,
	type DeliveryPlannerWorkGraphStore,
} from '../planner-service';

class MemoryWorkGraphStore implements DeliveryPlannerWorkGraphStore {
	private items = new Map<string, WorkItem>();
	private seq = 0;
	private depSeq = 0;

	async createItem(input: WorkItemCreateInput): Promise<WorkItem> {
		const now = new Date().toISOString();
		const item: WorkItem = {
			...input,
			id: `item-${++this.seq}`,
			status: input.status ?? 'discovered',
			readonly: input.readonly ?? false,
			tags: input.tags ?? [],
			createdAt: now,
			updatedAt: now,
			dependencies: input.dependencies?.map((d) => ({
				...d,
				id: `dep-${++this.depSeq}`,
				createdAt: now,
			})),
		};
		this.items.set(item.id, item);
		return item;
	}

	async updateItem(input: WorkItemUpdateInput): Promise<WorkItem> {
		const item = this.items.get(input.id);
		if (!item) throw new Error(`Unknown item ${input.id}`);
		const updated: WorkItem = { ...item, ...input.patch, updatedAt: new Date().toISOString() };
		this.items.set(updated.id, updated);
		return updated;
	}

	async getItem(id: string): Promise<WorkItem | undefined> {
		return this.items.get(id);
	}

	async listItems(filters: WorkItemFilters = {}): Promise<WorkGraphListResult> {
		let items = [...this.items.values()];
		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			items = items.filter((item) => sources.includes(item.source));
		}
		if (filters.projectPath) {
			items = items.filter((item) => item.projectPath === filters.projectPath);
		}
		return { items, total: items.length };
	}

	async addDependency(
		dep: Omit<WorkItemDependency, 'id' | 'createdAt'>
	): Promise<WorkItemDependency> {
		return { ...dep, id: `dep-${++this.depSeq}`, createdAt: new Date().toISOString() };
	}
}

function makeDocGapInput(): WorkItemCreateInput {
	return {
		type: 'task',
		status: 'discovered',
		title: 'doc gap: src/services/auth.ts',
		description: 'Missing Living Wiki doc for auth service.',
		projectPath: '/workspace/myproject',
		gitPath: '/workspace/myproject',
		source: 'living-wiki',
		readonly: false,
		tags: [LIVING_WIKI_DOC_GAP_TAG],
		metadata: {
			sourceGitPath: 'src/services/auth.ts',
			area: 'api',
			slug: 'auth-service',
		},
	};
}

describe('DeliveryPlannerService.promoteDocGap', () => {
	it('creates a Delivery Planner task from a valid doc-gap item', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		const docGap = await store.createItem(makeDocGapInput());
		const result = await service.promoteDocGap({ docGapWorkItemId: docGap.id });

		expect(result.created).toBe(true);
		expect(result.task.type).toBe('task');
		expect(result.task.source).toBe('delivery-planner');
		expect(result.task.tags).toContain('delivery-planner');
		expect(result.task.tags).toContain('living-wiki-doc-gap-promotion');
		// CRITICAL: must NOT be tagged agent-ready
		expect(result.task.tags).not.toContain('agent-ready');
	});

	it('mirrors metadata from the doc-gap item into the promoted task', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		const docGap = await store.createItem(makeDocGapInput());
		const result = await service.promoteDocGap({ docGapWorkItemId: docGap.id });

		const lw = result.task.metadata?.livingWiki as Record<string, unknown>;
		expect(lw).toBeDefined();
		expect(lw.sourceDocGapId).toBe(docGap.id);
		expect(lw.sourceGitPath).toBe('src/services/auth.ts');
		expect(lw.area).toBe('api');
		expect(lw.slug).toBe('auth-service');
	});

	it('sets parentWorkItemId to the original doc-gap id', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		const docGap = await store.createItem(makeDocGapInput());
		const result = await service.promoteDocGap({ docGapWorkItemId: docGap.id });

		expect(result.task.parentWorkItemId).toBe(docGap.id);
	});

	it('is idempotent: second call returns existing task with created=false', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		const docGap = await store.createItem(makeDocGapInput());
		const first = await service.promoteDocGap({ docGapWorkItemId: docGap.id });
		const second = await service.promoteDocGap({ docGapWorkItemId: docGap.id });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.task.id).toBe(first.task.id);
	});

	it('rejects an item not tagged living-wiki-doc-gap', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		const plainTask = await store.createItem({
			type: 'task',
			status: 'planned',
			title: 'Regular task',
			projectPath: '/workspace/myproject',
			gitPath: '/workspace/myproject',
			source: 'delivery-planner',
			readonly: false,
			tags: ['delivery-planner'],
		});

		await expect(service.promoteDocGap({ docGapWorkItemId: plainTask.id })).rejects.toBeInstanceOf(
			DeliveryPlannerValidationError
		);
	});

	it('rejects an unknown work item id', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		await expect(
			service.promoteDocGap({ docGapWorkItemId: 'nonexistent-id' })
		).rejects.toBeInstanceOf(DeliveryPlannerValidationError);
	});

	it('falls back to docGapItem.gitPath when sourceGitPath metadata is absent', async () => {
		const store = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph: store });

		const docGap = await store.createItem({
			...makeDocGapInput(),
			metadata: {}, // no sourceGitPath
		});
		const result = await service.promoteDocGap({ docGapWorkItemId: docGap.id });

		const lw = result.task.metadata?.livingWiki as Record<string, unknown>;
		expect(lw.sourceGitPath).toBe(docGap.gitPath);
	});
});
