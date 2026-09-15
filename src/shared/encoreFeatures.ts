/**
 * Encore Features - the canonical flag shape and default state.
 *
 * A capability starts life gated and off (a plugin). Once it has earned its
 * place in the core experience it graduates to an Encore Feature and ships ON
 * by default; users who don't want it turn it off in Settings > Encore
 * Features. That means "Encore" no longer implies "opt-in", so the default
 * state lives here rather than being re-declared per process.
 *
 * Four processes read these flags (renderer store, settings metadata, main
 * process gates, CLI `maestro-cli encore`). Before this module each one
 * carried its own copy of the defaults, and the main process and CLI simply
 * treated a missing key as `false` - so on a fresh install, where nothing has
 * been persisted yet, the renderer showed a feature ON while the main-process
 * gate for the same feature read OFF. Everything resolves through
 * `resolveEncoreFeatures()` so a stored partial object cannot disagree with
 * what the UI shows.
 */

export interface EncoreFeatureFlags {
	directorNotes: boolean;
	usageStats: boolean;
	symphony: boolean;
	maestroCue: boolean;
}

/**
 * Default state for a user who has never touched the Encore tab. All four
 * features have graduated, so all four are on.
 */
export const DEFAULT_ENCORE_FEATURES: EncoreFeatureFlags = {
	directorNotes: true,
	usageStats: true,
	symphony: true,
	maestroCue: true,
};

/**
 * Merge whatever is persisted (possibly nothing, possibly a partial object
 * written by an older version that had fewer flags) onto the defaults.
 *
 * Only real booleans override a default: a key the user never saw must fall
 * back to the default rather than to `undefined` -> false, which is exactly
 * how main-process gates used to silently disable features the UI reported as
 * on.
 */
export function resolveEncoreFeatures(raw: unknown): EncoreFeatureFlags {
	const stored = (raw ?? {}) as Partial<Record<keyof EncoreFeatureFlags, unknown>>;
	const resolved = { ...DEFAULT_ENCORE_FEATURES };
	for (const key of Object.keys(DEFAULT_ENCORE_FEATURES) as (keyof EncoreFeatureFlags)[]) {
		if (typeof stored[key] === 'boolean') resolved[key] = stored[key] as boolean;
	}
	return resolved;
}
