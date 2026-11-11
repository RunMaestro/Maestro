import { FIRST_PARTY_PLUGINS } from './plugins/first-party';

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
	webLogin: false,
	computerHistory: false,
	quickChat: true,
	maestroRun: false,
	throughputGauge: false,
	dataview: false,
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

/** The slice of a settings store an Encore gate reads. */
export interface EncoreSettingsReader {
	get(key: string): unknown;
}

/** Whether one Encore Feature is on, read live from a settings store. */
export function isEncoreFeatureEnabled(
	settingsStore: EncoreSettingsReader,
	flag: keyof EncoreFeatureDefaults
): boolean {
	return resolveEncoreFeatures(settingsStore.get('encoreFeatures'))[flag];
}

/**
 * Refuse a request for a switched-off feature: throws `new Error(code)`, the
 * `PluginsDisabled` / `PianolaDisabled` convention, so the caller's IPC error
 * wrapper reports it like any other refusal. A disabled feature must have no
 * effect at all, so every write path of a gated feature calls this first,
 * whoever the caller is (the UI, `maestro-cli`, a web client).
 */
export function requireEncoreFeature(
	settingsStore: EncoreSettingsReader,
	flag: keyof EncoreFeatureDefaults,
	code: string
): void {
	if (!isEncoreFeatureEnabled(settingsStore, flag)) throw new Error(code);
}

/** The name the Plugins tab shows for a feature. */
export function encoreFeatureName(flag: keyof EncoreFeatureDefaults): string {
	return flag === 'plugins' ? 'Community Plugins' : FIRST_PARTY_PLUGINS[flag].name;
}

/** `computerHistory` -> `computer-history`, a spelling `maestro-cli encore enable` accepts. */
export function encoreFeatureCliName(flag: keyof EncoreFeatureDefaults): string {
	return flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * What a request for a switched-off feature says, in every process: the CLI's
 * gated verbs and a main-process service that refuses with readable text
 * rather than a `XDisabled` code.
 */
export function encoreDisabledMessage(flag: keyof EncoreFeatureDefaults): string {
	return `${encoreFeatureName(flag)} is turned off. Turn it on in Settings > Plugins, or run: maestro-cli encore enable ${encoreFeatureCliName(flag)}`;
}
