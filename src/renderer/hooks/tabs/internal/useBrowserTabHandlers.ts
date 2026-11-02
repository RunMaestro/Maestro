import { useCallback } from 'react';
import {
	selectActiveSession,
	updateBrowserTab,
	updateSessionWith,
	useSessionStore,
} from '../../../stores/sessionStore';

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
import { sanitizeJourneyUrl } from '../../../../shared/userJourney';
import { recordJourney } from '../../../services/userJourney';

/**
 * Record that the user opened a browser tab. A private (ephemeral) tab and an
 * empty one (`about:blank`, which says nothing until it navigates) leave no
 * journey; a title that only repeats the URL is dropped by the store.
 */
function recordBrowserOpen(
	agentId: string,
	tab: Pick<BrowserTab, 'id' | 'url' | 'ephemeral'>,
	title?: string
) {
	if (tab.ephemeral || tab.url === DEFAULT_BROWSER_TAB_URL) return;
	recordJourney(agentId, {
		kind: 'browser.open',
		target: sanitizeJourneyUrl(tab.url),
		tabId: tab.id,
		...(title && title !== tab.url ? { title } : {}),
	});
}

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
						recordBrowserOpen(activeSessionId, tab, options.title);
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
			if (id) {
				focus(id);
				recordBrowserOpen(
					activeSessionId,
					{ id, url, ephemeral: options.ephemeral },
					options.title
				);
			}
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
			const session = selectActiveSession(useSessionStore.getState());
			const closingTab = session?.browserTabs?.find((tab) => tab.id === tabId);
			forceCloseBrowserTab(tabId);
			// `closingTab` was found in the active session, so the helper just closed it.
			if (session && closingTab && !closingTab.ephemeral) {
				recordJourney(session.id, {
					kind: 'browser.close',
					target: sanitizeJourneyUrl(closingTab.url),
					tabId,
					dwellMs: Math.max(0, Date.now() - closingTab.createdAt),
				});
			}
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
