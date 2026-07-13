/**
 * Main-process render host for plugin panels (FC6 / WS-render-host).
 *
 * A plugin panel renders in an Electron `<webview>` guest with a per-plugin
 * in-memory session (partition `plugin:<pluginId>`). This module is the ONE
 * place that session and its guest webContents get hardened:
 *
 * - **Web preferences** (`hardenPluginPanelWebPreferences`, applied in
 *   `will-attach-webview`): no Node, contextIsolation ON, OS sandbox ON,
 *   renderer-supplied preload stripped and replaced with the broker-only
 *   panel preload (`plugin-panel-preload.js`) whose entire surface is a
 *   one-way forward of the panel's `maestro:invokeCommand` postMessage to the
 *   embedder — the message contract of the old srcdoc iframe, unchanged.
 * - **Session** (`hardenPluginPanelSession`): a per-session protocol handler
 *   serves ONLY that plugin's own panel documents (grant-gated via the
 *   injected provider) with a restrictive CSP header + meta; `webRequest`
 *   cancels every request that is not a `plugin-panel:` document fetch
 *   (session-level egress denial — fetch/XHR/WS/beacon/subresources all die
 *   here even if CSP were bypassed); all permission requests/checks denied.
 * - **Guest webContents** (`attachPluginPanelGuestSecurity`, applied in
 *   `did-attach-webview`): `window.open` denied, and ALL navigations and
 *   redirects denied — the guest lives and dies on its initial panel
 *   document, closing the self-navigation exfil channel the srcdoc iframe
 *   could only mitigate. The main window's `will-frame-navigate` backstop
 *   (`blocksSubframeNavigation`) stays in place for the remaining srcdoc
 *   subframes (file preview); panel guests are separate webContents, so they
 *   are guarded HERE.
 *
 * The panel HTML provider is injected (`setPanelHtmlProvider`) from the
 * plugins IPC registration site, where the PluginManager and the feature flag
 * live — the provider itself re-checks the `plugins` Encore flag and the
 * grant-gated contribution set on EVERY document fetch, so a revoke or
 * disable takes effect on the next load with no cached authority. Until a
 * provider is set the host serves nothing (default deny).
 */

import { session } from 'electron';
import { logger } from '../utils/logger';
import {
	PLUGIN_PANEL_SCHEME,
	PANEL_CSP_CONTENT,
	pluginIdFromPanelPartition,
	interactivePanelKeyFromPluginPanelUrl,
	withPanelCsp,
} from '../../shared/plugins/panel-host';

const LOG_CONTEXT = 'PluginPanelHost';

/** Grant-gated interactive panel HTML source; wired from the plugins IPC registration. */
export type PanelHtmlProvider = (ownerPluginId: string, panelLocalId: string) => string | null;

/** Default-deny until the plugins subsystem wires the real provider. */
let panelHtmlProvider: PanelHtmlProvider = () => null;

export function setPanelHtmlProvider(provider: PanelHtmlProvider): void {
	panelHtmlProvider = provider;
}

/** Minimal structural view of Electron.Session — keeps this testable. */
interface PanelSessionLike {
	protocol: {
		handle(scheme: string, handler: (request: { url: string }) => Response): void;
	};
	webRequest: {
		onBeforeRequest(
			listener: (
				details: { url: string },
				callback: (response: { cancel: boolean }) => void
			) => void
		): void;
	};
	setPermissionRequestHandler(handler: ((...args: unknown[]) => void) | null): void;
	setPermissionCheckHandler(handler: ((...args: unknown[]) => boolean) | null): void;
}

/** Sessions this module has hardened; identity marks a session as panel-owned. */
const hardenedPanelSessions = new WeakSet<object>();

/** Is this (guest webContents') session one of ours? Drives the
 * `did-attach-webview` branch between panel lockdown and browser-tab rules. */
export function isPluginPanelSession(ses: unknown): boolean {
	return typeof ses === 'object' && ses !== null && hardenedPanelSessions.has(ses);
}

/** Webview webPreferences as mutated inside `will-attach-webview`. */
export type PanelWebPreferences = Record<string, unknown>;

/**
 * Force the locked-down web preferences for a plugin panel guest. Runs inside
 * `will-attach-webview`, so nothing the renderer put on the <webview> tag
 * survives: preload is replaced with the broker-only panel preload, Node is
 * off everywhere, contextIsolation + OS sandbox are on.
 */
