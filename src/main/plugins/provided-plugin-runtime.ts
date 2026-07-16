import { isProvidedPluginId } from '../../shared/plugins/provided';
import type { PluginRegistry } from '../../shared/plugins/plugin-registry';

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
 * Enables and refreshes the provided runtime before a consent or re-enable
 * action. The caller must still check the sealed authorization ledger before
 * enabling code-tier execution.
 */
export function enableProvidedPluginRuntimeForConsent(
	pluginId: string,
	deps: ProvidedPluginRuntimeConsentDeps
): boolean {
	const features = (deps.settingsStore.get('encoreFeatures') ?? {}) as Record<string, boolean>;
	const existing = deps.manager
		.getRegistry()
		.records.find((candidate) => candidate.id === pluginId);
	if (!isProvidedPluginId(pluginId) || existing?.installOwner !== 'bundle') return false;

	if (features.plugins !== true) {
		deps.settingsStore.set('encoreFeatures', { ...features, plugins: true });
	}
	const refreshed = deps.manager.refresh().records.find((candidate) => candidate.id === pluginId);
	return refreshed?.installOwner === 'bundle';
}
