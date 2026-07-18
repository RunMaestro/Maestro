/**
 * Generalized contribution-registry substrate (pure, bundle-safe).
 *
 * ONE merge contract for every plugin-extensible surface (themes, prompts,
 * commands, docked panels, sidebar items, ...), applying one collision rule:
 *  - ids are namespaced `<pluginId>/<localId>` for plugin entries, bare for built-ins;
 *  - BUILT-IN ALWAYS WINS a collision (a plugin can never shadow or impersonate a
 *    first-party surface), and an earlier plugin wins over a later duplicate;
 *  - a dropped entry is recorded as an error, never thrown - one bad item never
 *    breaks the surface;
 *  - every entry carries non-suppressible provenance so the UI can always show
 *    where a surface came from (anti-impersonation).
 */

/** Anything mergeable carries a fully-qualified id. */
export interface RegistryEntry {
	id: string;
}

export type Provenance = { source: 'builtin' } | { source: 'plugin'; pluginId: string };

export interface RegisteredItem<T extends RegistryEntry> {
	item: T;
	provenance: Provenance;
}

/** One plugin's entries for a single surface. */
export interface PluginEntries<T extends RegistryEntry> {
	pluginId: string;
	items: readonly T[];
}

export interface MergeResult<T extends RegistryEntry> {
	/** Built-ins first (registration order), then surviving plugin entries. */
	items: RegisteredItem<T>[];
	/** Per-entry errors (collision with a built-in or another plugin). Never throws. */
	errors: string[];
}

/**
 * Merge built-in entries with plugin-contributed entries under the shared
 * contract above. Pure and deterministic.
 */
export function mergeContributions<T extends RegistryEntry>(
	builtins: readonly T[],
	pluginEntries: readonly PluginEntries<T>[]
): MergeResult<T> {
	const errors: string[] = [];
	const byId = new Map<string, RegisteredItem<T>>();

	for (const b of builtins) {
		byId.set(b.id, { item: b, provenance: { source: 'builtin' } });
	}

	for (const { pluginId, items } of pluginEntries) {
		for (const item of items) {
			const existing = byId.get(item.id);
			if (existing) {
				errors.push(
					existing.provenance.source === 'builtin'
						? `plugin "${pluginId}" entry "${item.id}" collides with a built-in and was dropped`
						: `plugin "${pluginId}" entry "${item.id}" duplicates another contribution and was dropped`
				);
				continue;
			}
			byId.set(item.id, { item, provenance: { source: 'plugin', pluginId } });
		}
	}

	return { items: [...byId.values()], errors };
}
