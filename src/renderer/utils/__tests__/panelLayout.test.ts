/**
 * Tests for panelLayout.ts - pure split-pane layout tree utilities (tab tiling).
 *
 * Functions tested:
 * - createLeaf
 * - createGroupFromTabRefs
 * - splitLeaf (both directions, same-direction parent reuse, size normalization)
 * - removeLeafByTabRef (rebalance, single-child collapse, last-leaf -> null)
 * - findLeafByTabRef / findLeafById
 * - collectLeafTabRefs / countLeaves
 * - generateGroupName / isGroupRef
 */

import { describe, it, expect } from 'vitest';
import type { PanelLayoutNode, Session, TabGroup, UnifiedTabRef } from '../../types';
import {
	createLeaf,
	createGroupFromTabRefs,
	splitLeaf,
	removeLeafByTabRef,
	findLeafByTabRef,
	findLeafById,
	collectLeafTabRefs,
	countLeaves,
	generateGroupName,
	isGroupRef,
	updateSplitSizes,
	setFocusedPane,
	findPaneInDirection,
	rebalanceLayout,
	dissolveGroup,
	MIN_PANE_FRACTION,
	computeDropZone,
	dropZoneToSplit,
	insertRefIntoOrder,
	tileTabIntoGroup,
	movePaneInGroup,
	swapPanesInGroup,
	createGroupFromDrop,
	promotePaneToStandalone,
	tabRefKey,
	splitPaneRectsByKind,
	breakApartGroup,
	renameGroup,
	setGroupEmoji,
	normalizeTabGroups,
	resolveTabRefTitle,
	type DropRect,
} from '../panelLayout';
import type { PaneRects } from '../../types';

const aiRef = (id: string): UnifiedTabRef => ({ type: 'ai', id });
const fileRef = (id: string): UnifiedTabRef => ({ type: 'file', id });

/** Sum of a split node's sizes, rounded to avoid float noise. */
function sizesSum(node: PanelLayoutNode): number {
	if (node.kind !== 'split') return 0;
	return Number(node.sizes.reduce((a, b) => a + b, 0).toFixed(6));
}

describe('createLeaf', () => {
	it('builds a leaf that references the given tab and has a generated id', () => {
		const leaf = createLeaf(aiRef('a'));
		expect(leaf.kind).toBe('leaf');
		expect(leaf).toMatchObject({ kind: 'leaf', tab: { type: 'ai', id: 'a' } });
		expect(typeof leaf.id).toBe('string');
		expect(leaf.id.length).toBeGreaterThan(0);
	});
});

describe('createGroupFromTabRefs', () => {
	it('produces equal sizes summing to 1 and a focused first pane', () => {
		const group = createGroupFromTabRefs([aiRef('a'), fileRef('b'), aiRef('c')], 'My Group');

		expect(group.name).toBe('My Group');
		expect(typeof group.id).toBe('string');
		expect(group.createdAt).toBeGreaterThan(0);

		const layout = group.layout;
		expect(layout.kind).toBe('split');
		if (layout.kind !== 'split') throw new Error('expected split');

		// One equal-sized leaf per tab, weights sum to 1.
		expect(layout.direction).toBe('row');
		expect(layout.children).toHaveLength(3);
		expect(layout.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
		expect(sizesSum(layout)).toBe(1);

		// Every child is a leaf referencing the input tabs in order.
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), fileRef('b'), aiRef('c')]);

		// The first leaf is focused.
		expect(group.focusedPaneId).toBe(layout.children[0].id);
	});
});

describe('splitLeaf', () => {
	it('splits a single-leaf layout in the row direction', () => {
		const leaf = createLeaf(aiRef('a'));
		const result = splitLeaf(leaf, leaf.id, 'row', aiRef('b'));

		expect(result.kind).toBe('split');
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		expect(result.sizes).toEqual([0.5, 0.5]);
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('b')]);
	});

	it('splits a single-leaf layout in the column direction', () => {
		const leaf = createLeaf(aiRef('a'));
		const result = splitLeaf(leaf, leaf.id, 'column', aiRef('b'));

		expect(result.kind).toBe('split');
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('column');
		expect(result.sizes).toEqual([0.5, 0.5]);
	});

	it('reuses a same-direction parent split instead of nesting (tmux behavior)', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		const targetLeafId = rowSplit.children[0].id;

		// Split the first leaf in the SAME (row) direction: the new leaf becomes a
		// sibling in the existing row, not a nested split.
		const result = splitLeaf(rowSplit, targetLeafId, 'row', aiRef('c'));
		expect(result.kind).toBe('split');
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		// Flat: 3 leaf children, none of them nested splits.
		expect(result.children).toHaveLength(3);
		expect(result.children.every((c) => c.kind === 'leaf')).toBe(true);
		// New leaf inserted directly after the target.
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('c'), aiRef('b')]);
		// Sizes stay normalized and equal.
		expect(result.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
		expect(sizesSum(result)).toBe(1);
	});

	it('nests a new split when the parent runs in the other direction', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		const targetLeafId = rowSplit.children[0].id;

		// Split the first leaf in the COLUMN direction: the parent is a row, so the
		// target leaf is replaced by a nested column split.
		const result = splitLeaf(rowSplit, targetLeafId, 'column', aiRef('c'));
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		expect(result.children).toHaveLength(2);

		const firstChild = result.children[0];
		expect(firstChild.kind).toBe('split');
		if (firstChild.kind !== 'split') throw new Error('expected nested split');
		expect(firstChild.direction).toBe('column');
		expect(firstChild.sizes).toEqual([0.5, 0.5]);
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('c'), aiRef('b')]);
	});
});

