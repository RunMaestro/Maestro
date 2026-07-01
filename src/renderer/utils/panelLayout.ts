// Panel layout helpers - pure, side-effect-free tree utilities for tmux-style
// tab tiling (split panes). Mirrors the functional style of tabHelpers.ts and
// terminalTabHelpers.ts: every function takes a node/group and returns a new
// one, never mutating its input.
//
// A layout is a recursive tree of PanelLayoutNode. Leaves reference existing
// tabs by UnifiedTabRef ({ type, id }); they never own tab data, so tiling a
// tab never copies or relocates its state. Splits arrange children in a row or
// column with fractional `sizes` (one weight per child, summing to 1).

import type { PanelLayoutNode, Session, TabGroup, UnifiedTabRef } from '../types';
import { generateId } from './ids';

/**
 * Minimum fractional size a pane may shrink to during a resize. Splits normalize
 * to sum to 1, so a leaf laid out in, say, a 4-wide row already sits at 0.25;
 * this floor (5% of the split's axis) just stops a divider drag from collapsing a
 * pane to an unusable sliver. It is a fraction-of-parent clamp, the pixel-ish
 * "minimum pane size" the resize handler enforces before committing sizes.
 */
export const MIN_PANE_FRACTION = 0.05;

/** Compare two tab refs by type + id (leaves reference tabs by value, not identity). */
function sameTabRef(a: UnifiedTabRef, b: UnifiedTabRef): boolean {
	return a.type === b.type && a.id === b.id;
}

/** Normalize an array of weights so it sums to 1 (falls back to equal weights). */
function normalizeSizes(sizes: number[]): number[] {
	const total = sizes.reduce((sum, n) => sum + n, 0);
	if (total <= 0) {
		return sizes.map(() => 1 / sizes.length);
	}
	return sizes.map((n) => n / total);
}

/** Build a leaf node that references an existing tab. */
export function createLeaf(tab: UnifiedTabRef): PanelLayoutNode {
	return { kind: 'leaf', id: generateId(), tab };
}

/**
 * Build a TabGroup from a set of tab refs: one top-level `row` split with an
 * equal-sized leaf per tab (each weight `1 / n`). The first leaf is focused.
 */
export function createGroupFromTabRefs(tabs: UnifiedTabRef[], name: string): TabGroup {
	const children = tabs.map((tab) => createLeaf(tab));
	const sizes = children.map(() => 1 / children.length);
	const layout: PanelLayoutNode = {
		kind: 'split',
		id: generateId(),
		direction: 'row',
		children,
		sizes,
	};
	return {
		id: generateId(),
		name,
		layout,
		focusedPaneId: children[0]?.id ?? null,
		createdAt: Date.now(),
	};
}

/**
 * Replace the leaf identified by `leafId` with a split that holds the original
 * leaf plus a new leaf for `newTab`, dividing the space `[0.5, 0.5]`.
 *
 * tmux behavior: when the target leaf's parent split already runs in the
 * requested `direction`, the new leaf is inserted as a sibling in that parent
 * (rebalanced to equal weights) instead of nesting a fresh split - so repeated
 * splits in one direction produce a flat row/column rather than a deep tree.
 */
export function splitLeaf(
	layout: PanelLayoutNode,
	leafId: string,
	direction: 'row' | 'column',
	newTab: UnifiedTabRef
): PanelLayoutNode {
	const newLeaf = createLeaf(newTab);

	function recurse(node: PanelLayoutNode): PanelLayoutNode {
		if (node.kind === 'leaf') {
			// A bare leaf with no parent split (single-pane layout): wrap it.
			if (node.id === leafId) {
				return {
					kind: 'split',
					id: generateId(),
					direction,
					children: [node, newLeaf],
					sizes: [0.5, 0.5],
				};
			}
			return node;
		}

		// If a direct child of this split is the target leaf and the split already
		// runs in the requested direction, insert the new leaf as a sibling here
		// (flat, tmux-style) rather than nesting a new split around the leaf.
		const targetIndex = node.children.findIndex(
			(child) => child.kind === 'leaf' && child.id === leafId
		);
		if (targetIndex !== -1 && node.direction === direction) {
			const children = [
				...node.children.slice(0, targetIndex + 1),
				newLeaf,
				...node.children.slice(targetIndex + 1),
			];
			const sizes = children.map(() => 1 / children.length);
			return { ...node, children, sizes };
		}

		// Otherwise recurse: the target leaf either lives deeper or its parent
		// split runs in the other direction (so it must nest a new split).
		return { ...node, children: node.children.map(recurse) };
	}

	return recurse(layout);
}

