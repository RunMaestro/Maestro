/**
 * Plugin subsystem storage contract: on-disk filenames, the persisted
 * enable-state shape, a schema version, and a forward migration runner.
 *
 * electron-store has no schema-version/migration mechanism, so the plugin
 * subsystem carries its own from day one (a Track B Phase 0 non-negotiable).
 * The migration runner here is generic - it is seeded with the plugin state
 * file's own steps but the `runMigrations` helper is written to be liftable to
 * any other versioned JSON store later.
 *
 * As with the pianola storage contract, validation is hand-rolled and pure so
 * this module is bundle-safe (renderer + main + CLI). The fs read/write lives in
 * the main process (src/main/plugins/plugin-store-main.ts).
 */

/** Filename of the persisted plugin enable-state, in the Maestro user data dir. */
export const PLUGIN_STATE_FILENAME = 'pianola-plugins.json';

/** Filename of the persisted per-plugin permission grants. */
export const PLUGIN_GRANTS_FILENAME = 'pianola-plugin-grants.json';

/**
 * Directory name (under user data) where installed plugins live, one folder per
 * plugin, each containing a plugin.json. Kept as a constant so discovery, the
 * installer, and the uninstaller agree.
 */
export const PLUGINS_DIRNAME = 'plugins';

/** Current schema version of the plugin state file. */
export const PLUGIN_STATE_SCHEMA_VERSION = 1;

/** Per-plugin persisted state. Only the user toggle is persisted; everything
 * else (manifest, load status) is re-derived from disk on each discovery. */
export interface PluginStateEntry {
	enabled: boolean;
}

/** The full, versioned plugin state file. */
export interface PluginStateFile {
	schemaVersion: number;
	plugins: Record<string, PluginStateEntry>;
}

/** A single forward migration step for a versioned JSON store. */
export interface MigrationStep {
	/** The schemaVersion this step upgrades FROM. */
	from: number;
	/** The schemaVersion this step produces. */
	to: number;
	/** Pure transform of the raw object from `from`-shape to `to`-shape. */
	migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Generic forward migration runner. Starting from the object's declared
 * `schemaVersion` (or 0 when absent), applies matching steps until it reaches
 * `targetVersion` or runs out of steps. Pure: never mutates the input.
 *
 * Throws only on a genuinely broken migration table (a step that does not
 * advance the version), which is a programming error, not bad user data.
 */
export function runMigrations(
	raw: Record<string, unknown>,
	steps: readonly MigrationStep[],
	targetVersion: number
): Record<string, unknown> {
	let current: Record<string, unknown> = { ...raw };
	let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 0;
	let guard = 0;
	while (version < targetVersion) {
		if (++guard > 100) throw new Error('migration runner exceeded step limit (cycle?)');
		const step = steps.find((s) => s.from === version);
		if (!step) break; // no path forward; caller falls back to defaults
		if (step.to <= step.from)
			throw new Error(`migration step ${step.from}->${step.to} does not advance`);
		current = { ...step.migrate(current), schemaVersion: step.to };
		version = step.to;
	}
	return current;
}

/**
 * Migration steps for the plugin state file.
 *
 * v0 -> v1: the pre-versioning shape was a bare `{ [pluginId]: boolean }` map
 * (no wrapper, no schemaVersion). Wrap each boolean into `{ enabled }` under a
 * `plugins` key. Anything already shaped like v1 falls through untouched because
 * a v1 file declares schemaVersion: 1 and the runner skips it.
 */
export const PLUGIN_STATE_MIGRATIONS: readonly MigrationStep[] = [
	{
		from: 0,
		to: 1,
		migrate: (raw) => {
			// If it already has a `plugins` object, assume it is v1-shaped and keep it.
			if (raw.plugins && typeof raw.plugins === 'object') {
				return { plugins: raw.plugins };
			}
			const plugins: Record<string, PluginStateEntry> = {};
			for (const [key, value] of Object.entries(raw)) {
				if (key === 'schemaVersion') continue;
				if (typeof value === 'boolean') plugins[key] = { enabled: value };
			}
			return { plugins };
		},
	},
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Current schema version of the plugin grants file. */
export const PLUGIN_GRANTS_SCHEMA_VERSION = 1;

/** Persisted per-plugin permission grants. Keyed by plugin id. */
export interface PluginGrantsFile {
	schemaVersion: number;
	grants: Record<string, PersistedGrant[]>;
}

/** Minimal persisted grant shape (kept independent of the permissions module so
 * this storage contract stays free of cross-module coupling). */
export interface PersistedGrant {
	capability: string;
	scope?: string;
	grantedAt: number;
}

/**
 * Validate (and migrate) a parsed grants file. Always returns a well-formed
 * file; malformed grants are dropped. Like the state file, a corrupt hand-edit
 * degrades to an empty grant set rather than throwing, but because grants are a
 * SECURITY boundary, an unparseable entry is dropped (deny) rather than guessed.
 */
export function validatePluginGrantsFile(input: unknown): PluginGrantsFile {
	const raw = isPlainObject(input) ? input : {};
	const grantsRaw = isPlainObject(raw.grants) ? raw.grants : {};
	const grants: Record<string, PersistedGrant[]> = {};
	for (const [pluginId, list] of Object.entries(grantsRaw)) {
		if (!Array.isArray(list)) continue;
		const validated: PersistedGrant[] = [];
		for (const entry of list) {
			if (!isPlainObject(entry)) continue;
			if (typeof entry.capability !== 'string' || entry.capability.trim() === '') continue;
			if (entry.scope !== undefined && typeof entry.scope !== 'string') continue;
			const grantedAt = typeof entry.grantedAt === 'number' ? entry.grantedAt : 0;
			validated.push({
				capability: entry.capability,
				...(typeof entry.scope === 'string' && entry.scope.trim() !== ''
					? { scope: entry.scope }
					: {}),
				grantedAt,
			});
		}
		if (validated.length > 0) grants[pluginId] = validated;
	}
	return { schemaVersion: PLUGIN_GRANTS_SCHEMA_VERSION, grants };
}

/**
 * Validate (and migrate) a parsed plugin state file. Always returns a
 * well-formed PluginStateFile: unknown/old shapes are migrated, invalid entries
 * are dropped, and a totally unrecognizable input degrades to an empty state
 * rather than throwing. The persistence boundary calls this on both read and
 * write so a corrupt hand-edit can never poison the subsystem.
 */
export function validatePluginStateFile(input: unknown): PluginStateFile {
	const raw = isPlainObject(input) ? input : {};
	const migrated = runMigrations(raw, PLUGIN_STATE_MIGRATIONS, PLUGIN_STATE_SCHEMA_VERSION);

	const pluginsRaw = isPlainObject(migrated.plugins) ? migrated.plugins : {};
	const plugins: Record<string, PluginStateEntry> = {};
	for (const [id, entry] of Object.entries(pluginsRaw)) {
		if (isPlainObject(entry) && typeof entry.enabled === 'boolean') {
			plugins[id] = { enabled: entry.enabled };
		}
	}
	return { schemaVersion: PLUGIN_STATE_SCHEMA_VERSION, plugins };
}
