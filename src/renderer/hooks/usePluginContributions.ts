/**
 * usePluginContributions - the renderer's read seam for active plugin
 * contributions (themes, prompts, command macros, settings, ...).
 *
 * Fetches the aggregated contributions over IPC on mount and re-fetches whenever
 * the plugin registry changes (install/uninstall/enable/disable). When the
 * `plugins` Encore flag is off the hook makes no IPC call and holds no
 * subscription: it returns empty buckets, so consumers can call it
 * unconditionally and merge nothing when plugins are disabled. Switching the
 * flag on re-runs the read. (Main also rejects the IPC with 'PluginsDisabled';
 * that is treated as feature-off too.)
 */

import { useState, useEffect } from 'react';
import type { AggregatedContributions } from '../../shared/plugins/contributions';
import { useSettingsStore } from '../stores/settingsStore';

const EMPTY: AggregatedContributions = {
	themes: [],
	iconPacks: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	agents: [],
	tools: [],
	keybindings: [],
	uiItems: [],
	hostViews: [],
	groupings: [],
	errorsByPlugin: {},
};

export function usePluginContributions(): AggregatedContributions & { isLoading: boolean } {
	const [contributions, setContributions] = useState<
		AggregatedContributions & { isLoading: boolean }
	>({ ...EMPTY, isLoading: true });
	const pluginsEnabled = useSettingsStore((s) => s.encoreFeatures?.plugins === true);

	useEffect(() => {
		// The plugins API is absent in the web build (and before the preload bridge
		// is ready); treat that exactly like feature-off and stay on empty buckets.
		const plugins = window.maestro?.plugins;
		if (!pluginsEnabled || !plugins) {
			setContributions({ ...EMPTY, isLoading: false });
			return;
		}

		let cancelled = false;
		let requestGeneration = 0;

		const load = async (): Promise<void> => {
			const generation = ++requestGeneration;
			try {
				const next = await plugins.contributions();
				if (!cancelled && generation === requestGeneration)
					setContributions({ ...next, isLoading: false });
			} catch {
				// 'PluginsDisabled' or any read failure -> behave as feature-off.
				if (!cancelled && generation === requestGeneration)
					setContributions({ ...EMPTY, isLoading: false });
			}
		};

		void load();
		const unsubscribe = plugins.onChanged((activePanelIds) => {
			// The host sends live, grant-filtered panel IDs. Remove revoked guests
			// immediately while retaining unaffected guests and their unsaved edits.
			// A legacy notification without IDs cannot confirm eligibility.
			setContributions((previous) => ({
				...EMPTY,
				isLoading: true,
				// Groupings are presentation-only. A transient empty list makes the
				// sidebar persist its manual fallback, losing the selected grouping.
				// Keep them until the authoritative read confirms removal or fails.
				groupings: previous.groupings,
				panels: previous.panels.filter((panel) => activePanelIds?.includes(panel.id)),
			}));
			void load();
		});

		return () => {
			cancelled = true;
			requestGeneration++;
			unsubscribe();
		};
	}, [pluginsEnabled]);

	return contributions;
}
