/**
 * useEncoreRegistry - Hook for renderer-side encore state management
 *
 * Provides encore list, enable/disable operations, and active encore tab collection.
 * Used by both the Encore Manager modal and the Right Panel.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { LoadedEncore } from '../../shared/encore-types';

export interface EncoreTab {
	encoreId: string;
	tabId: string;
	label: string;
	icon?: string;
}

export interface UseEncoreRegistryReturn {
	encores: LoadedEncore[];
	loading: boolean;
	refreshEncores: () => Promise<void>;
	enableEncore: (id: string) => Promise<void>;
	disableEncore: (id: string) => Promise<void>;
	getActiveEncores: () => LoadedEncore[];
	getEncoreTabs: () => EncoreTab[];
}

export function useEncoreRegistry(): UseEncoreRegistryReturn {
	const [encores, setEncores] = useState<LoadedEncore[]>([]);
	const [loading, setLoading] = useState(true);

	const refreshEncores = useCallback(async () => {
		try {
			const result = await window.maestro.encores.getAll();
			if (result?.success && Array.isArray(result.encores)) {
				setEncores(result.encores);
			} else {
				setEncores([]);
			}
		} catch (err) {
			console.error('Failed to fetch encores:', err);
			setEncores([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refreshEncores();
	}, [refreshEncores]);

	const enableEncore = useCallback(
		async (id: string) => {
			await window.maestro.encores.enable(id);
			await refreshEncores();
		},
		[refreshEncores]
	);

	const disableEncore = useCallback(
		async (id: string) => {
			await window.maestro.encores.disable(id);
			await refreshEncores();
		},
		[refreshEncores]
	);

	const getActiveEncores = useCallback(() => {
		return encores.filter((p) => p.state === 'active');
	}, [encores]);

	const getEncoreTabs = useCallback((): EncoreTab[] => {
		const tabs: EncoreTab[] = [];
		for (const encore of encores) {
			if (encore.state !== 'active') continue;
			const rightPanelTabs = encore.manifest.ui?.rightPanelTabs;
			if (!rightPanelTabs) continue;
			for (const tab of rightPanelTabs) {
				tabs.push({
					encoreId: encore.manifest.id,
					tabId: tab.id,
					label: tab.label,
					icon: tab.icon,
				});
			}
		}
		return tabs;
	}, [encores]);

	return useMemo(
		() => ({
			encores,
			loading,
			refreshEncores,
			enableEncore,
			disableEncore,
			getActiveEncores,
			getEncoreTabs,
		}),
		[encores, loading, refreshEncores, enableEncore, disableEncore, getActiveEncores, getEncoreTabs]
	);
}