describe('removeLeafByTabRef', () => {
	it('rebalances the parent split sizes after removal', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b'), aiRef('c')], 'g');
		const result = removeLeafByTabRef(group.layout, aiRef('b'));

		expect(result).not.toBeNull();
		if (!result || result.kind !== 'split') throw new Error('expected split');
		expect(result.children).toHaveLength(2);
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('c')]);
		// Two remaining children, renormalized to equal weights summing to 1.
		expect(result.sizes).toEqual([0.5, 0.5]);
		expect(sizesSum(result)).toBe(1);
	});

	it('collapses a split left with a single child into that child', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const result = removeLeafByTabRef(group.layout, aiRef('b'));

		// Removing one of two leaves leaves a single-child split, which collapses to
		// the surviving leaf.
		expect(result).not.toBeNull();
		if (!result) throw new Error('expected node');
		expect(result.kind).toBe('leaf');
		if (result.kind !== 'leaf') throw new Error('expected leaf');
		expect(result.tab).toEqual(aiRef('a'));
	});

	it('collapses nested single-child splits recursively', () => {
		// row[ column[a, b], c ] -> remove b -> column collapses to a -> row[a, c]
		const group = createGroupFromTabRefs([aiRef('x'), aiRef('c')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		const nested = splitLeaf(rowSplit, rowSplit.children[0].id, 'column', aiRef('b'));
		// nested is: row[ column[x, b], c ]
		const result = removeLeafByTabRef(nested, aiRef('b'));
		expect(result).not.toBeNull();
		if (!result || result.kind !== 'split') throw new Error('expected split');
		expect(result.direction).toBe('row');
		expect(collectLeafTabRefs(result)).toEqual([aiRef('x'), aiRef('c')]);
		expect(result.children.every((child) => child.kind === 'leaf')).toBe(true);
	});

	it('returns null when the last leaf is removed', () => {
		const leaf = createLeaf(aiRef('only'));
		expect(removeLeafByTabRef(leaf, aiRef('only'))).toBeNull();
	});

	it('leaves the tree unchanged when the tab is not found', () => {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('b')], 'g');
		const result = removeLeafByTabRef(group.layout, aiRef('missing'));
		expect(result).not.toBeNull();
		expect(collectLeafTabRefs(result as PanelLayoutNode)).toEqual([aiRef('a'), aiRef('b')]);
	});
});

describe('collectLeafTabRefs / countLeaves / findLeaf*', () => {
	// Build a nested tree: row[ column[a, b], c ]
	function buildNested() {
		const group = createGroupFromTabRefs([aiRef('a'), aiRef('c')], 'g');
		const rowSplit = group.layout;
		if (rowSplit.kind !== 'split') throw new Error('expected split');
		return splitLeaf(rowSplit, rowSplit.children[0].id, 'column', fileRef('b'));
	}

	it('collectLeafTabRefs returns all leaf refs in order on a nested tree', () => {
		const tree = buildNested();
		expect(collectLeafTabRefs(tree)).toEqual([aiRef('a'), fileRef('b'), aiRef('c')]);
	});

	it('countLeaves counts every leaf in a nested tree', () => {
		const tree = buildNested();
		expect(countLeaves(tree)).toBe(3);
		expect(countLeaves(createLeaf(aiRef('solo')))).toBe(1);
	});

	it('findLeafByTabRef finds the matching leaf or null', () => {
		const tree = buildNested();
		const found = findLeafByTabRef(tree, fileRef('b'));
		expect(found).not.toBeNull();
		expect(found?.kind).toBe('leaf');
		if (found?.kind === 'leaf') expect(found.tab).toEqual(fileRef('b'));
		expect(findLeafByTabRef(tree, aiRef('nope'))).toBeNull();
	});

	it('findLeafById finds the leaf by node id or null', () => {
		const leaf = createLeaf(aiRef('a'));
		const tree = splitLeaf(leaf, leaf.id, 'row', aiRef('b'));
		if (tree.kind !== 'split') throw new Error('expected split');
		const targetId = tree.children[1].id;
		const found = findLeafById(tree, targetId);
		expect(found?.id).toBe(targetId);
		expect(findLeafById(tree, 'does-not-exist')).toBeNull();
	});
});

describe('generateGroupName / isGroupRef', () => {
	it('generateGroupName prefixes the first tab title', () => {
		expect(generateGroupName('Feature X')).toBe('Group: Feature X');
	});

	it('isGroupRef is true only for group refs', () => {
		expect(isGroupRef({ type: 'group', id: 'g1' })).toBe(true);
		expect(isGroupRef(aiRef('a'))).toBe(false);
		expect(isGroupRef(fileRef('f'))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Phase 02 helpers: resize, focus, spatial navigation, rebalance, dissolve.
// ---------------------------------------------------------------------------

/** A leaf node with a fixed id so tests can address panes deterministically. */
function leaf(id: string, tab: UnifiedTabRef): PanelLayoutNode {
	return { kind: 'leaf', id, tab };
}

function rowSplit(id: string, children: PanelLayoutNode[]): PanelLayoutNode {
	return {
		kind: 'split',
		id,
		direction: 'row',
		children,
		sizes: children.map(() => 1 / children.length),
	};
}

function colSplit(id: string, children: PanelLayoutNode[]): PanelLayoutNode {
	return {
		kind: 'split',
		id,
		direction: 'column',
		children,
		sizes: children.map(() => 1 / children.length),
	};
}

function groupFrom(layout: PanelLayoutNode, focusedPaneId: string | null = null): TabGroup {
	return { id: 'grp', name: 'g', layout, focusedPaneId, createdAt: 1 };
}

describe('updateSplitSizes', () => {
	it('replaces a split node sizes and keeps them normalized to 1', () => {
		const layout = rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]);
		const result = updateSplitSizes(layout, 'root', [0.7, 0.3]);
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.sizes[0]).toBeCloseTo(0.7, 5);
		expect(result.sizes[1]).toBeCloseTo(0.3, 5);
		expect(result.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});

	it('renormalizes raw (non-summing) inputs', () => {
		const layout = rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]);
		// Pixel-ish widths that do not sum to 1.
		const result = updateSplitSizes(layout, 'root', [600, 200]);
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.sizes[0]).toBeCloseTo(0.75, 5);
		expect(result.sizes[1]).toBeCloseTo(0.25, 5);
	});

	it('clamps a pane to the minimum fraction and still sums to 1', () => {
		const layout = rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]);
		// Ask to shrink the second pane below the floor.
		const result = updateSplitSizes(layout, 'root', [0.99, 0.01]);
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.sizes[1]).toBeGreaterThanOrEqual(MIN_PANE_FRACTION - 1e-9);
		expect(result.sizes[0]).toBeLessThanOrEqual(1 - MIN_PANE_FRACTION + 1e-9);
		expect(result.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
	});

	it('only touches the addressed split, recursing into nested splits', () => {
		const inner = colSplit('inner', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]);
		const outer = rowSplit('outer', [inner, leaf('l3', aiRef('c'))]);
		const result = updateSplitSizes(outer, 'inner', [0.8, 0.2]);
		if (result.kind !== 'split') throw new Error('expected split');
		// Outer split sizes untouched.
		expect(result.sizes).toEqual([0.5, 0.5]);
		const nested = result.children[0];
		if (nested.kind !== 'split') throw new Error('expected nested split');
		expect(nested.sizes[0]).toBeCloseTo(0.8, 5);
		expect(nested.sizes[1]).toBeCloseTo(0.2, 5);
	});

	it('is a no-op when the length does not match the child count', () => {
		const layout = rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]);
		const result = updateSplitSizes(layout, 'root', [0.5, 0.3, 0.2]);
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.sizes).toEqual([0.5, 0.5]);
	});
});

