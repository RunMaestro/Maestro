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
 *
 * A routing hint (`maestro+https://...`, `system+https://...`, see
 * `src/shared/urlRoutingHint.ts`) overrides both the setting and the modifier
 * key for that one link. This function is the single place that decides.
 */

import type { BrowserTab } from '../types';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore, selectActiveSession } from '../stores/sessionStore';
import { generateId } from './ids';
import { getBrowserTabPartition } from './browserTabPersistence';
import { insertAfterActiveInUnifiedTabOrder } from './unifiedTabOrderUtils';
import { parseUrlRoutingHint } from '../../shared/urlRoutingHint';

/**
 * Open a URL, respecting the user's default browser setting.
 *
 * @param url        The URL to open (http, https, mailto, or a hinted http(s) URL)
 * @param options.ctrlKey  Whether Ctrl (or Meta on macOS for this purpose) was
 *                         held - inverts the default browser choice. Ignored
 *                         for a hinted URL.
 */
export function openUrl(url: string, options?: { ctrlKey?: boolean }): void {
	// A routing hint decides on its own, before anything else. An invalid hint
	// (`maestro+file:`, `system+ssh:`) opens nothing: falling through would hand
	// the whole string to shell.openExternal.
	const hinted = parseUrlRoutingHint(url);
	if (hinted.kind === 'invalid') return;
	if (hinted.kind === 'hinted') {
		if (hinted.hint === 'maestro') openInMaestroBrowser(hinted.url);
		else openInSystemBrowser(hinted.url);
		return;
	}

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
 * The URL an explicit destination (context menu, hint) should load: a valid
 * hint is stripped, an invalid one yields null so nothing opens.
 */
function explicitTarget(url: string): string | null {
	const parsed = parseUrlRoutingHint(url);
	return parsed.kind === 'invalid' ? null : parsed.url;
}

/**
 * Open a URL directly in the system browser, bypassing settings.
 */
export function openInSystemBrowser(url: string): void {
	const target = explicitTarget(url);
	if (target) window.maestro.shell.openExternal(target);
}

/**
 * Open a URL in a Maestro browser tab within the current active agent.
 */
export function openInMaestroBrowser(rawUrl: string): void {
	const url = explicitTarget(rawUrl);
	if (!url) return;
	const { setSessions } = useSessionStore.getState();
	const session = selectActiveSession(useSessionStore.getState());
	if (!session) {
		// No active session - fall back to system browser
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
				unifiedTabOrder: insertAfterActiveInUnifiedTabOrder(s, {
					type: 'browser',
					id: newBrowserTab.id,
				}),
			};
		})
	);
}
