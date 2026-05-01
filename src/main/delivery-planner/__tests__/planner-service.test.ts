import { describe, expect, it, vi } from 'vitest';
import type {
	WorkGraphActor,
	WorkGraphListResult,
	WorkItem,
	WorkItemCreateInput,
	WorkItemDependency,
	WorkItemFilters,
	WorkItemUpdateInput,
} from '../../../shared/work-graph-types';
import { WORK_GRAPH_READY_TAG } from '../../../shared/work-graph-types';
import { DeliveryPlannerDecomposer } from '../decomposer';
import {
	DeliveryPlannerService,
	DeliveryPlannerValidationError,
	type DeliveryPlannerWorkGraphStore,
} from '../planner-service';

class MemoryWorkGraphStore implements DeliveryPlannerWorkGraphStore {
	private items = new Map<string, WorkItem>();
	private itemSequence = 0;
	private dependencySequence = 0;

	async createItem(input: WorkItemCreateInput): Promise<WorkItem> {
		const timestamp = new Date().toISOString();
		const item: WorkItem = {
			...input,
			id: `item-${++this.itemSequence}`,
			status: input.status ?? 'discovered',
			readonly: input.readonly ?? false,
			tags: input.tags ?? [],
			createdAt: timestamp,
			updatedAt: timestamp,
			dependencies: input.dependencies?.map((dependency) => ({
				...dependency,
				id: `dependency-${++this.dependencySequence}`,
				createdAt: timestamp,
			})),
		};

		this.items.set(item.id, item);
		return item;
	}

	async updateItem(input: WorkItemUpdateInput): Promise<WorkItem> {
		const item = this.items.get(input.id);
		if (!item) {
			throw new Error(`Unknown item ${input.id}`);
		}

		const updated: WorkItem = {
			...item,
			...input.patch,
			updatedAt: new Date().toISOString(),
		};
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
		if (filters.gitPath) {
			items = items.filter((item) => item.gitPath === filters.gitPath);
		}

		return { items, total: items.length };
	}

	async addDependency(
		dependency: Omit<WorkItemDependency, 'id' | 'createdAt'>
	): Promise<WorkItemDependency> {
		const created: WorkItemDependency = {
			...dependency,
			id: `dependency-${++this.dependencySequence}`,
			createdAt: new Date().toISOString(),
		};
		const item = this.items.get(dependency.fromWorkItemId);
		if (!item) {
			throw new Error(`Unknown item ${dependency.fromWorkItemId}`);
		}

		this.items.set(item.id, {
			...item,
			dependencies: [...(item.dependencies ?? []), created],
			updatedAt: new Date().toISOString(),
		});
		return created;
	}
}

const actor: WorkGraphActor = {
	type: 'user',
	id: 'test-user',
};

