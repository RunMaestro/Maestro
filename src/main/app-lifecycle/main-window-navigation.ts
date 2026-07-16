import type { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { blocksSubframeNavigation } from '../../shared/plugins/panel-navigation';
import { parseConcertoHtmlUrl } from '../../shared/concerto-html';

const ALLOWED_APP_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);

export interface MainWindowNavigationOptions {
	isDevelopment: boolean;
	devServerUrl: string;
	rendererProductionUrl: string;
	/** Exact entry URL for this window (includes ?windowId= for secondary windows). */
	entryUrl: string;
}

/** Allow only valid local Concerto documents through the general subframe deny rule. */
export function blocksMainWindowSubframeNavigation(
	isMainFrame: boolean,
	targetUrl: string
): boolean {
	if (parseConcertoHtmlUrl(targetUrl)) return false;
	return blocksSubframeNavigation(isMainFrame, targetUrl);
}

/**
 * Deny popups, restrict top-level navigation to the app entry document, and
 * gate browser permission requests to the main app window only.
 */
export function attachMainWindowNavigationGuards(
	browserWindow: BrowserWindow,
	options: MainWindowNavigationOptions
): void {
	const { isDevelopment, devServerUrl, rendererProductionUrl, entryUrl } = options;

	// Subframe egress guard (backstop). File-preview srcDoc frames have no
	// business navigating anywhere. Concerto mockups are the one explicit
	// exception: their initial valid maestro-concerto document is allowed, then
	// the document CSP and this same guard block every external target. Plugin
	// panels are NOT subframes anymore - they are <webview>
	// guests with their own webContents, locked down separately in
	// attachPluginPanelGuestSecurity (did-attach-webview) - but this guard
	// stays as defense in depth for every iframe in the app window.
	browserWindow.webContents.on('will-frame-navigate', (event) => {
		if (!blocksMainWindowSubframeNavigation(event.isMainFrame, event.url)) return;
		event.preventDefault();
		logger.warn(`Blocked subframe navigation to: ${event.url}`, 'Window');
	});

	// Deny all popup/new-window requests - external links use IPC shell:openExternal
	browserWindow.webContents.setWindowOpenHandler(({ url }) => {
		logger.warn(`Blocked window.open request: ${url}`, 'Window');
		return { action: 'deny' };
	});

	// Restrict navigation to the app itself - prevent renderer from navigating away.
	// Both the dev-server URL and the renderer entry's file:// URL are constants
	// for the lifetime of this window, so compute them once at setup time rather
	// than on every navigation event. The production guard only allows the
	// renderer entry HTML itself: a previous "directory prefix" check let any
	// file inside the renderer dir through, which meant a stray <a href="foo.md">
	// in chat output could resolve relative to index.html and unload the app to
	// a non-existent bundle file.
	// The dev server serves the app at its root. A previous guard allowed the
	// ENTIRE dev origin through, which let any same-origin path (a game served
	// by the dev server, or a stray relative <a href="game/"> in chat/markdown
	// output) unload the app and take over the whole window. Page content
	// belongs in a <webview> browser tab, never the top-level frame, so the dev
	// guard is now as strict as production: only the app's own entry document
	// (origin AND pathname) may load top-level. HMR/full-reloads target the same
	// root URL and the renderer has no top-level URL routing, so this is safe.
	// `allowedProdEntryUrl` is THIS window's exact entry URL (which carries the
	// `?windowId=` query for secondary windows) so a programmatic reload to the
	// same URL is allowed while any other path is still rejected.
	const devEntryUrl = isDevelopment ? new URL(devServerUrl) : null;
	const allowedDevOrigin = devEntryUrl ? devEntryUrl.origin : null;
	const allowedDevPathname = devEntryUrl ? devEntryUrl.pathname || '/' : null;
	const allowedProdOrigin = isDevelopment ? null : new URL(rendererProductionUrl).origin;
	const allowedProdEntryUrl = isDevelopment ? null : entryUrl;
	browserWindow.webContents.on('will-navigate', (event, url) => {
		const parsedUrl = new URL(url);
		if (isDevelopment) {
			const pathname = parsedUrl.pathname || '/';
			if (parsedUrl.origin === allowedDevOrigin && pathname === allowedDevPathname) return;
		} else {
			if (parsedUrl.origin === allowedProdOrigin && url === allowedProdEntryUrl) return;
		}
		event.preventDefault();
		logger.warn(`Blocked navigation to: ${url}`, 'Window');
	});

	// Deny most browser permission requests (camera, mic, geolocation, etc.)
	// Allow clipboard access for the app window only, never embedded browser tabs.
	browserWindow.webContents.session.setPermissionRequestHandler(
		(webContents, permission, callback) => {
			const contentsType = webContents?.getType?.();
			const isAppWindow = contentsType === 'window';

			if (isAppWindow && ALLOWED_APP_PERMISSIONS.has(permission)) {
				callback(true);
			} else {
				if (contentsType === 'webview') {
					logger.warn(`Blocked browser-tab permission request: ${permission}`, 'Window', {
						permission,
						type: contentsType,
					});
				}
				callback(false);
			}
		}
	);
}
