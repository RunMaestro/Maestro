import { BrowserWindow, shell } from 'electron';
import { logger } from '../utils/logger';
import { dispatchDeepLink, parseDeepLink } from '../deep-links';
import { blocksSubframeNavigation } from '../../shared/plugins/panel-navigation';
import { parseConcertoHtmlUrl } from '../../shared/concerto-html';

// 'local-fonts' backs the font pickers in Settings -> Display. Granted to the
// app window only (never an embedded browser tab, where enumerating installed
// fonts is a fingerprinting vector): reading the list of installed families is
// the whole mechanism by which the picker can say a font exists, and the
// previous fc-list probe silently failed on stock macOS and Windows.
const ALLOWED_APP_PERMISSIONS = new Set([
	'clipboard-read',
	'clipboard-sanitized-write',
	'local-fonts',
]);

// Link schemes a main-window subframe (the HTML file preview) may hand off.
// The frame never navigates: the guards below cancel the navigation and route
// the URL. `maestro:` goes to the in-app deep-link handler, never the OS (in
// dev the OS would bounce it to the installed production app). http(s) is
// deliberately absent: opening a URL the previewed page built is the
// exfiltration path the subframe egress guard exists to stop.
const SUBFRAME_EXTERNAL_PROTOCOLS = new Set(['obsidian:', 'mailto:']);
// A script in the previewed page can fire these in a loop with no click;
// one hand-off per second stops it from flooding the user with apps.
const SUBFRAME_LINK_MIN_INTERVAL_MS = 1000;

export type SubframeLinkRoute = 'deep-link' | 'external';

/** How a link out of a main-window subframe is handed off, or null to block it. */
export function subframeLinkRoute(url: string | undefined): SubframeLinkRoute | null {
	if (!url) return null;
	let protocol: string;
	try {
		protocol = new URL(url).protocol;
	} catch {
		return null;
	}
	if (protocol === 'maestro:') return 'deep-link';
	return SUBFRAME_EXTERNAL_PROTOCOLS.has(protocol) ? 'external' : null;
}

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
	const isConcertoHtmlDocument = parseConcertoHtmlUrl(targetUrl);
	if (!isMainFrame && isConcertoHtmlDocument) return false;
	if (isMainFrame && isConcertoHtmlDocument) return true;
	return blocksSubframeNavigation(isMainFrame, targetUrl);
}

// Keyed by window so one window's links never throttle another's.
const lastSubframeLinkAt = new WeakMap<BrowserWindow, number>();

/** Hand an allowed subframe link off on behalf of the window that holds the frame. */
function routeSubframeLink(
	browserWindow: BrowserWindow,
	url: string,
	route: SubframeLinkRoute
): void {
	const now = Date.now();
	if (now - (lastSubframeLinkAt.get(browserWindow) ?? 0) < SUBFRAME_LINK_MIN_INTERVAL_MS) {
		logger.warn(`Throttled subframe link: ${url}`, 'Window');
		return;
	}
	lastSubframeLinkAt.set(browserWindow, now);
	if (route === 'deep-link') {
		const parsed = parseDeepLink(url);
		if (parsed) dispatchDeepLink(parsed, () => browserWindow);
		return;
	}
	shell.openExternal(url).catch((err: unknown) => {
		logger.warn(`Could not open subframe link: ${url}`, 'Window', { error: String(err) });
	});
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
	// Allowed link schemes are routed instead of dropped (issue #1773).
	browserWindow.webContents.on('will-frame-navigate', (event) => {
		const linkRoute = event.isMainFrame ? null : subframeLinkRoute(event.url);
		if (linkRoute) {
			event.preventDefault();
			routeSubframeLink(browserWindow, event.url, linkRoute);
			return;
		}
		if (!blocksMainWindowSubframeNavigation(event.isMainFrame, event.url)) return;
		event.preventDefault();
		logger.warn(`Blocked subframe navigation to: ${event.url}`, 'Window');
	});

	// Deny all popup/new-window requests - external links use IPC shell:openExternal.
	// A target=_blank link with an allowed scheme is routed, still with no window.
	browserWindow.webContents.setWindowOpenHandler(({ url }) => {
		const linkRoute = subframeLinkRoute(url);
		if (linkRoute) {
			routeSubframeLink(browserWindow, url, linkRoute);
			return { action: 'deny' };
		}
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
	// Every window shares this session, so each new window replaces this handler.
	// It must resolve the window from the request, never close over `browserWindow`.
	browserWindow.webContents.session.setPermissionRequestHandler(
		(webContents, permission, callback, details) => {
			const contentsType = webContents?.getType?.();
			const isAppWindow = contentsType === 'window';

			if (isAppWindow && ALLOWED_APP_PERMISSIONS.has(permission)) {
				callback(true);
			} else if (permission === 'openExternal') {
				// Backstop for a subframe link that did not surface through
				// will-frame-navigate. Route it ourselves; never grant, so the
				// OS hand-off always goes through the scheme allowlist above.
				const externalURL = details && 'externalURL' in details ? details.externalURL : undefined;
				const linkRoute =
					isAppWindow && details?.isMainFrame === false ? subframeLinkRoute(externalURL) : null;
				const requestingWindow =
					linkRoute && webContents ? BrowserWindow.fromWebContents(webContents) : null;
				if (linkRoute && externalURL && requestingWindow && !requestingWindow.isDestroyed()) {
					routeSubframeLink(requestingWindow, externalURL, linkRoute);
				} else {
					logger.warn(`Blocked openExternal request: ${externalURL ?? ''}`, 'Window', {
						type: contentsType,
					});
				}
				callback(false);
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