export function hardenPluginPanelWebPreferences(
	webPreferences: PanelWebPreferences,
	panelPreloadPath: string
): void {
	delete webPreferences.preloadURL;
	webPreferences.preload = panelPreloadPath;
	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.nodeIntegrationInWorker = false;
	webPreferences.contextIsolation = true;
	webPreferences.sandbox = true;
	webPreferences.webSecurity = true;
	webPreferences.allowRunningInsecureContent = false;
	webPreferences.webviewTag = false;
	webPreferences.plugins = false;
}

/**
 * Idempotently harden the per-plugin panel session named by `partition`:
 * register the panel-document protocol handler (scoped to the partition's
 * OWN plugin), deny all other egress at the webRequest layer, and deny every
 * permission. Safe to call on every attach; only the first call installs.
 */
export function hardenPluginPanelSession(
	partition: string,
	sessionFactory: (partition: string) => PanelSessionLike = (p) =>
		session.fromPartition(p) as unknown as PanelSessionLike
): void {
	const pluginId = pluginIdFromPanelPartition(partition);
	if (pluginId === null) return;
	const ses = sessionFactory(partition);
	if (hardenedPanelSessions.has(ses as unknown as object)) return;
	hardenedPanelSessions.add(ses as unknown as object);

	// Serve ONLY this plugin's own panel documents on this session.
	ses.protocol.handle(PLUGIN_PANEL_SCHEME, (request) => {
		const panelKey = interactivePanelKeyFromPluginPanelUrl(request.url);
		if (panelKey === null || panelKey.ownerPluginId !== pluginId) {
			logger.warn(`Refused foreign/malformed panel document: ${request.url}`, LOG_CONTEXT);
			return new Response(null, { status: 404 });
		}
		const html = panelHtmlProvider(panelKey.ownerPluginId, panelKey.panelLocalId);
		if (html === null) {
			// Unknown panel, plugins flag off, or ui:interactivePanel not granted — deny.
			return new Response(null, { status: 404 });
		}
		return new Response(withPanelCsp(html), {
			status: 200,
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Content-Security-Policy': PANEL_CSP_CONTENT,
			},
		});
	});

	// Session-level egress denial: the ONLY requests this session may make are
	// its own panel-document fetches. Everything else (http/https/ws/file/...)
	// is cancelled before it leaves the app, regardless of CSP.
	ses.webRequest.onBeforeRequest((details, callback) => {
		const cancel = !details.url.startsWith(`${PLUGIN_PANEL_SCHEME}://`);
		if (cancel) {
			logger.warn(`Blocked panel egress attempt: ${details.url}`, LOG_CONTEXT);
		}
		callback({ cancel });
	});

	// No web permission (camera, mic, geolocation, clipboard, ...) is ever
	// grantable inside a panel.
	ses.setPermissionRequestHandler((...args: unknown[]) => {
		const callback = args[2];
		if (typeof callback === 'function') (callback as (granted: boolean) => void)(false);
	});
	ses.setPermissionCheckHandler(() => false);
}

/** Guest webContents surface used by the panel lockdown (structural). */
export interface PluginPanelGuestContents {
	session?: unknown;
	setWindowOpenHandler(handler: ({ url }: { url: string }) => { action: 'deny' }): void;
	on(
		event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
		handler: (event: { preventDefault: () => void; url?: string }, url?: string) => void
	): void;
}

/**
 * Lock down an attached panel guest: no popups, no navigation of any kind.
 * The initial document load is programmatic (the <webview> `src` attribute →
 * loadURL) and does NOT emit these events, so a blanket deny is safe: after
 * first paint the guest can never go anywhere else — the self-navigation
 * exfil channel is closed in the main process, not just mitigated by CSP.
 */
export function attachPluginPanelGuestSecurity(guestContents: PluginPanelGuestContents): void {
	guestContents.setWindowOpenHandler(({ url }) => {
		logger.warn(`Blocked panel popup: ${url}`, LOG_CONTEXT);
		return { action: 'deny' };
	});

	const denyNavigation = (
		eventName: string,
		event: { preventDefault: () => void; url?: string },
		url?: string
	) => {
		event.preventDefault();
		logger.warn(`Blocked panel ${eventName}: ${url ?? event.url ?? '<unknown>'}`, LOG_CONTEXT);
	};

	guestContents.on('will-navigate', (event, url) => denyNavigation('will-navigate', event, url));
	guestContents.on('will-redirect', (event, url) => denyNavigation('will-redirect', event, url));
	guestContents.on('will-frame-navigate', (event) => denyNavigation('will-frame-navigate', event));
}
