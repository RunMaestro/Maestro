// Panel layout helpers - pure, side-effect-free tree utilities for tmux-style
// tab tiling (split panes). Mirrors the functional style of tabHelpers.ts and
// terminalTabHelpers.ts: every function takes a node/group and returns a new
// one, never mutating its input.
//
// A layout is a recursive tree of PanelLayoutNode. Leaves reference existing
// tabs by UnifiedTabRef ({ type, id }); they never own tab data, so tiling a
// tab never copies or relocates its state. Splits arrange children in a row or
// column with fractional `sizes` (one weight per child, summing to 1).

import type {
	PaneRect,
	PaneRects,
	PanelLayoutNode,
	Session,
	TabGroup,
	UnifiedTabRef,
} from '../types';
import { generateId } from './ids';
import { getTabDisplayName } from './tabHelpers';
import { getTerminalTabDisplayName } from './terminalTabHelpers';
import { getBrowserTabLabel } from './browserTabPersistence';

/**
 * Minimum fractional size a pane may shrink to during a resize. Splits normalize
 * to sum to 1, so a leaf laid out in, say, a 4-wide row already sits at 0.25;
 * this floor (5% of the split's axis) just stops a divider drag from collapsing a
 * pane to an unusable sliver. It is a fraction-of-parent clamp, the pixel-ish
 * "minimum pane size" the resize handler enforces before committing sizes.
 */
export const MIN_PANE_FRACTION = 0.05;

/** A drop target region within a pane's bounding rect. */
export type DropZone = 'top' | 'bottom' | 'left' | 'right' | 'center';

/** A pane's on-screen box (client pixels), as returned by getBoundingClientRect. */
export interface DropRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Half-width of the central swap box on each axis (only when `allowCenter`): a
 * pointer within `[0.5 - CENTER_HALF, 0.5 + CENTER_HALF]` on BOTH axes lands in the
 * `center` zone. 0.2 gives a comfortable inner 40% target while keeping the edge
 * zones wide enough to hit reliably.
 */
const CENTER_HALF = 0.2;

/**
 * Classify a pointer position within a pane's rect into a drop zone. By default the
 * pane is carved along its two diagonals into four triangular edge quadrants
 * (top/bottom/left/right) - the standard tmux / VS Code split model - so every point
 * tiles. When `allowCenter` is set (pane-rearrange drags only), a central box yields
 * the `center` zone, which the caller treats as a SWAP rather than a reslice; a center
 * target reads as "replace/swap here", which is confusing for tiling a brand-new tab
 * but exactly right for exchanging two existing panes. The dominant offset from the
 * pane center picks the edge axis: a larger horizontal offset means left/right, a
 * larger vertical offset means top/bottom. A degenerate (zero-area) rect defaults to
 * `left` so callers still get a valid split direction.
 */
export function computeDropZone(
	rect: DropRect,
	pointerX: number,
	pointerY: number,
	allowCenter = false
): DropZone {
	if (rect.width <= 0 || rect.height <= 0) return 'left';
	// Normalize the pointer into [0,1] within the rect (clamped, so samples just
	// outside the box during a fast drag still classify to the nearest edge).
	const nx = Math.min(1, Math.max(0, (pointerX - rect.left) / rect.width));
	const ny = Math.min(1, Math.max(0, (pointerY - rect.top) / rect.height));

	// Offset from the pane center, in [-0.5, 0.5] on each axis. The axis with the
	// larger magnitude wins, and its sign picks the edge. This carves the pane into
	// four diagonal triangles meeting at the center - no dead/center region.
	const dx = nx - 0.5;
	const dy = ny - 0.5;
	// A pointer near the middle (both axes within the central box) means swap.
	if (allowCenter && Math.abs(dx) < CENTER_HALF && Math.abs(dy) < CENTER_HALF) {
		return 'center';
	}
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx < 0 ? 'left' : 'right';
	}
	return dy < 0 ? 'top' : 'bottom';
}

/**
 * Map a drop zone to the split geometry it implies: the split `direction`
 * (left/right tile side by side -> `row`; top/bottom stack -> `column`) and
 * whether the dropped pane lands `before` the target leaf (top/left) or after
 * (bottom/right). `center` has no edge geometry, so it reports `null`.
 */
