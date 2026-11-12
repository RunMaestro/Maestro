/**
 * Modal host for a plugin-contributed UI panel (the `modal` placement).
 *
 * Mounted ONCE at App level by `PluginModalPanelMount`, driven by
 * `uiStore.openPluginPanelId`. Both entry points converge here: the
 * Settings -> Encore -> Plugins launch button and a plugin summoning its own
 * panel through `ui.openPanel` / `ui.togglePanel`.
 *
 * The isolated panel surface (a per-plugin-partition <webview>, hardened in the
 * main process: no Node, contextIsolation, broker-only preload, nav/egress
 * lockdown), the `maestro:invokeCommand` bridge, and the non-suppressible
 * provenance line all live in the shared `PluginPanelFrame` (the ONE place a
 * panel renders). This component only supplies the modal chrome (backdrop,
 * title bar, close affordance) around that frame.
 *
 * Chrome size follows the panel's `size` contribution: `default` is the historic
 * fixed dialog, `full` an edge-to-edge overlay for summonable mission-control
 * surfaces. Escape goes through the layer stack (in the reserved plugin band, so
 * a first-party modal above it still takes Escape first) rather than a local key
 * handler, which never fired on this non-focusable backdrop.
 */

import { X } from 'lucide-react';
import type { Theme } from '../../types';
import type { PanelContribution } from '../../../shared/plugins/contributions';
import { PluginPanelFrame } from '../plugins/PluginPanelFrame';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { pluginPanelPriority } from '../../constants/modalPriorities';

interface PluginPanelHostProps {
	theme: Theme;
	panel: PanelContribution;
	onClose: () => void;
}

export function PluginPanelHost({ theme, panel, onClose }: PluginPanelHostProps) {
	useModalLayer(pluginPanelPriority(0), panel.title, onClose);

	const isFull = panel.size === 'full';

	return (
		<div
			className="fixed inset-0 z-[1000] flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={onClose}
			role="presentation"
		>
			<div
				className={`rounded-xl border flex flex-col overflow-hidden ${
					isFull ? 'absolute inset-4' : 'w-[720px] max-w-[94vw] h-[560px] max-h-[88vh]'
				}`}
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="flex items-center justify-between px-4 py-2.5 shrink-0"
					style={{ borderBottom: `1px solid ${theme.colors.border}` }}
				>
					<div className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
						{panel.title}
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
					<PluginPanelFrame theme={theme} panel={panel} />
				</div>
			</div>
		</div>
	);
}
