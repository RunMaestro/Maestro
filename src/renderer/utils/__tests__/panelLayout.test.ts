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
} from '../panelLayout';

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
