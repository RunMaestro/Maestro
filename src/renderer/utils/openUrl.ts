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

import type { BrowserTab } from '../../shared/browserPage';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore, selectActiveSession, updateSessionWith } from '../stores/sessionStore';
import { activateBrowserTab, createBrowserTab } from '../hooks/tabs/internal/browserTabHelpers';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { isWebDesktop } from './runtimeContext';
import { isHostLocalPreviewUrl } from '../../shared/hostLocalPreview';

/**
 * Open a URL, respecting the user's default browser setting.
 *
 * @param url        The URL to open (http, https, or mailto)
 * @param options.ctrlKey  Whether Ctrl (or Meta on macOS for this purpose) was
 *                         held - inverts the default browser choice
 */
export function openUrl(url: string, options?: { ctrlKey?: boolean }): void {
	// Never send a host localhost URL to a browser executing on the client.
	if (isWebDesktop() && isHostLocalPreviewUrl(url)) {
		openInMaestroBrowser(url);
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
 * Open a URL directly in the system browser, bypassing settings.
 */
export function openInSystemBrowser(url: string): void {
	if (isWebDesktop() && isHostLocalPreviewUrl(url)) {
		openInMaestroBrowser(url);
		return;
	}
	window.maestro.shell.openExternal(url);
}

/**
 * Open a URL in a Maestro browser tab within the current active agent.
 */
export function openInMaestroBrowser(url: string): void {
	const session = selectActiveSession(useSessionStore.getState());
	if (!session) {
		if (isWebDesktop() && isHostLocalPreviewUrl(url)) {
			notifyCenterFlash({ color: 'red', message: 'Select an agent to open a host preview' });
			return;
		}
		// No active session - fall back to system browser
		window.maestro.shell.openExternal(url);
		return;
	}

	const activate = (tab: BrowserTab) =>
		updateSessionWith(session.id, (current) => activateBrowserTab(current, tab));
	if (isWebDesktop()) {
		void window.maestro.browserSession
			.createTab(session.id, { url, title: url })
			.then(activate)
			.catch((error) =>
				notifyCenterFlash({
					color: 'red',
					message: 'Could not create host browser tab',
					detail: error instanceof Error ? error.message : String(error),
				})
			);
		return;
	}
	activate(createBrowserTab(session.id, url, { title: url }));
}
