import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type {
	WorkGraphActor,
	WorkGraphBroadcastOperation,
	WorkItem,
} from '../../shared/work-graph-types';
import type { DeliveryPlannerWorkGraphStore } from './planner-service';

export interface PlanningArtifactIndexInput {
	workGraph: DeliveryPlannerWorkGraphStore;
	projectPath: string;
	gitPath?: string;
	actor?: WorkGraphActor;
	publish?: (operation: WorkGraphBroadcastOperation, payload: unknown) => void | Promise<void>;
}

interface PlanningArtifact {
	filePath: string;
	tool: 'speckit' | 'openspec';
	kind: 'spec' | 'plan' | 'tasks' | 'proposal' | 'design';
	title: string;
	body: string;
}

const ARTIFACT_LIMIT = 200;

export async function indexPlanningArtifacts(
	input: PlanningArtifactIndexInput
): Promise<WorkItem[]> {
	const projectPath = path.resolve(input.projectPath);
	const gitPath = path.resolve(input.gitPath ?? projectPath);
	const artifacts = await discoverPlanningArtifacts(projectPath);
	if (!artifacts.length) return [];

	const existing = await input.workGraph.listItems({
		projectPath,
		gitPath,
		source: 'delivery-planner',
	});
	const byArtifactPath = new Map(
		existing.items
			.map((item) => [readSpecBridgePath(item), item] as const)
			.filter((entry): entry is readonly [string, WorkItem] => Boolean(entry[0]))
	);

	const indexed: WorkItem[] = [];
	for (const artifact of artifacts.slice(0, ARTIFACT_LIMIT)) {
		const relativePath = path.relative(projectPath, artifact.filePath);
		const contentHash = hashContent(artifact.body);
		const current = byArtifactPath.get(relativePath);
		const metadata = {
			...(current?.metadata ?? {}),
			kind: artifact.kind === 'tasks' ? 'task' : 'prd',
			deliveryPlannerConcept: artifact.kind === 'tasks' ? 'task' : 'prd',
			specBridge: {
				tool: artifact.tool,
				kind: artifact.kind,
				path: relativePath,
				contentHash,
			},
		};

		if (current) {
			if (
				(current.metadata?.specBridge as { contentHash?: string } | undefined)?.contentHash ===
				contentHash
			) {
				indexed.push(current);
				continue;
			}

			const updated = await input.workGraph.updateItem({
				id: current.id,
				actor: input.actor,
				patch: {
					title: artifact.title,
					description: artifact.body,
					metadata,
				},
			});
			await input.publish?.('workGraph.item.updated', { item: updated });
			indexed.push(updated);
			continue;
		}

		const created = await input.workGraph.createItem(
			{
				type: artifact.kind === 'tasks' ? 'task' : 'document',
				status: 'planned',
				title: artifact.title,
				description: artifact.body,
				projectPath,
				gitPath,
				source: 'delivery-planner',
				readonly: true,
				tags: ['delivery-planner', artifact.tool, artifact.kind],
				metadata,
			},
			input.actor
		);
		await input.publish?.('workGraph.item.created', { item: created });
		indexed.push(created);
	}

	return indexed;
}

async function discoverPlanningArtifacts(projectPath: string): Promise<PlanningArtifact[]> {
	const roots = [
		{ tool: 'speckit' as const, root: path.join(projectPath, 'specs') },
		{ tool: 'speckit' as const, root: path.join(projectPath, '.specify', 'specs') },
		{ tool: 'openspec' as const, root: path.join(projectPath, 'openspec', 'changes') },
		{ tool: 'openspec' as const, root: path.join(projectPath, '.openspec', 'changes') },
	];
	const artifacts: PlanningArtifact[] = [];

	for (const { tool, root } of roots) {
		const files = await listMarkdownFiles(root);
		for (const filePath of files) {
			const basename = path.basename(filePath).toLowerCase();
			const kind = classifyArtifact(tool, basename);
			if (!kind) continue;

			const body = await fs.readFile(filePath, 'utf8');
			artifacts.push({
				filePath,
				tool,
				kind,
				title: parseArtifactTitle(body, filePath, tool, kind),
				body,
			});
		}
	}

	return artifacts;
}

async function listMarkdownFiles(root: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const files = await Promise.all(
			entries.map(async (entry) => {
				const entryPath = path.join(root, entry.name);
				if (entry.isDirectory()) return listMarkdownFiles(entryPath);
				if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) return [entryPath];
				return [];
			})
		);
		return files.flat();
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') return [];
		throw error;
	}
}

function classifyArtifact(
	tool: PlanningArtifact['tool'],
	basename: string
): PlanningArtifact['kind'] | null {
	if (tool === 'speckit') {
		if (basename === 'spec.md') return 'spec';
		if (basename === 'plan.md') return 'plan';
		if (basename === 'tasks.md') return 'tasks';
		return null;
	}

	if (basename === 'proposal.md') return 'proposal';
	if (basename === 'design.md') return 'design';
	if (basename === 'tasks.md') return 'tasks';
	return null;
}

function parseArtifactTitle(
	body: string,
	filePath: string,
	tool: PlanningArtifact['tool'],
	kind: PlanningArtifact['kind']
): string {
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) return heading;

	const changeName = path.basename(path.dirname(filePath));
	return `${tool === 'speckit' ? 'Spec-Kit' : 'OpenSpec'} ${kind}: ${changeName}`;
}

function readSpecBridgePath(item: WorkItem): string | undefined {
	const specBridge = item.metadata?.specBridge as { path?: unknown } | undefined;
	return typeof specBridge?.path === 'string' ? specBridge.path : undefined;
}

function hashContent(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}
