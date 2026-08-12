/**
 * Renders every plugin-contributed panel whose `placement` matches this slot,
 * docked inline, each in an isolated per-plugin <webview> (`PluginPanelFrame`).
 *
 * Panels are merged through the shared contribution registry so the same
 * built-in-wins / earlier-plugin-wins / provenance-retained contract that
 * governs themes and commands also governs docked panels. The slot is z-clamped
 * to the reserved plugin band (`PLUGIN_PANEL_BASE`), well below first-party
 * modals/consent dialogs, so a docked panel can never paint over privileged
 * chrome even if its content forces a stacking context.
 *
 * Renders nothing when the `plugins` Encore flag is off (then
 * `usePluginContributions` returns empty buckets) or when no panel targets this
 * slot, so the slot stays invisible until a plugin docks here.
 *
 * Each docked panel carries a host-drawn header with a hide control; hidden
 * panels collapse to a slim reopen rail. The set of collapsed panel ids lives
 * in `uiStore.hiddenPluginPanels` (persisted). The frame's non-suppressible
 * provenance line stays in `PluginPanelFrame` and is never touched here.
 */

import { useMemo } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { Theme } from '../../types';
import type { PanelContribution, PanelPlacement } from '../../../shared/plugins/contributions';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { mergePluginContributions } from '../../utils/pluginContributionMerge';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useUIStore } from '../../stores/uiStore';
import { PluginPanelFrame } from './PluginPanelFrame';

/** Every placement except `modal` docks inline through this slot. */
export type DockedPlacement = Exclude<PanelPlacement, 'modal'>;

interface PluginPanelSlotProps {
	theme: Theme;
	placement: DockedPlacement;
	/** Container classes (sizing differs per dock: a rail column vs a full pane). */
	className?: string;
}

export function PluginPanelSlot({ theme, placement, className }: PluginPanelSlotProps) {
	const contributions = usePluginContributions();
	const hiddenPluginPanels = useUIStore((s) => s.hiddenPluginPanels);
	const toggleHiddenPluginPanel = useUIStore((s) => s.toggleHiddenPluginPanel);

	const panels = useMemo(() => {
		const matching = contributions.panels.filter((p) => p.placement === placement);
		// No built-in docked panels exist today, so merge against an empty
		// built-in set: the shared contract still de-dupes plugin ids, keeps
		// earlier-plugin-wins, retains provenance, and automatically yields to a
		// first-party panel of the same id should one be added later.
		return mergePluginContributions<PanelContribution>([], matching).items;
	}, [contributions.panels, placement]);

	if (panels.length === 0) return null;

	const visible = panels.filter(({ item }) => !hiddenPluginPanels.includes(item.id));
	const hidden = panels.filter(({ item }) => hiddenPluginPanels.includes(item.id));

	// Clamp strictly below first-party modals/consent dialogs.
	const slotStyle = {
		position: 'relative' as const,
		zIndex: MODAL_PRIORITIES.PLUGIN_PANEL_BASE,
		borderColor: theme.colors.border,
		backgroundColor: theme.colors.bgMain,
	};
	const borderSide = placement === 'left' ? 'border-r' : placement === 'right' ? 'border-l' : '';

	// Every docked panel hidden: collapse the whole slot to a slim reopen rail so
	// it stops consuming horizontal space but stays one click from returning.
	if (visible.length === 0) {
		return (
			<div
				className={`flex flex-col shrink-0 overflow-hidden w-9 ${borderSide}`}
				style={slotStyle}
				data-plugin-panel-slot={placement}
				data-plugin-panel-collapsed="true"
			>
				{hidden.map(({ item }) => (
					<button
						key={item.id}
						type="button"
						onClick={() => toggleHiddenPluginPanel(item.id)}
						className="flex flex-col items-center gap-1.5 py-2 w-full transition-colors hover:bg-white/5"
						style={{ color: theme.colors.textDim }}
						title={`Show ${item.title} (from ${item.pluginId})`}
						aria-label={`Show ${item.title} panel`}
					>
						<PanelRightOpen className="w-4 h-4 shrink-0" />
						<span
							className="text-[10px] whitespace-nowrap rotate-180"
							style={{ writingMode: 'vertical-rl' }}
						>
							{item.title}
						</span>
					</button>
				))}
			</div>
		);
	}

	return (
		<div
			className={className ?? 'flex flex-col shrink-0 overflow-hidden border-l w-[320px]'}
			style={slotStyle}
			data-plugin-panel-slot={placement}
		>
			{/* Reopen chips for panels hidden while others remain docked. */}
			{hidden.map(({ item }) => (
				<button
					key={item.id}
					type="button"
					onClick={() => toggleHiddenPluginPanel(item.id)}
					className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] shrink-0 border-b transition-colors hover:bg-white/5"
					style={{ color: theme.colors.textDim, borderColor: theme.colors.border }}
					title={`Show ${item.title} (from ${item.pluginId})`}
				>
					<PanelRightOpen className="w-3 h-3 shrink-0" />
					<span className="truncate">Show {item.title}</span>
				</button>
			))}
			{visible.map(({ item }) => (
				<div key={item.id} className="flex flex-col flex-1 min-h-0">
					{/* Host-drawn header + hide control, kept in the slot (not
					    PluginPanelFrame) so the modal host and the frame's
					    non-suppressible provenance line stay unchanged. */}
					<div
						className="flex items-center justify-between gap-1.5 px-2.5 py-1 shrink-0 select-none border-b"
						style={{ borderColor: theme.colors.border }}
					>
						<span
							className="truncate text-[11px]"
							style={{ color: theme.colors.textMain }}
							title={item.title}
						>
							{item.title}
						</span>
						<button
							type="button"
							onClick={() => toggleHiddenPluginPanel(item.id)}
							className="shrink-0 p-0.5 rounded transition-colors hover:bg-white/10"
							style={{ color: theme.colors.textDim }}
							title={`Hide ${item.title}`}
							aria-label={`Hide ${item.title} panel`}
						>
							<PanelRightClose className="w-3.5 h-3.5" />
						</button>
					</div>
					<div className="flex-1 min-h-0">
						<PluginPanelFrame theme={theme} panel={item} />
					</div>
				</div>
			))}
		</div>
	);
}
