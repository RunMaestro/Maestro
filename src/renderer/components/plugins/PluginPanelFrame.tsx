/**
 * The ONE place a plugin-contributed panel's HTML is rendered.
 *
 * Loads the panel HTML over IPC (read from the plugin dir in main) and injects
 * it into an iframe locked to an opaque origin: `sandbox="allow-scripts"` with
 * NO `allow-same-origin` and NEVER a URL `src` (always `srcDoc`). The frame
 * therefore cannot read the app's cookies/localStorage, reach `window.parent`,
 * navigate the top frame, or touch the host DOM. The only channel out is a
 * single narrow postMessage shape (`maestro:invokeCommand`), gated on THIS
 * frame's `contentWindow` and namespaced to the panel's owning plugin, then
 * forwarded over the EXISTING broker-gated `invokeCommand` RPC.
 *
 * A non-suppressible provenance line ("from <plugin>") sits above the frame on
 * every surface that renders it (modal or docked), so a plugin panel can never
 * impersonate first-party chrome. Both `PluginPanelHost` (modal) and
 * `PluginPanelSlot` (docked) render through this component so the lockdown lives
 * in exactly one place.
 */

import { useState, useEffect, useRef } from 'react';
import { Puzzle } from 'lucide-react';
import type { Theme } from '../../types';
import type { PanelContribution } from '../../../shared/plugins/contributions';
import { notifyToast } from '../../stores/notificationStore';

interface PluginPanelFrameProps {
	theme: Theme;
	panel: PanelContribution;
	/** Sizing classes for the iframe element (modal vs docked differ). */
	iframeClassName?: string;
}

/**
 * Inject a restrictive Content-Security-Policy into a plugin panel's HTML so the
 * sandboxed iframe cannot make network requests directly (which would bypass the
 * brokered, egress-checked `net:fetch` capability). Inline script/style is allowed
 * (the panel UI runs inline) but `connect-src 'none'` blocks fetch/XHR/WebSocket/
 * beacon, `img/font/object/frame/child-src` block external/resource loads, and
 * `form-action 'none'` blocks form posts - so a panel's only intended way out stays
 * the narrow `maestro:invokeCommand` postMessage bridge below.
 *
 * Self-navigation egress (a panel setting `window.location`/meta-refresh to a
 * remote URL to leak data through it) is mitigated in depth: top-frame nav is
 * blocked (the sandbox has no `allow-top-navigation`), the SPA's own frame CSP
 * constrains where subframes may load, and the bridge below rejects any message
 * whose origin is not the opaque `null` - so a navigated frame can no longer reuse
 * the bridge. As an additional main-process backstop, the window's
 * `will-frame-navigate` guard (see `blocksSubframeNavigation`) blocks a subframe
 * navigating away from its initial `about:srcdoc` document. (Sandboxed-srcdoc
 * self-navigation does not reliably surface through `will-frame-navigate`, so the
 * sandbox + CSP + origin-gated bridge are the load-bearing barriers; the guard is
 * belt-and-suspenders.)
 */
export function withPanelCsp(html: string): string {
	const meta =
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
		`script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; ` +
		`font-src data:; connect-src 'none'; child-src 'none'; frame-src 'none'; ` +
		`object-src 'none'; form-action 'none'; base-uri 'none'">`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
	}
	return `${meta}${html}`;
}

export function PluginPanelFrame({ theme, panel, iframeClassName }: PluginPanelFrameProps) {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const result = await window.maestro.plugins.panelHtml(panel.id);
				if (cancelled) return;
				if (result.html === null) setError('Panel content could not be loaded.');
				else setHtml(withPanelCsp(result.html));
			} catch (err) {
				if (!cancelled) setError(String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [panel.id]);

	// Bridge: accept only `maestro:invokeCommand` from THIS iframe and forward it
	// to the plugin's command handler via the broker-gated RPC. Everything else is
	// ignored. Gate on BOTH the source (this frame's contentWindow) AND an opaque
	// origin: a sandboxed srcDoc frame's origin is "null", so if the panel ever
	// self-navigates to a real origin (e.g. https://evil) - where the WindowProxy
	// source can survive - the navigated page's messages carry a non-null origin and
	// are rejected here, so a navigated frame can never reuse the bridge.
	useEffect(() => {
		const onMessage = (event: MessageEvent): void => {
			if (event.source !== iframeRef.current?.contentWindow) return;
			if (event.origin !== 'null') return;
			const data = event.data;
			if (typeof data !== 'object' || data === null) return;
			const msg = data as Record<string, unknown>;
			if (msg.type !== 'maestro:invokeCommand') return;
			if (typeof msg.commandId !== 'string') return;
			// Namespace the command to this panel's owning plugin so a panel can
			// only invoke its own plugin's commands.
			const commandId = `${panel.pluginId}/${msg.commandId}`;
			void window.maestro.plugins.invokeCommand(commandId, msg.args).catch((err) => {
				notifyToast({ color: 'red', title: 'Plugin', message: `Command failed: ${String(err)}` });
			});
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [panel.pluginId]);

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
				{error ? (
					<div className="p-4 text-sm" style={{ color: theme.colors.error }}>
						{error}
					</div>
				) : html === null ? (
					<div className="p-4 text-sm italic" style={{ color: theme.colors.textDim }}>
						Loading...
					</div>
				) : (
					<iframe
						ref={iframeRef}
						title={panel.title}
						sandbox="allow-scripts"
						srcDoc={html}
						className={iframeClassName ?? 'w-full h-full border-0'}
						style={{ backgroundColor: '#fff' }}
					/>
				)}
			</div>
		</div>
	);
}
