/**
 * Renders every plugin-contributed `uiItem` whose `surface` matches this slot as
 * a small, unobtrusive button. Activating one fires the plugin's OWN command via
 * the brokered `invokeCommand(`<pluginId>/<command>`)` bridge - the same
 * fire-and-forget contract the menu surface (Quick Actions palette) and docked
 * panels use, so a uiItem can only ever dispatch a command its plugin registered.
 *
 * The `menu` surface is handled separately by the command palette; this slot
 * covers the in-chrome regions (sidebar, activity bar, toolbar). `status-bar`
 * has no host region today, so nothing mounts it.
 *
 * Renders nothing when the `plugins` Encore flag is off (then
 * `usePluginContributions` returns empty buckets) or when no item targets this
 * surface, so each mounted slot stays invisible until a plugin contributes here.
 */

import { useMemo } from 'react';
import type { UiSurface, UiItemContribution } from '../../../shared/plugins/contributions';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { notifyToast } from '../../stores/notificationStore';

interface PluginUiItemsSlotProps {
	surface: UiSurface;
}

export function PluginUiItemsSlot({ surface }: PluginUiItemsSlotProps) {
	const contributions = usePluginContributions();

	const items = useMemo(
		() => contributions.uiItems.filter((item) => item.surface === surface),
		[contributions.uiItems, surface]
	);

	if (items.length === 0) return null;

	const activate = async (item: UiItemContribution): Promise<void> => {
		try {
			const result = await window.maestro.plugins.invokeCommand(`${item.pluginId}/${item.command}`);
			notifyToast({
				color: result.dispatched ? 'green' : 'orange',
				title: 'Plugins',
				message: result.dispatched ? `Ran "${item.label}"` : `"${item.label}" is not running`,
			});
		} catch (err) {
			notifyToast({ color: 'red', title: 'Plugins', message: `Command failed: ${String(err)}` });
		}
	};

	return (
		<div className="flex items-center gap-1 flex-wrap" data-plugin-uiitems-slot={surface}>
			{items.map((item) => (
				<button
					key={item.id}
					type="button"
					onClick={() => void activate(item)}
					className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
					title={`from ${item.pluginId}`}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}
