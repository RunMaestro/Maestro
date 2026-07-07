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
 */

import { useMemo } from 'react';
import type { Theme } from '../../types';
import type { PanelContribution, PanelPlacement } from '../../../shared/plugins/contributions';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { mergePluginContributions } from '../../utils/pluginContributionMerge';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
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

	const panels = useMemo(() => {
		const matching = contributions.panels.filter((p) => p.placement === placement);
		// No built-in docked panels exist today, so merge against an empty
		// built-in set: the shared contract still de-dupes plugin ids, keeps
		// earlier-plugin-wins, retains provenance, and automatically yields to a
		// first-party panel of the same id should one be added later.
		return mergePluginContributions<PanelContribution>([], matching).items;
	}, [contributions.panels, placement]);

	if (panels.length === 0) return null;

	return (
		<div
			className={className ?? 'flex flex-col shrink-0 overflow-hidden border-l w-[320px]'}
			style={{
				// Clamp strictly below first-party modals/consent dialogs.
				position: 'relative',
				zIndex: MODAL_PRIORITIES.PLUGIN_PANEL_BASE,
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
			}}
			data-plugin-panel-slot={placement}
		>
			{panels.map(({ item }) => (
				<div key={item.id} className="flex flex-col flex-1 min-h-0">
					<PluginPanelFrame theme={theme} panel={item} />
				</div>
			))}
		</div>
	);
}