describe('DeliveryPlannerService', () => {
	it('creates PRDs through Work Graph storage and publishes item events', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const publish = vi.fn();
		const service = new DeliveryPlannerService({
			workGraph,
			events: { publish },
		});

		const prd = await service.createPrd({
			title: 'Improve planning',
			projectPath: '/project',
			gitPath: '/project',
			actor,
		});

		expect(prd.type).toBe('document');
		expect(prd.metadata).toMatchObject({ kind: 'prd', ccpmSlug: 'improve-planning' });
		expect(prd.tags).toContain('prd');
		expect(publish).toHaveBeenCalledWith('workGraph.item.created', { item: prd });
	});

	it('converts PRDs to epics and derives dashboards from Work Graph state', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph });
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});

		const epic = await service.convertPrdToEpic({ prdId: prd.id, actor });
		await service.updateStatus(epic.id, 'ready', actor);

		const dashboard = await service.listDashboard({ projectPath: '/project' });

		expect(epic.type).toBe('feature');
		expect(epic.metadata).toMatchObject({
			kind: 'epic',
			prdWorkItemId: prd.id,
			ccpmSlug: 'delivery-planner',
		});
		expect(dashboard.items).toHaveLength(2);
		expect(dashboard.readyItems.map((item) => item.id)).toEqual([epic.id]);
		expect(dashboard.statusCounts.find((count) => count.status === 'ready')?.count).toBe(1);
	});

	it('generates technical epic content and CCPM slug metadata from PRDs', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const syncEpic = vi.fn().mockResolvedValue({ mirrorHash: 'epic-mirror' });
		const service = new DeliveryPlannerService({
			workGraph,
			ccpmMirror: { syncEpic },
		});
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			description: 'Build the planner.',
			projectPath: '/project',
			gitPath: '/project',
		});

		const epic = await service.convertPrdToEpic({ prdId: prd.id });

		expect(epic.metadata).toMatchObject({
			kind: 'epic',
			prdWorkItemId: prd.id,
			ccpmSlug: 'delivery-planner',
		});
		expect(epic.description).toContain('## Architecture Decisions');
		expect(epic.description).toContain('## Task Preview');
		expect(syncEpic).toHaveBeenCalledWith(
			expect.objectContaining({ id: epic.id }),
			expect.objectContaining({ type: 'ccpm-sync' })
		);
	});

	it('decomposes epics through the configured gateway and persists task dependencies', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const decomposer = new DeliveryPlannerDecomposer({
			decomposeEpic: vi.fn().mockResolvedValue({
				tasks: [
					{ title: 'Design model' },
					{ title: 'Build service', dependsOnTaskTitles: ['Design model'] },
				],
			}),
		});
		const service = new DeliveryPlannerService({ workGraph, decomposer });
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});
		const epic = await service.convertPrdToEpic({ prdId: prd.id });

		const result = await service.decomposeEpicToTasks({ epicId: epic.id, actor });
		const readinessBefore = await service.calculateDependencyReadiness(result.tasks[1].id);
		await service.updateStatus(result.tasks[0].id, 'done', actor);
		const readinessAfter = await service.calculateDependencyReadiness(result.tasks[1].id);

		expect(result.operation.status).toBe('completed');
		expect(result.tasks.map((task) => task.title)).toEqual(['Design model', 'Build service']);
		expect(readinessBefore.ready).toBe(false);
		expect(readinessAfter.ready).toBe(true);
	});

	it('marks only unblocked specified tasks agent-ready and exposes dispatch/wiki metadata', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const decomposer = new DeliveryPlannerDecomposer({
			decomposeEpic: vi.fn().mockResolvedValue({
				tasks: [
					{
						title: 'Design model',
						description: 'Specify the model.',
						acceptanceCriteria: ['Model is documented'],
						filesLikelyTouched: ['docs/model.md'],
						capabilities: ['docs'],
					},
					{
						title: 'Build service',
						description: 'Implement the service.',
						acceptanceCriteria: ['Service is implemented'],
						dependsOnTaskTitles: ['Design model'],
						filesLikelyTouched: ['src/service.ts'],
						capabilities: ['code'],
					},
				],
			}),
		});
		const service = new DeliveryPlannerService({ workGraph, decomposer });
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});
		const epic = await service.convertPrdToEpic({ prdId: prd.id });

		const result = await service.decomposeEpicToTasks({ epicId: epic.id, actor });
		const [designTask, buildTask] = result.tasks;

		expect(designTask.tags).toContain(WORK_GRAPH_READY_TAG);
		expect(buildTask.tags).not.toContain(WORK_GRAPH_READY_TAG);
		expect(designTask.capabilities).toEqual(['docs']);
		expect(designTask.metadata).toMatchObject({
			deliveryPlannerTraceability: {
				prdWorkItemId: prd.id,
				epicWorkItemId: epic.id,
				parentWorkItemId: epic.id,
				livingWiki: {
					workGraphSource: 'delivery-planner',
					artifactKind: 'task',
				},
			},
			deliveryPlannerDispatch: {
				capabilityHints: ['docs'],
			},
			deliveryPlannerAgentReady: {
				tag: WORK_GRAPH_READY_TAG,
				ready: true,
			},
		});

		await service.updateStatus(designTask.id, 'done', actor);
		const refreshedBuildTask = await workGraph.getItem(buildTask.id);

		expect(refreshedBuildTask?.tags).toContain(WORK_GRAPH_READY_TAG);
		expect(refreshedBuildTask?.metadata).toMatchObject({
			deliveryPlannerAgentReady: {
				tag: WORK_GRAPH_READY_TAG,
				ready: true,
			},
		});
	});

	it('marks sufficiently specified bug follow-ups agent-ready on creation', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const service = new DeliveryPlannerService({ workGraph });

		const bug = await service.createBugFollowUp({
			title: 'Fix dispatch refresh',
			description: 'Bug details.\n\n## Acceptance Criteria\n- Ready tag is applied',
			projectPath: '/project',
			gitPath: '/project',
			actor,
		});

		expect(bug.tags).toContain(WORK_GRAPH_READY_TAG);
		expect(bug.metadata).toMatchObject({
			deliveryPlannerDispatch: {
				capabilityHints: ['code'],
			},
			deliveryPlannerAgentReady: {
				tag: WORK_GRAPH_READY_TAG,
				ready: true,
			},
		});
	});

	it('syncs task mirrors after dependency edges are persisted', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const syncTask = vi.fn().mockResolvedValue({ mirrorHash: 'task-mirror' });
		const decomposer = new DeliveryPlannerDecomposer({
			decomposeEpic: vi.fn().mockResolvedValue({
				tasks: [
					{ title: 'Design model' },
					{ title: 'Build service', dependsOnTaskTitles: ['Design model'] },
				],
			}),
		});
		const service = new DeliveryPlannerService({
			workGraph,
			decomposer,
			ccpmMirror: { syncTask },
		});
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});
		const epic = await service.convertPrdToEpic({ prdId: prd.id });

		const result = await service.decomposeEpicToTasks({ epicId: epic.id, actor });

		expect(result.tasks[1].dependencies).toHaveLength(1);
		expect(syncTask).toHaveBeenLastCalledWith(
			expect.objectContaining({
				title: 'Build service',
				dependencies: [expect.objectContaining({ toWorkItemId: result.tasks[0].id })],
			}),
			expect.objectContaining({ type: 'ccpm-sync' })
		);
	});

	it('adds deterministic task preview metadata and validates parallel file conflicts', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const decomposer = new DeliveryPlannerDecomposer({
			decomposeEpic: vi.fn().mockResolvedValue({
				tasks: [
					{
						title: 'Design model',
						acceptanceCriteria: ['Model is documented'],
						filesLikelyTouched: ['src/model.ts'],
						parallel: true,
					},
					{
						title: 'Build service',
						dependsOnTaskTitles: ['Design model'],
						filesLikelyTouched: ['src/service.ts'],
						integrationRisks: ['Service depends on model shape'],
					},
				],
			}),
		});
		const service = new DeliveryPlannerService({ workGraph, decomposer });
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});
		const epic = await service.convertPrdToEpic({ prdId: prd.id });

		const result = await service.decomposeEpicToTasks({ epicId: epic.id, actor });

		expect(result.operation.metadata?.dependencyPreview).toEqual([
			{
				title: 'Design model',
				dependsOnTaskTitles: [],
				filesLikelyTouched: ['src/model.ts'],
				parallel: true,
			},
			{
				title: 'Build service',
				dependsOnTaskTitles: ['Design model'],
				filesLikelyTouched: ['src/service.ts'],
				parallel: true,
			},
		]);
		expect(result.tasks[0].description).toContain('## Acceptance Criteria');
		expect(result.tasks[0].metadata).toMatchObject({
			ccpmSlug: 'delivery-planner',
			ccpmTaskId: 1,
			acceptanceCriteria: ['Model is documented'],
			filesLikelyTouched: ['src/model.ts'],
		});

		const conflicting = new DeliveryPlannerDecomposer({
			decomposeEpic: vi.fn().mockResolvedValue({
				tasks: [
					{ title: 'Task A', filesLikelyTouched: ['src/shared.ts'], parallel: true },
					{ title: 'Task B', filesLikelyTouched: ['src/shared.ts'], parallel: true },
				],
			}),
		});
		await expect(
			conflicting.draftTasks({
				epicTitle: 'Delivery Planner',
				projectPath: '/project',
				gitPath: '/project',
				parentWorkItemId: epic.id,
			})
		).rejects.toThrow('Parallel task file conflict');
	});

	it('syncs CCPM mirrors through progress-aware service methods', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const syncPrd = vi.fn().mockResolvedValue({ mirrorHash: 'mirror-v1' });
		const service = new DeliveryPlannerService({
			workGraph,
			ccpmMirror: { syncPrd },
		});
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});

		const synced = await service.syncCcpmMirror(prd.id);

		expect(syncPrd).toHaveBeenCalledTimes(2);
		expect(synced.mirrorHash).toBe('mirror-v1');
		expect(service.listProgress().every((operation) => operation.status === 'completed')).toBe(
			true
		);
	});

	it('marks failed decomposition operations as retryable and reports validation failures distinctly', async () => {
		const workGraph = new MemoryWorkGraphStore();
		const decomposer = new DeliveryPlannerDecomposer({
			decomposeEpic: vi.fn().mockResolvedValue({ tasks: [] }),
		});
		const service = new DeliveryPlannerService({ workGraph, decomposer });
		const prd = await service.createPrd({
			title: 'Delivery Planner',
			projectPath: '/project',
			gitPath: '/project',
		});
		const epic = await service.convertPrdToEpic({ prdId: prd.id });

		await expect(service.decomposeEpicToTasks({ epicId: epic.id })).rejects.toBeInstanceOf(
			DeliveryPlannerValidationError
		);

		const [operation] = service.listProgress();
		expect(operation.status).toBe('failed');
		expect(operation.retryable).toBe(true);
	});
});
