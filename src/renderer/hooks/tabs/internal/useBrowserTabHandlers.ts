import { useCallback } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import type { BrowserTab, Session } from '../../../types';
import {
	closeBrowserTab as closeBrowserTabHelper,
	ensureInUnifiedTabOrder,
} from '../../../utils/tabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../utils/browserTabPersistence';
import { insertAfterActiveInUnifiedTabOrder } from '../../../utils/unifiedTabOrderUtils';
import { useSettingsStore } from '../../../stores/settingsStore';
import { createBrowserTab, normalizeBrowserTabUpdates } from './browserTabHelpers';
import type { BrowserTabHandlersReturn } from './types';

export function useBrowserTabHandlers(): BrowserTabHandlersReturn {
	const handleNewBrowserTab = useCallback(() => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		const homeUrl = useSettingsStore.getState().browserHomeUrl || DEFAULT_BROWSER_TAB_URL;
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

				const newBrowserTab = createBrowserTab(s.id, homeUrl, {
					title: homeUrl === DEFAULT_BROWSER_TAB_URL ? undefined : homeUrl,
					isLoading: homeUrl !== DEFAULT_BROWSER_TAB_URL,
				});

				return {
					...s,
					browserTabs: [...(s.browserTabs || []), newBrowserTab],
					activeFileTabId: null,
					activeBrowserTabId: newBrowserTab.id,
					activeTerminalTabId: null,
					inputMode: 'ai',
					unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
						type: 'browser',
						id: newBrowserTab.id,
					}),
				};
			})
		);
	}, []);

	const handleOpenBrowserTabAt = useCallback((url: string, options?: { title?: string }) => {
		if (!url) return;
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;

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
					unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
						type: 'browser',
						id: newBrowserTab.id,
					}),
				};
			})
		);
	}, []);

	const handleSelectBrowserTab = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
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
			})
		);
	}, []);

	const forceCloseBrowserTab = useCallback((tabId: string) => {
		const { setSessions, activeSessionId } = useSessionStore.getState();
		setSessions((prev: Session[]) =>
			prev.map((s) => {
				if (s.id !== activeSessionId) return s;
				const result = closeBrowserTabHelper(s, tabId);
				return result ? result.session : s;
			})
		);
	}, []);

	const handleCloseBrowserTab = useCallback(
		(tabId: string) => {
			forceCloseBrowserTab(tabId);
		},
		[forceCloseBrowserTab]
	);

	const handleUpdateBrowserTab = useCallback(
		(sessionId: string, tabId: string, updates: Partial<BrowserTab>) => {
			const { setSessions } = useSessionStore.getState();
			setSessions((prev: Session[]) =>
				prev.map((s) => {
					if (s.id !== sessionId) return s;
					return {
						...s,
						browserTabs: (s.browserTabs || []).map((tab) =>
							tab.id === tabId ? normalizeBrowserTabUpdates(tab, updates) : tab
						),
					};
				})
			);
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
