/**
 * Centralized URL opening utility.
 *
 * Routes URLs to either the system browser or the Maestro built-in browser tab
 * based on the `useSystemBrowser` setting. Ctrl+click (or Meta+click on macOS)
 * inverts the behavior: if the default is Maestro, ctrl+click opens in system
 * browser, and vice versa.
 *
 * Only http/https URLs are eligible for the Maestro browser tab. mailto: and
 * other protocols always fall through to the system browser.
 */

import type { BrowserTab } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { generateId } from './ids';
import { getBrowserTabPartition } from './browserTabPersistence';
import { ensureInUnifiedTabOrder } from './tabHelpers';

/**
 * Open a URL, respecting the user's default browser setting.
 *
 * @param url        The URL to open (http, https, or mailto)
 * @param options.ctrlKey  Whether Ctrl (or Meta on macOS for this purpose) was
 *                         held — inverts the default browser choice
 */
export function openUrl(url: string, options?: { ctrlKey?: boolean }): void {
	// mailto: always goes to system browser
	if (/^mailto:/i.test(url)) {
		window.maestro.shell.openExternal(url);
		return;
	}

	// Only handle http/https for internal browser
	if (!/^https?:\/\//i.test(url)) {
		window.maestro.shell.openExternal(url);
		return;
	}

	const useSystemBrowser = useSettingsStore.getState().useSystemBrowser;
	const ctrlHeld = options?.ctrlKey ?? false;

	// XOR: if setting says system and ctrl is NOT held → system browser
	//       if setting says system and ctrl IS held → maestro browser
	//       if setting says maestro and ctrl is NOT held → maestro browser
	//       if setting says maestro and ctrl IS held → system browser
	const shouldUseSystemBrowser = useSystemBrowser !== ctrlHeld;

	if (shouldUseSystemBrowser) {
		window.maestro.shell.openExternal(url);
	} else {
		openInMaestroBrowser(url);
	}
}

/**
 * Open a URL directly in the system browser, bypassing settings.
 */
export function openInSystemBrowser(url: string): void {
	window.maestro.shell.openExternal(url);
}

/**
 * Open a URL in a Maestro browser tab within the current active agent.
 */
export function openInMaestroBrowser(url: string): void {
	const { setSessions } = useSessionStore.getState();
	const session = selectActiveSession(useSessionStore.getState());
	if (!session) {
		// No active session — fall back to system browser
		window.maestro.shell.openExternal(url);
		return;
	}

	const newBrowserTab: BrowserTab = {
		id: generateId(),
		url,
		title: url,
		createdAt: Date.now(),
		partition: getBrowserTabPartition(session.id),
		canGoBack: false,
		canGoForward: false,
		isLoading: true,
		favicon: null,
	};

	setSessions((prev) =>
		prev.map((s) => {
			if (s.id !== session.id) return s;
			return {
				...s,
				browserTabs: [...(s.browserTabs || []), newBrowserTab],
				activeFileTabId: null,
				activeBrowserTabId: newBrowserTab.id,
				activeTerminalTabId: null,
				inputMode: 'ai' as const,
				unifiedTabOrder: ensureInUnifiedTabOrder(
					s.unifiedTabOrder || [],
					'browser',
					newBrowserTab.id
				),
			};
		})
	);
}
