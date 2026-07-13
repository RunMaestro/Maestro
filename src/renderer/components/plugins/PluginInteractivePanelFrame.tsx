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
		onFailure?: (error: unknown) => void;
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
	const [attempt, setAttempt] = useState(0);
	const webviewRef = useRef<InteractivePanelWebviewElement | null>(null);
	const retryRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		if (failed) retryRef.current?.focus();
	}, [failed]);

	useEffect(() => {
		const webview = webviewRef.current;
		if (!webview) return;
		let active = true;
		let unbind: (() => void) | undefined;
		const reportFailure = (): void => {
			if (!active) return;
			setFailed(true);
		};
		const onFailLoad = reportFailure;
		webview.addEventListener('did-fail-load', onFailLoad);
		try {
			unbind = binder.bind({ panel, webview, onFailure: reportFailure });
		} catch {
			reportFailure();
		}
		if (attempt > 0) webview.focus();
		return () => {
			active = false;
			webview.removeEventListener('did-fail-load', onFailLoad);
			try {
				unbind?.();
			} catch {
				// A revoked guest must never prevent a later retry from mounting.
			}
		};
	}, [attempt, binder, failed, panel]);

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
					<div className="p-4 text-sm" role="alert" style={{ color: theme.colors.error }}>
						<p>Panel content could not be loaded.</p>
						<button
							ref={retryRef}
							type="button"
							aria-label="Retry panel"
							className="mt-3 rounded px-3 py-1.5 text-sm font-medium"
							style={{ border: `1px solid ${theme.colors.error}` }}
							onClick={() => {
								setFailed(false);
								setAttempt((current) => current + 1);
							}}
						>
							Retry
						</button>
					</div>
				) : (
					<webview
						key={attempt}
						tabIndex={0}
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
