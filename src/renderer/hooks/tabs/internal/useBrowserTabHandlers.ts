import { useCallback } from 'react';
import { updateBrowserTab, updateSessionWith, useSessionStore } from '../../../stores/sessionStore';

import {
	closeBrowserTab as closeBrowserTabHelper,
	ensureInUnifiedTabOrder,
} from '../../../utils/tabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../../../utils/browserTabPersistence';

import { useSettingsStore } from '../../../stores/settingsStore';
import { useUIStore } from '../../../stores/uiStore';
import type { BrowserTabHandlersReturn } from './types';
import {
	activateBrowserTab,
	createBrowserTab,
	normalizeBrowserTabUpdates,
} from './browserTabHelpers';
import { isWebDesktop } from '../../../utils/runtimeContext';
import { notifyCenterFlash } from '../../../stores/centerFlashStore';
import type { BrowserTab, BrowserTabCreationOptions } from '../../../../shared/browserPage';

export function useBrowserTabHandlers(): BrowserTabHandlersReturn {
	const openBrowserTab = useCallback(
		(url: string, options: BrowserTabCreationOptions, focusAddress: boolean) => {
			const { activeSessionId } = useSessionStore.getState();
			if (
				!activeSessionId ||
				!useSessionStore.getState().sessions.some((session) => session.id === activeSessionId)
			)
				return;
			const focus = (id: string) => {
				if (focusAddress && useSessionStore.getState().activeSessionId === activeSessionId)
					useUIStore.getState().requestTabFocus({ type: 'browser', id });
			};
			if (isWebDesktop()) {
				void window.maestro.browserSession
					.createTab(activeSessionId, { ...options, url })
					.then((tab) => {
						updateSessionWith(activeSessionId, (session) => activateBrowserTab(session, tab));
						focus(tab.id);
					})
					.catch((error) =>
						notifyCenterFlash({
							color: 'red',
							message: 'Could not create host browser tab',
							detail: error instanceof Error ? error.message : String(error),
						})
					);
				return;
			}
			let id: string | null = null;
			updateSessionWith(activeSessionId, (session) => {
				const tab = createBrowserTab(session.id, url, {
					title: options.title,
					ephemeral: options.ephemeral,
					isLoading: url !== DEFAULT_BROWSER_TAB_URL,
				});
				id = tab.id;
				return activateBrowserTab(session, tab);
			});
			if (id) focus(id);
		},
		[]
	);
	const handleNewBrowserTab = useCallback(
		(options?: { ephemeral?: boolean }) => {
			const homeUrl = useSettingsStore.getState().browserHomeUrl || DEFAULT_BROWSER_TAB_URL;
			openBrowserTab(
				homeUrl,
				{
					title: homeUrl === DEFAULT_BROWSER_TAB_URL ? undefined : homeUrl,
					ephemeral: options?.ephemeral,
				},
				true
			);
		},
		[openBrowserTab]
	);
	const handleOpenBrowserTabAt = useCallback(
		(url: string, options?: { title?: string }) => {
			if (url) openBrowserTab(url, { title: options?.title ?? url }, false);
		},
		[openBrowserTab]
	);

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
