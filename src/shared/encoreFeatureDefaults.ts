/**
 * Default Encore Feature flags - the one copy.
 *
 * Read by the renderer settings store, the main-process electron-store
 * defaults, the settings metadata (CLI `settings get` / `settings reset`), and
 * the CLI `encore` command. Main has to carry it too: its gates (the Cue engine
 * start at boot, stats recording) read the raw store, so a default that lived
 * only in the renderer showed a feature as on while main treated it as off.
 *
 * electron-store merges defaults at the top level only, so this reaches an
 * install with no `encoreFeatures` key on disk. A user who already has the
 * object keeps their saved values.
 */
export const ENCORE_FEATURE_DEFAULTS = {
	directorNotes: true,
	usageStats: true,
	symphony: true,
	maestroCue: true,
	pianola: false,
	plugins: false,
	coworking: false,
	opencodeServer: false,
	concerto: false,
	groupsPlus: false,
} as const satisfies Readonly<Record<string, boolean>>;

/** The flag shape these defaults describe, derived so the two cannot drift. */
export type EncoreFeatureDefaults = {
	-readonly [K in keyof typeof ENCORE_FEATURE_DEFAULTS]: boolean;
};

/**
 * Merge whatever is persisted onto the defaults.
 *
 * Only a real boolean overrides a default. A key the user never saw must fall
 * back to its default rather than to `undefined` -> false, which is exactly how
 * the main-process gates used to silently disable a feature the UI reported as
 * on: four processes read these flags (renderer store, settings metadata, main
 * gates, CLI `maestro-cli encore`) and the last two treated a missing key as
 * off, so on a fresh install - where nothing is persisted yet - the renderer
 * showed Cue ON while the boot gate read OFF and never started the engine.
 *
 * Keys are derived from `ENCORE_FEATURE_DEFAULTS`, never hand-listed, so a
 * newly graduated feature cannot be left out of the merge.
 */
export function resolveEncoreFeatures(raw: unknown): EncoreFeatureDefaults {
	const stored = (raw ?? {}) as Partial<Record<keyof EncoreFeatureDefaults, unknown>>;
	const resolved = { ...ENCORE_FEATURE_DEFAULTS } as Record<string, boolean>;
	for (const key of Object.keys(ENCORE_FEATURE_DEFAULTS)) {
		if (typeof stored[key as keyof EncoreFeatureDefaults] === 'boolean') {
			resolved[key] = stored[key as keyof EncoreFeatureDefaults] as boolean;
		}
	}
	return resolved as EncoreFeatureDefaults;
}
