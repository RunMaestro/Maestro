/**
 * Renderer-side adapter over the shared contribution-registry substrate.
 *
 * The ONE place plugin-contributed UI surfaces (command-palette commands, docked
 * panels, themes, ...) get merged with Maestro's first-party built-ins. It wraps
 * `mergeContributions` so every consumer inherits the SAME contract, identical to
 * the seam that already worked for themes/agents:
 *  - BUILT-IN ALWAYS WINS a collision (a plugin can never shadow or impersonate a
 *    first-party surface), and an earlier plugin wins over a later duplicate;
 *  - a dropped entry is recorded as an error, never thrown;
 *  - every surviving entry keeps non-suppressible provenance so the UI can always
 *    show where a surface came from.
 *
 * Pure: no IPC, no Electron. Consumers fetch contributions (gated empty when the
 * `plugins` Encore flag is off) and feed them here, so a disabled feature merges
 * nothing.
 */

import {
	mergeContributions,
	type MergeResult,
	type PluginEntries,
	type RegistryEntry,
} from '../../shared/plugins/contribution-registry';

/** A plugin-contributed UI item always knows which plugin authored it. */
export type PluginScoped = RegistryEntry & { pluginId: string };

/**
 * Bucket a flat list of plugin items into per-plugin entries, preserving the
 * order in which each plugin is first seen. That ordering is what gives the
 * merge its deterministic earlier-plugin-wins behavior on a duplicate id.
 */
export function groupByPlugin<T extends PluginScoped>(items: readonly T[]): PluginEntries<T>[] {
	const order: string[] = [];
	const byPlugin = new Map<string, T[]>();
	for (const item of items) {
		let bucket = byPlugin.get(item.pluginId);
		if (!bucket) {
			bucket = [];
			byPlugin.set(item.pluginId, bucket);
			order.push(item.pluginId);
		}
		bucket.push(item);
	}
	return order.map((pluginId) => ({ pluginId, items: byPlugin.get(pluginId) as readonly T[] }));
}

/**
 * Merge first-party built-ins with flat plugin-contributed items under the
 * shared contract. Built-ins win every collision; provenance is retained on each
 * surviving item so the caller can render "from <plugin>".
 */
export function mergePluginContributions<T extends RegistryEntry>(
	builtins: readonly T[],
	pluginItems: readonly (T & { pluginId: string })[]
): MergeResult<T> {
	return mergeContributions<T>(builtins, groupByPlugin(pluginItems));
}