describe('setFocusedPane', () => {
	it('moves focus to an existing leaf', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = setFocusedPane(group, 'l2');
		expect(next.focusedPaneId).toBe('l2');
		// New object, original untouched.
		expect(group.focusedPaneId).toBe('l1');
	});

	it('is a no-op (same ref) when the leaf does not exist', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		expect(setFocusedPane(group, 'nope')).toBe(group);
	});

	it('is a no-op (same ref) when focus is already on that leaf', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		expect(setFocusedPane(group, 'l1')).toBe(group);
	});
});

describe('findPaneInDirection', () => {
	// 2x2 grid: column[ row[a, b], row[c, d] ]
	//   a b
	//   c d
	function build2x2(): TabGroup {
		const top = rowSplit('top', [leaf('a', aiRef('a')), leaf('b', aiRef('b'))]);
		const bottom = rowSplit('bottom', [leaf('c', aiRef('c')), leaf('d', aiRef('d'))]);
		return groupFrom(colSplit('root', [top, bottom]), 'a');
	}

	it('navigates right/left/up/down on a 2x2 grid', () => {
		const g = build2x2();
		expect(findPaneInDirection(g, 'a', 'right')).toBe('b');
		expect(findPaneInDirection(g, 'b', 'left')).toBe('a');
		expect(findPaneInDirection(g, 'a', 'down')).toBe('c');
		expect(findPaneInDirection(g, 'c', 'up')).toBe('a');
		expect(findPaneInDirection(g, 'd', 'left')).toBe('c');
		expect(findPaneInDirection(g, 'd', 'up')).toBe('b');
		expect(findPaneInDirection(g, 'b', 'down')).toBe('d');
	});

	it('returns null at the edges of a 2x2 grid', () => {
		const g = build2x2();
		expect(findPaneInDirection(g, 'a', 'left')).toBeNull();
		expect(findPaneInDirection(g, 'a', 'up')).toBeNull();
		expect(findPaneInDirection(g, 'd', 'right')).toBeNull();
		expect(findPaneInDirection(g, 'd', 'down')).toBeNull();
	});

	it('returns null when the source leaf is not in the layout', () => {
		const g = build2x2();
		expect(findPaneInDirection(g, 'ghost', 'right')).toBeNull();
	});

	it('navigates an L-shaped nested layout: row[ column[a, b], c ]', () => {
		// Left column stacks a over b (each half height); c fills the right, full height.
		//   a | c
		//   b | c
		const left = colSplit('left', [leaf('a', aiRef('a')), leaf('b', aiRef('b'))]);
		const g = groupFrom(rowSplit('root', [left, leaf('c', aiRef('c'))]), 'a');

		// Within the left column.
		expect(findPaneInDirection(g, 'a', 'down')).toBe('b');
		expect(findPaneInDirection(g, 'b', 'up')).toBe('a');
		// Across into the full-height right pane.
		expect(findPaneInDirection(g, 'a', 'right')).toBe('c');
		expect(findPaneInDirection(g, 'b', 'right')).toBe('c');
		// From the tall right pane back left: 'a' overlaps the top half, 'b' the
		// bottom half; both are equidistant so the greater-overlap tiebreak is a
		// wash - either is a valid left neighbor, so assert it lands in the column.
		expect(['a', 'b']).toContain(findPaneInDirection(g, 'c', 'left'));
		// No pane above/below the source in this layout's outer axis.
		expect(findPaneInDirection(g, 'a', 'up')).toBeNull();
		expect(findPaneInDirection(g, 'c', 'right')).toBeNull();
	});
});

describe('rebalanceLayout', () => {
	it('resets every split to equal fractions, preserving shape and refs', () => {
		// Skew both splits away from equal to prove they are reset.
		const innerSkewed: PanelLayoutNode = {
			kind: 'split',
			id: 'inner',
			direction: 'column',
			children: [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))],
			sizes: [0.8, 0.2],
		};
		const outer: PanelLayoutNode = {
			kind: 'split',
			id: 'outer',
			direction: 'row',
			children: [innerSkewed, leaf('l3', aiRef('c'))],
			sizes: [0.9, 0.1],
		};
		const result = rebalanceLayout(outer);
		if (result.kind !== 'split') throw new Error('expected split');
		expect(result.sizes).toEqual([0.5, 0.5]);
		const nested = result.children[0];
		if (nested.kind !== 'split') throw new Error('expected nested split');
		expect(nested.sizes).toEqual([0.5, 0.5]);
		// Leaf refs and order untouched.
		expect(collectLeafTabRefs(result)).toEqual([aiRef('a'), aiRef('b'), aiRef('c')]);
	});

	it('returns a bare leaf unchanged', () => {
		const solo = leaf('solo', aiRef('x'));
		expect(rebalanceLayout(solo)).toEqual(solo);
	});
});

describe('dissolveGroup', () => {
	/** Minimal Session stub carrying only the fields dissolveGroup touches. */
	function sessionWith(group: TabGroup, extra?: Partial<Session>): Session {
		return {
			unifiedTabOrder: [],
			tabGroups: [group],
			activeGroupId: group.id,
			...extra,
		} as unknown as Session;
	}

	it('promotes remaining tabs to unifiedTabOrder and removes the group', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', fileRef('b'))]),
			'l1'
		);
		const session = sessionWith(group);
		const next = dissolveGroup(session, group.id);

		expect(next.tabGroups).toHaveLength(0);
		expect(next.activeGroupId).toBeNull();
		expect(next.unifiedTabOrder).toEqual([aiRef('a'), fileRef('b')]);
	});

	it('does not duplicate tabs already present in unifiedTabOrder', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group, { unifiedTabOrder: [aiRef('a')] });
		const next = dissolveGroup(session, group.id);
		// 'a' already ordered, only 'b' is appended.
		expect(next.unifiedTabOrder).toEqual([aiRef('a'), aiRef('b')]);
	});

	it('replaces the group ref in place with its promoted members', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', fileRef('b'))]),
			'l1'
		);
		// Group ref sits between two standalone tabs; dissolving must restore its members
		// at that position, not append them to the end.
		const session = sessionWith(group, {
			unifiedTabOrder: [aiRef('x'), { type: 'group', id: group.id }, aiRef('y')],
		});
		const next = dissolveGroup(session, group.id);
		expect(next.unifiedTabOrder).toEqual([aiRef('x'), aiRef('a'), fileRef('b'), aiRef('y')]);
		expect(next.tabGroups).toHaveLength(0);
	});

	it('leaves activeGroupId untouched when a different group is active', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group, { activeGroupId: 'other-group' });
		const next = dissolveGroup(session, group.id);
		expect(next.activeGroupId).toBe('other-group');
	});

	it('is a no-op copy when the group id is unknown', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group);
		const next = dissolveGroup(session, 'missing');
		expect(next.tabGroups).toHaveLength(1);
		expect(next.activeGroupId).toBe(group.id);
		expect(next.unifiedTabOrder).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: drop-zone geometry + drag-and-drop tiling edits.
