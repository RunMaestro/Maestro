/**
 * Bridge-only preload for DataviewJS guests (D4). This is the ENTIRE main-world-adjacent surface of a guest.
 * It exposes NOTHING on `window` (no contextBridge) and runs in the isolated world, so note scripts never
 * reach `ipcRenderer`. Main forces it in `will-attach-webview`; the renderer never names it. It relays the
 * sandbox bridge (`src/shared/dataview/sandboxProtocol.ts`) and nothing else:
 *
 * - **Guest to host.** The page posts `{ channel: SANDBOX_TO_HOST_CHANNEL, message }` envelopes on its own
 *   window (`startDataviewGuest()`). This preload forwards `message` with `ipcRenderer.sendToHost`, which
 *   surfaces as an `ipc-message` event on the `<webview>` element, where the host checks every message with
 *   `parseSandboxMessage(raw, 'guest')`. Only the page's own window posts here: the CSP forbids frames and
 *   main denies popups.
 * - **Clicks.** `open.link` and `toggle.task` act outside the guest, and a script can post them without any
 *   click. So each real click (`isTrusted`, seen here before the page sees it) lets ONE of them through, and
 *   only while that click's transient user activation lasts. A script can never open a link or tick a task
 *   on its own.
 * - **Host to guest.** What arrives on `SANDBOX_TO_GUEST_CHANNEL` is re-posted into the page as a to-guest
 *   envelope; the page parses it with `parseSandboxMessage(raw, 'host')`.
 * - **Theme.** `PANEL_THEME_CHANNEL` payloads are applied to the root style here, as the plugin panel preload
 *   does, so page scripts never see a bridge for it either.
 */

import { ipcRenderer } from 'electron';
import {
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	openSandboxEnvelope,
	sandboxEnvelope,
} from '../../shared/dataview/sandboxProtocol';
import { applyPanelThemePayload, PANEL_THEME_CHANNEL } from '../../shared/plugins/panel-theme';

/** Minimal DOM surface (tsconfig.main has no DOM lib). */
interface GuestMessageEvent {
	source: unknown;
	data: unknown;
}

interface GuestClickEvent {
	isTrusted: boolean;
}

declare const window: {
	addEventListener(type: 'message', listener: (event: GuestMessageEvent) => void): void;
	addEventListener(
		type: 'click',
		listener: (event: GuestClickEvent) => void,
		useCapture: boolean
	): void;
	postMessage(message: unknown, targetOrigin: string): void;
};

declare const document: {
	documentElement: {
		style: {
			setProperty(name: string, value: string): void;
			removeProperty(name: string): void;
		};
	};
};

declare const navigator: { userActivation?: { isActive: boolean } };

/** Guest messages that act outside the guest, and so need a click behind them. */
const CLICK_ACTIONS = new Set(['open.link', 'toggle.task']);

/** Whether a real click happened that has not been spent on an action yet. */
let clickUnspent = false;

// Capture phase on the window, registered before any page script: the page cannot run before this sees the
// click, and cannot forge one (script-made events are not trusted).
window.addEventListener(
	'click',
	(event) => {
		if (event.isTrusted) clickUnspent = true;
	},
	true
);

/** Spend the pending click on one action, if there is one and its activation still holds. */
function spendClick(): boolean {
	const allowed = clickUnspent && navigator.userActivation?.isActive === true;
	clickUnspent = false;
	return allowed;
}

window.addEventListener('message', (event) => {
	// Only the page's own scripts message this window.
	if ((event.source as unknown) !== (window as unknown)) return;
	const message = openSandboxEnvelope(event.data, SANDBOX_TO_HOST_CHANNEL);
	if (typeof message !== 'object' || message === null) return;
	const type = (message as { type?: unknown }).type;
	if (typeof type === 'string' && CLICK_ACTIONS.has(type) && !spendClick()) return;
	ipcRenderer.sendToHost(SANDBOX_TO_HOST_CHANNEL, message);
});

ipcRenderer.on(SANDBOX_TO_GUEST_CHANNEL, (_event, message: unknown) => {
	window.postMessage(sandboxEnvelope(SANDBOX_TO_GUEST_CHANNEL, message), '*');
});

/** Apply only host-approved CSS color slots; invalid updates clear stale values. */
ipcRenderer.on(PANEL_THEME_CHANNEL, (_event, data: unknown) => {
	applyPanelThemePayload(document.documentElement.style, data);
});
