/**
 * IPC guard helper for Encore-gated features.
 *
 * Usage inside a handler registration function:
 *
 *   const gate = requireEncoreFeature(settingsStore, 'agentDispatch');
 *   if (gate) return gate;  // early-return the structured error to the caller
 *
 * Returns `null` when the feature is enabled (caller should proceed normally).
 * Returns a `FeatureDisabledError` object when the feature flag is off or unknown.
 *
 * The error shape is intentionally data-only so it survives the IPC bridge
 * without serialisation issues.
 */

import type { SettingsStoreInterface } from '../stores/types';

/**
 * Canonical error object returned when an encore feature is disabled.
 *
 * Includes `error` so it is assignable to `{ success: false; error: string }`
 * shaped IPC result types without a cast.
 */
export interface FeatureDisabledError {
	success: false;
	code: 'FEATURE_DISABLED';
	feature: string;
	error: string;
}

/**
 * Check whether `flag` is enabled in the main-process settings store.
 *
 * @param settingsStore - Electron-store instance (or compatible interface) that
 *   holds `encoreFeatures` as a key-value map.
 * @param flag - The feature flag key to check (e.g. `'agentDispatch'`).
 * @returns `null` when the feature is enabled; a {@link FeatureDisabledError}
 *   when it is disabled or not present.
 */
export function requireEncoreFeature(
	settingsStore: SettingsStoreInterface,
	flag: string
): FeatureDisabledError | null {
	const encoreFeatures = settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
	if (encoreFeatures[flag] === true) {
		return null;
	}
	return { success: false, code: 'FEATURE_DISABLED', feature: flag, error: 'FEATURE_DISABLED' };
}