// ---------------------------------------------------------------------------

describe('computeDropZone', () => {
	// A 200x100 pane whose top-left is at (10, 20) - non-zero origin so the tests
	// exercise the pointer-to-rect normalization, not just an origin-anchored box.
	// Center is at (110, 70). The pane is split into four diagonal triangles.
	const rect: DropRect = { left: 10, top: 20, width: 200, height: 100 };

	it('resolves the inner core to an edge, never center', () => {
		// A point just right of dead-center: horizontal offset (tiny +) dominates the
		// zero vertical offset, so it lands on the nearest edge rather than a center zone.
		expect(computeDropZone(rect, 111, 70)).toBe('right');
		expect(computeDropZone(rect, 109, 70)).toBe('left');
		// Exact center: |dx| >= |dy| tie resolves to the horizontal axis (right side of 0).
		expect(computeDropZone(rect, 110, 70)).toBe('right');
	});

	it('classifies each edge from the dominant offset axis', () => {
		expect(computeDropZone(rect, 15, 70)).toBe('left'); // far left, vertically centered
		expect(computeDropZone(rect, 205, 70)).toBe('right'); // far right
		expect(computeDropZone(rect, 110, 25)).toBe('top'); // near top, horizontally centered
		expect(computeDropZone(rect, 110, 115)).toBe('bottom'); // near bottom
	});

	it('assigns a corner to the axis with the larger offset from center', () => {
		// Top-left corner: dx ≈ -0.475 (horizontal) vs dy ≈ -0.45 (vertical); horizontal
		// dominates, so left wins.
		expect(computeDropZone(rect, 15, 25)).toBe('left');
		// Near the top edge but close to horizontal center: vertical offset dominates -> top.
		expect(computeDropZone(rect, 95, 21)).toBe('top');
	});

	it('clamps a pointer just outside the rect to the nearest edge', () => {
		expect(computeDropZone(rect, -100, 70)).toBe('left');
		expect(computeDropZone(rect, 9999, 70)).toBe('right');
	});

	it('defaults a degenerate (zero-area) rect to a valid edge', () => {
		expect(computeDropZone({ left: 0, top: 0, width: 0, height: 100 }, 0, 50)).toBe('left');
	});

	it('returns center for a middle pointer only when allowCenter is set', () => {
		// Dead center: edges-only (default) picks the tie-break edge; allowCenter -> center.
		expect(computeDropZone(rect, 110, 70)).toBe('right');
		expect(computeDropZone(rect, 110, 70, true)).toBe('center');
		// Inside the inner 40% box (|dx|,|dy| < 0.2) still swaps.
		expect(computeDropZone(rect, 130, 78, true)).toBe('center');
		// Outside the central box resolves to the dominant edge even with allowCenter.
		expect(computeDropZone(rect, 205, 70, true)).toBe('right');
		expect(computeDropZone(rect, 110, 25, true)).toBe('top');
	});
});

describe('dropZoneToSplit', () => {
	it('maps edges to direction + insert-before, center to null', () => {
		expect(dropZoneToSplit('left')).toEqual({ direction: 'row', before: true });
		expect(dropZoneToSplit('right')).toEqual({ direction: 'row', before: false });
		expect(dropZoneToSplit('top')).toEqual({ direction: 'column', before: true });
		expect(dropZoneToSplit('bottom')).toEqual({ direction: 'column', before: false });
		expect(dropZoneToSplit('center')).toBeNull();
	});
});

describe('insertRefIntoOrder', () => {
	it('inserts at an index and dedupes any existing occurrence', () => {
		const order = [aiRef('a'), aiRef('b'), aiRef('c')];
		expect(insertRefIntoOrder(order, fileRef('x'), 1)).toEqual([
			aiRef('a'),
			fileRef('x'),
			aiRef('b'),
			aiRef('c'),
		]);
		// Re-inserting an existing ref removes the old copy first (no duplicate).
		expect(insertRefIntoOrder(order, aiRef('c'), 0)).toEqual([aiRef('c'), aiRef('a'), aiRef('b')]);
	});

	it('appends for an out-of-range index', () => {
		expect(insertRefIntoOrder([aiRef('a')], fileRef('x'), 99)).toEqual([aiRef('a'), fileRef('x')]);
	});
});

describe('tileTabIntoGroup', () => {
	/** Session stub with a single group and a dragged tab still in the order. */
	function sessionWith(group: TabGroup, order: UnifiedTabRef[]): Session {
		return {
			id: 'sess',
			unifiedTabOrder: order,
			tabGroups: [group],
			activeGroupId: group.id,
		} as unknown as Session;
	}

	it('splits a leaf into a row and places the new pane before on a left drop', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = tileTabIntoGroup(
			sessionWith(group, [fileRef('x')]),
			'grp',
			'l1',
			'left',
			fileRef('x')
		);

		const layout = next.tabGroups[0].layout;
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(layout.direction).toBe('row');
		// Flat insert before l1: [x, l1, l2].
		expect(collectLeafTabRefs(layout)).toEqual([fileRef('x'), aiRef('a'), aiRef('b')]);
		// Dragged ref removed from the strip (it now lives in the group).
		expect(next.unifiedTabOrder).toEqual([]);
	});

	it('places the new pane after on a right drop', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = tileTabIntoGroup(
			sessionWith(group, [fileRef('x')]),
			'grp',
			'l1',
			'right',
			fileRef('x')
		);
		const layout = next.tabGroups[0].layout;
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), fileRef('x'), aiRef('b')]);
	});

	it('nests a column split on a top/bottom drop into a row group', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = tileTabIntoGroup(
			sessionWith(group, [fileRef('x')]),
			'grp',
			'l1',
			'top',
			fileRef('x')
		);
		const root = next.tabGroups[0].layout;
		if (root.kind !== 'split') throw new Error('expected split');
		expect(root.direction).toBe('row');
		// l1 replaced by a column split holding [x, l1] (x before, per top drop).
		const nested = root.children[0];
		if (nested.kind !== 'split') throw new Error('expected nested split');
		expect(nested.direction).toBe('column');
		expect(collectLeafTabRefs(nested)).toEqual([fileRef('x'), aiRef('a')]);
	});

	it('center adds as a sibling along the parent split direction', () => {
		const group = groupFrom(
			colSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = tileTabIntoGroup(
			sessionWith(group, [fileRef('x')]),
			'grp',
			'l1',
			'center',
			fileRef('x')
		);
		const layout = next.tabGroups[0].layout;
		if (layout.kind !== 'split') throw new Error('expected split');
		// Parent is a column, so center flat-inserts after l1 in the column.
		expect(layout.direction).toBe('column');
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), fileRef('x'), aiRef('b')]);
	});

	it('is a no-op copy when the group or target leaf is missing', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group, [fileRef('x')]);
		expect(tileTabIntoGroup(session, 'nope', 'l1', 'left', fileRef('x')).unifiedTabOrder).toEqual([
			fileRef('x'),
		]);
		expect(
			tileTabIntoGroup(session, 'grp', 'missing', 'left', fileRef('x')).unifiedTabOrder
		).toEqual([fileRef('x')]);
	});
});

