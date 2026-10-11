import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { createBrowserTab } from '../hooks/tabs/internal/browserTabHelpers';
import { insertAfterActiveInUnifiedTabOrder } from '../utils/unifiedTabOrderUtils';

/** Open a URL in a new active browser tab without requesting DOM focus. */
export function openBrowserTabAt(url: string, options?: { title?: string }): void {
	if (!url) return;
	const { activeSessionId } = useSessionStore.getState();
	updateSessionWith(activeSessionId, (s) => {
		const newBrowserTab = createBrowserTab(s.id, url, {
			title: options?.title ?? url,
			isLoading: true,
		});

		return {
			...s,
			browserTabs: [...(s.browserTabs || []), newBrowserTab],
			activeFileTabId: null,
			activeBrowserTabId: newBrowserTab.id,
			activeTerminalTabId: null,
			inputMode: 'ai',
			// A programmatically-opened standalone browser tab takes over the
			// panel, so it must leave any active tiled group.
			activeGroupId: null,
			unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
				type: 'browser',
				id: newBrowserTab.id,
			}),
		};
	});
}
