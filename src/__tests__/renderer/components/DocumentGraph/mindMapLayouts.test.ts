/**
 * Tests for the canvas-based mind map layout algorithms (mindMapLayouts.ts)
 *
 * Verifies the six layout algorithms (Mind Map, Radial, Hierarchical, Force-Directed,
 * Lobes, Timeline),
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
	MIND_MAP_LAYOUT_TYPES,
	nextMindMapLayout,
	calculateLayout,
	calculateMindMapLayout,
	calculateRadialLayout,
	calculateHierarchicalLayout,
	calculateForceLayout,
	calculateLobesLayout,
	calculateTimelineLayout,
	buildAdjacencyMap,
	calculateNodeHeight,
	calculateNodeWidth,
	NODE_PILL_MIN_WIDTH,
	NODE_PILL_CHAR_WIDTH,
	NODE_PILL_CHROME_WIDTH,
	NODE_WIDTH,
	NODE_HEADER_HEIGHT,
	NODE_SUBHEADER_HEIGHT,
	NODE_HEIGHT_BASE,
	NODE_PILL_HEIGHT,
	DESC_LINE_HEIGHT,
	CHARS_PER_LINE,
	DESC_PADDING,
	CENTER_NODE_SCALE,
	EXTERNAL_NODE_WIDTH,
	EXTERNAL_NODE_HEIGHT,
	CANVAS_PADDING,
} from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { PREVIEW_CHAR_LIMIT_OFF } from '../../../../renderer/components/DocumentGraph/previewCharLimit';

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
		it('has entries for all four layout types', () => {
			const types: MindMapLayoutType[] = ['mindmap', 'radial', 'hierarchical', 'force'];
			for (const type of types) {
				expect(LAYOUT_LABELS[type]).toBeDefined();
				expect(LAYOUT_LABELS[type].name).toBeTruthy();
				expect(LAYOUT_LABELS[type].description).toBeTruthy();
			}
		});
	});

	// ====================================================================
	// MIND_MAP_LAYOUT_TYPES / nextMindMapLayout
	// ====================================================================

	describe('nextMindMapLayout', () => {
		// One order serves the toolbar dropdown and the `L` shortcut, so a key
		// press and a click cannot disagree about what comes next.
		it('every listed layout has a label', () => {
			for (const type of MIND_MAP_LAYOUT_TYPES) {
				expect(LAYOUT_LABELS[type]).toBeDefined();
			}
			expect(MIND_MAP_LAYOUT_TYPES).toHaveLength(Object.keys(LAYOUT_LABELS).length);
		});

		it('advances through the list in order', () => {
			expect(nextMindMapLayout('mindmap')).toBe('radial');
			expect(nextMindMapLayout('radial')).toBe('hierarchical');
			expect(nextMindMapLayout('hierarchical')).toBe('force');
			expect(nextMindMapLayout('force')).toBe('lobes');
			expect(nextMindMapLayout('lobes')).toBe('timeline');
		});

		it('wraps at the end of the list', () => {
			// Read the last entry rather than naming it, so adding a layout does
			// not turn this into a false failure about the wrap behaviour.
			const last = MIND_MAP_LAYOUT_TYPES[MIND_MAP_LAYOUT_TYPES.length - 1];
			expect(nextMindMapLayout(last)).toBe(MIND_MAP_LAYOUT_TYPES[0]);
		});

		it('visits every layout exactly once per cycle', () => {
			const seen: MindMapLayoutType[] = [];
			let current: MindMapLayoutType = MIND_MAP_LAYOUT_TYPES[0];
			for (let i = 0; i < MIND_MAP_LAYOUT_TYPES.length; i++) {
				seen.push(current);
				current = nextMindMapLayout(current);
			}
			expect(new Set(seen).size).toBe(MIND_MAP_LAYOUT_TYPES.length);
			expect(current).toBe(MIND_MAP_LAYOUT_TYPES[0]);
		});

		it('restarts the cycle from an unrecognized layout rather than sticking', () => {
			expect(nextMindMapLayout('nonsense' as MindMapLayoutType)).toBe(MIND_MAP_LAYOUT_TYPES[0]);
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

		it('collapses to a pill when previews are off, however long the text', () => {
			// Off is a mode, not a zero-length preview: the body box and the folder
			// sub-header both go away, so the height cannot depend on the content.
			expect(calculateNodeHeight('A'.repeat(500), 0)).toBe(NODE_PILL_HEIGHT);
			expect(calculateNodeHeight('short', 0)).toBe(NODE_PILL_HEIGHT);
			expect(calculateNodeHeight(undefined, 0)).toBe(NODE_PILL_HEIGHT);
			expect(NODE_PILL_HEIGHT).toBeLessThan(NODE_HEIGHT_BASE);
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
	// Hierarchical Layout (Top-Down)
	// ====================================================================

	describe('calculateHierarchicalLayout', () => {
		it('returns empty result when center node not found', () => {
			const result = calculateHierarchicalLayout(
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

		it('places center at canvas center and children below it', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateHierarchicalLayout(
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
			const center = result.nodes.find((n) => n.id === 'center')!;
			const children = result.nodes.filter((n) => n.id !== 'center');
			expect(children.length).toBeGreaterThan(0);
			for (const child of children) {
				expect(child.y).toBeGreaterThan(center.y);
			}
		});

		it('aligns siblings on the same horizontal row', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const result = calculateHierarchicalLayout(
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
			const siblings = result.nodes.filter((n) => n.id !== 'center');
			const ys = new Set(siblings.map((n) => n.y));
			// Star graph has all neighbors at depth 1 - they should share a single row Y.
			expect(ys.size).toBe(1);
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

	// ====================================================================
	// Node width (pill sizing)
	// ====================================================================
	describe('calculateNodeWidth', () => {
		it('returns the full card width whenever previews are on', () => {
			expect(calculateNodeWidth('a', 100)).toBe(NODE_WIDTH);
			expect(calculateNodeWidth('a-very-long-document-name', 500)).toBe(NODE_WIDTH);
		});

		it('measures the filename when previews are off', () => {
			// A pill draws 32px tall. Reserving a full 260px card width for it is
			// what pushed the radial rings out to thousands of pixels.
			const short = calculateNodeWidth('todo', PREVIEW_CHAR_LIMIT_OFF);
			expect(short).toBeLessThan(NODE_WIDTH);
			expect(short).toBeGreaterThanOrEqual(NODE_PILL_MIN_WIDTH);
		});

		it('grows with the label but never past the card width', () => {
			const short = calculateNodeWidth('abcdefghij', PREVIEW_CHAR_LIMIT_OFF);
			const longer = calculateNodeWidth('abcdefghijklmnopqrst', PREVIEW_CHAR_LIMIT_OFF);
			expect(longer).toBeGreaterThan(short);
			expect(calculateNodeWidth('x'.repeat(200), PREVIEW_CHAR_LIMIT_OFF)).toBe(NODE_WIDTH);
		});

		it('keeps a one-character filename clickable', () => {
			expect(calculateNodeWidth('a', PREVIEW_CHAR_LIMIT_OFF)).toBe(NODE_PILL_MIN_WIDTH);
			expect(calculateNodeWidth(undefined, PREVIEW_CHAR_LIMIT_OFF)).toBe(NODE_PILL_MIN_WIDTH);
		});

		it('reserves exactly the width the renderer truncates against', () => {
			// The renderer fits `(width - CHROME) / CHAR_WIDTH` characters. A pill
			// sized here must therefore hold its own label without clipping.
			const label = 'twelve-chars';
			const width = calculateNodeWidth(label, PREVIEW_CHAR_LIMIT_OFF);
			const fits = Math.floor((width - NODE_PILL_CHROME_WIDTH) / NODE_PILL_CHAR_WIDTH);
			expect(fits).toBeGreaterThanOrEqual(label.length);
		});
	});

	// ====================================================================
	// Radial band packing
	// ====================================================================
	describe('calculateRadialLayout ring banding', () => {
		/** A hub with `count` documents hanging off it, all at depth 1. */
		function buildHub(count: number) {
			const center = createNode('center');
			const nodes = [center];
			const links: MindMapLink[] = [];
			for (let i = 0; i < count; i++) {
				const id = `n${String(i).padStart(3, '0')}`;
				nodes.push(createNode(id, { depth: 1 }));
				links.push(createLink('center', id));
			}
			return { nodes, links };
		}

		function maxRadius(result: ReturnType<typeof calculateRadialLayout>): number {
			return result.nodes.reduce((max, n) => Math.max(max, Math.hypot(n.x - 600, n.y - 400)), 0);
		}

		function layoutHub(count: number, previewCharLimit: number) {
			const { nodes, links } = buildHub(count);
			return calculateRadialLayout(
				nodes,
				links,
				buildAdjacencyMap(links),
				'center.md',
				2,
				1200,
				800,
				false,
				previewCharLimit
			);
		}

		it('places every sibling', () => {
			const result = layoutHub(60, PREVIEW_CHAR_LIMIT_OFF);
			expect(result.nodes).toHaveLength(61);
		});

		it('spills a crowded depth into sub-bands instead of one huge ring', () => {
			// The old layout sized a ring as N * arcLength / 2pi, so 60 siblings
			// produced a multi-thousand-pixel circle nothing could frame. Banding
			// makes the radius grow with roughly sqrt(N) instead.
			const result = layoutHub(60, PREVIEW_CHAR_LIMIT_OFF);
			const radii = new Set(
				result.nodes
					.filter((n) => n.id !== 'center')
					.map((n) => Math.round(Math.hypot(n.x - 600, n.y - 400)))
			);
			expect(radii.size).toBeGreaterThan(1);
			expect(maxRadius(result)).toBeLessThan(1200);
		});

		it('grows sub-linearly in sibling count', () => {
			const small = maxRadius(layoutHub(12, PREVIEW_CHAR_LIMIT_OFF));
			const large = maxRadius(layoutHub(48, PREVIEW_CHAR_LIMIT_OFF));
			// Four times the nodes must not cost four times the radius.
			expect(large).toBeLessThan(small * 4);
		});

		it('does not overlap two nodes on the same band', () => {
			const result = layoutHub(24, PREVIEW_CHAR_LIMIT_OFF);
			const placed = result.nodes.filter((n) => n.id !== 'center');
			for (let i = 0; i < placed.length; i++) {
				for (let j = i + 1; j < placed.length; j++) {
					const a = placed[i];
					const b = placed[j];
					const overlapsX = Math.abs(a.x - b.x) < (a.width + b.width) / 2;
					const overlapsY = Math.abs(a.y - b.y) < (a.height + b.height) / 2;
					expect(overlapsX && overlapsY).toBe(false);
				}
			}
		});

		it('is deterministic', () => {
			const first = layoutHub(30, PREVIEW_CHAR_LIMIT_OFF).nodes.map((n) => [n.id, n.x, n.y]);
			const second = layoutHub(30, PREVIEW_CHAR_LIMIT_OFF).nodes.map((n) => [n.id, n.x, n.y]);
			expect(first).toEqual(second);
		});

		it('bounds the whole graph, so it can be framed on screen', () => {
			const result = layoutHub(60, PREVIEW_CHAR_LIMIT_OFF);
			for (const node of result.nodes) {
				expect(node.x - node.width / 2).toBeGreaterThanOrEqual(result.bounds.minX);
				expect(node.x + node.width / 2).toBeLessThanOrEqual(result.bounds.maxX);
				expect(node.y - node.height / 2).toBeGreaterThanOrEqual(result.bounds.minY);
				expect(node.y + node.height / 2).toBeLessThanOrEqual(result.bounds.maxY);
			}
		});
	});

	// ====================================================================
	// Lobes
	// ====================================================================
	describe('calculateLobesLayout', () => {
		/**
		 * Two densely-linked clusters joined by a single bridge, plus the center.
		 * Label propagation should separate the clusters.
		 */
		function buildTwoClusterGraph() {
			const nodes = [createNode('center')];
			const links: MindMapLink[] = [];
			const cluster = (prefix: string, size: number) => {
				const ids: string[] = [];
				for (let i = 0; i < size; i++) {
					const id = `${prefix}${i}`;
					ids.push(id);
					nodes.push(createNode(id, { depth: 1 }));
				}
				for (let i = 0; i < ids.length; i++) {
					for (let j = i + 1; j < ids.length; j++) {
						links.push(createLink(ids[i], ids[j]));
					}
				}
				return ids;
			};
			const a = cluster('a', 5);
			const b = cluster('b', 5);
			links.push(createLink('center', a[0]));
			links.push(createLink('center', b[0]));
			return { nodes, links, a, b };
		}

		function layoutClusters(previewCharLimit = 100) {
			const { nodes, links, a, b } = buildTwoClusterGraph();
			const result = calculateLobesLayout(
				nodes,
				links,
				buildAdjacencyMap(links),
				'center.md',
				3,
				1200,
				800,
				false,
				previewCharLimit
			);
			return { result, a, b };
		}

		it('places every visible document exactly once', () => {
			const { result } = layoutClusters();
			expect(result.nodes).toHaveLength(11);
			expect(new Set(result.nodes.map((n) => n.id)).size).toBe(11);
		});

		it('keeps a cluster closer to itself than to the other cluster', () => {
			const { result, a, b } = layoutClusters();
			const at = (id: string) => result.nodes.find((n) => n.id === id)!;
			const centroid = (ids: string[]) => ({
				x: ids.reduce((sum, id) => sum + at(id).x, 0) / ids.length,
				y: ids.reduce((sum, id) => sum + at(id).y, 0) / ids.length,
			});
			const ca = centroid(a);
			const cb = centroid(b);
			const spread = (ids: string[], c: { x: number; y: number }) =>
				Math.max(...ids.map((id) => Math.hypot(at(id).x - c.x, at(id).y - c.y)));
			const separation = Math.hypot(ca.x - cb.x, ca.y - cb.y);
			expect(separation).toBeGreaterThan(Math.max(spread(a, ca), spread(b, cb)));
		});

		it('draws every link between placed nodes, not just adjacent depths', () => {
			// The cross-cluster edges are the whole reason to look at this layout,
			// so a depth filter here would hide the answer.
			const { result } = layoutClusters();
			const ids = new Set(result.nodes.map((n) => n.id));
			const intra = result.links.filter(
				(l) => l.source.startsWith('a') && l.target.startsWith('a')
			);
			expect(intra.length).toBeGreaterThan(0);
			result.links.forEach((link) => {
				expect(ids.has(link.source)).toBe(true);
				expect(ids.has(link.target)).toBe(true);
			});
		});

		it('marks exactly one node as focused', () => {
			const { result } = layoutClusters();
			expect(result.nodes.filter((n) => n.isFocused)).toHaveLength(1);
			expect(result.nodes.find((n) => n.isFocused)?.id).toBe('center');
		});

		it('is deterministic across runs', () => {
			const first = layoutClusters().result.nodes.map((n) => [n.id, n.x, n.y]);
			const second = layoutClusters().result.nodes.map((n) => [n.id, n.x, n.y]);
			expect(first).toEqual(second);
		});

		it('handles a graph with no links at all', () => {
			const nodes = [createNode('center'), createNode('lonely')];
			const result = calculateLobesLayout(
				nodes,
				[],
				buildAdjacencyMap([]),
				'center.md',
				3,
				1200,
				800,
				false,
				100
			);
			expect(result.nodes.length).toBeGreaterThan(0);
			result.nodes.forEach((n) => {
				expect(Number.isFinite(n.x)).toBe(true);
				expect(Number.isFinite(n.y)).toBe(true);
			});
		});
	});

	// ====================================================================
	// Timeline
	// ====================================================================
	describe('calculateTimelineLayout', () => {
		const DAY = 86400000;
		const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

		function buildDatedGraph() {
			const center = createNode('center', { mtime: BASE });
			const older = createNode('older', { depth: 1, mtime: BASE - 2 * DAY });
			const oldest = createNode('oldest', { depth: 1, mtime: BASE - 5 * DAY });
			const undated = createNode('undated', { depth: 1, mtime: 0 });
			const links = [
				createLink('center', 'older'),
				createLink('center', 'oldest'),
				createLink('center', 'undated'),
			];
			return { nodes: [center, older, oldest, undated], links };
		}

		function layoutDated() {
			const { nodes, links } = buildDatedGraph();
			return calculateTimelineLayout(
				nodes,
				links,
				buildAdjacencyMap(links),
				'center.md',
				3,
				1200,
				800,
				false,
				100
			);
		}

		it('orders columns oldest to newest, left to right', () => {
			const result = layoutDated();
			const at = (id: string) => result.nodes.find((n) => n.id === id)!;
			expect(at('oldest').x).toBeLessThan(at('older').x);
			expect(at('older').x).toBeLessThan(at('center').x);
		});

		it('leads with an Undated column rather than dating a file to 1970', () => {
			const result = layoutDated();
			const at = (id: string) => result.nodes.find((n) => n.id === id)!;
			expect(at('undated').x).toBeLessThan(at('oldest').x);
			expect(result.axisLabels?.[0]?.text).toBe('Undated');
		});

		it('captions every column, since an uncaptioned time axis says nothing', () => {
			const result = layoutDated();
			const columnCount = new Set(result.nodes.map((n) => Math.round(n.x))).size;
			expect(result.axisLabels).toHaveLength(columnCount);
		});

		it('groups documents modified on the same day into one column', () => {
			const center = createNode('center', { mtime: BASE });
			const sameDay = createNode('sameDay', { depth: 1, mtime: BASE + 3600000 });
			const links = [createLink('center', 'sameDay')];
			const result = calculateTimelineLayout(
				[center, sameDay],
				links,
				buildAdjacencyMap(links),
				'center.md',
				3,
				1200,
				800,
				false,
				100
			);
			const xs = result.nodes.map((n) => Math.round(n.x));
			expect(new Set(xs).size).toBe(1);
			expect(result.axisLabels).toHaveLength(1);
		});

		it('does not stack two documents on top of each other in a column', () => {
			const result = layoutDated();
			const byColumn = new Map<number, typeof result.nodes>();
			result.nodes.forEach((n) => {
				const key = Math.round(n.x);
				if (!byColumn.has(key)) byColumn.set(key, []);
				byColumn.get(key)!.push(n);
			});
			byColumn.forEach((column) => {
				const sorted = [...column].sort((a, b) => a.y - b.y);
				for (let i = 1; i < sorted.length; i++) {
					const prev = sorted[i - 1];
					expect(sorted[i].y - sorted[i].height / 2).toBeGreaterThanOrEqual(
						prev.y + prev.height / 2 - 0.001
					);
				}
			});
		});

		it('frames its own captions in the reported bounds', () => {
			const result = layoutDated();
			const topLabel = Math.min(...(result.axisLabels ?? []).map((l) => l.y));
			expect(result.bounds.minY).toBeLessThan(topLabel);
		});
	});

	describe('layout algorithm diversity', () => {
		it('different algorithms produce different node positions', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const args = [nodes, links, adjacency, 'center', 2, 1200, 800, false, 100] as const;

			const mindmap = calculateMindMapLayout(...args);
			const radial = calculateRadialLayout(...args);
			const hierarchical = calculateHierarchicalLayout(...args);
			const force = calculateForceLayout(...args);

			// Each algorithm should produce positioned nodes
			expect(mindmap.nodes.length).toBeGreaterThan(0);
			expect(radial.nodes.length).toBeGreaterThan(0);
			expect(hierarchical.nodes.length).toBeGreaterThan(0);
			expect(force.nodes.length).toBeGreaterThan(0);

			// At least some positions should differ between algorithms
			// (comparing node A's position across layouts)
			const mmA = mindmap.nodes.find((n) => n.id === 'A');
			const rdA = radial.nodes.find((n) => n.id === 'A');
			const hrA = hierarchical.nodes.find((n) => n.id === 'A');
			const fcA = force.nodes.find((n) => n.id === 'A');

			if (mmA && rdA && hrA && fcA) {
				const positions = [
					{ x: mmA.x, y: mmA.y },
					{ x: rdA.x, y: rdA.y },
					{ x: hrA.x, y: hrA.y },
					{ x: fcA.x, y: fcA.y },
				];
				// Not all four should be identical
				const allSame = positions.every((p) => p.x === positions[0].x && p.y === positions[0].y);
				expect(allSame).toBe(false);
			}
		});
	});

	// ====================================================================
	// Spacing scale: +/- key adjustment multiplier applied across layouts
	// ====================================================================

	describe('spacingScale parameter', () => {
		it('expands mind map horizontal columns when scale > 1', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const base = calculateMindMapLayout(
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
			const wide = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100,
				2
			);
			const baseA = base.nodes.find((n) => n.id === 'A')!;
			const wideA = wide.nodes.find((n) => n.id === 'A')!;
			const center = base.nodes.find((n) => n.id === 'center')!;
			expect(Math.abs(wideA.x - center.x)).toBeGreaterThan(Math.abs(baseA.x - center.x));
		});

		it('expands radial rings when scale > 1', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const base = calculateRadialLayout(
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
			const wide = calculateRadialLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100,
				2
			);
			const center = base.nodes.find((n) => n.id === 'center')!;
			const baseRadius = Math.hypot(
				base.nodes.find((n) => n.id === 'A')!.x - center.x,
				base.nodes.find((n) => n.id === 'A')!.y - center.y
			);
			const wideRadius = Math.hypot(
				wide.nodes.find((n) => n.id === 'A')!.x - center.x,
				wide.nodes.find((n) => n.id === 'A')!.y - center.y
			);
			expect(wideRadius).toBeGreaterThan(baseRadius);
		});

		it('treats undefined spacingScale as 1 (backward compatible)', () => {
			const { nodes, links } = buildStarGraph();
			const adjacency = buildAdjacencyMap(links);
			const noScale = calculateMindMapLayout(
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
			const explicitOne = calculateMindMapLayout(
				nodes,
				links,
				adjacency,
				'center',
				2,
				1200,
				800,
				false,
				100,
				1
			);
			const a1 = noScale.nodes.find((n) => n.id === 'A')!;
			const a2 = explicitOne.nodes.find((n) => n.id === 'A')!;
			expect(a2.x).toBe(a1.x);
			expect(a2.y).toBe(a1.y);
		});
	});
});
