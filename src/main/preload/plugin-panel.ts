/**
 * Broker-only preload for plugin panel <webview> guests (FC6 render host).
 *
 * This is the ENTIRE main-world-adjacent surface of a plugin panel. It exposes
 * NOTHING on `window` (no contextBridge), holds no state, and performs exactly
 * one job: forward the panel's existing postMessage bridge shape
 *
 *     { type: 'maestro:invokeCommand', commandId: string, args?: unknown }
 *
 * to the embedder renderer via `ipcRenderer.sendToHost` (surfacing there as an
 * `ipc-message` event on the <webview> element), where it is namespaced to the
 * owning plugin and forwarded over the broker-gated `plugins:invoke-command`
 * RPC. The panel keeps calling `parent.postMessage(...)` exactly as it did in
 * the srcdoc-iframe era - in a top-level guest `parent === window`, so the
 * message dispatches on the guest window and this isolated-world listener
 * receives it. One-way, fire-and-forget: nothing is ever sent back into the
 * page, and no reply channel exists.
 *
 * Gates:
 * - `event.source === window`: only the panel document's OWN scripts pass.
 *   The embedder cannot postMessage into a guest (separate process), and
 *   subframes cannot exist (CSP `child-src 'none'; frame-src 'none'`).
 * - Shape check: exactly `type === 'maestro:invokeCommand'` with a string
 *   `commandId`; anything else is ignored.
 *
 * Self-contained on purpose (mirrors consent.ts): imports nothing outside
 * `electron`, so its audit surface is this one file. The channel/shape
 * constants are duplicated from `src/shared/plugins/panel-host.ts`
 * (PANEL_BRIDGE_CHANNEL) - keep them in sync.
 */

import { ipcRenderer } from 'electron';

/** Minimal DOM surface (tsconfig.main has no DOM lib). */
interface PanelMessageEvent {
	source: unknown;
	data: unknown;
}

declare const window: {
	addEventListener(type: 'message', listener: (event: PanelMessageEvent) => void): void;
	postMessage(message: unknown, targetOrigin: string): void;
};

window.addEventListener('message', (event) => {
	// Only the panel document's own scripts message this window.
	if ((event.source as unknown) !== (window as unknown)) return;
	const data = event.data;
	if (typeof data !== 'object' || data === null) return;
	const msg = data as Record<string, unknown>;
	if (msg.type !== 'maestro:invokeCommand') return;
	if (typeof msg.commandId !== 'string') return;
	ipcRenderer.sendToHost('maestro:invokeCommand', {
		commandId: msg.commandId,
		args: msg.args,
	});
});

/**
 * The one channel pushed INTO the page: host-to-panel data (`ui.panelPost`).
 * The embedder renderer sends it only after the main process verified the
 * posting plugin OWNS this panel and that the payload is JSON and under the
 * size cap. Here the relay is deliberately dumb and total: take the structured-
 * cloned value and re-post it on the page's own window under one fixed shape.
 * Nothing is evaluated, `ipcRenderer` is never exposed, no other channel is
 * relayed, and there is no reply path - the page can only read.
 * The channel/shape constants are duplicated from
 * `src/shared/plugins/panel-host.ts` (PANEL_DATA_CHANNEL) - keep them in sync.
 */
ipcRenderer.on('maestro:panelData', (_event, data: unknown) => {
	window.postMessage({ type: 'maestro:panelData', data }, '*');
});
