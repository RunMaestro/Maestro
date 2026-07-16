/**
 * Renders every plugin-contributed `uiItem` whose `surface` matches this slot as
 * a small, unobtrusive button. Activating one fires the plugin's OWN command via
 * the brokered `invokeCommand(`<pluginId>/<command>`)` bridge - the same
 * fire-and-forget contract the menu surface (Quick Actions palette) and docked
 * panels use, so a uiItem can only ever dispatch a command its plugin registered.
 *
 * The `menu` surface is handled separately by the command palette; this shared
 * host-owned slot covers the remaining approved mount points. `status-bar` has
 * no host region today, so nothing mounts it.
 *
 * Renders nothing when the `plugins` Encore flag is off (then
 * `usePluginContributions` returns empty buckets) or when no item targets this
 * surface, so each mounted slot stays invisible until a plugin contributes here.
 */

import { useMemo } from 'react';
import { Circle, Command, PanelRight, Puzzle, Settings } from 'lucide-react';
import {
	isPluginUiSurface,
	type PluginUiSurface,
	type UiItemContribution,
} from '../../../shared/plugins/contributions';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { notifyToast } from '../../stores/notificationStore';

const UI_ITEM_ICONS = {
	action: Command,
	panel: PanelRight,
	plugin: Puzzle,
	settings: Settings,
	status: Circle,
} as const;

type PluginUiItemsSlotPresentation = 'inline' | 'menu';

interface PluginUiItemsSlotProps {
	surface: PluginUiSurface;
	className?: string;
	presentation?: PluginUiItemsSlotPresentation;
	onActivate?: () => void;
}

export function PluginUiItemsSlot({
	surface,
	className,
	onActivate,
	presentation = 'inline',
}: PluginUiItemsSlotProps) {
	const contributions = usePluginContributions();
	// This is a render-boundary backstop, independent of main-process
	// aggregation. A forged renderer object must never convert an arbitrary
	// namespaced contribution id into an addressable trusted-chrome surface.
	const surfaceIsAllowed = isPluginUiSurface(surface);

	const items = useMemo(() => {
		if (!surfaceIsAllowed) return [];
		return contributions.uiItems.filter(
			(item) =>
				item.surface === surface &&
				isPluginUiSurface(item.surface) &&
				item.id === `${item.pluginId}/${item.localId}`
		);
	}, [contributions.uiItems, surface, surfaceIsAllowed]);

	if (!surfaceIsAllowed || items.length === 0) return null;

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

	const isMenu = presentation === 'menu';
	const containerClass = isMenu ? 'flex flex-col' : 'flex items-center gap-1 flex-wrap';
	const itemClass = isMenu
		? 'w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2'
		: 'text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors inline-flex items-center gap-1';

	return (
		<div
			className={className ? `${containerClass} ${className}` : containerClass}
			data-plugin-uiitems-slot={surface}
		>
			{items.map((item) => {
				const Icon = item.icon ? UI_ITEM_ICONS[item.icon as keyof typeof UI_ITEM_ICONS] : undefined;
				const tooltip = item.tooltip
					? `${item.tooltip} · from ${item.pluginId}`
					: `from ${item.pluginId}`;
				return (
					<button
						key={item.id}
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							void activate(item);
							onActivate?.();
						}}
						className={itemClass}
						title={tooltip}
					>
						{Icon && <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />}
						{item.label}
					</button>
				);
			})}
		</div>
	);
}
