/**
 * useTilingShortcuts - handlers for the Ctrl+Cmd pane-tiling shortcut family.
 *
 * Each handler operates ONLY on the active window's active tab group (the group
 * referenced by `activeSession.activeGroupId`) and no-ops gracefully when there
 * is no active group, no focused pane, or no neighbor/target. All layout mutation
 * goes through the pure helpers in utils/panelLayout and is committed with a
 * single updateSessionWith call; the transient zoom state lives in the UI store.
 *
 * These are wired into the main keyboard handler (see useMainKeyboardHandler),
 * which matches the keys with isPaneShortcut and dispatches to the matching
 * handler. Kept out of App.tsx's body to keep that file's ctx assembly lean.
 *
 * Active Session is resolved at call time via selectActiveSession(getState()) so
 * App does not need to pass a live Session into this hook.
 */

import { useCallback, useMemo } from 'react';

import { selectActiveSession, updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { useUIStore } from '../../stores/uiStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import {
	countLeaves,
	dissolveGroup,
	findLeafById,
	findPaneInDirection,
	focusPaneInSession,
	rebalanceLayout,
	removeLeafByTabRef,
	splitLeaf,
	updateGroupInSession,
} from '../../utils/panelLayout';
import type { PanelLayoutNode, Session, TabGroup, UnifiedTabRef } from '../../types';

/** All pane actions the tiling shortcut family dispatches to. */
export interface TilingShortcutHandlers {
	focusPane: (direction: 'left' | 'right' | 'up' | 'down') => void;
	/** Cycle focus through the group's panes in document order (Alt+[ / Alt+]). */
	cyclePane: (direction: 'prev' | 'next') => void;
	splitFocusedPane: (direction: 'row' | 'column') => void;
	closeFocusedPane: () => void;
	toggleZoom: () => void;
	rebalance: () => void;
}

/** Collect every leaf's node id in document order (left-to-right / top-to-bottom). */
function collectLeafIdsOrdered(node: PanelLayoutNode, out: string[]): void {
	if (node.kind === 'leaf') {
		out.push(node.id);
		return;
	}
	node.children.forEach((child) => collectLeafIdsOrdered(child, out));
}

/** The active session's active group, or null when nothing is tiled/active. */
function activeGroupOf(session: Session | null | undefined): TabGroup | null {
	if (!session || session.activeGroupId == null) return null;
	return session.tabGroups.find((g) => g.id === session.activeGroupId) ?? null;
}

/** True when a unified ref is a standalone AI/file tab eligible to move into a pane. */
function isEligibleStandalone(ref: UnifiedTabRef): boolean {
	return ref.type === 'ai' || ref.type === 'file';
}

/** Resolve the active agent id at call time (identity-split: selectActiveSession, not raw activeSessionId). */
function resolveActiveSessionId(): string | null {
	return selectActiveSession(useSessionStore.getState())?.id ?? null;
}

