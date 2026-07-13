import { useEffect, useRef, useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { Theme } from '../../types';
import type { CanonicalInteractivePanelContribution } from '../../../shared/plugins/contributions';
import { pluginPanelPartition, pluginPanelUrl } from '../../../shared/plugins/panel-host';

export interface InteractivePanelWebviewElement extends HTMLElement {
	addEventListener(type: string, listener: (event: Event) => void): void;
	removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * The generic host owns the guest element while the injected binder owns the
 * closed request/result/event protocol and the panel instance capability.
 */
export interface InteractivePanelHostBinder {
	bind(input: {
		panel: CanonicalInteractivePanelContribution;
		webview: InteractivePanelWebviewElement;
	}): () => void;
}

interface PluginInteractivePanelFrameProps {
	theme: Theme;
	panel: CanonicalInteractivePanelContribution;
	binder: InteractivePanelHostBinder;
}

export function PluginInteractivePanelFrame({
	theme,
	panel,
	binder,
}: PluginInteractivePanelFrameProps) {
	const [failed, setFailed] = useState(false);
	const webviewRef = useRef<InteractivePanelWebviewElement | null>(null);

	useEffect(() => {
		const webview = webviewRef.current;
		if (!webview) return;
		const onFailLoad = (): void => setFailed(true);
		webview.addEventListener('did-fail-load', onFailLoad);
		const unbind = binder.bind({ panel, webview });
		return () => {
			unbind();
			webview.removeEventListener('did-fail-load', onFailLoad);
		};
	}, [binder, panel]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				className="flex shrink-0 select-none items-center gap-1.5 px-2.5 py-1 text-[11px]"
				style={{ color: theme.colors.textDim, borderBottom: `1px solid ${theme.colors.border}` }}
				title={`This panel is provided by the "${panel.ownerPluginId}" plugin`}
			>
				<Puzzle className="h-3 w-3" />
				<span>from {panel.ownerPluginId}</span>
			</div>
			<div className="min-h-0 flex-1">
				{failed ? (
					<div className="p-4 text-sm" style={{ color: theme.colors.error }}>
						Panel content could not be loaded.
					</div>
				) : (
					<webview
						ref={(element) => {
							webviewRef.current = element as unknown as InteractivePanelWebviewElement | null;
						}}
						title={panel.title}
						partition={pluginPanelPartition(panel.ownerPluginId)}
						src={pluginPanelUrl(panel.canonicalContributionId)}
						className="h-full w-full border-0"
						style={{ backgroundColor: '#fff' }}
					/>
				)}
			</div>
		</div>
	);
}
