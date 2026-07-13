/**
 * Host-owned identities for signed plugins distributed with Maestro.
 *
 * This allowlist is intentionally separate from plugin manifests and the
 * first-party Encore feature registry. A plugin.json can claim an id here but
 * can never grant itself provided/first-party presentation or lifecycle policy.
 */
export const PROVIDED_PLUGIN_IDS = ['com.maestro.omp'] as const;

export type ProvidedPluginId = (typeof PROVIDED_PLUGIN_IDS)[number];

export function isProvidedPluginId(id: string): id is ProvidedPluginId {
	return (PROVIDED_PLUGIN_IDS as readonly string[]).includes(id);
}
