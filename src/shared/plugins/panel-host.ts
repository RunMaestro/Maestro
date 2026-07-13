/**
 * Shared, pure helpers for the plugin panel render host (FC6 / WS-render-host).
 *
 * A plugin-contributed panel renders in an Electron `<webview>` guest that is
 * isolated per plugin:
 *
 * - **Partition** `plugin:<pluginId>` — a NON-persist (in-memory) session per
 *   plugin, so panels of different plugins can never see each other's storage
 *   (cookies, localStorage, caches), nor the app's, and everything is wiped on
 *   relaunch.
 * - **Document URL** `plugin-panel://panel/<encodeURIComponent(panelId)>` — a
 *   non-standard scheme served by a per-session `protocol.handle` in the main
 *   process, which reads the panel HTML from the plugin dir (grant-gated) and
 *   serves it with a restrictive CSP header. Non-standard scheme ⇒ opaque
 *   origin, matching the old sandboxed-srcdoc posture.
 *
 * Everything here is pure string manipulation so both the renderer (building
 * the webview attributes) and the main process (validating attachment and
 * serving documents) share ONE definition of the naming contract, and it is
 * unit-testable without Electron.
 */

/** Scheme the main process serves panel documents on (per plugin session). */
export const PLUGIN_PANEL_SCHEME = 'plugin-panel';

/** Fixed host of a panel document URL; the panel id travels in the path. */
export const PLUGIN_PANEL_URL_HOST = 'panel';

/**
 * Per-plugin session partition prefix. Deliberately NOT `persist:` — the
 * session is in-memory and dies with the app, so a panel can never accumulate
 * durable state outside the brokered `storage:*` capabilities.
 */
export const PLUGIN_PANEL_PARTITION_PREFIX = 'plugin:';

/**
 * The single restrictive CSP applied to every panel document — served as a
 * response header by the protocol handler AND injected as a meta tag
 * (belt-and-suspenders). Inline script/style is allowed (panel UIs run
 * inline), everything else is denied: `connect-src 'none'` blocks
 * fetch/XHR/WebSocket/beacon, `img/font` allow only inline `data:`,
 * `child-src/frame-src 'none'` block subframes entirely, `form-action 'none'`
 * blocks form posts and `base-uri 'none'` blocks base hijacks. Network egress
 * is ALSO denied at the session level (webRequest) — CSP is defense in depth.
 */
export const PANEL_CSP_CONTENT =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"img-src data:; font-src data:; connect-src 'none'; child-src 'none'; " +
	"frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The one ipc channel a panel guest's preload forwards the postMessage bridge
 * on (`ipcRenderer.sendToHost` → `ipc-message` on the <webview> element). The
 * in-page message shape (`{ type: 'maestro:invokeCommand', commandId, args }`)
 * is unchanged from the srcdoc-iframe era, so existing panel HTML keeps
 * working verbatim.
 */
export const PANEL_BRIDGE_CHANNEL = 'maestro:invokeCommand';

/** Session partition for a plugin's panels: `plugin:<pluginId>`. */
export function pluginPanelPartition(pluginId: string): string {
	return `${PLUGIN_PANEL_PARTITION_PREFIX}${pluginId}`;
}

/** Is this partition string a plugin-panel partition? */
export function isPluginPanelPartition(partition: string): boolean {
	return partition.startsWith(PLUGIN_PANEL_PARTITION_PREFIX);
}

/** The owning plugin id of a plugin-panel partition, or null. */
export function pluginIdFromPanelPartition(partition: string): string | null {
	if (!isPluginPanelPartition(partition)) return null;
	const id = partition.slice(PLUGIN_PANEL_PARTITION_PREFIX.length);
	return id.length > 0 ? id : null;
}

/**
 * Document URL for a panel: `plugin-panel://panel/<encoded panelId>`. The
 * panel id (`<pluginId>/<localId>`) is URI-encoded into a single path segment
 * so `/` in the id can never be confused with URL structure.
 */
export function pluginPanelUrl(panelId: string): string {
	return `${PLUGIN_PANEL_SCHEME}://${PLUGIN_PANEL_URL_HOST}/${encodeURIComponent(panelId)}`;
}

/**
 * Parse a panel document URL back to its panel id. Returns null for anything
 * that is not EXACTLY `plugin-panel://panel/<single-encoded-segment>` — wrong
 * scheme, wrong host, extra path segments, or an empty id all fail closed.
 */
export function panelIdFromPluginPanelUrl(rawUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.protocol !== `${PLUGIN_PANEL_SCHEME}:`) return null;
	// Non-standard schemes parse host+path differently across environments;
	// normalize by stripping the leading `//host/` shape from the raw remainder.
	const rest = rawUrl.slice(`${PLUGIN_PANEL_SCHEME}://`.length);
	const slash = rest.indexOf('/');
	if (slash < 0) return null;
	if (rest.slice(0, slash) !== PLUGIN_PANEL_URL_HOST) return null;
	const segment = rest.slice(slash + 1);
	// Exactly one path segment; no query/fragment smuggling.
	if (segment.length === 0 || segment.includes('/')) return null;
	if (segment.includes('?') || segment.includes('#')) return null;
	try {
		const id = decodeURIComponent(segment);
		return id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

/** Canonical owner-bound identity carried by an interactive panel document URL. */
export interface InteractivePanelUrlKey {
	ownerPluginId: string;
	panelLocalId: string;
}

/**
 * Parse the exact canonical owner/local key used by closed interactive panels.
 * Unlike the legacy opaque panel id parser, this rejects alternate escaping and
 * every ambiguous multi-segment form before authority reaches a provider.
 */
export function interactivePanelKeyFromPluginPanelUrl(
	rawUrl: string
): InteractivePanelUrlKey | null {
	const canonicalContributionId = panelIdFromPluginPanelUrl(rawUrl);
	if (canonicalContributionId === null || pluginPanelUrl(canonicalContributionId) !== rawUrl) {
		return null;
	}
	const separator = canonicalContributionId.indexOf('/');
	if (
		separator <= 0 ||
		separator !== canonicalContributionId.lastIndexOf('/') ||
		separator === canonicalContributionId.length - 1
	) {
		return null;
	}
	return {
		ownerPluginId: canonicalContributionId.slice(0, separator),
		panelLocalId: canonicalContributionId.slice(separator + 1),
	};
}

/**
 * Attachment gate: may a webview with this partition load this src? True only
 * when the partition is a plugin-panel partition AND the src is a well-formed
 * panel document URL whose panel id is namespaced to THAT plugin
 * (`<pluginId>/<localId>`). A renderer bug (or compromise) can therefore never
 * attach plugin A's session to plugin B's panel document, nor point a panel
 * webview at an arbitrary URL.
 */
export function isAllowedPluginPanelAttachment(partition: string, src: string): boolean {
	const pluginId = pluginIdFromPanelPartition(partition);
	if (pluginId === null) return false;
	const panelId = panelIdFromPluginPanelUrl(src);
	if (panelId === null) return false;
	if (!panelId.startsWith(`${pluginId}/`)) return false;
	// There must be a non-empty local id after the namespace.
	return panelId.length > pluginId.length + 1;
}

/**
 * Inject the restrictive panel CSP as a meta tag into a panel's HTML. The
 * protocol handler ALSO serves the same policy as a Content-Security-Policy
 * response header; the meta duplicates it so the policy survives even if the
 * document is ever rendered through a path that drops response headers.
 */
export function withPanelCsp(html: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${PANEL_CSP_CONTENT}">`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
	}
	return `${meta}${html}`;
}
