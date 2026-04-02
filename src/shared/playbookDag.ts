import type {
	BatchDocumentEntry,
	Playbook,
	PlaybookDocumentEntry,
	PlaybookDraft,
	PlaybookTaskGraph,
	PlaybookTaskGraphNode,
	PlaybookUpdate,
} from './types';

export const DEFAULT_PLAYBOOK_MAX_PARALLELISM = 1;
export const DEFAULT_AUTORUN_SKILLS = ['context-and-impact', 'gitnexus'] as const;

type DocumentLike = Pick<PlaybookDocumentEntry, 'filename'> | Pick<BatchDocumentEntry, 'filename'>;

type PlaybookGraphCarrier = {
	documents: DocumentLike[];
	maxParallelism?: number | null;
	taskGraph?: PlaybookTaskGraph | null;
	skills?: string[];
};

function slugifyGraphSegment(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/\\/g, '/')
			.replace(/\.md$/i, '')
			.replace(/[^a-z0-9/]+/g, '-')
			.replace(/\/+/g, '-')
			.replace(/^-+|-+$/g, '') || 'task'
	);
}

export function normalizePlaybookSkills(skills: string[] = []): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const skill of [...DEFAULT_AUTORUN_SKILLS, ...skills]) {
		if (typeof skill !== 'string') continue;
		const trimmed = skill.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		normalized.push(trimmed);
	}

	return normalized;
}

export function buildImplicitTaskGraph(documents: DocumentLike[]): PlaybookTaskGraph {
	const occurrenceCounts = new Map<string, number>();
	const nodes: PlaybookTaskGraphNode[] = [];

	for (const [index, document] of documents.entries()) {
		const slug = slugifyGraphSegment(document.filename);
		const occurrence = (occurrenceCounts.get(slug) ?? 0) + 1;
		occurrenceCounts.set(slug, occurrence);
		const id = occurrence === 1 ? slug : `${slug}-${occurrence}`;
		nodes.push({
			id,
			documentIndex: index,
			dependsOn: index === 0 ? [] : [nodesIdForIndex(nodes, index - 1)],
		});
	}

	return { nodes };
}

function nodesIdForIndex(nodes: PlaybookTaskGraphNode[], index: number): string {
	const node = nodes[index];
	if (!node) {
		throw new Error(`Missing playbook DAG node at index ${index}`);
	}
	return node.id;
}

export function normalizePlaybookTaskGraph(
	documents: DocumentLike[],
	taskGraph?: PlaybookTaskGraph | null
): PlaybookTaskGraph {
	if (!taskGraph || !Array.isArray(taskGraph.nodes) || taskGraph.nodes.length === 0) {
		return buildImplicitTaskGraph(documents);
	}

	return {
		nodes: taskGraph.nodes.map((node) => ({
			id: node.id,
			documentIndex: node.documentIndex,
			dependsOn: Array.isArray(node.dependsOn) ? [...node.dependsOn] : [],
		})),
	};
}

export function normalizePlaybookMaxParallelism(value?: number | null): number {
	if (!Number.isInteger(value) || (value ?? 0) < 1) {
		return DEFAULT_PLAYBOOK_MAX_PARALLELISM;
	}
	return value as number;
}

export function normalizePlaybookDagFields<T extends PlaybookGraphCarrier>(
	playbook: T
): T & {
	maxParallelism: number;
	taskGraph: PlaybookTaskGraph;
	skills: string[];
} {
	return {
		...playbook,
		maxParallelism: normalizePlaybookMaxParallelism(playbook.maxParallelism),
		taskGraph: normalizePlaybookTaskGraph(playbook.documents, playbook.taskGraph),
		skills: normalizePlaybookSkills(playbook.skills),
	};
}

export function normalizePersistedPlaybook(playbook: Partial<Playbook>): Playbook {
	const documents = Array.isArray(playbook.documents)
		? playbook.documents
				.filter(
					(document): document is PlaybookDocumentEntry =>
						Boolean(document) && typeof document.filename === 'string'
				)
				.map((document) => ({
					...document,
					filename: document.filename,
					resetOnCompletion: Boolean(document.resetOnCompletion),
				}))
		: [];
	const normalized = normalizePlaybookDagFields({
		...playbook,
		documents,
	});

	return {
		id: typeof playbook.id === 'string' ? playbook.id : '',
		name: typeof playbook.name === 'string' ? playbook.name : '',
		createdAt: typeof playbook.createdAt === 'number' ? playbook.createdAt : 0,
		updatedAt:
			typeof playbook.updatedAt === 'number'
				? playbook.updatedAt
				: typeof playbook.createdAt === 'number'
					? playbook.createdAt
					: 0,
		documents,
		loopEnabled: typeof playbook.loopEnabled === 'boolean' ? playbook.loopEnabled : false,
		maxLoops: playbook.maxLoops ?? null,
		taskTimeoutMs: playbook.taskTimeoutMs ?? null,
		prompt:
			playbook.prompt === null || typeof playbook.prompt === 'string'
				? (playbook.prompt as string)
				: '',
		skills: normalized.skills,
		definitionOfDone: Array.isArray(playbook.definitionOfDone)
			? playbook.definitionOfDone.filter((item): item is string => typeof item === 'string')
			: [],
		verificationSteps: Array.isArray(playbook.verificationSteps)
			? playbook.verificationSteps.filter((item): item is string => typeof item === 'string')
			: [],
		promptProfile: playbook.promptProfile ?? 'compact-code',
		documentContextMode: playbook.documentContextMode ?? 'active-task-only',
		skillPromptMode: playbook.skillPromptMode ?? 'brief',
		agentStrategy: playbook.agentStrategy ?? 'single',
		maxParallelism: normalized.maxParallelism,
		taskGraph: normalized.taskGraph,
		worktreeSettings: playbook.worktreeSettings,
	};
}

