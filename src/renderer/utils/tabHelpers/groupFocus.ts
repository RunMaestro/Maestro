import type { Session, TabGroup, UnifiedTabRef, PanelLayoutNode } from '../../types';

/**
 * The AI tab id of the group's first AI pane in layout order, or null when the
 * group holds no AI pane at all. The fallback target for {@link groupFocusFields}
 * when the group's focused pane can't be resolved.
 */
function firstAiTabIdInGroup(group: TabGroup): string | null {
	let found: string | null = null;
	const walk = (node: PanelLayoutNode): void => {
		if (found) return;
		if (node.kind === 'leaf') {
			if (node.tab.type === 'ai') found = node.tab.id;
			return;
		}
		node.children.forEach(walk);
	};
	walk(group.layout);
	return found;
}

/**
 * The session patch that makes a tiled group the visible view.
 *
 * Setting `activeGroupId` alone is NOT enough. The shared AI input area renders
 * once below whichever content the panel shows and always targets
 * `session.activeTabId`, so a group activated without syncing that id leaves the
 * composer pointed at whatever standalone AI tab was last active - a tab the
 * group's panes do not include (group members are excluded from the tab strip).
 * The user then types into a visible tile and the message is delivered to an
 * invisible conversation.
 *
 * So: point `activeTabId` at the group's focused AI pane, clear the three
 * standalone ids that outrank the group in the render precedence, and force AI
 * mode.
 *
 * The two cases where the focused pane yields no AI tab differ:
 *   - Focused pane IS a non-AI tab (file/terminal/browser): leave `activeTabId`
 *     alone, mirroring `focusPaneInSession`. MainPanelContent hides the input
 *     entirely (`groupFocusedIsNonAi`), so there is nothing to target.
 *   - Focused pane is MISSING or stale (no `focusedPaneId`, or it names a leaf
 *     that no longer exists): fall back to the group's first AI pane. That check
 *     needs a resolvable leaf to conclude "non-AI", so it reports false here and
 *     the input DOES render - without the fallback it would render aimed at a tab
 *     outside the group, which is the same invisible-delivery bug.
 *
 * Every path that activates a group spreads this instead of hand-rolling the
 * literal: the group chip click, Cmd+1..9 navigation, and anything added later.
 *
 * @param group - The group being activated. Pass the group itself (not an id) so
 *                the caller has already proved it exists.
 */
export function groupFocusFields(group: TabGroup): Partial<Session> {
	const focusedRef = resolveFocusedPaneTabRef(group);
	// Resolvable non-AI pane: the input is hidden, so leave activeTabId untouched.
	const targetAiId =
		focusedRef?.type === 'ai' ? focusedRef.id : focusedRef ? null : firstAiTabIdInGroup(group);
	return {
		activeGroupId: group.id,
		...(targetAiId ? { activeTabId: targetAiId } : {}),
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		inputMode: 'ai',
	};
}

/**
 * Resolve a group's focused pane to its full tab ref (any kind), or null when the
 * group has no focused pane or the leaf can't be found. Walks the layout locally to
 * avoid a circular import with panelLayout (which imports from this module). Used by
 * the Cmd+W close path so it targets the visible tile, not a stale standalone active
 * id that may point elsewhere (e.g. a file-focused pane leaves activeTabId untouched).
 */
export function resolveFocusedPaneTabRef(group: TabGroup): UnifiedTabRef | null {
	if (!group.focusedPaneId) return null;
	let found: UnifiedTabRef | null = null;
	const walk = (node: PanelLayoutNode): void => {
		if (found) return;
		if (node.kind === 'leaf') {
			if (node.id === group.focusedPaneId) found = node.tab;
			return;
		}
		node.children.forEach(walk);
	};
	walk(group.layout);
	return found;
}

/**
 * Locate the tiled group and leaf-pane id that hold a given tab (of any kind),
 * or null when the tab isn't tiled into any group (i.e. it's a standalone tab).
 * Walks each group's layout locally to avoid a circular import with panelLayout
 * (which imports from this module). Used so selecting or opening a group-member
 * tab activates its group and focuses its pane instead of trying to render it
 * standalone - group members have no standalone chip and are excluded from
 * buildUnifiedTabs, so the standalone path leaves focus stuck on whatever was
 * already showing.
 */
export function findGroupPaneForTab(
	session: Session,
	type: UnifiedTabRef['type'],
	tabId: string
): { groupId: string; leafId: string } | null {
	const groups = session.tabGroups;
	if (!groups || groups.length === 0) return null;
	for (const group of groups) {
		let leafId: string | null = null;
		const walk = (node: PanelLayoutNode): void => {
			if (leafId) return;
			if (node.kind === 'leaf') {
				if (node.tab.type === type && node.tab.id === tabId) leafId = node.id;
				return;
			}
			node.children.forEach(walk);
		};
		walk(group.layout);
		if (leafId) return { groupId: group.id, leafId };
	}
	return null;
}

/**
 * AI-tab shortcut for {@link findGroupPaneForTab}. Kept as a named wrapper so the
 * AI-specific call sites read clearly.
 */
export function findGroupPaneForAiTab(
	session: Session,
	tabId: string
): { groupId: string; leafId: string } | null {
	return findGroupPaneForTab(session, 'ai', tabId);
}