export function useTilingShortcuts(): TilingShortcutHandlers {
	// Move focus to the spatially nearest pane in `direction`. No-op when there is
	// no active group, no focused pane, or no neighbor that way (edge of layout).
	const focusPane = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
		const sessionId = resolveActiveSessionId();
		if (!sessionId) return;
		updateSessionWith(sessionId, (s) => {
			const group = activeGroupOf(s);
			if (!group || !group.focusedPaneId) return s;
			const neighbor = findPaneInDirection(group, group.focusedPaneId, direction);
			if (!neighbor) return s;
			return focusPaneInSession(s, group.id, neighbor);
		});
	}, []);

	// Cycle focus through the group's panes in document order (Alt+[ prev, Alt+] next)
	// with wrap-around. Unlike focusPane (spatial), this visits every pane in a fixed
	// order so a user can round-robin through all panes regardless of geometry. No-op
	// with no active group or fewer than two panes.
	const cyclePane = useCallback((direction: 'prev' | 'next') => {
		const sessionId = resolveActiveSessionId();
		if (!sessionId) return;
		updateSessionWith(sessionId, (s) => {
			const group = activeGroupOf(s);
			if (!group) return s;
			const ids: string[] = [];
			collectLeafIdsOrdered(group.layout, ids);
			if (ids.length < 2) return s;
			const currentIdx = group.focusedPaneId ? ids.indexOf(group.focusedPaneId) : -1;
			// From no/unknown focus: next -> first pane, prev -> last pane.
			const step = direction === 'next' ? 1 : -1;
			const base = currentIdx === -1 ? (direction === 'next' ? -1 : 0) : currentIdx;
			const nextIdx = (base + step + ids.length) % ids.length;
			return focusPaneInSession(s, group.id, ids[nextIdx]);
		});
	}, []);

	// Split the focused pane, pulling the next standalone AI/file tab out of the
	// tab strip into the new pane. Full content selection lands with drag-and-drop
	// in Phase 03; here we take the first eligible standalone tab if one exists,
	// otherwise flash a hint and leave the layout untouched.
	const splitFocusedPane = useCallback((direction: 'row' | 'column') => {
		const sessionId = resolveActiveSessionId();
		if (!sessionId) return;
		let flashNoTab = false;
		updateSessionWith(sessionId, (s) => {
			const group = activeGroupOf(s);
			if (!group || !group.focusedPaneId) return s;
			const nextRef = (s.unifiedTabOrder ?? []).find(isEligibleStandalone);
			if (!nextRef) {
				flashNoTab = true;
				return s;
			}
			const newLayout = splitLeaf(group.layout, group.focusedPaneId, direction, nextRef);
			// The new leaf is the one referencing nextRef that wasn't in the old tree.
			const newLeaf = collectNewLeafFor(newLayout, group.layout, nextRef);
			const withLayout = updateGroupInSession(s, group.id, (g) => ({ ...g, layout: newLayout }));
			// Drop the moved tab from the standalone strip (it now lives in a pane).
			const cleaned: Session = {
				...withLayout,
				unifiedTabOrder: (withLayout.unifiedTabOrder ?? []).filter(
					(ref) => !(ref.type === nextRef.type && ref.id === nextRef.id)
				),
			};
			// Focus the freshly inserted pane so input immediately targets it.
			return newLeaf ? focusPaneInSession(cleaned, group.id, newLeaf.id) : cleaned;
		});
		if (flashNoTab) {
			notifyCenterFlash({
				message: 'No standalone tab to split into',
				color: 'yellow',
			});
		}
	}, []);

	// Close the focused pane: promote its tab back to a standalone strip chip, move
	// focus to a neighbor, rebalance the remaining panes. If that leaves a single
	// pane, auto-dissolve the whole group (promoting the last tab too).
	const closeFocusedPane = useCallback(() => {
		const sessionId = resolveActiveSessionId();
		if (!sessionId) return;
		// Closing a pane changes the leaf set, so drop any stale maximize/zoom that
		// might point at the pane being removed. Cheap and keeps the view consistent.
		useUIStore.getState().setZoomedPaneId(null);
		updateSessionWith(sessionId, (s) => {
			const group = activeGroupOf(s);
			if (!group || !group.focusedPaneId) return s;
			const focusedLeaf = findLeafById(group.layout, group.focusedPaneId);
			if (!focusedLeaf || focusedLeaf.kind !== 'leaf') return s;
			const removedRef = focusedLeaf.tab;

			// Pick the neighbor to receive focus BEFORE mutating the tree.
			const neighborId =
				findPaneInDirection(group, group.focusedPaneId, 'left') ??
				findPaneInDirection(group, group.focusedPaneId, 'right') ??
				findPaneInDirection(group, group.focusedPaneId, 'up') ??
				findPaneInDirection(group, group.focusedPaneId, 'down');

			const nextLayout = removeLeafByTabRef(group.layout, removedRef);

			// Group down to one (or zero) pane: dissolve it entirely and promote the
			// remaining tab(s). dissolveGroup handles unifiedTabOrder + activeGroupId.
			if (!nextLayout || countLeaves(nextLayout) <= 1) {
				return promoteRef(dissolveGroup(s, group.id), removedRef);
			}

			// Otherwise keep the group: swap in the pruned + rebalanced layout, move
			// focus to the chosen neighbor, and re-add the removed tab to the strip.
			const rebalanced = rebalanceLayout(nextLayout);
			const focusTarget =
				neighborId && findLeafById(rebalanced, neighborId) ? neighborId : firstLeafId(rebalanced);
			const withLayout = updateGroupInSession(s, group.id, (g) => ({ ...g, layout: rebalanced }));
			const promoted = promoteRef(withLayout, removedRef);
			// focusPaneInSession moves focusedPaneId to the neighbor and syncs activeTabId.
			return focusTarget ? focusPaneInSession(promoted, group.id, focusTarget) : promoted;
		});
	}, []);

	// Toggle maximize/zoom for the focused pane. Transient UI-store state, not the
	// Session. Toggling again (or when already zoomed) restores the full layout.
	const toggleZoom = useCallback(() => {
		const session = selectActiveSession(useSessionStore.getState());
		const group = activeGroupOf(session);
		if (!group || !group.focusedPaneId) return;
		const { zoomedPaneId, setZoomedPaneId } = useUIStore.getState();
		setZoomedPaneId(zoomedPaneId ? null : group.focusedPaneId);
	}, []);

	// Equal-split: reset every split node's sizes to equal fractions.
	const rebalance = useCallback(() => {
		const sessionId = resolveActiveSessionId();
		if (!sessionId) return;
		updateSessionWith(sessionId, (s) => {
			const group = activeGroupOf(s);
			if (!group) return s;
			return updateGroupInSession(s, group.id, (g) => ({
				...g,
				layout: rebalanceLayout(g.layout),
			}));
		});
	}, []);

	return useMemo(
		() => ({ focusPane, cyclePane, splitFocusedPane, closeFocusedPane, toggleZoom, rebalance }),
		[focusPane, cyclePane, splitFocusedPane, closeFocusedPane, toggleZoom, rebalance]
	);
}

