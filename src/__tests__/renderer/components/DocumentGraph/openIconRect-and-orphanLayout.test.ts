// Source: src/__tests__/renderer/components/DocumentGraph/openIconRect.test.ts
// Source: src/__tests__/renderer/components/DocumentGraph/orphanLayout.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { openIconRect } from '../../../../renderer/components/DocumentGraph/mindMapCanvas';
import { NODE_HEADER_HEIGHT } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import type { MindMapNode } from '../../../../renderer/components/DocumentGraph/MindMap';
import type { MindMapLink } from '../../../../renderer/components/DocumentGraph/MindMap';
import { calculateLayout } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { calculateMindMapLayout } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { calculateRadialLayout } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { calculateHierarchicalLayout } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { calculateForceLayout } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { buildAdjacencyMap } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { NODE_WIDTH } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import { NODE_HEIGHT_BASE } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import type { MindMapLayoutType } from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
describeSourceSuite('openIconRect', () => {
	/** A node is positioned by its CENTER, so the box runs from x - w/2 to x + w/2. */
	const card = { x: 200, y: 300, width: 240, height: 120 };
	const pill = { x: 200, y: 300, width: 240, height: NODE_HEADER_HEIGHT };

	describe('openIconRect', () => {
		it('sits inside the node, hard against its right edge', () => {
			const rect = openIconRect(card, 100);
			const right = card.x + card.width / 2;

			expect(rect.x).toBeGreaterThan(card.x);
			expect(rect.x + rect.size).toBeLessThan(right);
		});

		it('centres the icon in the header band on a full card', () => {
			const rect = openIconRect(card, 100);
			const top = card.y - card.height / 2;

			// Equal gap above and below within the header strip - not the whole node,
			// which would drop the icon into the preview text.
			const gapAbove = rect.y - top;
			const gapBelow = top + NODE_HEADER_HEIGHT - (rect.y + rect.size);
			expect(gapAbove).toBeCloseTo(gapBelow);
			expect(rect.y + rect.size).toBeLessThanOrEqual(top + NODE_HEADER_HEIGHT);
		});

		it('centres the icon in the whole node once previews are off', () => {
			// The pill has no header strip to sit in: the title band IS the node.
			const rect = openIconRect(pill, 0);
			const top = pill.y - pill.height / 2;

			const gapAbove = rect.y - top;
			const gapBelow = top + pill.height - (rect.y + rect.size);
			expect(gapAbove).toBeCloseTo(gapBelow);
		});

		it('never runs past the bottom of a node shorter than a header band', () => {
			// Defensive: a layout that produced a stubby node must not draw the icon
			// outside it, which would leave a hit box floating over the canvas.
			const stub = { x: 0, y: 0, width: 200, height: 20 };
			const rect = openIconRect(stub, 100);

			expect(rect.y).toBeGreaterThanOrEqual(stub.y - stub.height / 2);
			expect(rect.y + rect.size).toBeLessThanOrEqual(stub.y + stub.height / 2);
		});

		it('gives the same rectangle for every "off" spelling', () => {
			// `isPreviewOff` treats anything at or below 0 as off, so the hit test and
			// the renderer must agree on a stored value of -1 as much as on 0.
			expect(openIconRect(pill, 0)).toEqual(openIconRect(pill, -1));
		});
	});
});
describeSourceSuite('orphanLayout', () => {
	function node(id: string, overrides: Partial<MindMapNode> = {}): MindMapNode {
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

	/**
	 * center -> linked, plus `lonely` (no edges at all) and a `pairA`/`pairB`
	 * cluster that links only to itself. Both of the latter are unreachable from
	 * the center and both are what "not interlinked" means to a user.
	 */
	const NODES: MindMapNode[] = [
		node('doc-center'),
		node('doc-linked'),
		node('doc-lonely'),
		node('doc-pairA'),
		node('doc-pairB'),
	];

	const LINKS: MindMapLink[] = [
		{ source: 'doc-center', target: 'doc-linked', type: 'internal' },
		{ source: 'doc-pairA', target: 'doc-pairB', type: 'internal' },
	];

	const ADJACENCY = buildAdjacencyMap(LINKS);

	function run(layoutType: MindMapLayoutType, showOrphans: boolean) {
		return calculateLayout(
			layoutType,
			NODES,
			LINKS,
			ADJACENCY,
			'center.md',
			3,
			2000,
			1500,
			false,
			100,
			1,
			showOrphans
		);
	}

	const LAYOUTS: MindMapLayoutType[] = ['mindmap', 'radial', 'hierarchical', 'force'];

	describe('orphan admission in layouts', () => {
		it.each(LAYOUTS)('%s drops unreachable documents when showOrphans is off', (layoutType) => {
			const ids = run(layoutType, false).nodes.map((n) => n.id);
			expect(ids).toContain('doc-center');
			expect(ids).toContain('doc-linked');
			expect(ids).not.toContain('doc-lonely');
			expect(ids).not.toContain('doc-pairA');
		});

		it.each(LAYOUTS)('%s positions unreachable documents when showOrphans is on', (layoutType) => {
			const ids = run(layoutType, true).nodes.map((n) => n.id);
			expect(ids).toContain('doc-lonely');
			// A disconnected cluster is unreachable too, and is just as much "not
			// interlinked" as a file with no edges at all.
			expect(ids).toContain('doc-pairA');
			expect(ids).toContain('doc-pairB');
		});

		it.each(LAYOUTS)('%s marks orphans so they can be told apart visually', (layoutType) => {
			const orphan = run(layoutType, true).nodes.find((n) => n.id === 'doc-lonely');
			expect(orphan?.isOrphan).toBe(true);
			expect(orphan?.side).toBe('orphan');
		});

		it.each(LAYOUTS)('%s leaves reachable documents unmarked', (layoutType) => {
			const linked = run(layoutType, true).nodes.find((n) => n.id === 'doc-linked');
			expect(linked?.isOrphan).toBeFalsy();
			expect(linked?.side).not.toBe('orphan');
		});

		it('places the orphan band below everything else', () => {
			// The band must clear the graph rather than overlap it. Checked on the
			// deterministic mindmap layout; the force layout settles by simulation.
			const result = calculateMindMapLayout(
				NODES,
				LINKS,
				ADJACENCY,
				'center.md',
				3,
				2000,
				1500,
				false,
				100,
				1,
				true
			);
			const lowestNonOrphan = Math.max(
				...result.nodes.filter((n) => !n.isOrphan).map((n) => n.y + n.height / 2)
			);
			const highestOrphan = Math.min(
				...result.nodes.filter((n) => n.isOrphan).map((n) => n.y - n.height / 2)
			);
			expect(highestOrphan).toBeGreaterThan(lowestNonOrphan);
		});

		it('gives every orphan a real position', () => {
			// A node left at the origin reads as a rendering bug rather than an
			// orphan, and stacks every orphan on top of the others.
			const orphans = calculateRadialLayout(
				NODES,
				LINKS,
				ADJACENCY,
				'center.md',
				3,
				2000,
				1500,
				false,
				100,
				1,
				true
			).nodes.filter((n) => n.isOrphan);

			expect(orphans.length).toBe(3);
			const positions = new Set(orphans.map((n) => `${n.x},${n.y}`));
			expect(positions.size).toBe(orphans.length);
			for (const o of orphans) {
				expect(Number.isFinite(o.x)).toBe(true);
				expect(Number.isFinite(o.y)).toBe(true);
				expect(o.width).toBeGreaterThan(0);
				expect(o.height).toBeGreaterThan(0);
			}
		});

		it('defaults to hiding orphans so existing callers are unaffected', () => {
			// The flag is last and optional; every pre-existing call site omits it.
			const ids = calculateHierarchicalLayout(
				NODES,
				LINKS,
				ADJACENCY,
				'center.md',
				3,
				2000,
				1500,
				false,
				100,
				1
			).nodes.map((n) => n.id);
			expect(ids).not.toContain('doc-lonely');
		});

		it('keeps orphans out of the drawn links', () => {
			const result = calculateForceLayout(
				NODES,
				LINKS,
				ADJACENCY,
				'center.md',
				3,
				2000,
				1500,
				false,
				100,
				1,
				true
			);
			// doc-lonely has no edges, so no link may reference it.
			for (const link of result.links) {
				expect(link.source).not.toBe('doc-lonely');
				expect(link.target).not.toBe('doc-lonely');
			}
		});
	});
});