describe('movePaneInGroup', () => {
	function sessionWith(group: TabGroup): Session {
		return {
			id: 'sess',
			unifiedTabOrder: [{ type: 'group', id: group.id }],
			tabGroups: [group],
			activeGroupId: group.id,
		} as unknown as Session;
	}

	it('moves a pane to the opposite side of a sibling (right edge of l1)', () => {
		// [a | b | c] row; move c to the RIGHT of a -> [a, c, b].
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b')), leaf('l3', aiRef('c'))]),
			'l3'
		);
		const next = movePaneInGroup(sessionWith(group), 'grp', 'l3', 'l1', 'right');
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([
			aiRef('a'),
			aiRef('c'),
			aiRef('b'),
		]);
		// The tab stays in the group (unifiedTabOrder still just the group ref).
		expect(next.unifiedTabOrder).toEqual([{ type: 'group', id: 'grp' }]);
	});

	it('nests a new split when moving across the perpendicular axis (bottom of l1)', () => {
		// Row [a | b]; drop b onto the BOTTOM of a -> a column split [a / b] nested where a was.
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l2'
		);
		const next = movePaneInGroup(sessionWith(group), 'grp', 'l2', 'l1', 'bottom');
		const layout = next.tabGroups[0].layout;
		// Removing b collapsed the row into a; splitting a by column yields a lone column split.
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(layout.direction).toBe('column');
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), aiRef('b')]);
		// The moved pane holds focus.
		const moved = findLeafByTabRef(layout, aiRef('b'));
		expect(next.tabGroups[0].focusedPaneId).toBe(moved?.kind === 'leaf' ? moved.id : null);
	});

	it('is a no-op when dropping a pane onto itself', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group);
		expect(movePaneInGroup(session, 'grp', 'l1', 'l1', 'left')).toBe(session);
	});

	it('is a no-op copy when the group or a leaf is unknown', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group);
		expect(movePaneInGroup(session, 'nope', 'l1', 'l2', 'left')).toBe(session);
		expect(movePaneInGroup(session, 'grp', 'missing', 'l2', 'left')).toBe(session);
		expect(movePaneInGroup(session, 'grp', 'l1', 'missing', 'left')).toBe(session);
	});
});

describe('swapPanesInGroup', () => {
	function sessionWith(group: TabGroup): Session {
		return {
			id: 'sess',
			unifiedTabOrder: [{ type: 'group', id: group.id }],
			tabGroups: [group],
			activeGroupId: group.id,
		} as unknown as Session;
	}

	it('exchanges two tiles in place, keeping node ids, structure, and sizes', () => {
		// 2x2 grid: column[ row[a,b], row[c,d] ]. Swap top-left (a) with bottom-right (d).
		const top = rowSplit('top', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]);
		const bottom = rowSplit('bottom', [leaf('l3', aiRef('c')), leaf('l4', aiRef('d'))]);
		const group = groupFrom(colSplit('root', [top, bottom]), 'l1');
		const next = swapPanesInGroup(sessionWith(group), 'grp', 'l1', 'l4');
		const layout = next.tabGroups[0].layout;
		// Grid shape is untouched (still column[ row[..], row[..] ]); only a and d traded spots.
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('d'), aiRef('b'), aiRef('c'), aiRef('a')]);
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(layout.id).toBe('root');
		expect(layout.direction).toBe('column');
		expect((layout.children[0] as { id: string }).id).toBe('top');
	});

	it('focuses the target pane (where the dragged content lands)', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		// Drag l1 onto l2's center -> a now lives at l2, so l2 holds focus.
		const next = swapPanesInGroup(sessionWith(group), 'grp', 'l1', 'l2');
		expect(next.tabGroups[0].focusedPaneId).toBe('l2');
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([aiRef('b'), aiRef('a')]);
	});

	it('is a no-op copy on self, unknown group, or missing leaf', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group);
		expect(swapPanesInGroup(session, 'grp', 'l1', 'l1')).toBe(session);
		expect(swapPanesInGroup(session, 'nope', 'l1', 'l2')).toBe(session);
		expect(swapPanesInGroup(session, 'grp', 'missing', 'l2')).toBe(session);
		expect(swapPanesInGroup(session, 'grp', 'l1', 'missing')).toBe(session);
	});
});

describe('createGroupFromDrop', () => {
	function sessionWith(order: UnifiedTabRef[]): Session {
		return {
			id: 'sess',
			unifiedTabOrder: order,
			tabGroups: [],
			activeGroupId: null,
		} as unknown as Session;
	}

	it('replaces BOTH member refs with a single group ref in the strip (in place)', () => {
		const session = sessionWith([aiRef('a'), fileRef('b'), aiRef('c')]);
		const next = createGroupFromDrop(session, aiRef('a'), fileRef('b'), 'right', 'New Group');

		expect(next.tabGroups).toHaveLength(1);
		expect(next.activeGroupId).toBe(next.tabGroups[0].id);
		// The two members (a, b) are folded into a single `group` ref landing where the
		// first member sat; the standalone 'c' is untouched. The group is the 5th unified
		// tab type, so it lives in the order and navigates as one entry.
		expect(next.unifiedTabOrder).toEqual([{ type: 'group', id: next.tabGroups[0].id }, aiRef('c')]);

		const layout = next.tabGroups[0].layout;
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(layout.direction).toBe('row');
		// right drop -> dragged after target: [a, b].
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), fileRef('b')]);
	});

	it('honors direction and order for a top drop (dragged before, column)', () => {
		const session = sessionWith([aiRef('a'), fileRef('b')]);
		const next = createGroupFromDrop(session, aiRef('a'), fileRef('b'), 'top', 'g');
		const layout = next.tabGroups[0].layout;
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(layout.direction).toBe('column');
		// top drop -> dragged before target: [b, a].
		expect(collectLeafTabRefs(layout)).toEqual([fileRef('b'), aiRef('a')]);
	});

	it('defaults center to a row with dragged after the target', () => {
		const session = sessionWith([aiRef('a'), fileRef('b')]);
		const next = createGroupFromDrop(session, aiRef('a'), fileRef('b'), 'center', 'g');
		const layout = next.tabGroups[0].layout;
		if (layout.kind !== 'split') throw new Error('expected split');
		expect(layout.direction).toBe('row');
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), fileRef('b')]);
	});

	it('does not throw when a legacy session has no tabGroups/unifiedTabOrder fields', () => {
		// Sessions persisted before tiling shipped have neither field. The first drop
		// must create the group instead of crashing on a spread of `undefined` (the
		// real-world "drop does nothing" bug: the TypeError was swallowed by React).
		const legacy = { id: 'sess', activeGroupId: null } as unknown as Session;
		const next = createGroupFromDrop(legacy, aiRef('a'), fileRef('b'), 'right', 'g');
		expect(next.tabGroups).toHaveLength(1);
		expect(next.activeGroupId).toBe(next.tabGroups[0].id);
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([aiRef('a'), fileRef('b')]);
	});
});