/** Re-add a promoted tab ref to unifiedTabOrder if it isn't already present. */
function promoteRef(session: Session, ref: UnifiedTabRef): Session {
	const order = session.unifiedTabOrder ?? [];
	if (order.some((r) => r.type === ref.type && r.id === ref.id)) return session;
	return { ...session, unifiedTabOrder: [...order, ref] };
}

/** First leaf id in a layout (document order), or null for an empty tree. */
function firstLeafId(layout: PanelLayoutNode): string | null {
	if (layout.kind === 'leaf') return layout.id;
	for (const child of layout.children) {
		const id = firstLeafId(child);
		if (id) return id;
	}
	return null;
}

/**
 * Identify the leaf node that `splitLeaf` created for `newTab`. splitLeaf mints a
 * fresh leaf via createLeaf; we can't know its id up front, so find the leaf that
 * references `newTab` and wasn't in the pre-split tree. Returns null if not found
 * (should not happen after a successful split).
 */
function collectNewLeafFor(
	newLayout: PanelLayoutNode,
	oldLayout: PanelLayoutNode,
	newTab: UnifiedTabRef
): Extract<PanelLayoutNode, { kind: 'leaf' }> | null {
	const oldIds = new Set<string>();
	collectLeafIds(oldLayout, oldIds);
	let found: Extract<PanelLayoutNode, { kind: 'leaf' }> | null = null;
	const walk = (node: PanelLayoutNode) => {
		if (node.kind === 'leaf') {
			if (!oldIds.has(node.id) && node.tab.type === newTab.type && node.tab.id === newTab.id) {
				found = node;
			}
			return;
		}
		node.children.forEach(walk);
	};
	walk(newLayout);
	return found;
}

function collectLeafIds(layout: PanelLayoutNode, out: Set<string>): void {
	if (layout.kind === 'leaf') {
		out.add(layout.id);
		return;
	}
	layout.children.forEach((c) => collectLeafIds(c, out));
}