/**
 * Remove the leaf matching `tab` from the tree. The parent split's `sizes` are
 * renormalized over the remaining children, and any split reduced to a single
 * child collapses into that child. Returns `null` if the removed leaf was the
 * last one in the tree.
 */
export function removeLeafByTabRef(
	layout: PanelLayoutNode,
	tab: UnifiedTabRef
): PanelLayoutNode | null {
	function recurse(node: PanelLayoutNode): PanelLayoutNode | null {
		if (node.kind === 'leaf') {
			return sameTabRef(node.tab, tab) ? null : node;
		}

		const survivors: PanelLayoutNode[] = [];
		const survivorSizes: number[] = [];
		node.children.forEach((child, index) => {
			const kept = recurse(child);
			if (kept !== null) {
				survivors.push(kept);
				survivorSizes.push(node.sizes[index]);
			}
		});

		if (survivors.length === 0) return null;
		// Collapse a split left with a single child into that child.
		if (survivors.length === 1) return survivors[0];
		return { ...node, children: survivors, sizes: normalizeSizes(survivorSizes) };
	}

	return recurse(layout);
}

/** Find the leaf that references `tab`, or null if none matches. */
export function findLeafByTabRef(
	layout: PanelLayoutNode,
	tab: UnifiedTabRef
): PanelLayoutNode | null {
	if (layout.kind === 'leaf') {
		return sameTabRef(layout.tab, tab) ? layout : null;
	}
	for (const child of layout.children) {
		const found = findLeafByTabRef(child, tab);
		if (found) return found;
	}
	return null;
}

/** Find the leaf whose node id is `leafId`, or null if none matches. */
export function findLeafById(layout: PanelLayoutNode, leafId: string): PanelLayoutNode | null {
	if (layout.kind === 'leaf') {
		return layout.id === leafId ? layout : null;
	}
	for (const child of layout.children) {
		const found = findLeafById(child, leafId);
		if (found) return found;
	}
	return null;
}

/** Collect every leaf's tab ref, left-to-right / top-to-bottom. */
export function collectLeafTabRefs(layout: PanelLayoutNode): UnifiedTabRef[] {
	if (layout.kind === 'leaf') return [layout.tab];
	return layout.children.flatMap(collectLeafTabRefs);
}

