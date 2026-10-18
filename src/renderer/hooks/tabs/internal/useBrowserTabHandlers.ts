import { useCallback } from 'react';
import { openBrowserTab, openBrowserTabAt } from '../../../services/browserTabs';
import { updateBrowserTab, updateSessionWith, useSessionStore } from '../../../stores/sessionStore';

import {
	closeBrowserTab as closeBrowserTabHelper,
	ensureInUnifiedTabOrder,
} from '../../../utils/tabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../utils/browserTabPersistence';

import { useSettingsStore } from '../../../stores/settingsStore';
import type { BrowserTabHandlersReturn } from './types';
import { normalizeBrowserTabUpdates } from './browserTabHelpers';
import type { BrowserTab } from '../../../../shared/browserPage';

export function useBrowserTabHandlers(): BrowserTabHandlersReturn {
	const handleNewBrowserTab = useCallback((options?: { ephemeral?: boolean }) => {
		const homeUrl = useSettingsStore.getState().browserHomeUrl || DEFAULT_BROWSER_TAB_URL;
		openBrowserTab(
			homeUrl,
			{
				title: homeUrl === DEFAULT_BROWSER_TAB_URL ? undefined : homeUrl,
				ephemeral: options?.ephemeral,
			},
			true
		);
	}, []);
	const handleOpenBrowserTabAt = useCallback(openBrowserTabAt, []);

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
