/**
 * Plugin subsystem main-process storage.
 *
 * Resolves the on-disk plugins directory and reads/writes the versioned
 * enable-state file in the Maestro user data dir. Mirrors the pianola store
 * conventions: atomic temp-file + rename writes, validation at the persistence
 * boundary, ENOENT treated as empty. The fs logic lives here (not in src/shared)
 * because src/shared is bundled into the renderer where `fs` is unavailable; the
 * contracts and migrations ARE shared (src/shared/plugins/storage.ts).
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
	PLUGIN_STATE_FILENAME,
	PLUGINS_DIRNAME,
	validatePluginStateFile,
	type PluginStateFile,
} from '../../shared/plugins/storage';

export type { PluginStateFile };

/** Resolve the Maestro data dir, matching the pianola store / CLI semantics. */
function dataDir(): string {
	if (process.env.MAESTRO_USER_DATA) return path.resolve(process.env.MAESTRO_USER_DATA);
	return app.getPath('userData');
}

/** Absolute path to the installed-plugins directory (one folder per plugin). */
export function pluginsDir(): string {
	return path.join(dataDir(), PLUGINS_DIRNAME);
}

function statePath(): string {
	return path.join(dataDir(), PLUGIN_STATE_FILENAME);
}

/**
 * Guard a discovered folder name before it is joined onto pluginsDir().
 * Discovery only ever reads names from readdir, but the installer accepts ids,
 * so a single strict guard here keeps every join inside the plugins dir.
 */
export function isSafePluginFolderName(name: string): boolean {
	if (!name || name.trim() === '') return false;
	const trimmed = name.trim();
	return !(
		trimmed.includes('..') ||
		trimmed.includes('/') ||
		trimmed.includes('\\') ||
		trimmed.startsWith('~') ||
		trimmed.startsWith('.') ||
		path.isAbsolute(trimmed)
	);
}

/** Read and migrate the persisted enable-state. Returns an empty state when
 * the file is missing or unparseable (never throws on bad user data). */
export function readPluginState(): PluginStateFile {
	let content: string;
	try {
		content = fs.readFileSync(statePath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return validatePluginStateFile({});
		}
		throw error;
	}
	try {
		return validatePluginStateFile(JSON.parse(content));
	} catch {
		return validatePluginStateFile({});
	}
}

/**
 * Persist the enable-state. Validated (and migrated to the current schema) at
 * this boundary, then written atomically via temp + rename so a concurrent
 * reader never observes a partial file.
 */
export function writePluginState(state: unknown): PluginStateFile {
	const validated = validatePluginStateFile(state);
	const dir = dataDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const target = statePath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(validated, null, '\t'), 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/** Set one plugin's enabled flag and persist. Returns the new state. */
export function setPluginEnabled(id: string, enabled: boolean): PluginStateFile {
	const current = readPluginState();
	const next: PluginStateFile = {
		...current,
		plugins: { ...current.plugins, [id]: { enabled } },
	};
	return writePluginState(next);
}

/** Forget a plugin's persisted state (used on uninstall). Returns new state. */
export function forgetPlugin(id: string): PluginStateFile {
	const current = readPluginState();
	const plugins = { ...current.plugins };
	delete plugins[id];
	return writePluginState({ ...current, plugins });
}
