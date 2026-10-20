/**
 * Main-process render host for plugin panels (FC6 / WS-render-host).
 *
 * A plugin panel renders in an Electron `<webview>` guest with a per-plugin
 * in-memory session (partition `plugin:<pluginId>`). This module is the ONE
 * place that session and its guest webContents get hardened. The lockdown
 * itself is the shared isolated-guest one (`src/main/utils/isolated-guest.ts`,
 * which the DataviewJS sandbox uses too); this module supplies the panel
 * scheme, preload, and grant-gated documents:
 *
 * - **Web preferences** (`hardenPluginPanelWebPreferences`, applied in
 *   `will-attach-webview`): no Node, contextIsolation ON, OS sandbox ON,
 *   renderer-supplied preload stripped and replaced with the broker-only
 *   panel preload (`plugin-panel-preload.js`), which forwards the panel's
 *   `maestro:invokeCommand` postMessage to the embedder and applies only the
 *   host-approved theme palette sent into the guest. The command contract of
 *   the old srcdoc iframe is unchanged.
 * - **Session** (`hardenPluginPanelSession`): a per-session protocol handler
 *   serves ONLY that plugin's own panel documents (grant-gated via the
 *   injected provider) with a restrictive CSP header + meta; `webRequest`
 *   cancels every request that is not a `plugin-panel:` document fetch
 *   (session-level egress denial - fetch/XHR/WS/beacon/subresources all die
 *   here even if CSP were bypassed); all permission requests/checks denied.
 * - **Guest webContents** (`attachPluginPanelGuestSecurity`, applied in
 *   `did-attach-webview`): `window.open` denied, and ALL navigations and
 *   redirects denied - the guest lives and dies on its initial panel
 *   document, closing the self-navigation exfil channel the srcdoc iframe
 *   could only mitigate. The main window's `will-frame-navigate` backstop
 *   (`blocksSubframeNavigation`) stays in place for the remaining srcdoc
 *   subframes (file preview); panel guests are separate webContents, so they
 *   are guarded HERE.
 *
 * The panel HTML provider is injected (`setPanelHtmlProvider`) from the
 * plugins IPC registration site, where the PluginManager and the feature flag
 * live - the provider itself re-checks the `plugins` Encore flag and the
 * grant-gated contribution set on EVERY document fetch, so a revoke or
 * disable takes effect on the next load with no cached authority. Until a
 * provider is set the host serves nothing (default deny).
 */

import { session } from 'electron';
import { logger } from '../utils/logger';
import {
	attachIsolatedGuestSecurity,
	hardenIsolatedGuestSession,
	hardenIsolatedGuestWebPreferences,
	isIsolatedGuestSession,
	isolatedGuestDocument,
	isolatedGuestNotFound,
	type IsolatedGuestContents,
	type IsolatedGuestSessionLike,
	type IsolatedGuestWebPreferences,
} from '../utils/isolated-guest';
import {
	PLUGIN_PANEL_SCHEME,
	PANEL_CSP_CONTENT,
	pluginIdFromPanelPartition,
	panelIdFromPluginPanelUrl,
} from '../../shared/plugins/panel-host';

const LOG_CONTEXT = 'PluginPanelHost';

/** How the shared isolated-guest lockdown names panels in its log lines. */
const GUEST_LABEL = 'panel';

/** Grant-gated panel HTML source; wired from the plugins IPC registration. */
export type PanelHtmlProvider = (panelId: string) => string | null;

/** Default-deny until the plugins subsystem wires the real provider. */
let panelHtmlProvider: PanelHtmlProvider = () => null;

export function setPanelHtmlProvider(provider: PanelHtmlProvider): void {
	panelHtmlProvider = provider;
}

/** Is this (guest webContents') session one of ours? Drives the
 * `did-attach-webview` branch between panel lockdown and browser-tab rules. */
export function isPluginPanelSession(ses: unknown): boolean {
	return isIsolatedGuestSession(ses, PLUGIN_PANEL_SCHEME);
}

/** Webview webPreferences as mutated inside `will-attach-webview`. */
export type PanelWebPreferences = IsolatedGuestWebPreferences;

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
	hardenIsolatedGuestWebPreferences(webPreferences, panelPreloadPath);
}

/**
 * Idempotently harden the per-plugin panel session named by `partition`:
 * register the panel-document protocol handler (scoped to the partition's
 * OWN plugin), deny all other egress at the webRequest layer, and deny every
 * permission. Safe to call on every attach; only the first call installs.
 */
export function hardenPluginPanelSession(
	partition: string,
	sessionFactory: (partition: string) => IsolatedGuestSessionLike = (p) =>
		session.fromPartition(p) as unknown as IsolatedGuestSessionLike
): void {
	const pluginId = pluginIdFromPanelPartition(partition);
	if (pluginId === null) return;
	hardenIsolatedGuestSession(sessionFactory(partition), {
		scheme: PLUGIN_PANEL_SCHEME,
		label: GUEST_LABEL,
		logContext: LOG_CONTEXT,
		// Serve ONLY this plugin's own panel documents on this session.
		serve: (request) => {
			const panelId = panelIdFromPluginPanelUrl(request.url);
			if (panelId === null || !panelId.startsWith(`${pluginId}/`)) {
				logger.warn(`Refused foreign/malformed panel document: ${request.url}`, LOG_CONTEXT);
				return isolatedGuestNotFound();
			}
			const html = panelHtmlProvider(panelId);
			// Unknown panel, plugins flag off, or ui:panel not granted - deny.
			if (html === null) return isolatedGuestNotFound();
			return isolatedGuestDocument(html, PANEL_CSP_CONTENT);
		},
	});
}

/** Guest webContents surface used by the panel lockdown (structural). */
export type PluginPanelGuestContents = IsolatedGuestContents;

/**
 * Lock down an attached panel guest: no popups, no navigation of any kind.
 * The initial document load is programmatic (the <webview> `src` attribute →
 * loadURL) and does NOT emit these events, so a blanket deny is safe: after
 * first paint the guest can never go anywhere else - the self-navigation
 * exfil channel is closed in the main process, not just mitigated by CSP.
 */
export function attachPluginPanelGuestSecurity(guestContents: PluginPanelGuestContents): void {
	attachIsolatedGuestSecurity(guestContents, { label: GUEST_LABEL, logContext: LOG_CONTEXT });
}
