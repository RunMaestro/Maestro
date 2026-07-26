/**
 * The ONE place a plugin-contributed panel renders.
 *
 * A panel is hosted in an Electron `<webview>` guest - a separate renderer
 * process with a per-plugin in-memory session (partition `plugin:<pluginId>`),
 * so panels can never see the app's storage nor another plugin's. Everything
 * security-relevant is enforced in the MAIN process, not here:
 *
 * - `will-attach-webview` (window-manager) validates that the partition and
 *   the document URL name the SAME plugin, then forces the locked-down web
 *   preferences: no Node, contextIsolation, OS sandbox, and the broker-only
 *   panel preload (anything set on this tag is overridden there).
 * - The panel document is served by a per-plugin `plugin-panel://` protocol
 *   handler (grant-gated, CSP header + meta with `connect-src 'none'` etc.).
 * - The session cancels all non-panel-document requests (egress denial) and
 *   denies every permission; the guest denies window.open and ALL navigation.
 *
 * The message contract is unchanged from the srcdoc-iframe era: panel HTML
 * calls `parent.postMessage({ type: 'maestro:invokeCommand', commandId, args },
 * '*')`. The guest preload forwards that one shape to this component as an
 * `ipc-message` event on the <webview> element, where it is namespaced to the
 * panel's owning plugin and forwarded over the EXISTING broker-gated
 * `invokeCommand` RPC.
 *
 * A non-suppressible provenance line ("from <plugin>") sits above the frame on
 * every surface that renders it (modal or docked), so a plugin panel can never
 * impersonate first-party chrome. Both `PluginPanelHost` (modal) and
 * `PluginPanelSlot` (docked) render through this component so the lockdown
 * lives in exactly one place.
 */

import { useState, useEffect, useRef } from 'react';
import { Puzzle } from 'lucide-react';
import type { Theme } from '../../types';
import type { PanelContribution } from '../../../shared/plugins/contributions';
import {
	pluginPanelPartition,
	pluginPanelUrl,
	PANEL_BRIDGE_CHANNEL,
	PANEL_DATA_CHANNEL,
} from '../../../shared/plugins/panel-host';
import { notifyToast } from '../../stores/notificationStore';
import { captureException } from '../../utils/sentry';

// webview.send throws when the guest webContents is not attached yet (a push can
// land before the panel finishes loading) or is tearing down - both are expected
// races for a best-effort UI data frame. Anything else is unexpected.
function isDetachedWebviewError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /destroyed|disposed|detached|not attached|must be attached/i.test(message);
}

interface PluginPanelFrameProps {
	theme: Theme;
	panel: PanelContribution;
	/** Sizing classes for the webview element (modal vs docked differ). */
	frameClassName?: string;
}

/** The <webview> element surface this component uses (structural - the real
 * element is Electron's WebViewElement, unavailable to renderer types). */
interface PanelWebviewElement extends HTMLElement {
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
	/** Structured-clone push into the guest (host-to-panel data, one-way). */
	send(channel: string, ...args: unknown[]): void;
}

/** Shape of the `ipc-message` event the guest preload emits via sendToHost. */
interface PanelIpcMessageEvent extends Event {
	channel?: string;
	args?: unknown[];
}

export function PluginPanelFrame({ theme, panel, frameClassName }: PluginPanelFrameProps) {
	const [failed, setFailed] = useState(false);
	const webviewRef = useRef<PanelWebviewElement | null>(null);

	// Bridge: the guest preload forwards the panel's postMessage bridge
	// (`{ type: 'maestro:invokeCommand', commandId, args }`) as an ipc-message
	// on this element. Namespace the command to this panel's owning plugin so a
	// panel can only ever invoke its own plugin's commands, then hand it to the
	// broker-gated RPC. Also surface load failures (unknown/ungranted panel ⇒
	// the protocol handler refuses the document).
	useEffect(() => {
		const webview = webviewRef.current;
		if (!webview) return;

		const onIpcMessage = (event: Event): void => {
			const message = event as PanelIpcMessageEvent;
			if (message.channel !== PANEL_BRIDGE_CHANNEL) return;
			const payload = message.args?.[0];
			if (typeof payload !== 'object' || payload === null) return;
			const { commandId, args } = payload as Record<string, unknown>;
			if (typeof commandId !== 'string' || commandId.length === 0) return;
			void window.maestro.plugins
				.invokeCommand(`${panel.pluginId}/${commandId}`, args)
				.catch((err) => {
					notifyToast({
						color: 'red',
						title: 'Plugin',
						message: `Command failed: ${String(err)}`,
					});
				});
		};

		const onFailLoad = (): void => setFailed(true);

		webview.addEventListener('ipc-message', onIpcMessage);
		webview.addEventListener('did-fail-load', onFailLoad);
		return () => {
			webview.removeEventListener('ipc-message', onIpcMessage);
			webview.removeEventListener('did-fail-load', onFailLoad);
		};
	}, [panel.pluginId, failed]);

	// Host-to-panel push (`ui.panelPost`). Main validated ownership, JSON-ness and
	// size before broadcasting; here we only route the event to the ONE frame
	// whose panel it names and hand the value to the guest as structured-clone
	// data. The renderer never inspects or evaluates the payload.
	useEffect(() => {
		return window.maestro.plugins.onPanelData(({ panelId, data }) => {
			if (panelId !== panel.id) return;
			const webview = webviewRef.current;
			if (!webview) return;
			try {
				webview.send(PANEL_DATA_CHANNEL, data);
			} catch (error) {
				// The guest may not be attached yet (or is tearing down); drop the
				// message rather than surfacing a plugin-triggered error to the user.
				// Report anything that is NOT that expected race so real regressions
				// still reach Sentry instead of being silently swallowed.
				if (!isDetachedWebviewError(error)) {
					captureException(error, {
						extra: {
							where: 'PluginPanelFrame.onPanelData',
							pluginId: panel.pluginId,
							panelId: panel.id,
						},
					});
				}
			}
		});
	}, [panel.id, panel.pluginId, failed]);

	return (
		<div className="flex flex-col h-full min-h-0">
			<div
				className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] shrink-0 select-none"
				style={{ color: theme.colors.textDim, borderBottom: `1px solid ${theme.colors.border}` }}
				title={`This panel is provided by the "${panel.pluginId}" plugin`}
			>
				<Puzzle className="w-3 h-3" />
				<span>from {panel.pluginId}</span>
			</div>
			<div className="flex-1 min-h-0">
				{failed ? (
					<div className="p-4 text-sm" style={{ color: theme.colors.error }}>
						Panel content could not be loaded.
					</div>
				) : (
					<webview
						ref={(element) => {
							webviewRef.current = element as unknown as PanelWebviewElement | null;
						}}
						title={panel.title}
						partition={pluginPanelPartition(panel.pluginId)}
						src={pluginPanelUrl(panel.id)}
						className={frameClassName ?? 'w-full h-full border-0'}
						style={{ backgroundColor: '#fff' }}
					/>
				)}
			</div>
		</div>
	);
}