export function dropZoneToSplit(
	zone: DropZone
): { direction: 'row' | 'column'; before: boolean } | null {
	switch (zone) {
		case 'left':
			return { direction: 'row', before: true };
		case 'right':
			return { direction: 'row', before: false };
		case 'top':
			return { direction: 'column', before: true };
		case 'bottom':
			return { direction: 'column', before: false };
		default:
			return null;
	}
}

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
 * `before` controls which side the new leaf lands on: `false` (default) places
 * it after the target (right/below), `true` places it before (left/above). This
 * lets an edge-drop honor its direction (a left/top drop inserts before, a
 * right/bottom drop inserts after).
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
	newTab: UnifiedTabRef,
	before = false
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
					children: before ? [newLeaf, node] : [node, newLeaf],
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
			const insertAt = before ? targetIndex : targetIndex + 1;
			const children = [
				...node.children.slice(0, insertAt),
				newLeaf,
				...node.children.slice(insertAt),
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

/**
 * Resolve a unified tab ref to its display title from the live tab it references,
 * covering all four kinds: AI (`getTabDisplayName`), file (tab name), terminal
 * (`getTerminalTabDisplayName` with its 1-based index), and browser (user title >
 * page title > URL). Returns a per-kind fallback when the tab no longer exists.
 * The single source of truth for a leaf's/pane's title, used both by TiledLayout's
 * pane title bars and by group auto-naming so the two never diverge.
 */
export function resolveTabRefTitle(session: Session, ref: UnifiedTabRef): string {
	switch (ref.type) {
		case 'ai': {
			const aiTab = session.aiTabs?.find((t) => t.id === ref.id);
			return aiTab ? getTabDisplayName(aiTab) : 'AI';
		}
		case 'file': {
			const fileTab = session.filePreviewTabs?.find((t) => t.id === ref.id);
			return fileTab ? fileTab.name : 'File';
		}
		case 'terminal': {
			const index = session.terminalTabs?.findIndex((t) => t.id === ref.id) ?? -1;
			const terminalTab = index >= 0 ? session.terminalTabs[index] : undefined;
			return terminalTab ? getTerminalTabDisplayName(terminalTab, index) : 'Terminal';
		}
		case 'browser': {
			const browserTab = session.browserTabs?.find((t) => t.id === ref.id);
			// Reuse the shared label helper (trims, falls back host -> "New Tab") so a
			// tiled pane never shows a blank title. The bare `customTitle ?? title ?? url`
			// chain rendered an empty label whenever `title` was an empty string (e.g. a
			// mid-reload transient after switching away from and back to the group).
			return browserTab ? getBrowserTabLabel(browserTab) : 'Browser';
		}
		default:
			return 'Tab';
	}
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
interface NormalizedPaneRect {
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
	out: NormalizedPaneRect[]
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
	const rects: NormalizedPaneRect[] = [];
	computePaneRects(group.layout, 0, 0, 1, 1, rects);
	const from = rects.find((r) => r.leafId === fromLeafId);
	if (!from) return null;

	const fromCenterX = from.x + from.width / 2;
	const fromCenterY = from.y + from.height / 2;
	// Small epsilon so panes sharing an exact edge count as "beyond" the source.
	const EPS = 1e-6;

	let best: { rect: NormalizedPaneRect; travel: number; overlap: number } | null = null;
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

	const order = session.unifiedTabOrder ?? [];
	const groupKey = `group:${groupId}`;
	const remainingRefs = collectLeafTabRefs(group.layout);
	// Members already present in the strip aren't re-added (avoid dupes); the rest are
	// promoted back where the group chip sat, so breaking a group apart restores its
	// tabs in place rather than appending them to the end.
	const alreadyOrdered = new Set(order.filter((ref) => tabRefKey(ref) !== groupKey).map(tabRefKey));
	const promoted = remainingRefs.filter((ref) => !alreadyOrdered.has(tabRefKey(ref)));
	const nextOrder: UnifiedTabRef[] = [];
	let replaced = false;
	for (const ref of order) {
		if (tabRefKey(ref) === groupKey) {
			nextOrder.push(...promoted);
			replaced = true;
			continue;
		}
		nextOrder.push(ref);
	}
	// No group ref in the order (legacy/migrated state): append the promoted members.
	if (!replaced) nextOrder.push(...promoted);

	return {
		...session,
		unifiedTabOrder: nextOrder,
		tabGroups: session.tabGroups.filter((g) => g.id !== groupId),
		activeGroupId: session.activeGroupId === groupId ? null : session.activeGroupId,
	};
}

/**
 * Explicitly break a group apart (the "Break apart" action): promote every leaf
 * back into `unifiedTabOrder` in left-to-right pane order, drop the group, clear
 * `activeGroupId` if it pointed here, and land `activeTabId`/`inputMode` on the
 * first promoted tab when it is an AI tab (so the panel doesn't strand focus on a
 * torn-down group). Distinct from the silent auto-dissolve: this is only ever
 * called after a user confirms. Reuses {@link dissolveGroup} for the promotion /
 * teardown so the two paths can never drift. A no-op copy when the id is unknown.
 */
export function breakApartGroup(session: Session, groupId: string): Session {
	const group = session.tabGroups.find((g) => g.id === groupId);
	if (!group) return session;
	// Capture the first pane's tab before the group is torn down so focus can land
	// on it (left-to-right leaf order matches collectLeafTabRefs).
	const firstRef = collectLeafTabRefs(group.layout)[0] ?? null;
	const dissolved = dissolveGroup(session, groupId);
	if (firstRef && firstRef.type === 'ai') {
		return { ...dissolved, activeTabId: firstRef.id, inputMode: 'ai' };
	}
	return dissolved;
}

/**
 * Rename the group `groupId` to `name`, trimming whitespace. A blank name falls
 * back to `fallbackName` (the auto-generated name from the group's first tab), so
 * clearing the field never leaves an unnamed chip. A no-op copy when the group
 * isn't found. Pairs with `updateSessionWith` in the rename handler.
 */
export function renameGroup(
	session: Session,
	groupId: string,
	name: string,
	fallbackName: string
): Session {
	const trimmed = name.trim();
	const finalName = trimmed.length > 0 ? trimmed : fallbackName;
	return updateGroupInSession(session, groupId, (g) => ({ ...g, name: finalName }));
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

/**
 * Stable key for a tab ref (used to dedupe / match refs by value in a Set, and
 * to key the per-pane geometry map the tiled layout publishes for keep-alive
 * overlay repositioning - e.g. `terminal:<id>` / `browser:<id>`).
 */
export function tabRefKey(ref: UnifiedTabRef): string {
	return `${ref.type}:${ref.id}`;
}

/**
 * Split a `tabRefKey`-keyed PaneRects map (as published by TiledLayout) into
 * per-kind maps keyed by bare tab id, so the terminal and browser keep-alive
 * overlays can look their tab up directly. Only terminal/browser leaves need
 * repositioning (AI/file panes render inline), so other kinds are ignored.
 */
export function splitPaneRectsByKind(paneRects: PaneRects): {
	terminals: Map<string, PaneRect>;
	browsers: Map<string, PaneRect>;
} {
	const terminals = new Map<string, PaneRect>();
	const browsers = new Map<string, PaneRect>();
	const TERMINAL = 'terminal:';
	const BROWSER = 'browser:';
	for (const [key, rect] of paneRects) {
		if (key.startsWith(TERMINAL)) terminals.set(key.slice(TERMINAL.length), rect);
		else if (key.startsWith(BROWSER)) browsers.set(key.slice(BROWSER.length), rect);
	}
	return { terminals, browsers };
}

/** Drop every occurrence of `tab` from `order` (matched by type + id). */
function removeRefFromOrder(order: UnifiedTabRef[], tab: UnifiedTabRef): UnifiedTabRef[] {
	return order.filter((ref) => !sameTabRef(ref, tab));
}

/**
 * Insert `tab` into `order` at `index` (clamped to the array bounds), first
 * removing any existing occurrence so a promoted-out pane can't double up in the
 * strip. A negative or out-of-range index appends.
 */
export function insertRefIntoOrder(
	order: UnifiedTabRef[],
	tab: UnifiedTabRef,
	index: number
): UnifiedTabRef[] {
	const without = removeRefFromOrder(order, tab);
	const at = index < 0 || index > without.length ? without.length : index;
	return [...without.slice(0, at), tab, ...without.slice(at)];
}

/**
 * Tile a dragged tab into an existing group by dropping it on one of a target
 * pane's zones:
 *
 * - An EDGE zone (top/bottom/left/right) splits the target leaf in the matching
 *   direction (left/right -> `row`, top/bottom -> `column`) with the new pane
 *   placed before (top/left) or after (bottom/right) per the drop side.
 * - The CENTER zone adds the dragged tab as a sibling of the target using the
 *   target's parent split direction (falling back to `row` for a single-pane
 *   group), keeping behavior simple: no stacking/replace.
 *
 * The dragged ref is removed from `unifiedTabOrder` (it now lives in the group)
 * and the freshly inserted pane is focused. A no-op copy when the group or the
 * target leaf can't be found. All state moves in one returned Session.
 */
export function tileTabIntoGroup(
	session: Session,
	groupId: string,
	targetLeafId: string,
	zone: DropZone,
	draggedTab: UnifiedTabRef
): Session {
	// Legacy sessions may lack these fields entirely; default so nothing throws.
	const tabGroups = session.tabGroups ?? [];
	const unifiedTabOrder = session.unifiedTabOrder ?? [];
	const group = tabGroups.find((g) => g.id === groupId);
	if (!group) return session;
	const targetLeaf = findLeafById(group.layout, targetLeafId);
	if (!targetLeaf || targetLeaf.kind !== 'leaf') return session;

	const split = dropZoneToSplit(zone);
	// Center: add as a sibling along the target's parent split direction.
	const direction = split ? split.direction : parentSplitDirection(group.layout, targetLeafId);
	const before = split ? split.before : false;

	const nextLayout = splitLeaf(group.layout, targetLeafId, direction, draggedTab, before);
	const newLeafId = findNewLeafId(group.layout, nextLayout, draggedTab);

	const withGroup = updateGroupInSession(
		{ ...session, tabGroups, unifiedTabOrder: removeRefFromOrder(unifiedTabOrder, draggedTab) },
		groupId,
		(g) => ({ ...g, layout: nextLayout })
	);
	return newLeafId ? focusPaneInSession(withGroup, groupId, newLeafId) : withGroup;
}

/**
 * Rearrange a pane WITHIN its group: move the pane `draggedLeafId` to the `zone`
 * of the pane `targetLeafId` (both leaves of `groupId`). Unlike {@link tileTabIntoGroup},
 * the dragged tab is already in the layout, so it is first removed from its current
 * position (collapsing any split it leaves at a single child) and then re-inserted by
 * splitting the target leaf in the drop direction (center adds it as a sibling in the
 * target's parent direction). The moved pane keeps focus. No-ops (same-reference copy)
 * when the group/leaves can't be found, the two leaves are the same pane, or removal
 * would empty the layout. `unifiedTabOrder` is untouched: the tab stays in the group.
 */
export function movePaneInGroup(
	session: Session,
	groupId: string,
	draggedLeafId: string,
	targetLeafId: string,
	zone: DropZone
): Session {
	if (draggedLeafId === targetLeafId) return session;
	const group = (session.tabGroups ?? []).find((g) => g.id === groupId);
	if (!group) return session;
	const draggedLeaf = findLeafById(group.layout, draggedLeafId);
	const targetLeaf = findLeafById(group.layout, targetLeafId);
	if (!draggedLeaf || draggedLeaf.kind !== 'leaf') return session;
	if (!targetLeaf || targetLeaf.kind !== 'leaf') return session;
	const draggedTab = draggedLeaf.tab;

	// Remove the pane from its current spot first (collapses a single-child split into
	// its survivor, which preserves the target leaf's node id).
	const withoutDragged = removeLeafByTabRef(group.layout, draggedTab);
	if (!withoutDragged) return session;
	// The target must survive the removal (it does unless it shared its only split with
	// the dragged pane - but a collapse keeps the survivor's node id, so it's re-findable).
	if (!findLeafById(withoutDragged, targetLeafId)) return session;

	const split = dropZoneToSplit(zone);
	const direction = split ? split.direction : parentSplitDirection(withoutDragged, targetLeafId);
	const before = split ? split.before : false;
	const nextLayout = splitLeaf(withoutDragged, targetLeafId, direction, draggedTab, before);
	const newLeafId = findNewLeafId(withoutDragged, nextLayout, draggedTab);

	const withGroup = updateGroupInSession(session, groupId, (g) => ({ ...g, layout: nextLayout }));
	return newLeafId ? focusPaneInSession(withGroup, groupId, newLeafId) : withGroup;
}

/**
 * Swap the contents of two panes WITHIN a group, exchanging their tab refs in place
 * while leaving the split structure, node ids, and sizes untouched. This is the
 * "rearrange the grid" primitive: dropping one pane onto the CENTER of another trades
 * their positions (swap top/bottom, left/right, or any two tiles) without reslicing -
 * so a 2x2 grid stays a 2x2 grid. Contrast {@link movePaneInGroup}, which removes and
 * re-inserts by splitting the target (used for the edge zones that change orientation).
 * Focus follows the dragged pane to its new home (`targetLeafId`, where its content now
 * lives). No-op (same-reference) copy when the group or either leaf can't be found, or
 * the two leaves are the same pane.
 */
export function swapPanesInGroup(
	session: Session,
	groupId: string,
	draggedLeafId: string,
	targetLeafId: string
): Session {
	if (draggedLeafId === targetLeafId) return session;
	const group = (session.tabGroups ?? []).find((g) => g.id === groupId);
	if (!group) return session;
	const draggedLeaf = findLeafById(group.layout, draggedLeafId);
	const targetLeaf = findLeafById(group.layout, targetLeafId);
	if (!draggedLeaf || draggedLeaf.kind !== 'leaf') return session;
	if (!targetLeaf || targetLeaf.kind !== 'leaf') return session;
	const draggedTab = draggedLeaf.tab;
	const targetTab = targetLeaf.tab;

	const swap = (node: PanelLayoutNode): PanelLayoutNode => {
		if (node.kind === 'leaf') {
			if (node.id === draggedLeafId) return { ...node, tab: targetTab };
			if (node.id === targetLeafId) return { ...node, tab: draggedTab };
			return node;
		}
		return { ...node, children: node.children.map(swap) };
	};

	const withGroup = updateGroupInSession(session, groupId, (g) => ({
		...g,
		layout: swap(g.layout),
	}));
	// The dragged pane's content now lives at the target leaf; focus follows it there.
	return focusPaneInSession(withGroup, groupId, targetLeafId);
}

/**
 * Create a brand-new tiled group from two standalone tabs: the drop-target tab
 * and the dragged tab, arranged per the drop `zone`. Used when a bar tab is
 * dropped onto the content of another standalone tab (no group active yet).
 *
 * The two panes are ordered by the drop side (the dragged pane lands before the
 * target for a top/left drop, after for bottom/right or center), the split runs
 * in the zone's direction (center falls back to `row`), both refs are removed
 * from `unifiedTabOrder`, the group is appended to `tabGroups`, and it becomes
 * the active group with its focused pane routing input.
 */
export function createGroupFromDrop(
	session: Session,
	targetRef: UnifiedTabRef,
	draggedRef: UnifiedTabRef,
	zone: DropZone,
	name: string
): Session {
	const split = dropZoneToSplit(zone);
	const direction = split ? split.direction : 'row';
	// top/left -> dragged before target; bottom/right/center -> dragged after.
	const ordered = split && split.before ? [draggedRef, targetRef] : [targetRef, draggedRef];

	const group = createGroupFromTabRefs(ordered, name);
	// createGroupFromTabRefs builds a flat `row` split; honor a column drop.
	const layout = group.layout.kind === 'split' ? { ...group.layout, direction } : group.layout;
	const draggedLeaf =
		layout.kind === 'split'
			? layout.children.find((c) => c.kind === 'leaf' && sameTabRef(c.tab, draggedRef))
			: undefined;
	const finalGroup: TabGroup = {
		...group,
		layout,
		// Focus the dragged pane (the one the user just placed).
		focusedPaneId: draggedLeaf?.id ?? group.focusedPaneId,
	};

	// Legacy sessions persisted before tiling may have neither field defined; default
	// both to arrays so the spread/filter below can't throw on a first-ever drop.
	const removeKeys = new Set([tabRefKey(targetRef), tabRefKey(draggedRef)]);
	const groupRef: UnifiedTabRef = { type: 'group', id: finalGroup.id };
	// Replace the two member refs with a single `group` ref in the strip order,
	// landing it where the first member sat so the group chip appears in place (not
	// tacked onto the end). The group is now a first-class unified tab: it navigates,
	// indexes, and renders as one entry. See UnifiedTabRef's 'group' kind.
	const nextOrder: UnifiedTabRef[] = [];
	let groupInserted = false;
	for (const ref of session.unifiedTabOrder ?? []) {
		if (removeKeys.has(tabRefKey(ref))) {
			if (!groupInserted) {
				nextOrder.push(groupRef);
				groupInserted = true;
			}
			continue;
		}
		nextOrder.push(ref);
	}
	if (!groupInserted) nextOrder.push(groupRef);
	const withGroup: Session = {
		...session,
		unifiedTabOrder: nextOrder,
		tabGroups: [...(session.tabGroups ?? []), finalGroup],
		activeGroupId: finalGroup.id,
	};
	return finalGroup.focusedPaneId
		? focusPaneInSession(withGroup, finalGroup.id, finalGroup.focusedPaneId)
		: withGroup;
}

/**
 * Promote a group's pane back to a standalone tab: remove the leaf from the
 * group's layout, re-insert its tab ref into `unifiedTabOrder` at `insertIndex`,
 * and rebalance. When the removal leaves the group with fewer than two panes the
 * group auto-dissolves (its remaining pane is promoted too, the group is dropped,
 * and `activeGroupId` clears if it pointed here) via {@link dissolveGroup}. A
 * no-op copy when the group or the leaf can't be found.
 */
export function promotePaneToStandalone(
	session: Session,
	groupId: string,
	leafId: string,
	insertIndex: number
): Session {
	const group = session.tabGroups.find((g) => g.id === groupId);
	if (!group) return session;
	const leaf = findLeafById(group.layout, leafId);
	if (!leaf || leaf.kind !== 'leaf') return session;

	const promotedRef = leaf.tab;
	const remaining = removeLeafByTabRef(group.layout, promotedRef);

	// Re-add the promoted tab to the strip at the drop position.
	const withOrder: Session = {
		...session,
		unifiedTabOrder: insertRefIntoOrder(session.unifiedTabOrder, promotedRef, insertIndex),
	};

	// Removal emptied the group (only that pane remained): drop the group and
	// clear the active pointer. The dissolve helper handles promoting leftovers,
	// but here there are none to promote beyond the one we just re-added.
	if (remaining === null) {
		return {
			...withOrder,
			tabGroups: withOrder.tabGroups.filter((g) => g.id !== groupId),
			activeGroupId: withOrder.activeGroupId === groupId ? null : withOrder.activeGroupId,
		};
	}

	const rebalanced = rebalanceLayout(remaining);
	const withGroup = updateGroupInSession(withOrder, groupId, (g) => ({
		...g,
		layout: rebalanced,
		// Focus a surviving pane if the promoted one held focus.
		focusedPaneId: g.focusedPaneId === leafId ? firstLeafId(rebalanced) : g.focusedPaneId,
	}));

	// Below two panes: auto-dissolve, promoting the lone survivor to a standalone
	// tab and tearing down the group.
	if (countLeaves(rebalanced) < 2) {
		return dissolveGroup(withGroup, groupId);
	}
	return withGroup;
}

/** The split direction of the immediate parent of `leafId`, or `row` if none. */
function parentSplitDirection(node: PanelLayoutNode, leafId: string): 'row' | 'column' {
	if (node.kind === 'leaf') return 'row';
	if (node.children.some((c) => c.kind === 'leaf' && c.id === leafId)) return node.direction;
	for (const child of node.children) {
		if (child.kind === 'split') {
			const found = parentSplitDirection(child, leafId);
			if (findLeafById(child, leafId)) return found;
		}
	}
	return 'row';
}

/** Id of the first (top-left) leaf in a layout, or null for an empty tree. */
function firstLeafId(node: PanelLayoutNode): string | null {
	if (node.kind === 'leaf') return node.id;
	for (const child of node.children) {
		const id = firstLeafId(child);
		if (id) return id;
	}
	return null;
}

/**
 * Find the id of the leaf added to `next` (vs `prev`) that references `tab`.
 * `splitLeaf` mints a fresh id for the inserted leaf, so we locate it by the new
 * leaf-id set diff filtered to leaves referencing the dragged tab. Returns null
 * if nothing new matched (should not happen after a successful split).
 */
function findNewLeafId(
	prev: PanelLayoutNode,
	next: PanelLayoutNode,
	tab: UnifiedTabRef
): string | null {
	const prevIds = new Set<string>();
	collectLeafIds(prev, prevIds);
	let found: string | null = null;
	function walk(node: PanelLayoutNode): void {
		if (found) return;
		if (node.kind === 'leaf') {
			if (!prevIds.has(node.id) && sameTabRef(node.tab, tab)) found = node.id;
			return;
		}
		node.children.forEach(walk);
	}
	walk(next);
	return found;
}

/** Collect every leaf node id in the tree into `out`. */
function collectLeafIds(node: PanelLayoutNode, out: Set<string>): void {
	if (node.kind === 'leaf') {
		out.add(node.id);
		return;
	}
	node.children.forEach((child) => collectLeafIds(child, out));
}

/**
 * Build the set of `tabRefKey`s the session still has live tab data for. A layout
 * leaf whose ref isn't in this set is dangling (its tab was closed while the group
 * was persisted) and gets pruned during normalization.
 */
function liveTabRefKeys(session: Session): Set<string> {
	const keys = new Set<string>();
	for (const t of session.aiTabs ?? []) keys.add(`ai:${t.id}`);
	for (const t of session.filePreviewTabs ?? []) keys.add(`file:${t.id}`);
	for (const t of session.terminalTabs ?? []) keys.add(`terminal:${t.id}`);
	for (const t of session.browserTabs ?? []) keys.add(`browser:${t.id}`);
	return keys;
}

/**
 * Prune every leaf whose tab ref is not in `liveKeys` from the layout tree,
 * renormalizing surviving `sizes` and collapsing any split reduced to a single
 * child (same shape as {@link removeLeafByTabRef}, but keyed on a liveness set so
 * one pass drops all dangling leaves). Returns `null` when nothing survives.
 */
function pruneLayoutToLiveTabs(
	node: PanelLayoutNode,
	liveKeys: Set<string>
): PanelLayoutNode | null {
	if (node.kind === 'leaf') {
		return liveKeys.has(tabRefKey(node.tab)) ? node : null;
	}
	const survivors: PanelLayoutNode[] = [];
	const survivorSizes: number[] = [];
	node.children.forEach((child, index) => {
		const kept = pruneLayoutToLiveTabs(child, liveKeys);
		if (kept !== null) {
			survivors.push(kept);
			survivorSizes.push(node.sizes[index] ?? 1 / node.children.length);
		}
	});
	if (survivors.length === 0) return null;
	// Collapse a split left with a single child into that child.
	if (survivors.length === 1) return survivors[0];
	return { ...node, children: survivors, sizes: normalizeSizes(survivorSizes) };
}

/**
 * Harden a persisted session's tab groups so a corrupt or partial layout can never
 * break the panel on restore. For each group it: prunes any layout leaf whose
 * referenced tab no longer exists in `aiTabs`/`filePreviewTabs`/`terminalTabs`/
 * `browserTabs`, collapses the resulting single-child splits and renormalizes
 * `sizes`, and drops any group that ends up with fewer than two leaves (promoting
 * the lone survivor, if any, back into `unifiedTabOrder`). Finally it clears
 * `activeGroupId` when it points at a group that was removed. Pure: returns a new
 * Session (same reference-shape as the other helpers), never mutating the input.
 *
 * Wired into the session-restoration path so it runs once per session before it
 * lands in the store. A session with no groups round-trips untouched.
 */
export function normalizeTabGroups(session: Session): Session {
	const groups = session.tabGroups ?? [];
	if (groups.length === 0) {
		// Legacy sessions persisted before tiling existed have no `tabGroups` field at
		// all. Guarantee it is always an array so the tiling mutators (createGroupFromDrop
		// / tileTabIntoGroup) can spread and iterate it without throwing on a first drop.
		// A session that already has the (empty) array round-trips as the same reference.
		return session.tabGroups ? session : { ...session, tabGroups: [] };
	}

	const liveKeys = liveTabRefKeys(session);
	const alreadyOrdered = new Set((session.unifiedTabOrder ?? []).map(tabRefKey));

	const keptGroups: TabGroup[] = [];
	const promoted: UnifiedTabRef[] = [];
	const removedGroupIds = new Set<string>();
	// Stays false while every group survives with all its leaves intact, so a fully
	// valid session round-trips as the same reference (cheap no-op on the hot path).
	let changed = false;

	for (const group of groups) {
		const originalLeafCount = countLeaves(group.layout);
		const prunedLayout = pruneLayoutToLiveTabs(group.layout, liveKeys);
		// A tiled group needs at least two panes to be meaningful. Anything below
		// that (all leaves dangling, or a single survivor) is torn down; a lone
		// survivor is promoted back to a standalone tab.
		if (!prunedLayout || countLeaves(prunedLayout) < 2) {
			changed = true;
			removedGroupIds.add(group.id);
			if (prunedLayout) {
				for (const ref of collectLeafTabRefs(prunedLayout)) {
					if (!alreadyOrdered.has(tabRefKey(ref))) {
						alreadyOrdered.add(tabRefKey(ref));
						promoted.push(ref);
					}
				}
			}
			continue;
		}
		// No leaf pruned: keep the original group reference untouched.
		if (countLeaves(prunedLayout) === originalLeafCount) {
			keptGroups.push(group);
			continue;
		}
		// Some leaves were pruned: swap in the pruned layout and repoint focus if the
		// focused pane was among the leaves that got pruned away.
		changed = true;
		const focusStillValid =
			group.focusedPaneId != null && findLeafById(prunedLayout, group.focusedPaneId) != null;
		keptGroups.push({
			...group,
			layout: prunedLayout,
			focusedPaneId: focusStillValid ? group.focusedPaneId : firstLeafId(prunedLayout),
		});
	}

	const nextActiveGroupId =
		session.activeGroupId != null && removedGroupIds.has(session.activeGroupId)
			? null
			: session.activeGroupId;
	if (nextActiveGroupId !== session.activeGroupId) changed = true;

	// Reconcile unifiedTabOrder with the kept groups so a group is a first-class
	// unified tab: each kept group is represented by exactly one `group` ref, its
	// member tabs are dropped from the strip (the group ref stands in for them), and
	// group refs for removed groups are pruned. This also MIGRATES sessions persisted
	// before groups joined the order (a group in tabGroups but no group ref in the
	// order) by backfilling the ref where its first member sat. Members promoted out
	// of sub-two-pane groups are appended.
	const originalOrder = session.unifiedTabOrder ?? [];
	const keptGroupIds = new Set(keptGroups.map((g) => g.id));
	const memberKeyToGroupId = new Map<string, string>();
	for (const g of keptGroups) {
		for (const ref of collectLeafTabRefs(g.layout)) memberKeyToGroupId.set(tabRefKey(ref), g.id);
	}
	const represented = new Set<string>();
	const reconciledOrder: UnifiedTabRef[] = [];
	for (const ref of originalOrder) {
		if (ref.type === 'group') {
			// Keep a kept group's ref (once); drop refs for removed groups + duplicates.
			if (keptGroupIds.has(ref.id) && !represented.has(ref.id)) {
				reconciledOrder.push(ref);
				represented.add(ref.id);
			}
			continue;
		}
		const owningGroupId = memberKeyToGroupId.get(tabRefKey(ref));
		if (owningGroupId) {
			// Replace the first member of a kept group with that group's ref (in place);
			// drop any further member refs.
			if (!represented.has(owningGroupId)) {
				reconciledOrder.push({ type: 'group', id: owningGroupId });
				represented.add(owningGroupId);
			}
			continue;
		}
		reconciledOrder.push(ref);
	}
	for (const g of keptGroups) {
		if (!represented.has(g.id)) reconciledOrder.push({ type: 'group', id: g.id });
	}
	reconciledOrder.push(...promoted);

	const orderChanged =
		reconciledOrder.length !== originalOrder.length ||
		reconciledOrder.some((ref, i) => tabRefKey(ref) !== tabRefKey(originalOrder[i]));
	if (orderChanged) changed = true;

	// Nothing changed: return the same reference so callers can cheaply skip work.
	if (!changed) return session;

	return {
		...session,
		tabGroups: keptGroups,
		unifiedTabOrder: orderChanged ? reconciledOrder : session.unifiedTabOrder,
		activeGroupId: nextActiveGroupId,
	};
}
