/**
 * Modal host for a plugin-contributed UI panel (the `modal` placement, launched
 * from Settings -> Encore -> Plugins).
 *
 * The locked-down sandboxed iframe, its HTML loading, the `maestro:invokeCommand`
 * postMessage bridge, and the non-suppressible provenance line all live in the
 * shared `PluginPanelFrame` (the ONE place the opaque-origin invariant is
 * enforced: `srcDoc` + `sandbox="allow-scripts"`, never `allow-same-origin`,
 * never a URL `src`). This component only supplies the modal chrome (backdrop,
 * title bar, close affordance) around that frame.
 */

import { useCallback } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import type { PanelContribution } from '../../../shared/plugins/contributions';
import { PluginPanelFrame } from '../plugins/PluginPanelFrame';

interface PluginPanelHostProps {
	theme: Theme;
	panel: PanelContribution;
	onClose: () => void;
}

export function PluginPanelHost({ theme, panel, onClose }: PluginPanelHostProps) {
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
