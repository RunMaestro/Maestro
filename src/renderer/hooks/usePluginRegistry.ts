/**
 * usePluginRegistry - Hook for renderer-side plugin state management
 *
 * Provides plugin list, enable/disable operations, and active plugin tab collection.
 * Used by both the Plugin Manager modal and the Right Panel.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { LoadedPlugin } from '../../shared/plugin-types';

export interface PluginTab {
	pluginId: string;
	tabId: string;
	label: string;
	icon?: string;
}

export interface UsePluginRegistryReturn {
	plugins: LoadedPlugin[];
	loading: boolean;
	refreshPlugins: () => Promise<void>;
	enablePlugin: (id: string) => Promise<void>;
	disablePlugin: (id: string) => Promise<void>;
	getActivePlugins: () => LoadedPlugin[];
	getPluginTabs: () => PluginTab[];
}

export function usePluginRegistry(): UsePluginRegistryReturn {
	const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
	const [loading, setLoading] = useState(true);

	const refreshPlugins = useCallback(async () => {
		try {
			const all = await window.maestro.plugins.getAll();
			setPlugins(all);
		} catch (err) {
			console.error('Failed to fetch plugins:', err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refreshPlugins();
	}, [refreshPlugins]);

	const enablePlugin = useCallback(
		async (id: string) => {
			await window.maestro.plugins.enable(id);
			await refreshPlugins();
		},
		[refreshPlugins]
	);

	const disablePlugin = useCallback(
		async (id: string) => {
			await window.maestro.plugins.disable(id);
			await refreshPlugins();
		},
		[refreshPlugins]
	);

	const getActivePlugins = useCallback(() => {
		return plugins.filter((p) => p.state === 'active');
	}, [plugins]);

	const getPluginTabs = useCallback((): PluginTab[] => {
		const tabs: PluginTab[] = [];
		for (const plugin of plugins) {
			if (plugin.state !== 'active') continue;
			const rightPanelTabs = plugin.manifest.ui?.rightPanelTabs;
			if (!rightPanelTabs) continue;
			for (const tab of rightPanelTabs) {
				tabs.push({
					pluginId: plugin.manifest.id,
					tabId: tab.id,
					label: tab.label,
					icon: tab.icon,
				});
			}
		}
		return tabs;
	}, [plugins]);

	return useMemo(
		() => ({
			plugins,
			loading,
			refreshPlugins,
			enablePlugin,
			disablePlugin,
			getActivePlugins,
			getPluginTabs,
		}),
		[plugins, loading, refreshPlugins, enablePlugin, disablePlugin, getActivePlugins, getPluginTabs]
	);
}
