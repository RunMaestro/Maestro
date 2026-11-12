import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../types';
import { useSettingsStore } from '../../stores/settingsStore';
import {
	useCoworkingBrowserKeepAliveStore,
	activePinnedTabIds,
} from '../../stores/coworkingBrowserKeepAliveStore';

/**
 * Decides which of the active agent's browser tabs stay mounted.
 *
 * Each in-app browser tab is an Electron <webview>; unmounting it destroys the
 * guest webContents, so the page cold-reloads (and loses all in-memory JS state)
 * when the tab is shown again. To preserve background-tab state we keep extra
 * webviews mounted but hidden, mirroring the terminal keep-alive overlay pattern
 * in MainPanelContent.
 *
 * Policy comes from the `browserTabKeepAlive` setting:
 *  - 'off'    - only the active browser tab is mounted (lowest memory; page
 *               reloads on return). This reproduces the original behavior.
 *  - 'recent' - keep the N most-recently-active browser tabs mounted (LRU),
 *               where N is `browserTabKeepAliveLimit`.
 *  - 'all'    - keep every browser tab in the active agent mounted.
 *
 * Scope is the ACTIVE agent only. Switching agents unmounts the previous
 * agent's browser tabs; cross-agent keep-alive would grow memory unbounded and
 * is intentionally out of scope.
 *
 * @returns Ordered list of browser tab ids to mount (stable in live-tab order so
 *   React never reorders the underlying webview DOM nodes).
 */
export function useBrowserTabMounting(activeSession: Session | null): string[] {
	const keepAlive = useSettingsStore((s) => s.browserTabKeepAlive);
	const keepAliveLimit = useSettingsStore((s) => s.browserTabKeepAliveLimit);
	// Browser tabs a coworking agent is actively driving (TTL pins) must stay
	// mounted even when backgrounded, so the agent can keep interacting after the
	// user clicks away. Subscribing re-renders when a pin is added or lapses.
	const pins = useCoworkingBrowserKeepAliveStore((s) => s.pins);

	const sessionId = activeSession?.id ?? null;
	const activeBrowserTabId = activeSession?.activeBrowserTabId ?? null;
	// Stable key over the live browser tab ids (order-preserving) so memoization
	// doesn't churn when the session object is recreated without tab changes.
	const liveIdsKey = activeSession?.browserTabs?.map((t) => t.id).join(',') ?? '';

	// Browser tabs tiled into the active group MUST stay mounted regardless of the
	// keep-alive policy: while a group is active, `activeBrowserTabId` points at no
	// standalone tab, so the 'off'/'recent' policies would otherwise never mount a
	// tiled browser pane - its <webview> would be absent, leaving the pane blank.
	// Comma-joined key (memo-friendly, mirrors liveIdsKey).
	const groupBrowserLeafKey = useMemo(() => {
		const activeGroup =
			activeSession?.activeGroupId != null
				? activeSession.tabGroups?.find((g) => g.id === activeSession.activeGroupId)
				: undefined;
		if (!activeGroup) return '';
		const ids: string[] = [];
		const walk = (node: (typeof activeGroup)['layout']): void => {
			if (node.kind === 'leaf') {
				if (node.tab.type === 'browser') ids.push(node.tab.id);
				return;
			}
			node.children.forEach(walk);
		};
		walk(activeGroup.layout);
		return ids.join(',');
	}, [activeSession?.activeGroupId, activeSession?.tabGroups]);

	// Recency-ordered browser tab ids (most-recent first) for the CURRENT agent
	// only. Reset whenever the active agent changes so we never keep another
	// agent's tabs alive.
	const [recency, setRecency] = useState<{ sessionId: string | null; order: string[] }>({
		sessionId: null,
		order: [],
	});

	useEffect(() => {
		setRecency((prev) => {
			if (prev.sessionId !== sessionId) {
				return { sessionId, order: activeBrowserTabId ? [activeBrowserTabId] : [] };
			}
			if (activeBrowserTabId && prev.order[0] !== activeBrowserTabId) {
				return {
					sessionId,
					order: [activeBrowserTabId, ...prev.order.filter((id) => id !== activeBrowserTabId)],
				};
			}
			return prev;
		});
	}, [sessionId, activeBrowserTabId]);

	return useMemo(() => {
		const liveIds = liveIdsKey ? liveIdsKey.split(',') : [];
		if (liveIds.length === 0) return [];
		const liveSet = new Set(liveIds);
		// Group browser leaves are always kept (see groupBrowserLeafKey), intersected
		// with live ids so a stale ref never mounts a nonexistent tab.
		const groupLeaves = new Set(
			(groupBrowserLeafKey ? groupBrowserLeafKey.split(',') : []).filter((id) => liveSet.has(id))
		);

		// Tabs to keep mounted. Always includes the active tab and any tab a
		// coworking agent has recently driven (TTL pin), so a backgrounded
		// agent-driven tab stays live/interactive regardless of the keepAlive mode.
		const keep = new Set<string>();
		if (activeBrowserTabId && liveSet.has(activeBrowserTabId)) keep.add(activeBrowserTabId);
		for (const id of activePinnedTabIds(pins)) {
			if (liveSet.has(id)) keep.add(id);
		}

		if (keepAlive === 'all') {
			for (const id of liveIds) keep.add(id);
		} else if (keepAlive === 'recent') {
			const cap = Math.max(1, Math.floor(keepAliveLimit) || 1);
			const ordered = recency.order.filter((id) => liveSet.has(id));
			// The active tab must always be mounted even if recency hasn't caught up.
			const withActive =
				activeBrowserTabId &&
				liveSet.has(activeBrowserTabId) &&
				!ordered.includes(activeBrowserTabId)
					? [activeBrowserTabId, ...ordered]
					: ordered;
			for (const id of withActive.slice(0, cap)) keep.add(id);
		}
		// 'off': only the active tab (plus any pins), already added above.

		// Tiled group browser panes are always mounted in ADDITION to the keep-alive
		// policy above so a group with more browser panes than the limit still renders
		// every pane.
		groupLeaves.forEach((id) => keep.add(id));
		if (keep.size === 0) return [];
		// Emit in live-tab order so the rendered webview nodes never reorder.
		return liveIds.filter((id) => keep.has(id));
	}, [
		liveIdsKey,
		keepAlive,
		keepAliveLimit,
		activeBrowserTabId,
		recency,
		pins,
		groupBrowserLeafKey,
	]);
}