export function normalizePlaybookDraft(playbook: PlaybookDraft): PlaybookDraft {
	return normalizePlaybookDagFields(playbook);
}

export function normalizePlaybookUpdate(
	documents: DocumentLike[],
	updates: PlaybookUpdate
): PlaybookUpdate {
	return {
		...updates,
		maxParallelism: normalizePlaybookMaxParallelism(updates.maxParallelism),
		taskGraph: normalizePlaybookTaskGraph(documents, updates.taskGraph),
		skills: normalizePlaybookSkills(updates.skills),
	};
}

export interface PlaybookDagValidationResult {
	valid: boolean;
	errors: string[];
}

export function validatePlaybookDag(
	documents: DocumentLike[],
	taskGraph?: PlaybookTaskGraph | null,
	maxParallelism?: number | null
): PlaybookDagValidationResult {
	const errors: string[] = [];
	const normalizedGraph = normalizePlaybookTaskGraph(documents, taskGraph);
	const normalizedMaxParallelism = normalizePlaybookMaxParallelism(maxParallelism);
	const nodes = normalizedGraph.nodes;
	let cycleDetected = false;

	if (
		maxParallelism !== undefined &&
		maxParallelism !== null &&
		normalizedMaxParallelism !== maxParallelism
	) {
		errors.push('maxParallelism must be a positive integer.');
	}

	if (nodes.length !== documents.length) {
		errors.push('taskGraph must contain exactly one node per playbook document.');
	}

	const idToNode = new Map<string, PlaybookTaskGraphNode>();
	const coveredDocumentIndexes = new Set<number>();

	for (const node of nodes) {
		if (!node.id || typeof node.id !== 'string' || !node.id.trim()) {
			errors.push('taskGraph nodes must have a non-empty id.');
			continue;
		}
		if (idToNode.has(node.id)) {
			errors.push(`Duplicate taskGraph node id: ${node.id}`);
		}
		idToNode.set(node.id, node);

		if (
			!Number.isInteger(node.documentIndex) ||
			node.documentIndex < 0 ||
			node.documentIndex >= documents.length
		) {
			errors.push(`Node "${node.id}" references an invalid documentIndex ${node.documentIndex}.`);
			continue;
		}
		if (coveredDocumentIndexes.has(node.documentIndex)) {
			errors.push(`Multiple taskGraph nodes reference documentIndex ${node.documentIndex}.`);
		}
		coveredDocumentIndexes.add(node.documentIndex);
	}

	for (let index = 0; index < documents.length; index++) {
		if (!coveredDocumentIndexes.has(index)) {
			errors.push(`Missing taskGraph node for documentIndex ${index}.`);
		}
	}

	for (const node of nodes) {
		const dependencies = Array.isArray(node.dependsOn) ? node.dependsOn : [];
		for (const depId of dependencies) {
			if (!idToNode.has(depId)) {
				errors.push(`Node "${node.id}" depends on missing node "${depId}".`);
				continue;
			}
			if (depId === node.id) {
				errors.push(`Node "${node.id}" cannot depend on itself.`);
				cycleDetected = true;
				continue;
			}
			const dependency = idToNode.get(depId)!;
			if (dependency.documentIndex === node.documentIndex) {
				errors.push(`Node "${node.id}" has an illegal same-document dependency on "${depId}".`);
			}
		}
	}

	const visited = new Set<string>();
	const active = new Set<string>();

	const visit = (nodeId: string) => {
		if (cycleDetected || visited.has(nodeId)) return;
		if (active.has(nodeId)) {
			cycleDetected = true;
			return;
		}

		active.add(nodeId);
		const node = idToNode.get(nodeId);
		for (const depId of node?.dependsOn ?? []) {
			if (idToNode.has(depId)) {
				visit(depId);
			}
		}
		active.delete(nodeId);
		visited.add(nodeId);
	};

	for (const node of nodes) {
		visit(node.id);
	}

	if (cycleDetected) {
		errors.push('taskGraph contains a dependency cycle.');
	}

	return { valid: errors.length === 0, errors };
}