/** Count the leaves in a layout tree. */
export function countLeaves(layout: PanelLayoutNode): number {
	if (layout.kind === 'leaf') return 1;
	return layout.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

/** Build an auto group name from the first tab's title (used for auto-naming). */
export function generateGroupName(firstTabTitle: string): string {
	return `Group: ${firstTabTitle}`;
}

/** True when a unified tab ref points at a TabGroup rather than a single tab. */
export function isGroupRef(ref: UnifiedTabRef): boolean {
	return ref.type === 'group';
}

/**
 * Clamp an array of fractional sizes so no entry drops below MIN_PANE_FRACTION,
 * then renormalize to sum to 1. Space taken by clamped-up entries is skimmed off
 * the entries that still sit above the floor (proportional to their headroom),
 * so a divider drag can push right up to a neighbor's minimum but not past it.
 */
function clampSizes(sizes: number[]): number[] {
	if (sizes.length === 0) return sizes;
	const floor = Math.min(MIN_PANE_FRACTION, 1 / sizes.length);
	// Work on a normalized copy so callers can pass raw pixel widths or fractions.
	const normalized = normalizeSizes(sizes);
	const clamped = normalized.map((n) => Math.max(floor, n));
	const overshoot = clamped.reduce((sum, n) => sum + n, 0) - 1;
	if (overshoot <= 0) {
		// Everything at/above floor already sums to <= 1 (all-at-floor edge case):
		// renormalize so the result still sums to exactly 1.
		return normalizeSizes(clamped);
	}
	// Distribute the overshoot back onto the panes that have headroom above floor.
	const headroom = clamped.map((n) => n - floor);
	const totalHeadroom = headroom.reduce((sum, n) => sum + n, 0);
	if (totalHeadroom <= 0) return clamped.map(() => 1 / clamped.length);
	return clamped.map((n, i) => n - overshoot * (headroom[i] / totalHeadroom));
}

/**
 * Replace the `sizes` of the split node identified by `splitNodeId` with new
 * weights (clamped to MIN_PANE_FRACTION and renormalized to sum to 1). Pure: the
 * rest of the tree is returned untouched. A no-op if the id isn't a split or the
 * incoming length doesn't match the split's child count.
 */
export function updateSplitSizes(
	layout: PanelLayoutNode,
	splitNodeId: string,
	sizes: number[]
): PanelLayoutNode {
	function recurse(node: PanelLayoutNode): PanelLayoutNode {
		if (node.kind === 'leaf') return node;
		if (node.id === splitNodeId && sizes.length === node.children.length) {
			return { ...node, sizes: clampSizes(sizes) };
		}
		return { ...node, children: node.children.map(recurse) };
	}
	return recurse(layout);
}

/**
 * Return a copy of `group` with `focusedPaneId` set to `leafId`. No-op (same
 * reference) when the leaf doesn't exist in the group's layout, so callers never
 * point focus at a pane that isn't there.
 */
export function setFocusedPane(group: TabGroup, leafId: string): TabGroup {
	if (group.focusedPaneId === leafId) return group;
	if (!findLeafById(group.layout, leafId)) return group;
	return { ...group, focusedPaneId: leafId };
}

/** A pane's position in the group's normalized [0,1] x [0,1] coordinate space. */
interface PaneRect {
	leafId: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Walk the split tree and compute each leaf's rectangle in a normalized unit
 * square (the whole group is [0,0]-[1,1]). A `row` split divides its box along x
 * by the children's fractional sizes; a `column` split divides along y. This
 * gives every pane a spatial position without needing measured DOM rects, so the
 * layout math stays pure and testable.
 */
function computePaneRects(
	node: PanelLayoutNode,
	x: number,
	y: number,
	width: number,
	height: number,
	out: PaneRect[]
): void {
	if (node.kind === 'leaf') {
		out.push({ leafId: node.id, x, y, width, height });
		return;
	}
	let offset = 0;
	node.children.forEach((child, index) => {
		const weight = node.sizes[index] ?? 1 / node.children.length;
		if (node.direction === 'row') {
			computePaneRects(child, x + offset * width, y, weight * width, height, out);
		} else {
			computePaneRects(child, x, y + offset * height, width, weight * height, out);
		}
		offset += weight;
	});
}

/**
 * Find the id of the nearest leaf in `direction` from the leaf `fromLeafId`,
 * using the panes' spatial rectangles. "Nearest" = the pane whose span overlaps
 * the source pane on the perpendicular axis and sits closest on the travel axis;
 * ties break toward the greatest perpendicular overlap. Returns null when there
 * is no pane in that direction (edge of the layout) or the source leaf is gone.
 */
export function findPaneInDirection(
	group: TabGroup,
	fromLeafId: string,
	direction: 'left' | 'right' | 'up' | 'down'
): string | null {
	const rects: PaneRect[] = [];
	computePaneRects(group.layout, 0, 0, 1, 1, rects);
	const from = rects.find((r) => r.leafId === fromLeafId);
	if (!from) return null;

	const fromCenterX = from.x + from.width / 2;
	const fromCenterY = from.y + from.height / 2;
	// Small epsilon so panes sharing an exact edge count as "beyond" the source.
	const EPS = 1e-6;

	let best: { rect: PaneRect; travel: number; overlap: number } | null = null;
	for (const rect of rects) {
		if (rect.leafId === fromLeafId) continue;

		let isBeyond = false;
		let travel = 0;
		let overlap = 0;
		if (direction === 'left') {
			isBeyond = rect.x + rect.width <= from.x + EPS;
			travel = fromCenterX - (rect.x + rect.width);
			overlap = overlapLength(from.y, from.height, rect.y, rect.height);
		} else if (direction === 'right') {
			isBeyond = rect.x >= from.x + from.width - EPS;
			travel = rect.x - (fromCenterX - from.width / 2 + from.width);
			overlap = overlapLength(from.y, from.height, rect.y, rect.height);
		} else if (direction === 'up') {
			isBeyond = rect.y + rect.height <= from.y + EPS;
			travel = fromCenterY - (rect.y + rect.height);
			overlap = overlapLength(from.x, from.width, rect.x, rect.width);
		} else {
			isBeyond = rect.y >= from.y + from.height - EPS;
			travel = rect.y - (fromCenterY - from.height / 2 + from.height);
			overlap = overlapLength(from.x, from.width, rect.x, rect.width);
		}

		// Must lie in the requested direction and share some perpendicular span so
		// we don't jump diagonally to a pane in a different row/column.
		if (!isBeyond || overlap <= EPS) continue;

		if (
			best === null ||
			travel < best.travel - EPS ||
			(Math.abs(travel - best.travel) <= EPS && overlap > best.overlap)
		) {
			best = { rect, travel, overlap };
		}
	}

	return best ? best.rect.leafId : null;
}

/** Length of the 1D overlap between segments [a, a+aLen] and [b, b+bLen]. */
function overlapLength(a: number, aLen: number, b: number, bLen: number): number {
	return Math.max(0, Math.min(a + aLen, b + bLen) - Math.max(a, b));
}

/**
 * Reset every split node's `sizes` to equal fractions (`1 / childCount`), leaving
 * the tree shape and leaf refs untouched. The "rebalance / equal-split" action.
 */
export function rebalanceLayout(layout: PanelLayoutNode): PanelLayoutNode {
	if (layout.kind === 'leaf') return layout;
	const children = layout.children.map(rebalanceLayout);
	const sizes = children.map(() => 1 / children.length);
	return { ...layout, children, sizes };
}

/**
 * Dissolve the tab group `groupId`: promote every tab its layout still references
 * back into `unifiedTabOrder` (any that aren't already there, appended in leaf
 * order so their relative order is preserved), drop the group from `tabGroups`,
 * and clear `activeGroupId` if it pointed at this group. Used when a group is
 * torn down (e.g. it dropped to a single pane and auto-dissolves). Returns a new
 * Session; a no-op copy when the group id isn't found.
 */
export function dissolveGroup(session: Session, groupId: string): Session {
	const group = session.tabGroups.find((g) => g.id === groupId);
	if (!group) return session;

	const remainingRefs = collectLeafTabRefs(group.layout);
	const alreadyOrdered = new Set(session.unifiedTabOrder.map((ref) => `${ref.type}:${ref.id}`));
	const promoted = remainingRefs.filter((ref) => !alreadyOrdered.has(`${ref.type}:${ref.id}`));

	return {
		...session,
		unifiedTabOrder: [...session.unifiedTabOrder, ...promoted],
		tabGroups: session.tabGroups.filter((g) => g.id !== groupId),
		activeGroupId: session.activeGroupId === groupId ? null : session.activeGroupId,
	};
}

/**
 * Apply `updater` to the group `groupId` within a session and return a new
 * Session with just that group replaced. A no-op copy when the group isn't
 * found. Wraps the common `tabGroups.map(...)` shape so pane-focus / resize /
 * rebalance handlers don't each hand-roll it.
 */
export function updateGroupInSession(
	session: Session,
	groupId: string,
	updater: (group: TabGroup) => TabGroup
): Session {
	return {
		...session,
		tabGroups: session.tabGroups.map((g) => (g.id === groupId ? updater(g) : g)),
	};
}

/**
 * Return the AI-tab id a focused pane routes input to, or null when the group's
 * focused pane references a non-AI tab (file/terminal/browser) or nothing is
 * focused. Callers keep `Session.activeTabId` in step with this so the shared
 * input area, send action, and tab-scoped shortcuts all target the focused
 * pane's tab without any extra plumbing.
 */
export function focusedAiTabId(group: TabGroup): string | null {
	if (!group.focusedPaneId) return null;
	const leaf = findLeafById(group.layout, group.focusedPaneId);
	if (!leaf || leaf.kind !== 'leaf') return null;
	return leaf.tab.type === 'ai' ? leaf.tab.id : null;
}

/**
 * Focus a pane within a group in a session: move the group's `focusedPaneId` to
 * `leafId` and, when that leaf references an AI tab, sync `activeTabId` to it so
 * the shared input area / send action / tab shortcuts target the focused pane.
 * `activeGroupId` is left intact so the tiled view keeps taking over the panel.
 * A non-AI focused pane leaves `activeTabId` as-is (the input is hidden for it).
 */
export function focusPaneInSession(session: Session, groupId: string, leafId: string): Session {
	const withFocus = updateGroupInSession(session, groupId, (g) => setFocusedPane(g, leafId));
	const group = withFocus.tabGroups.find((g) => g.id === groupId);
	if (!group) return withFocus;
	const aiId = focusedAiTabId(group);
	return aiId ? { ...withFocus, activeTabId: aiId, inputMode: 'ai' } : withFocus;
}