describe('promotePaneToStandalone', () => {
	function sessionWith(group: TabGroup, order: UnifiedTabRef[]): Session {
		return {
			id: 'sess',
			unifiedTabOrder: order,
			tabGroups: [group],
			activeGroupId: group.id,
		} as unknown as Session;
	}

	it('re-adds the promoted tab at the drop index and keeps a >=2-pane group', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b')), leaf('l3', aiRef('c'))]),
			'l1'
		);
		const next = promotePaneToStandalone(sessionWith(group, [fileRef('z')]), 'grp', 'l2', 0);

		// Promoted 'b' inserted at index 0 of the strip.
		expect(next.unifiedTabOrder).toEqual([aiRef('b'), fileRef('z')]);
		// Group survives with the two remaining panes.
		expect(next.tabGroups).toHaveLength(1);
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([aiRef('a'), aiRef('c')]);
		expect(next.activeGroupId).toBe('grp');
	});

	it('auto-dissolves the group when it falls below two panes', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = promotePaneToStandalone(sessionWith(group, []), 'grp', 'l1', 0);

		// Pulling l1 leaves a single pane -> group dissolves entirely.
		expect(next.tabGroups).toHaveLength(0);
		expect(next.activeGroupId).toBeNull();
		// The promoted pane (a) lands at the drop index; the lone survivor (b) is
		// promoted by dissolveGroup afterwards.
		expect(next.unifiedTabOrder).toEqual([aiRef('a'), aiRef('b')]);
	});

	it('is a no-op copy when the group or leaf is missing', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const session = sessionWith(group, []);
		expect(promotePaneToStandalone(session, 'nope', 'l1', 0).tabGroups).toHaveLength(1);
		expect(promotePaneToStandalone(session, 'grp', 'missing', 0).unifiedTabOrder).toEqual([]);
	});
});

describe('tabRefKey', () => {
	it('builds a stable `type:id` key used for the per-pane geometry map', () => {
		expect(tabRefKey({ type: 'terminal', id: 't1' })).toBe('terminal:t1');
		expect(tabRefKey({ type: 'browser', id: 'b9' })).toBe('browser:b9');
		expect(tabRefKey(aiRef('a'))).toBe('ai:a');
		expect(tabRefKey(fileRef('f'))).toBe('file:f');
	});

	it('is unique per (type, id) so terminal and browser leaves never collide', () => {
		expect(tabRefKey({ type: 'terminal', id: 'x' })).not.toBe(
			tabRefKey({ type: 'browser', id: 'x' })
		);
	});
});

describe('splitPaneRectsByKind', () => {
	const rect = (n: number) => ({ top: n, left: n, width: n, height: n });

	it('routes terminal/browser keys into per-kind maps under bare tab ids', () => {
		const paneRects: PaneRects = new Map([
			['terminal:t1', rect(1)],
			['browser:b1', rect(2)],
			['terminal:t2', rect(3)],
		]);
		const { terminals, browsers } = splitPaneRectsByKind(paneRects);
		expect([...terminals.keys()].sort()).toEqual(['t1', 't2']);
		expect([...browsers.keys()]).toEqual(['b1']);
		expect(terminals.get('t1')).toEqual(rect(1));
		expect(browsers.get('b1')).toEqual(rect(2));
	});

	it('ignores ai/file keys (those panes render inline, not as overlays)', () => {
		const paneRects: PaneRects = new Map([
			['ai:a1', rect(1)],
			['file:f1', rect(2)],
		]);
		const { terminals, browsers } = splitPaneRectsByKind(paneRects);
		expect(terminals.size).toBe(0);
		expect(browsers.size).toBe(0);
	});

	it('returns empty maps for an empty input', () => {
		const { terminals, browsers } = splitPaneRectsByKind(new Map());
		expect(terminals.size).toBe(0);
		expect(browsers.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: naming, break apart, rename, and persistence hardening.
// ---------------------------------------------------------------------------

describe('resolveTabRefTitle', () => {
	function sessionWithTabs(extra?: Partial<Session>): Session {
		return {
			aiTabs: [{ id: 'a1', name: 'My Chat' }],
			filePreviewTabs: [{ id: 'f1', name: 'README.md' }],
			terminalTabs: [{ id: 't1', name: null }],
			browserTabs: [{ id: 'b1', customTitle: undefined, title: 'Docs', url: 'https://x' }],
			...extra,
		} as unknown as Session;
	}

	it('resolves each tab kind from its live tab', () => {
		const s = sessionWithTabs();
		expect(resolveTabRefTitle(s, aiRef('a1'))).toBe('My Chat');
		expect(resolveTabRefTitle(s, fileRef('f1'))).toBe('README.md');
		// Unnamed terminal falls back to the 1-based index label.
		expect(resolveTabRefTitle(s, { type: 'terminal', id: 't1' })).toBe('Terminal 1');
		expect(resolveTabRefTitle(s, { type: 'browser', id: 'b1' })).toBe('Docs');
	});

	it('prefers a browser customTitle, then title, then url', () => {
		const s = sessionWithTabs({
			browserTabs: [{ id: 'b1', customTitle: 'Pinned', title: 'Docs', url: 'https://x' }],
		} as unknown as Partial<Session>);
		expect(resolveTabRefTitle(s, { type: 'browser', id: 'b1' })).toBe('Pinned');
	});

	it('returns a per-kind fallback when the tab no longer exists', () => {
		const s = sessionWithTabs();
		expect(resolveTabRefTitle(s, aiRef('gone'))).toBe('AI');
		expect(resolveTabRefTitle(s, fileRef('gone'))).toBe('File');
		expect(resolveTabRefTitle(s, { type: 'terminal', id: 'gone' })).toBe('Terminal');
		expect(resolveTabRefTitle(s, { type: 'browser', id: 'gone' })).toBe('Browser');
	});
});

describe('renameGroup', () => {
	function sessionWith(group: TabGroup): Session {
		return { id: 'sess', tabGroups: [group], activeGroupId: group.id } as unknown as Session;
	}

	it('trims and persists a new name', () => {
		const group = groupFrom(rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]));
		const next = renameGroup(sessionWith(group), 'grp', '  Backend work  ', 'Group: a');
		expect(next.tabGroups[0].name).toBe('Backend work');
	});

	it('falls back to the auto name when the input is blank', () => {
		const group = groupFrom(rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]));
		const next = renameGroup(sessionWith(group), 'grp', '   ', 'Group: a');
		expect(next.tabGroups[0].name).toBe('Group: a');
	});

	it('is a no-op copy when the group is unknown', () => {
		const group = groupFrom(rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]));
		const next = renameGroup(sessionWith(group), 'missing', 'x', 'Group: a');
		expect(next.tabGroups[0].name).toBe('g');
	});
});

