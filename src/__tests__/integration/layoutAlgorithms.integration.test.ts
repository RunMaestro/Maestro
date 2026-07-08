import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from 'reactflow';

import {
	applyForceLayout,
	applyHierarchicalLayout,
	clearNodePositions,
	createLayoutTransitionFrames,
	createNodeEntryFrames,
	createNodeExitFrames,
	diffNodes,
	hasSavedPositions,
	interpolatePosition,
	mergeAnimatingNodes,
	positionNewNodesNearNeighbors,
	restoreNodePositions,
	saveNodePositions,
} from '../../renderer/components/DocumentGraph/layoutAlgorithms';
import type {
	DocumentNodeData,
	ExternalLinkNodeData,
	GraphNodeData,
} from '../../renderer/components/DocumentGraph/graphDataBuilder';

function documentNode(
	id: string,
	position = { x: 0, y: 0 },
	overrides: Partial<DocumentNodeData> = {}
): Node<DocumentNodeData> {
	return {
		id,
		type: 'documentNode',
		position,
		data: {
			nodeType: 'document',
			title: id,
			lineCount: 42,
			wordCount: 420,
			size: '4 KB',
			filePath: `${id}.md`,
			...overrides,
		},
	};
}

function externalNode(domain: string, position = { x: 0, y: 0 }): Node<ExternalLinkNodeData> {
	return {
		id: `ext-${domain}`,
		type: 'externalLinkNode',
		position,
		data: {
			nodeType: 'external',
			domain,
			linkCount: 2,
			urls: [`https://${domain}/a`, `https://${domain}/b`],
		},
	};
}

function edge(source: string, target: string, type = 'default'): Edge {
	return { id: `${source}-${target}-${type}`, source, target, type };
}

function expectFinitePosition(node: Node): void {
	expect(Number.isFinite(node.position.x)).toBe(true);
	expect(Number.isFinite(node.position.y)).toBe(true);
}

