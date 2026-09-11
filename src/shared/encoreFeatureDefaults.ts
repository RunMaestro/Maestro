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
