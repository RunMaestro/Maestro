/**
 * webBridgeReconcile - ask the renderer to reconcile with main right now.
 *
 * The web-desktop bridge raises `WEB_BRIDGE_RECONCILE_EVENT` itself whenever it
 * reconnects. Renderer code raises it through this helper when the user asks for
 * a retry (the failed agent-list read, a conversation that did not load) or when
 * a send notices the bridge dropped mid-flight. `useSessionRestoration` is the
 * single listener: it retries a failed agent read, reloads deferred
 * conversations, and reattaches live turns.
 */

import { WEB_BRIDGE_RECONCILE_EVENT } from '../../shared/webClientConfig';

export function requestWebBridgeReconcile(): void {
	window.dispatchEvent(new Event(WEB_BRIDGE_RECONCILE_EVENT));
}
