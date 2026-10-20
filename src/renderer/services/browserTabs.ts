import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { activateBrowserTab, createBrowserTab } from '../hooks/tabs/internal/browserTabHelpers';
import { DEFAULT_BROWSER_TAB_URL } from '../utils/browserTabPersistence';
import { useUIStore } from '../stores/uiStore';
import { isWebDesktop } from '../utils/runtimeContext';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import type { BrowserTab, BrowserTabCreationOptions } from '../../shared/browserPage';

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
	if (created) focus(created.id);
	return created;
}

/** Open a URL in a new active browser tab without requesting DOM focus. */
export function openBrowserTabAt(
	url: string,
	options?: { title?: string }
): BrowserTab | Promise<BrowserTab | undefined> | undefined {
	if (url) return openBrowserTab(url, { title: options?.title ?? url }, false);
}
