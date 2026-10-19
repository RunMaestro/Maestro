/**
 * useTabWindowViewState - tell the owner how the user is looking at the AI tab
 * this tab window shows (Tab Windows, the `setViewState` intent).
 *
 * Two things in the owner depend on it. Its unread rule: a popped tab is never
 * the owner's active tab (D4), so without this every chunk the agent streams
 * would mark the tab unread while the user watches it here. And the dock: the
 * tab's scroll position comes back with it, so the owner shows it where the
 * user left off.
 *
 * "Viewed" means shown here while this window is visible; the owner counts the
 * tab as watched when it is also scrolled to the bottom, as its own rule does
 * for its active tab. The report waits for the scroll to settle, and a tab
 * that stops being shown (another tab is selected, or the window closes) is
 * reported as not viewed at once.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { sendTabWindowIntent } from '../../services/tabWindowIntentSender';
import { useEventListener } from '../../hooks/utils/useEventListener';

/** How long the scroll position must hold still before it is reported. */
export const TAB_WINDOW_VIEW_STATE_DELAY_MS = 300;

function isDocumentVisible(): boolean {
	return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** The view fields of one AI tab in this window's copy of the agent. */
function readTabView(agentId: string, tabId: string): { scrollTop: number; isAtBottom: boolean } {
	const tab = useSessionStore
		.getState()
		.sessions.find((s) => s.id === agentId)
		?.aiTabs.find((t) => t.id === tabId);
	return { scrollTop: tab?.scrollTop ?? 0, isAtBottom: tab?.isAtBottom !== false };
}

/**
 * Report the shown AI tab's view to the owner. Pass a null tab while the
 * window shows a tab of another kind.
 */
export function useTabWindowViewState(agentId: string, aiTabId: string | null): void {
	const scrollTop = useSessionStore((s) =>
		aiTabId
			? (s.sessions.find((x) => x.id === agentId)?.aiTabs.find((t) => t.id === aiTabId)
					?.scrollTop ?? 0)
			: 0
	);
	const isAtBottom = useSessionStore((s) =>
		aiTabId
			? s.sessions.find((x) => x.id === agentId)?.aiTabs.find((t) => t.id === aiTabId)
					?.isAtBottom !== false
			: true
	);
	const [visible, setVisible] = useState(isDocumentVisible);
	useEventListener('visibilitychange', () => setVisible(isDocumentVisible()), {
		target: document,
	});

	const report = useCallback(
		(tabId: string, view: { scrollTop: number; isAtBottom: boolean; viewed: boolean }) => {
			sendTabWindowIntent({
				kind: 'setViewState',
				agentId,
				tabRef: { type: 'ai', id: tabId },
				...view,
			});
		},
		[agentId]
	);

	// The shown tab, once the scroll settles (and at once on a visibility change,
	// which restarts the wait with the new value).
	useEffect(() => {
		if (!aiTabId) return;
		const timer = setTimeout(
			() => report(aiTabId, { scrollTop, isAtBottom, viewed: visible }),
			TAB_WINDOW_VIEW_STATE_DELAY_MS
		);
		return () => clearTimeout(timer);
	}, [aiTabId, scrollTop, isAtBottom, visible, report]);

	// A tab that stops being shown is no longer watched.
	useEffect(() => {
		if (!aiTabId) return;
		return () => report(aiTabId, { ...readTabView(agentId, aiTabId), viewed: false });
	}, [agentId, aiTabId, report]);
}
