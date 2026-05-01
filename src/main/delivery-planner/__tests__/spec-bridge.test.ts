import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type {
	WorkGraphListResult,
	WorkItem,
	WorkItemCreateInput,
	WorkItemDependency,
	WorkItemFilters,
	WorkItemUpdateInput,
} from '../../../shared/work-graph-types';
import { indexPlanningArtifacts } from '../spec-bridge';
import type { DeliveryPlannerWorkGraphStore } from '../planner-service';

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
		const current = this.items.get(input.id);
		if (!current) {
			throw new Error(`Unknown item ${input.id}`);
		}
		const updated: WorkItem = {
			...current,
			...input.patch,
			updatedAt: new Date().toISOString(),
		};
		this.items.set(updated.id, updated);
		return updated;
	}

	async getItem(id: string): Promise<WorkItem | undefined> {
		return this.items.get(id);
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

	async listItems(filters: WorkItemFilters = {}): Promise<WorkGraphListResult> {
		let items = [...this.items.values()];
		if (filters.projectPath) {
			items = items.filter((item) => item.projectPath === filters.projectPath);
		}
		if (filters.gitPath) {
			items = items.filter((item) => item.gitPath === filters.gitPath);
		}
		if (filters.source) {
			const sources = Array.isArray(filters.source) ? filters.source : [filters.source];
			items = items.filter((item) => sources.includes(item.source));
		}
		return { items, total: items.length };
	}
}

describe('indexPlanningArtifacts', () => {
	it('indexes Spec-Kit and OpenSpec markdown artifacts as read-only planner items', async () => {
		const projectPath = await mkdtemp(path.join(os.tmpdir(), 'maestro-spec-bridge-'));
		try {
			await writeArtifact(projectPath, 'specs/001-plan/spec.md', '# Checkout Flow\n\nSpec body');
			await writeArtifact(
				projectPath,
				'openspec/changes/add-api/proposal.md',
				'# Add API\n\nProposal body'
			);

			const workGraph = new MemoryWorkGraphStore();
			const publish = vi.fn();

			const indexed = await indexPlanningArtifacts({
				workGraph,
				projectPath,
				publish,
			});

			expect(indexed).toHaveLength(2);
			expect(indexed).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						title: 'Checkout Flow',
						type: 'document',
						readonly: true,
						tags: expect.arrayContaining(['delivery-planner', 'speckit', 'spec']),
						metadata: expect.objectContaining({
							kind: 'prd',
							specBridge: expect.objectContaining({
								tool: 'speckit',
								kind: 'spec',
								path: path.join('specs', '001-plan', 'spec.md'),
							}),
						}),
					}),
					expect.objectContaining({
						title: 'Add API',
						readonly: true,
						tags: expect.arrayContaining(['delivery-planner', 'openspec', 'proposal']),
						metadata: expect.objectContaining({
							specBridge: expect.objectContaining({
								tool: 'openspec',
								kind: 'proposal',
								path: path.join('openspec', 'changes', 'add-api', 'proposal.md'),
							}),
						}),
					}),
				])
			);
			expect(publish).toHaveBeenCalledTimes(2);
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});

	it('updates an existing indexed artifact when its content changes', async () => {
		const projectPath = await mkdtemp(path.join(os.tmpdir(), 'maestro-spec-bridge-'));
		try {
			const artifactPath = 'specs/001-plan/tasks.md';
			await writeArtifact(projectPath, artifactPath, '# Tasks\n\n- First task');

			const workGraph = new MemoryWorkGraphStore();
			const [created] = await indexPlanningArtifacts({ workGraph, projectPath });

			await writeArtifact(projectPath, artifactPath, '# Tasks\n\n- First task\n- Second task');
			const [updated] = await indexPlanningArtifacts({ workGraph, projectPath });

			expect(updated.id).toBe(created.id);
			expect(updated.description).toContain('Second task');
			expect(updated.metadata).toMatchObject({
				kind: 'task',
				deliveryPlannerConcept: 'task',
				specBridge: {
					tool: 'speckit',
					kind: 'tasks',
					path: path.join('specs', '001-plan', 'tasks.md'),
				},
			});

			const listed = await workGraph.listItems({ projectPath });
			expect(listed.items).toHaveLength(1);
		} finally {
			await rm(projectPath, { recursive: true, force: true });
		}
	});
});

async function writeArtifact(
	projectPath: string,
	relativePath: string,
	content: string
): Promise<void> {
	const filePath = path.join(projectPath, relativePath);
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content);
}