describe('DocumentGraph layout algorithms integration', () => {
	beforeEach(() => {
		clearNodePositions('integration-graph');
		vi.restoreAllMocks();
	});

	it('lays out mixed document and external graphs with real force and dagre engines', () => {
		const nodes: Node<GraphNodeData>[] = [
			documentNode('index', undefined, {
				title: 'Project Index With A Longer Title That Exercises Sizing',
				description:
					'Long descriptions should influence dimensions without dropping node data. '.repeat(3),
			}),
			documentNode('guide'),
			documentNode('api'),
			externalNode('github.com'),
			externalNode('docs.example.com'),
		];
		const edges = [
			edge('index', 'guide'),
			edge('guide', 'api'),
			edge('api', 'missing-target'),
			edge('index', 'ext-github.com', 'external'),
			edge('guide', 'ext-docs.example.com', 'external'),
		];

		const force = applyForceLayout(nodes, edges, {
			centerX: 250,
			centerY: 120,
			nodeSeparation: 90,
		});
		const hierarchicalTb = applyHierarchicalLayout(nodes, edges, {
			rankDirection: 'TB',
			nodeSeparation: 120,
			rankSeparation: 220,
		});
		const hierarchicalLr = applyHierarchicalLayout(nodes, edges, { rankDirection: 'LR' });

		expect(force).toHaveLength(nodes.length);
		expect(hierarchicalTb).toHaveLength(nodes.length);
		for (const node of [...force, ...hierarchicalTb, ...hierarchicalLr]) {
			expectFinitePosition(node);
		}
		expect(
			(force.find((node) => node.id === 'index')!.data as DocumentNodeData).description
		).toContain('Long descriptions');
		expect(hierarchicalTb.find((node) => node.id === 'index')!.position.y).toBeLessThan(
			hierarchicalTb.find((node) => node.id === 'api')!.position.y
		);
		expect(hierarchicalLr.find((node) => node.id === 'index')!.position.x).toBeLessThan(
			hierarchicalLr.find((node) => node.id === 'api')!.position.x
		);
	});

	it('uses grid and empty fallbacks for external-only or empty graph inputs', () => {
		const externalOnly: Node<GraphNodeData>[] = [
			externalNode('github.com'),
			externalNode('npmjs.com'),
			externalNode('vite.dev'),
			externalNode('docs.example.com'),
		];

		expect(applyForceLayout([], [])).toEqual([]);
		expect(applyHierarchicalLayout([], [])).toEqual([]);

		const forceGrid = applyForceLayout(externalOnly, [], { nodeSeparation: 40 });
		const hierarchicalGrid = applyHierarchicalLayout(externalOnly, [], { nodeSeparation: 40 });

		for (const node of [...forceGrid, ...hierarchicalGrid]) {
			expectFinitePosition(node);
		}
		expect(new Set(forceGrid.map((node) => node.position.x)).size).toBeGreaterThan(1);
		expect(hierarchicalGrid.every((node) => node.position.x === 0 && node.position.y === 0)).toBe(
			false
		);
	});

	it('completes cyclic graph layouts without hanging or producing invalid coordinates', () => {
		const nodes: Node<GraphNodeData>[] = Array.from({ length: 12 }, (_, index) =>
			documentNode(`doc-${index}`)
		);
		const edges = nodes.flatMap((node, index) => [
			edge(node.id, `doc-${(index + 1) % nodes.length}`),
			edge(node.id, node.id),
		]);

		const started = Date.now();
		const force = applyForceLayout(nodes, edges);
		const hierarchical = applyHierarchicalLayout(nodes, edges);

		expect(Date.now() - started).toBeLessThan(5000);
		expect(force).toHaveLength(nodes.length);
		expect(hierarchical).toHaveLength(nodes.length);
		for (const node of [...force, ...hierarchical]) {
			expectFinitePosition(node);
		}
	});

	it('creates interpolated layout frames and preserves unmatched start nodes', () => {
		const stale = documentNode('stale', { x: 10, y: 20 });
		const movingStart = documentNode('moving', { x: 0, y: 0 });
		const movingEnd = documentNode('moving', { x: 100, y: 100 });

		expect(interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 100 }, -1)).toEqual({
			x: 0,
			y: 0,
		});
		expect(interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 100 }, 2)).toEqual({
			x: 100,
			y: 100,
		});
		expect(interpolatePosition({ x: 0, y: 0 }, { x: 100, y: 100 }, 0.5).x).toBeGreaterThan(50);

		expect(createLayoutTransitionFrames([], [])).toEqual([[]]);
		expect(createLayoutTransitionFrames([movingStart], [movingEnd], 1)).toEqual([[movingEnd]]);

		const frames = createLayoutTransitionFrames([stale, movingStart], [movingEnd], 4);
		expect(frames).toHaveLength(5);
		expect(frames[0].find((node) => node.id === 'moving')!.position).toEqual({ x: 0, y: 0 });
		expect(frames.at(-1)!.find((node) => node.id === 'moving')!.position).toEqual({
			x: 100,
			y: 100,
		});
		expect(frames[2].find((node) => node.id === 'stale')).toBe(stale);
	});

	it('saves, restores, isolates, and clears in-memory node positions', () => {
		const graphA = 'integration-graph';
		const graphB = 'integration-graph-secondary';
		clearNodePositions(graphB);

		saveNodePositions(graphA, [documentNode('doc-a', { x: 100, y: 200 })]);
		saveNodePositions(graphB, [documentNode('doc-a', { x: 300, y: 400 })]);

		expect(hasSavedPositions(graphA)).toBe(true);
		expect(restoreNodePositions(graphA, [documentNode('doc-a')])[0].position).toEqual({
			x: 100,
			y: 200,
		});
		expect(restoreNodePositions(graphB, [documentNode('doc-a')])[0].position).toEqual({
			x: 300,
			y: 400,
		});
		expect(
			restoreNodePositions(graphA, [documentNode('unknown', { x: 5, y: 6 })])[0].position
		).toEqual({ x: 5, y: 6 });
		expect(restoreNodePositions('missing-graph', [documentNode('doc-a')])[0].position).toEqual({
			x: 0,
			y: 0,
		});

		clearNodePositions(graphA);
		clearNodePositions(graphB);
		expect(hasSavedPositions(graphA)).toBe(false);
	});

	it('diffs nodes and merges entry and exit animation frames with stable graph nodes', () => {
		const oldNodes: Node<GraphNodeData>[] = [
			documentNode('kept'),
			documentNode('removed', { x: 40, y: 40 }),
		];
		const newNodes: Node<GraphNodeData>[] = [
			documentNode('kept'),
			documentNode('added', { x: 80, y: 80 }),
		];

		const diff = diffNodes(oldNodes, newNodes);
		expect(diff.addedIds.has('added')).toBe(true);
		expect(diff.removedIds.has('removed')).toBe(true);
		expect(diff.unchanged.map((node) => node.id)).toEqual(['kept']);

		expect(createNodeEntryFrames([])).toEqual([]);
		expect(createNodeExitFrames([], 3)).toEqual([]);
		expect(createNodeExitFrames([documentNode('removed')], 1)).toEqual([]);

		const entryFrames = createNodeEntryFrames(diff.added, 3);
		const exitFrames = createNodeExitFrames(diff.removed, 3);
		expect(entryFrames).toHaveLength(4);
		expect(exitFrames).toHaveLength(4);
		expect(entryFrames[0][0].data.animationPhase).toBe('entering');
		expect(entryFrames.at(-1)![0].data.animationPhase).toBe('stable');
		expect(entryFrames.at(-1)![0].style?.opacity).toBe(1);
		expect(exitFrames[0][0].data.animationPhase).toBe('exiting');
		expect(exitFrames.at(-1)![0].style?.opacity).toBe(0);

		const merged = mergeAnimatingNodes(
			[{ ...documentNode('kept'), style: { opacity: 1 } }, documentNode('stable-only')],
			[{ ...documentNode('kept'), style: { opacity: 0.5 } }, exitFrames[0][0]]
		);
		expect(merged.map((node) => node.id)).toEqual(['kept', 'stable-only', 'removed']);
		expect(merged[0].style?.opacity).toBe(0.5);
	});

	it('positions new nodes near connected neighbors or near the configured center fallback', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);

		const existing: Node<GraphNodeData>[] = [
			documentNode('a', { x: 0, y: 0 }),
			documentNode('b', { x: 200, y: 0 }),
			documentNode('c', { x: 100, y: 200 }),
		];
		const connected = positionNewNodesNearNeighbors(
			[documentNode('new')],
			existing,
			[edge('a', 'new'), edge('new', 'b'), edge('new', 'missing'), edge('c', 'new')],
			{ nodeSeparation: 80 }
		);
		const unconnected = positionNewNodesNearNeighbors([documentNode('orphan')], existing, [], {
			centerX: 500,
			centerY: 250,
			nodeSeparation: 60,
		});

		expect(connected[0].position).toEqual({ x: 180, y: 200 / 3 });
		expect(unconnected[0].position).toEqual({ x: 440, y: 190 });
		expect(positionNewNodesNearNeighbors([], existing, [])).toEqual([]);
	});
});
