/**
 * Sandboxed host for a plugin-contributed UI panel.
 *
 * Renders the plugin's HTML inside an iframe locked down with `sandbox=
 * "allow-scripts"` and NO `allow-same-origin`, so the frame runs in an opaque
 * origin: it cannot read the app's cookies/localStorage, reach `window.parent`,
 * navigate the top frame, or touch the host DOM. The ONLY channel out is
 * postMessage, and we accept just one narrow message shape (`maestro:invokeCommand`)
 * which is forwarded to the plugin's own sandboxed code via the broker-gated RPC.
 *
 * The panel HTML is loaded over IPC (read from the plugin dir in main) and
 * injected via `srcDoc`, never by URL, so there is no http(s) origin to leak to.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import type { PanelContribution } from '../../../shared/plugins/contributions';
import { notifyToast } from '../../stores/notificationStore';

interface PluginPanelHostProps {
	theme: Theme;
	panel: PanelContribution;
	onClose: () => void;
}

export function PluginPanelHost({ theme, panel, onClose }: PluginPanelHostProps) {
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
				else setHtml(result.html);
			} catch (err) {
				if (!cancelled) setError(String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [panel.id]);

	// Bridge: accept only `maestro:invokeCommand` from THIS iframe and forward it
	// to the plugin's command handler via the broker-gated RPC. Everything else
	// is ignored. We cannot check origin (opaque = "null"), so we gate on source.
	useEffect(() => {
		const onMessage = (event: MessageEvent): void => {
			if (event.source !== iframeRef.current?.contentWindow) return;
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

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		},
		[onClose]
	);

	return (
		<div
			className="fixed inset-0 z-[1000] flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={onClose}
			onKeyDown={handleKeyDown}
			role="presentation"
		>
			<div
				className="rounded-xl border flex flex-col w-[720px] max-w-[94vw] h-[560px] max-h-[88vh] overflow-hidden"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="flex items-center justify-between px-4 py-2.5 shrink-0"
					style={{ borderBottom: `1px solid ${theme.colors.border}` }}
				>
					<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						{panel.title}
						<span className="ml-2 text-[11px] font-normal" style={{ color: theme.colors.textDim }}>
							{panel.pluginId}
						</span>
					</div>
					<button
						className="p-1 rounded"
						style={{ color: theme.colors.textDim }}
						onClick={onClose}
						title="Close"
					>
						<X className="w-4 h-4" />
					</button>
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
							className="w-full h-full border-0"
							style={{ backgroundColor: '#fff' }}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
