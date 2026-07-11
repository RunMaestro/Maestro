/**
 * usePluginContributions - the renderer's read seam for active plugin
 * contributions (themes, prompts, command macros, settings, ...).
 *
 * Fetches the aggregated contributions over IPC on mount and re-fetches whenever
 * the plugin registry changes (install/uninstall/enable/disable). When the
 * `plugins` Encore flag is off the IPC rejects with 'PluginsDisabled'; that is
 * treated as "feature off" and the hook returns empty buckets, so consumers can
 * call it unconditionally and merge nothing when plugins are disabled.
 */

import { useState, useEffect } from 'react';
import type { AggregatedContributions } from '../../shared/plugins/contributions';

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

export function usePluginContributions(): AggregatedContributions {
	const [contributions, setContributions] = useState<AggregatedContributions>(EMPTY);

	useEffect(() => {
		// The plugins API is absent in the web build (and before the preload bridge
		// is ready); treat that exactly like feature-off and stay on empty buckets.
		const plugins = window.maestro?.plugins;
		if (!plugins) return;

		let cancelled = false;

		const load = async (): Promise<void> => {
			try {
				const next = await plugins.contributions();
				if (!cancelled) setContributions(next);
			} catch {
				// 'PluginsDisabled' or any read failure -> behave as feature-off.
				if (!cancelled) setContributions(EMPTY);
			}
		};

		void load();
		const unsubscribe = plugins.onChanged(() => {
			void load();
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	return contributions;
}
