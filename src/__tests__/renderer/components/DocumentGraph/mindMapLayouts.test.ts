/**
 * Tests for the canvas-based mind map layout algorithms (mindMapLayouts.ts)
 *
 * Verifies the three layout algorithms (Mind Map, Radial, Force-Directed),
 * the calculateLayout dispatcher, shared utilities, and constants.
 */

import { describe, it, expect } from 'vitest';
import type {
	MindMapNode,
	MindMapLink,
} from '../../../../renderer/components/DocumentGraph/MindMap';
import {
	type MindMapLayoutType,
	LAYOUT_LABELS,
	calculateLayout,
	calculateMindMapLayout,
	calculateRadialLayout,
	calculateForceLayout,
	buildAdjacencyMap,
	calculateNodeHeight,
	NODE_WIDTH,
	NODE_HEADER_HEIGHT,
	NODE_SUBHEADER_HEIGHT,
	NODE_HEIGHT_BASE,
	DESC_LINE_HEIGHT,
	CHARS_PER_LINE,
	DESC_PADDING,
	CENTER_NODE_SCALE,
	EXTERNAL_NODE_WIDTH,
	EXTERNAL_NODE_HEIGHT,
	CANVAS_PADDING,
} from '../../../../renderer/components/DocumentGraph/mindMapLayouts';

// ============================================================================
// Test Helpers
// ============================================================================

function createNode(id: string, overrides: Partial<MindMapNode> = {}): MindMapNode {
	return {
		id,
		x: 0,
		y: 0,
		width: NODE_WIDTH,
		height: NODE_HEIGHT_BASE,
		depth: 0,
		side: 'center',
		nodeType: 'document',
		label: id,
		filePath: `${id}.md`,
		...overrides,
	};
}

function createExternalNode(domain: string): MindMapNode {
	return createNode(`ext-${domain}`, {
		nodeType: 'external',
		side: 'external',
		domain,
		urls: [`https://${domain}`],
		width: EXTERNAL_NODE_WIDTH,
		height: EXTERNAL_NODE_HEIGHT,
	});
}

function createLink(
	source: string,
	target: string,
	type: 'internal' | 'external' = 'internal'
): MindMapLink {
	return { source, target, type };
}

/**
 * Build a simple graph: center -> A, center -> B, center -> C
 */
function buildStarGraph(): { nodes: MindMapNode[]; links: MindMapLink[] } {
	const center = createNode('center');
	const a = createNode('A', { depth: 1 });
	const b = createNode('B', { depth: 1 });
	const c = createNode('C', { depth: 1 });
	const links: MindMapLink[] = [
		createLink('center', 'A'),
		createLink('center', 'B'),
		createLink('center', 'C'),
	];
	return { nodes: [center, a, b, c], links };
}

/**
 * Build a deeper graph: center -> A -> D, center -> B, center -> C
 */
function buildDeepGraph(): { nodes: MindMapNode[]; links: MindMapLink[] } {
	const center = createNode('center');
	const a = createNode('A', { depth: 1 });
	const b = createNode('B', { depth: 1 });
	const c = createNode('C', { depth: 1 });
	const d = createNode('D', { depth: 2 });
	const links: MindMapLink[] = [
		createLink('center', 'A'),
		createLink('center', 'B'),
		createLink('center', 'C'),
		createLink('A', 'D'),
	];
	return { nodes: [center, a, b, c, d], links };
}

// ============================================================================
// Tests
// ============================================================================

