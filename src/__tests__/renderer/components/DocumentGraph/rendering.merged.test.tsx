// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/components/DocumentGraph/orphanLayout.test.ts
// Source: src/__tests__/renderer/components/DocumentGraph/scrollMode.test.ts
import { describe, it, expect } from 'vitest';
import type {
	MindMapNode,
	MindMapLink,
} from '../../../../renderer/components/DocumentGraph/MindMap';
import {
	calculateLayout,
	calculateMindMapLayout,
	calculateRadialLayout,
	calculateHierarchicalLayout,
	calculateForceLayout,
	buildAdjacencyMap,
	NODE_WIDTH,
	NODE_HEIGHT_BASE,
	type MindMapLayoutType,
} from '../../../../renderer/components/DocumentGraph/mindMapLayouts';
import {
	DEFAULT_SCROLL_MODE,
	SCROLL_MODE_LABELS,
	SCROLL_MODE_STORAGE_KEY,
	nextScrollMode,
	scrollModeFromPans,
	scrollModePans,
	type GraphScrollMode,
} from '../../../../renderer/components/DocumentGraph/scrollMode';
// Source: src/__tests__/renderer/components/DocumentGraph/orphanLayout.test.ts
describe('', () => {
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
// Source: src/__tests__/renderer/components/DocumentGraph/scrollMode.test.ts
describe('', () => {
	describe('scrollMode', () => {
		describe('DEFAULT_SCROLL_MODE', () => {
			it('keeps the graph zooming on scroll, as it always has', () => {
				// Changing the default would silently repurpose the wheel for every
				// existing user on their next launch.
				expect(DEFAULT_SCROLL_MODE).toBe('zoom');
			});
		});
		describe('nextScrollMode', () => {
			it('swaps the two modes', () => {
				expect(nextScrollMode('zoom')).toBe('pan');
				expect(nextScrollMode('pan')).toBe('zoom');
			});
			it('returns to the starting mode after two presses', () => {
				expect(nextScrollMode(nextScrollMode('zoom'))).toBe('zoom');
				expect(nextScrollMode(nextScrollMode('pan'))).toBe('pan');
			});
		});
		describe('persistence round-trip', () => {
			it('survives the boolean the storage layer keeps', () => {
				const modes: GraphScrollMode[] = ['zoom', 'pan'];
				modes.forEach((mode) => {
					expect(scrollModeFromPans(scrollModePans(mode))).toBe(mode);
				});
			});
			it('reads pan as the panning mode', () => {
				expect(scrollModePans('pan')).toBe(true);
				expect(scrollModePans('zoom')).toBe(false);
				expect(scrollModeFromPans(true)).toBe('pan');
				expect(scrollModeFromPans(false)).toBe('zoom');
			});
			it('namespaces its storage key to the graph', () => {
				expect(SCROLL_MODE_STORAGE_KEY.startsWith('documentGraph.')).toBe(true);
			});
		});
		describe('SCROLL_MODE_LABELS', () => {
			it('describes every mode', () => {
				(['zoom', 'pan'] as GraphScrollMode[]).forEach((mode) => {
					expect(SCROLL_MODE_LABELS[mode].name).toBeTruthy();
					expect(SCROLL_MODE_LABELS[mode].wheelAction).toBeTruthy();
					expect(SCROLL_MODE_LABELS[mode].modifierAction).toBeTruthy();
				});
			});
			it('makes the modifier reach the other mode', () => {
				// This is the whole contract of the feature: whichever mode is on,
				// Shift still gets you the other action, so the mode is a default
				// rather than a lock. A label pair that broke this would be telling
				// the user an action is unavailable when it is one key away.
				expect(SCROLL_MODE_LABELS.zoom.modifierAction).toBe(SCROLL_MODE_LABELS.pan.wheelAction);
				expect(SCROLL_MODE_LABELS.pan.modifierAction).toBe(SCROLL_MODE_LABELS.zoom.wheelAction);
			});
			it('never describes the wheel and the modifier as doing the same thing', () => {
				(['zoom', 'pan'] as GraphScrollMode[]).forEach((mode) => {
					expect(SCROLL_MODE_LABELS[mode].wheelAction).not.toBe(
						SCROLL_MODE_LABELS[mode].modifierAction
					);
				});
			});
		});
		describe('wheel binding', () => {
			/**
			 * The rule the canvas applies: Shift INVERTS the mode rather than naming
			 * a fixed action. Mirrored here because it is one expression in
			 * `MindMap`'s wheel handler and it is easy to "simplify" into
			 * `mode === 'pan' || e.shiftKey`, which would strand a Pan-mode user
			 * with no way to zoom at all.
			 */
			const panning = (mode: GraphScrollMode, shiftKey: boolean) => (mode === 'pan') !== shiftKey;
			it('pans on a bare wheel only in pan mode', () => {
				expect(panning('zoom', false)).toBe(false);
				expect(panning('pan', false)).toBe(true);
			});
			it('gives the other action to Shift in both modes', () => {
				expect(panning('zoom', true)).toBe(true);
				expect(panning('pan', true)).toBe(false);
			});
			it('leaves zoom reachable from every mode', () => {
				const zoomReachable = (mode: GraphScrollMode) =>
					!panning(mode, false) || !panning(mode, true);
				expect(zoomReachable('zoom')).toBe(true);
				expect(zoomReachable('pan')).toBe(true);
			});
		});
	});
});
