import { isProvidedPluginId } from '../../shared/plugins/provided';
import type { PluginRecord, PluginRegistry } from '../../shared/plugins/plugin-registry';

export interface ProvidedPluginRuntimeConsentDeps {
	settingsStore: {
		get: (key: string) => unknown;
		set: (key: string, value: unknown) => void;
	};
	manager: {
		getRegistry: () => PluginRegistry;
		refresh: () => PluginRegistry;
	};
}

/**
 * Enables the community-plugin runtime immediately before opening consent for a
 * verified bundled plugin. This deliberately runs only in the main process:
 * renderer data and plugin manifests cannot use it to turn on the runtime.
 */
export function enableProvidedPluginRuntimeForConsent(
	pluginId: string,
	deps: ProvidedPluginRuntimeConsentDeps
): boolean {
	const features = (deps.settingsStore.get('encoreFeatures') ?? {}) as Record<string, boolean>;
	if (features.plugins === true) return true;
	const record: PluginRecord | undefined = deps.manager
		.getRegistry()
		.records.find((candidate) => candidate.id === pluginId);
	if (!isProvidedPluginId(pluginId) || record?.installOwner !== 'bundle') return false;

	deps.settingsStore.set('encoreFeatures', { ...features, plugins: true });
	deps.manager.refresh();
	return true;
}