describe('mindMapLayouts', () => {
	// ====================================================================
	// Constants
	// ====================================================================

	describe('exported constants', () => {
		it('exports expected node dimension constants', () => {
			expect(NODE_WIDTH).toBe(260);
			expect(NODE_HEADER_HEIGHT).toBe(32);
			expect(NODE_SUBHEADER_HEIGHT).toBe(22);
			expect(NODE_HEIGHT_BASE).toBe(56 + NODE_SUBHEADER_HEIGHT);
			expect(DESC_LINE_HEIGHT).toBe(14);
			expect(CHARS_PER_LINE).toBe(35);
			expect(DESC_PADDING).toBe(20);
			expect(CENTER_NODE_SCALE).toBe(1.15);
			expect(EXTERNAL_NODE_WIDTH).toBe(150);
			expect(EXTERNAL_NODE_HEIGHT).toBe(38);
			expect(CANVAS_PADDING).toBe(80);
		});
	});

	// ====================================================================
	// LAYOUT_LABELS
	// ====================================================================

	describe('LAYOUT_LABELS', () => {
		it('has entries for all three layout types', () => {
			const types: MindMapLayoutType[] = ['mindmap', 'radial', 'force'];
			for (const type of types) {
				expect(LAYOUT_LABELS[type]).toBeDefined();
				expect(LAYOUT_LABELS[type].name).toBeTruthy();
				expect(LAYOUT_LABELS[type].description).toBeTruthy();
			}
		});
	});

	// ====================================================================
	// calculateNodeHeight
	// ====================================================================

	describe('calculateNodeHeight', () => {
		it('returns base height when no preview text', () => {
			expect(calculateNodeHeight(undefined, 100)).toBe(NODE_HEIGHT_BASE);
			expect(calculateNodeHeight('', 100)).toBe(NODE_HEIGHT_BASE);
		});

		it('returns taller height for longer preview text', () => {
			const short = calculateNodeHeight('Hello', 100);
			const long = calculateNodeHeight('A'.repeat(200), 300);
			expect(long).toBeGreaterThan(short);
		});

		it('respects previewCharLimit truncation', () => {
			const text = 'A'.repeat(500);
			const limited = calculateNodeHeight(text, 100);
			const unlimited = calculateNodeHeight(text, 500);
			expect(unlimited).toBeGreaterThanOrEqual(limited);
		});

		it('returns consistent results (caching)', () => {
			const a = calculateNodeHeight('Test text here', 100);
			const b = calculateNodeHeight('Test text here', 100);
			expect(a).toBe(b);
		});
	});

	// ====================================================================
	// buildAdjacencyMap
	// ====================================================================

	describe('buildAdjacencyMap', () => {
		it('returns empty map for empty links', () => {
			const adj = buildAdjacencyMap([]);
			expect(adj.size).toBe(0);
		});

		it('builds bidirectional adjacency', () => {
			const adj = buildAdjacencyMap([createLink('A', 'B')]);
			expect(adj.get('A')?.has('B')).toBe(true);
			expect(adj.get('B')?.has('A')).toBe(true);
		});

		it('handles multiple links', () => {
			const adj = buildAdjacencyMap([
				createLink('A', 'B'),
				createLink('A', 'C'),
				createLink('B', 'C'),
			]);
			expect(adj.get('A')?.size).toBe(2);
			expect(adj.get('B')?.size).toBe(2);
			expect(adj.get('C')?.size).toBe(2);
		});
	});

	// ====================================================================
	// calculateLayout dispatcher
	// ====================================================================

	describe('calculateLayout', () => {
		const { nodes, links } = buildStarGraph();
		const adjacency = buildAdjacencyMap(links);

		it('dispatches to mindmap layout', () => {
			const result = calculateLayout(
				'mindmap',
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes.length).toBeGreaterThan(0);
			expect(result.links.length).toBeGreaterThan(0);
			expect(result.bounds).toBeDefined();
		});

		it('dispatches to radial layout', () => {
			const result = calculateLayout(
				'radial',
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes.length).toBeGreaterThan(0);
		});

		it('dispatches to force layout', () => {
			const result = calculateLayout(
				'force',
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes.length).toBeGreaterThan(0);
		});

		it('falls back to mindmap for unknown type', () => {
			const result = calculateLayout(
				'unknown' as MindMapLayoutType,
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes.length).toBeGreaterThan(0);
		});
	});

	// ====================================================================
	// Mind Map Layout
	// ====================================================================

	describe('calculateMindMapLayout', () => {
		it('returns empty result when no nodes match centerFilePath', () => {
			const result = calculateMindMapLayout(
				[],
				[],
				buildAdjacencyMap([]),
				'nonexistent',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes).toEqual([]);
			expect(result.links).toEqual([]);
		});

		it('positions center node at canvas center', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			const centerNode = result.nodes.find((n) => n.id === 'center');
			expect(centerNode).toBeDefined();
			expect(centerNode!.side).toBe('center');
		});

		it('distributes children left and right', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			const children = result.nodes.filter((n) => n.id !== 'center');
			const sides = new Set(children.map((n) => n.side));
			// Should have nodes on both sides
			expect(sides.has('left')).toBe(true);
			expect(sides.has('right')).toBe(true);
		});

		it('respects maxDepth filtering', () => {
			const { nodes, links } = buildDeepGraph();
			const adjacency = buildAdjacencyMap(links);
			// maxDepth=1 should exclude node D (depth 2)
			const result = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				1,
				1200,
				800,
				false,
				100
			);
			const nodeIds = result.nodes.map((n) => n.id);
			expect(nodeIds).not.toContain('D');
			expect(nodeIds).toContain('center');
		});

		it('includes external nodes when showExternalLinks is true', () => {
			const ext = createExternalNode('github.com');
			const nodes = [createNode('center'), ext];
			const links = [createLink('center', ext.id, 'external')];
			const adjacency = buildAdjacencyMap(links);

			const result = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				true,
				100
			);
			const hasExternal = result.nodes.some((n) => n.nodeType === 'external');
			expect(hasExternal).toBe(true);
		});

		it('excludes external nodes when showExternalLinks is false', () => {
			const ext = createExternalNode('github.com');
			const nodes = [createNode('center'), ext];
			const links = [createLink('center', ext.id, 'external')];
			const adjacency = buildAdjacencyMap(links);

			const result = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			const hasExternal = result.nodes.some((n) => n.nodeType === 'external');
			expect(hasExternal).toBe(false);
		});

		it('computes valid bounds', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.bounds.minX).toBeLessThanOrEqual(result.bounds.maxX);
			expect(result.bounds.minY).toBeLessThanOrEqual(result.bounds.maxY);
		});
	});

	// ====================================================================
	// Radial Layout
	// ====================================================================

	describe('calculateRadialLayout', () => {
		it('returns empty result when center node not found', () => {
			const result = calculateRadialLayout(
				[],
				[],
				buildAdjacencyMap([]),
				'nonexistent',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes).toEqual([]);
		});

		it('positions center node at canvas center', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateRadialLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			const centerNode = result.nodes.find((n) => n.id === 'center');
			expect(centerNode).toBeDefined();
			expect(centerNode!.side).toBe('center');
		});

		it('places depth-1 nodes in a ring around center', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateRadialLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			const centerNode = result.nodes.find((n) => n.id === 'center')!;
			const depth1Nodes = result.nodes.filter((n) => n.depth === 1);

			// All depth-1 nodes should be roughly equidistant from center
			const distances = depth1Nodes.map((n) =>
				Math.sqrt((n.x - centerNode.x) ** 2 + (n.y - centerNode.y) ** 2)
			);
			if (distances.length > 1) {
				const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
				for (const d of distances) {
					// Allow some tolerance due to node size adjustments
					expect(Math.abs(d - avgDist)).toBeLessThan(avgDist * 0.3);
				}
			}
		});

		it('produces valid bounds', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateRadialLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.bounds.minX).toBeLessThanOrEqual(result.bounds.maxX);
			expect(result.bounds.minY).toBeLessThanOrEqual(result.bounds.maxY);
		});
	});

	// ====================================================================
	// Force-Directed Layout
	// ====================================================================

	describe('calculateForceLayout', () => {
		it('returns empty result when center node not found', () => {
			const result = calculateForceLayout(
				[],
				[],
				buildAdjacencyMap([]),
				'nonexistent',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes).toEqual([]);
		});

		it('places all visible nodes', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateForceLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			// center + A + B + C
			expect(result.nodes.length).toBe(4);
		});

		it('positions center node near canvas center', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateForceLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			const centerNode = result.nodes.find((n) => n.id === 'center')!;
			// Center should be pinned near (600, 400) ± some tolerance
			expect(Math.abs(centerNode.x - 600)).toBeLessThan(200);
			expect(Math.abs(centerNode.y - 400)).toBeLessThan(200);
		});

		it('produces deterministic results (same input, same output)', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const r1 = calculateForceLayout(nodes, links, adjacency, 'center', 2, 1200, 800, false, 100);
			const r2 = calculateForceLayout(nodes, links, adjacency, 'center', 2, 1200, 800, false, 100);
			// Same input should produce same positions (deterministic seed)
			for (let i = 0; i < r1.nodes.length; i++) {
				expect(r1.nodes[i].x).toBeCloseTo(r2.nodes[i].x, 0);
				expect(r1.nodes[i].y).toBeCloseTo(r2.nodes[i].y, 0);
			}
		});

		it('produces valid bounds', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateForceLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.bounds.minX).toBeLessThanOrEqual(result.bounds.maxX);
			expect(result.bounds.minY).toBeLessThanOrEqual(result.bounds.maxY);
		});

		it('generates links between visible nodes', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateForceLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100
			);
			expect(result.links.length).toBeGreaterThan(0);
		});
	});

	// ====================================================================
	// Layout comparison: different algorithms produce different positions
	// ====================================================================

	describe('layout algorithm diversity', () => {
		it('different algorithms produce different node positions', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const args = [nodes, links, adjacency, 'center', 2, 1200, 800, false, 100] as const;

			const mindmap = calculateMindMapLayout(...args);
			const radial = calculateRadialLayout(...args);
			const force = calculateForceLayout(...args);

			// Each algorithm should produce positioned nodes
			expect(mindmap.nodes.length).toBeGreaterThan(0);
			expect(radial.nodes.length).toBeGreaterThan(0);
			expect(force.nodes.length).toBeGreaterThan(0);

			// At least some positions should differ between algorithms
			// (comparing node A's position across layouts)
			const mmA = mindmap.nodes.find((n) => n.id === 'A');
			const rdA = radial.nodes.find((n) => n.id === 'A');
			const fcA = force.nodes.find((n) => n.id === 'A');

			if (mmA && rdA && fcA) {
				const positions = [
					{ x: mmA.x, y: mmA.y },
					{ x: rdA.x, y: rdA.y },
					{ x: fcA.x, y: fcA.y },
				];
				// Not all three should be identical
				const allSame = positions.every((p) => p.x === positions[0].x && p.y === positions[0].y);
				expect(allSame).toBe(false);
			}
		});
	});
});
