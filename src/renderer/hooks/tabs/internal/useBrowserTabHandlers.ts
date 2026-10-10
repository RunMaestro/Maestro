import { useCallback } from 'react';
import { updateBrowserTab, updateSessionWith, useSessionStore } from '../../../stores/sessionStore';
import type { BrowserTab } from '../../../types';
import {
	closeBrowserTab as closeBrowserTabHelper,
	ensureInUnifiedTabOrder,
} from '../../../utils/tabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../utils/browserTabPersistence';
import { insertAfterActiveInUnifiedTabOrder } from '../../../utils/unifiedTabOrderUtils';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import { createBrowserTab, normalizeBrowserTabUpdates } from './browserTabHelpers';
import type { BrowserTabHandlersReturn } from './types';

export function useBrowserTabHandlers(): BrowserTabHandlersReturn {
	const handleNewBrowserTab = useCallback((options?: { ephemeral?: boolean }) => {
		const { activeSessionId } = useSessionStore.getState();
		const homeUrl = useSettingsStore.getState().browserHomeUrl || DEFAULT_BROWSER_TAB_URL;
		// Captured inside the updater so focus is only requested for a tab that was
		// actually created.
		let createdTabId: string | null = null;
		updateSessionWith(activeSessionId, (s) => {
			const newBrowserTab = createBrowserTab(s.id, homeUrl, {
				title: homeUrl === DEFAULT_BROWSER_TAB_URL ? undefined : homeUrl,
				isLoading: homeUrl !== DEFAULT_BROWSER_TAB_URL,
				ephemeral: options?.ephemeral,
			});
			createdTabId = newBrowserTab.id;

			return {
				...s,
				browserTabs: [...(s.browserTabs || []), newBrowserTab],
				activeFileTabId: null,
				activeBrowserTabId: newBrowserTab.id,
				activeTerminalTabId: null,
				inputMode: 'ai',
				// A newly-created standalone browser tab takes over the panel, so it
				// must leave any active tiled group (mirrors handleSelectBrowserTab).
				activeGroupId: null,
				unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
					type: 'browser',
					id: newBrowserTab.id,
				}),
			};
		});
		// A new browser tab is opened to go somewhere, so put the caret in the address
		// bar (selected) rather than leaving it wherever it was. The request retries
		// until the keep-alive overlay that owns the input has mounted.
		if (createdTabId) {
			useUIStore.getState().requestTabFocus({ type: 'browser', id: createdTabId });
		}
	}, []);

	const handleOpenBrowserTabAt = useCallback((url: string, options?: { title?: string }) => {
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
	}, []);

	const handleSelectBrowserTab = useCallback((tabId: string) => {
		const { activeSessionId } = useSessionStore.getState();
		updateSessionWith(activeSessionId, (s) => {
			if (!(s.browserTabs || []).some((tab) => tab.id === tabId)) return s;
			return {
				...s,
				activeFileTabId: null,
				activeBrowserTabId: tabId,
				activeTerminalTabId: null,
				inputMode: 'ai',
				unifiedTabOrder: ensureInUnifiedTabOrder(s.unifiedTabOrder || [], 'browser', tabId),
				// Selecting a standalone browser tab leaves any active tiled group.
				activeGroupId: null,
			};
		});
	}, []);

	const forceCloseBrowserTab = useCallback((tabId: string) => {
		const { activeSessionId } = useSessionStore.getState();
		updateSessionWith(activeSessionId, (s) => {
			const result = closeBrowserTabHelper(s, tabId);
			return result ? result.session : s;
		});
	}, []);

	const handleCloseBrowserTab = useCallback(
		(tabId: string) => {
			forceCloseBrowserTab(tabId);
		},
		[forceCloseBrowserTab]
	);

	const handleUpdateBrowserTab = useCallback(
		(sessionId: string, tabId: string, updates: Partial<BrowserTab>) => {
			updateBrowserTab(sessionId, tabId, (tab) => normalizeBrowserTabUpdates(tab, updates));
		},
		[]
	);

	return {
		handleNewBrowserTab,
		handleOpenBrowserTabAt,
		handleSelectBrowserTab,
		handleCloseBrowserTab,
		handleUpdateBrowserTab,
	};
}
