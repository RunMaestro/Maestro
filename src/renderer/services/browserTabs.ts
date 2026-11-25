import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { activateBrowserTab, createBrowserTab } from '../hooks/tabs/internal/browserTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../utils/browserTabPersistence';
import { useUIStore } from '../stores/uiStore';
import { isWebDesktop } from '../utils/runtimeContext';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import type { BrowserTab, BrowserTabCreationOptions } from '../../shared/browserPage';

import { sanitizeJourneyUrl } from '../../shared/userJourney';
import { recordJourney } from './userJourney';

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

export function openBrowserTab(
	url: string,
	options: BrowserTabCreationOptions,
	focusAddress: boolean
): BrowserTab | Promise<BrowserTab | undefined> | undefined {
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
		return window.maestro.browserSession
			.createTab(activeSessionId, { ...options, url })
			.then((tab) => {
				updateSessionWith(activeSessionId, (session) => activateBrowserTab(session, tab));
				focus(tab.id);
				recordBrowserOpen(activeSessionId, tab, options.title);
				return tab;
			})
			.catch((error) => {
				notifyCenterFlash({
					color: 'red',
					message: 'Could not create host browser tab',
					detail: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			});
	}
	let created: BrowserTab | undefined;
	updateSessionWith(activeSessionId, (session) => {
		const tab = createBrowserTab(session.id, url, {
			title: options.title,
			ephemeral: options.ephemeral,
			isLoading: url !== DEFAULT_BROWSER_TAB_URL,
		});
		created = tab;
		return activateBrowserTab(session, tab);
	});
	if (created) {
		focus(created.id);
		recordBrowserOpen(activeSessionId, created, options.title);
	}
	return created;
}

/** Open a URL in a new active browser tab without requesting DOM focus. */
export function openBrowserTabAt(
	url: string,
	options?: { title?: string }
): BrowserTab | Promise<BrowserTab | undefined> | undefined {
	if (url) return openBrowserTab(url, { title: options?.title ?? url }, false);
}
