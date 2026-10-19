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

import type { BrowserTab } from '../../shared/browserPage';
import { useSettingsStore } from '../stores/settingsStore';
import { useSessionStore, selectActiveSession, updateSessionWith } from '../stores/sessionStore';
import { activateBrowserTab, createBrowserTab } from '../hooks/tabs/internal/browserTabHelpers';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { isWebDesktop } from './runtimeContext';
import { isHostLocalPreviewUrl } from '../../shared/hostLocalPreview';
import { parseUrlRoutingHint } from '../../shared/urlRoutingHint';
import { sendShownTabIntent } from '../services/tabWindowIntentSender';

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
	if (!target) return;
	if (isWebDesktop() && isHostLocalPreviewUrl(target)) {
		openInMaestroBrowser(target);
		return;
	}
	window.maestro.shell.openExternal(target);
}

/**
 * Open a URL in a Maestro browser tab within the current active agent.
 */
export function openInMaestroBrowser(rawUrl: string): void {
	const url = explicitTarget(rawUrl);
	if (!url) return;
	// A browser tab is the agent's, and only its owner window writes the agent
	// (Tab Windows, D1): the owner opens it and raises itself.
	if (sendShownTabIntent('openUrlInMaestro', { url })) return;
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