describe('setGroupEmoji', () => {
	function sessionWith(group: TabGroup): Session {
		return { id: 'sess', tabGroups: [group], activeGroupId: group.id } as unknown as Session;
	}

	it('sets a trimmed emoji on the group', () => {
		const group = groupFrom(rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]));
		const next = setGroupEmoji(sessionWith(group), 'grp', '  🚀  ');
		expect(next.tabGroups[0].emoji).toBe('🚀');
	});

	it('clears the emoji when given a blank value', () => {
		const group = { ...groupFrom(rowSplit('root', [leaf('l1', aiRef('a'))])), emoji: '🚀' };
		const next = setGroupEmoji(sessionWith(group), 'grp', '   ');
		expect(next.tabGroups[0].emoji).toBeUndefined();
	});

	it('is a no-op copy when the group is unknown', () => {
		const group = { ...groupFrom(rowSplit('root', [leaf('l1', aiRef('a'))])), emoji: '🚀' };
		const next = setGroupEmoji(sessionWith(group), 'missing', '🎯');
		expect(next.tabGroups[0].emoji).toBe('🚀');
	});
});

describe('breakApartGroup', () => {
	function sessionWith(group: TabGroup, order: UnifiedTabRef[] = []): Session {
		return {
			id: 'sess',
			unifiedTabOrder: order,
			tabGroups: [group],
			activeGroupId: group.id,
			activeTabId: 'x',
			inputMode: 'terminal',
		} as unknown as Session;
	}

	it('promotes every pane back to the strip in left-to-right order and removes the group', () => {
		const group = groupFrom(
			rowSplit('root', [
				leaf('l1', aiRef('a')),
				leaf('l2', fileRef('b')),
				leaf('l3', { type: 'terminal', id: 'c' }),
			]),
			'l2'
		);
		const next = breakApartGroup(sessionWith(group), 'grp');
		expect(next.tabGroups).toHaveLength(0);
		expect(next.activeGroupId).toBeNull();
		expect(next.unifiedTabOrder).toEqual([aiRef('a'), fileRef('b'), { type: 'terminal', id: 'c' }]);
	});

	it('lands focus on the first promoted tab when it is an AI tab', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l2'
		);
		const next = breakApartGroup(sessionWith(group), 'grp');
		expect(next.activeTabId).toBe('a');
		expect(next.inputMode).toBe('ai');
	});

	it('leaves activeTabId/inputMode untouched when the first pane is not an AI tab', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', fileRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = breakApartGroup(sessionWith(group), 'grp');
		expect(next.activeTabId).toBe('x');
		expect(next.inputMode).toBe('terminal');
	});

	it('is a no-op copy when the group is unknown', () => {
		const group = groupFrom(rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]));
		const next = breakApartGroup(sessionWith(group), 'missing');
		expect(next.tabGroups).toHaveLength(1);
		expect(next.activeGroupId).toBe('grp');
	});
});

describe('auto-dissolve funnels through removeLeafByTabRef + countLeaves', () => {
	// Mirrors the close-focused-pane composition (useTilingShortcuts): remove the
	// focused leaf, and if fewer than two panes remain, dissolve the group. This
	// asserts the shared teardown rule holds independent of the UI handler.
	function closePaneLike(session: Session, groupId: string, removed: UnifiedTabRef): Session {
		const group = session.tabGroups.find((g) => g.id === groupId);
		if (!group) return session;
		const nextLayout = removeLeafByTabRef(group.layout, removed);
		if (!nextLayout || countLeaves(nextLayout) <= 1) {
			// Promote the removed ref (it left the layout) then dissolve the leftovers.
			const withRef = { ...session, unifiedTabOrder: [...session.unifiedTabOrder, removed] };
			return dissolveGroup(withRef, groupId);
		}
		return {
			...session,
			tabGroups: session.tabGroups.map((g) =>
				g.id === groupId ? { ...g, layout: rebalanceLayout(nextLayout) } : g
			),
		};
	}

	function sessionWith(group: TabGroup): Session {
		return {
			id: 'sess',
			unifiedTabOrder: [],
			tabGroups: [group],
			activeGroupId: group.id,
		} as unknown as Session;
	}

	it('close-pane keeps a group with 3+ panes (removes one, no dissolve)', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b')), leaf('l3', aiRef('c'))]),
			'l2'
		);
		const next = closePaneLike(sessionWith(group), 'grp', aiRef('b'));
		expect(next.tabGroups).toHaveLength(1);
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([aiRef('a'), aiRef('c')]);
	});

	it('close-pane auto-dissolves when it drops below two panes', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = closePaneLike(sessionWith(group), 'grp', aiRef('a'));
		expect(next.tabGroups).toHaveLength(0);
		expect(next.activeGroupId).toBeNull();
		// Removed 'a' promoted, then the lone survivor 'b' promoted by dissolveGroup.
		expect(next.unifiedTabOrder).toEqual([aiRef('a'), aiRef('b')]);
	});

	it('drag-out (promotePaneToStandalone) auto-dissolves below two panes', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = promotePaneToStandalone(sessionWith(group), 'grp', 'l1', 0);
		expect(next.tabGroups).toHaveLength(0);
		expect(next.activeGroupId).toBeNull();
		expect(next.unifiedTabOrder).toEqual([aiRef('a'), aiRef('b')]);
	});
});

