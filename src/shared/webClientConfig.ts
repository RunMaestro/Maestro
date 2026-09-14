/**
 * The config object the web server injects into every served page.
 *
 * `staticRoutes.ts` writes `window.__MAESTRO_CONFIG__` as one literal, and two
 * different bundles read it back: the web-desktop shim (`src/web-desktop/
 * electron-shim.ts`, which needs `wsUrl` to reach the bridge) and the legacy
 * web client (`src/web/utils/config.ts`). Each used to `declare global` its own
 * shape, and the two had already drifted - the shim's omitted `sessionId` and
 * `tabId` and added `concertoToken`, which is a `TS2717` the moment both files
 * land in one program. That is exactly what happened when `src/web-desktop` was
 * added to the typecheck: it had never been checked at all, so nothing had ever
 * compared the two.
 *
 * One declaration, imported by both, so a field the server starts injecting
 * cannot be described two ways. Keep this in step with the literal in
 * `staticRoutes.ts` - that is the producer, and this is only its type.
 */

export interface MaestroWebClientConfig {
	/** Security token (UUID) - required in every API and WS URL. */
	securityToken: string;
	/** Session ID when the page targets one agent, else null. */
	sessionId: string | null;
	/** Tab ID when the page targets one tab, else null. */
	tabId: string | null;
	/** Base path for API requests, e.g. `/$TOKEN/api`. */
	apiBase: string;
	/** WebSocket path, e.g. `/$TOKEN/ws`. */
	wsUrl: string;
	/**
	 * Read-only token for the Concerto HTML document route. Optional so a page
	 * served by an older build still satisfies this type.
	 */
	concertoToken?: string;
}

/** Reconcile browser-held work with the main process after bridge recovery. */
export const WEB_BRIDGE_RECONCILE_EVENT = 'maestro:webBridgeReconcile';

declare global {
	interface Window {
		__MAESTRO_CONFIG__?: MaestroWebClientConfig;
	}
}
