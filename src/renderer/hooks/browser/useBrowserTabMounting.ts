import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../types';
import { useSettingsStore } from '../../stores/settingsStore';

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
 *  - 'off'    — only the active browser tab is mounted (lowest memory; page
 *               reloads on return). This reproduces the original behavior.
 *  - 'recent' — keep the N most-recently-active browser tabs mounted (LRU),
 *               where N is `browserTabKeepAliveLimit`.
 *  - 'all'    — keep every browser tab in the active agent mounted.
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

	const sessionId = activeSession?.id ?? null;
	const activeBrowserTabId = activeSession?.activeBrowserTabId ?? null;
	// Stable key over the live browser tab ids (order-preserving) so memoization
	// doesn't churn when the session object is recreated without tab changes.
	const liveIdsKey = activeSession?.browserTabs?.map((t) => t.id).join(',') ?? '';

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

		if (keepAlive === 'all') {
			return liveIds;
		}

		if (keepAlive === 'recent') {
			const cap = Math.max(1, Math.floor(keepAliveLimit) || 1);
			const ordered = recency.order.filter((id) => liveSet.has(id));
			// The active tab must always be mounted even if recency hasn't caught up.
			const withActive =
				activeBrowserTabId &&
				liveSet.has(activeBrowserTabId) &&
				!ordered.includes(activeBrowserTabId)
					? [activeBrowserTabId, ...ordered]
					: ordered;
			const kept = new Set(withActive.slice(0, cap));
			// Emit in live-tab order so the rendered webview nodes never reorder.
			return liveIds.filter((id) => kept.has(id));
		}

		// 'off' — only the active browser tab is mounted (original behavior).
		return activeBrowserTabId && liveSet.has(activeBrowserTabId) ? [activeBrowserTabId] : [];
	}, [liveIdsKey, keepAlive, keepAliveLimit, activeBrowserTabId, recency]);
}