describe('normalizeTabGroups', () => {
	// A Session stub carrying the tab arrays + group fields normalizeTabGroups reads.
	function sessionWith(
		groups: TabGroup[],
		opts: {
			aiIds?: string[];
			fileIds?: string[];
			termIds?: string[];
			browserIds?: string[];
			order?: UnifiedTabRef[];
			activeGroupId?: string | null;
		} = {}
	): Session {
		return {
			id: 'sess',
			aiTabs: (opts.aiIds ?? []).map((id) => ({ id })),
			filePreviewTabs: (opts.fileIds ?? []).map((id) => ({ id })),
			terminalTabs: (opts.termIds ?? []).map((id) => ({ id })),
			browserTabs: (opts.browserIds ?? []).map((id) => ({ id })),
			unifiedTabOrder: opts.order ?? [],
			tabGroups: groups,
			activeGroupId: opts.activeGroupId ?? groups[0]?.id ?? null,
		} as unknown as Session;
	}

	it('returns the same session untouched when there are no groups', () => {
		const s = sessionWith([]);
		expect(normalizeTabGroups(s)).toBe(s);
	});

	it('backfills tabGroups to [] for a legacy session missing the field', () => {
		// A pre-tiling persisted session has no `tabGroups` at all. Normalization must
		// guarantee the array so a later drop does not spread `undefined` and crash.
		const legacy = { id: 'sess', unifiedTabOrder: [] } as unknown as Session;
		const next = normalizeTabGroups(legacy);
		expect(next.tabGroups).toEqual([]);
	});

	it('backfills a group ref into the order for a session persisted before groups were unified', () => {
		// Migration case (matches real on-disk data): a valid group in tabGroups but no
		// `group` ref in the order, and its members already stripped. Normalize must add
		// the group ref so the group is navigable/rendered as one unified tab.
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', fileRef('b'))]),
			'l1'
		);
		const next = normalizeTabGroups(
			sessionWith([group], { aiIds: ['a'], fileIds: ['b'], order: [aiRef('standalone')] })
		);
		expect(next.unifiedTabOrder).toEqual([aiRef('standalone'), { type: 'group', id: group.id }]);
	});

	it('replaces member refs left in the order with the single group ref (in place)', () => {
		// A stale/migrated order still listing tiled members: normalize folds them into
		// the group ref at the first member position and drops the rest.
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b'))]),
			'l1'
		);
		const next = normalizeTabGroups(
			sessionWith([group], {
				aiIds: ['a', 'b', 'z'],
				order: [aiRef('a'), aiRef('z'), aiRef('b')],
			})
		);
		expect(next.unifiedTabOrder).toEqual([{ type: 'group', id: group.id }, aiRef('z')]);
	});

	it('prunes a group ref whose group was removed (dropped below two panes)', () => {
		// Group has only one live leaf -> torn down; its stale group ref must be pruned
		// and the lone survivor promoted back as a standalone tab.
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('gone'))]),
			'l1'
		);
		const next = normalizeTabGroups(
			sessionWith([group], { aiIds: ['a'], order: [{ type: 'group', id: group.id }] })
		);
		expect(next.tabGroups).toHaveLength(0);
		expect(next.unifiedTabOrder).toEqual([aiRef('a')]);
	});

	it('prunes a dangling leaf and keeps a still-valid group (renormalized, focus repointed)', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('gone')), leaf('l3', aiRef('c'))]),
			'l2'
		);
		const next = normalizeTabGroups(sessionWith([group], { aiIds: ['a', 'c'] }));
		expect(next.tabGroups).toHaveLength(1);
		// The dangling 'gone' leaf is pruned; 'a' and 'c' survive.
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([aiRef('a'), aiRef('c')]);
		// Sizes renormalize to sum to 1.
		expect(sizesSum(next.tabGroups[0].layout)).toBe(1);
		// Focus was on the pruned leaf, so it moves to the first surviving leaf.
		expect(next.tabGroups[0].focusedPaneId).toBe('l1');
	});

	it('collapses a single-child split left after pruning', () => {
		// A group whose root row holds a leaf and a nested column; the column loses
		// one child to pruning and collapses into its lone survivor.
		const group = groupFrom(
			rowSplit('root', [
				leaf('l1', aiRef('a')),
				colSplit('col', [leaf('l2', aiRef('b')), leaf('l3', aiRef('gone'))]),
			]),
			'l1'
		);
		const next = normalizeTabGroups(sessionWith([group], { aiIds: ['a', 'b'] }));
		expect(next.tabGroups).toHaveLength(1);
		const layout = next.tabGroups[0].layout;
		// Root is still a 2-child row, but the second child collapsed to a bare leaf.
		expect(layout.kind).toBe('split');
		if (layout.kind === 'split') {
			expect(layout.children).toHaveLength(2);
			expect(layout.children[1]).toMatchObject({ kind: 'leaf', tab: aiRef('b') });
		}
		expect(collectLeafTabRefs(layout)).toEqual([aiRef('a'), aiRef('b')]);
	});

	it('dissolves a group that drops below two leaves, promoting the survivor', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('gone'))]),
			'l1'
		);
		const next = normalizeTabGroups(sessionWith([group], { aiIds: ['a'], order: [] }));
		expect(next.tabGroups).toHaveLength(0);
		// The lone survivor 'a' is promoted back to the strip.
		expect(next.unifiedTabOrder).toEqual([aiRef('a')]);
	});

	it('does not double-promote a survivor already in unifiedTabOrder', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('gone'))]),
			'l1'
		);
		const next = normalizeTabGroups(sessionWith([group], { aiIds: ['a'], order: [aiRef('a')] }));
		expect(next.tabGroups).toHaveLength(0);
		expect(next.unifiedTabOrder).toEqual([aiRef('a')]);
	});

	it('drops a group whose every leaf is dangling (nothing to promote)', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('gone1')), leaf('l2', aiRef('gone2'))]),
			'l1'
		);
		const next = normalizeTabGroups(sessionWith([group], { aiIds: [], order: [] }));
		expect(next.tabGroups).toHaveLength(0);
		expect(next.unifiedTabOrder).toEqual([]);
	});

	it('clears activeGroupId when it points at a removed group', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('gone'))]),
			'l1'
		);
		const next = normalizeTabGroups(sessionWith([group], { aiIds: ['a'], activeGroupId: 'grp' }));
		expect(next.activeGroupId).toBeNull();
	});

	it('keeps activeGroupId when its group survives normalization', () => {
		const group = groupFrom(
			rowSplit('root', [leaf('l1', aiRef('a')), leaf('l2', aiRef('b')), leaf('l3', aiRef('gone'))]),
			'l1'
		);
		const next = normalizeTabGroups(
			sessionWith([group], { aiIds: ['a', 'b'], activeGroupId: 'grp' })
		);
		expect(next.tabGroups).toHaveLength(1);
		expect(next.activeGroupId).toBe('grp');
	});

	it('handles mixed tab kinds when checking liveness', () => {
		const group = groupFrom(
			rowSplit('root', [
				leaf('l1', { type: 'terminal', id: 't1' }),
				leaf('l2', { type: 'browser', id: 'b1' }),
				leaf('l3', fileRef('gone-file')),
			]),
			'l1'
		);
		const next = normalizeTabGroups(
			sessionWith([group], { termIds: ['t1'], browserIds: ['b1'], fileIds: [] })
		);
		expect(next.tabGroups).toHaveLength(1);
		expect(collectLeafTabRefs(next.tabGroups[0].layout)).toEqual([
			{ type: 'terminal', id: 't1' },
			{ type: 'browser', id: 'b1' },
		]);
	});
});
