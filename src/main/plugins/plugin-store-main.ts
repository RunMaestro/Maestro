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
	PLUGIN_GRANTS_FILENAME,
	PLUGINS_DIRNAME,
	validatePluginStateFile,
	validatePluginGrantsFile,
	type PluginStateFile,
	type PluginGrantsFile,
} from '../../shared/plugins/storage';
import type { PermissionGrant } from '../../shared/plugins/permissions';

export type { PluginStateFile, PluginGrantsFile };

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

function grantsPath(): string {
	return path.join(dataDir(), PLUGIN_GRANTS_FILENAME);
}

type PluginFileDecoder<T> = (input: unknown) => T;

/**
 * Read one versioned plugin file. Only an absent file and untrusted file bytes
 * degrade to that file type's decoder defaults; operational filesystem failures
 * are deliberately surfaced to callers rather than misreported as no state.
 */
function readPluginFile<T>(target: string, decode: PluginFileDecoder<T>): T {
	let content: string;
	try {
		content = fs.readFileSync(target, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return decode({});
		throw error;
	}

	try {
		return decode(JSON.parse(content));
	} catch {
		return decode({});
	}
}

/**
 * Validate and atomically replace one versioned plugin file. State and grants
 * pass distinct decoders so their schemas and fail-closed behavior stay local
 * to their own persistence contracts.
 */
function writePluginFile<T>(target: string, value: unknown, decode: PluginFileDecoder<T>): T {
	const validated = decode(value);
	const dir = path.dirname(target);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(validated, null, '\t'), 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/**
 * Guard a discovered folder name before it is joined onto pluginsDir().
 * Discovery only ever reads names from readdir, but the installer accepts ids,
 * so a single strict guard here keeps every join inside the plugins dir.
 */
/** Windows reserved device names that must never become a folder name. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export function isSafePluginFolderName(name: string): boolean {
	if (!name || name.trim() === '') return false;
	const trimmed = name.trim();
	if (WINDOWS_RESERVED.test(trimmed)) return false;
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
	return readPluginFile(statePath(), validatePluginStateFile);
}

/**
 * Persist the enable-state. Validated (and migrated to the current schema) at
 * this boundary, then written atomically via temp + rename so a concurrent
 * reader never observes a partial file.
 */
export function writePluginState(state: unknown): PluginStateFile {
	return writePluginFile(statePath(), state, validatePluginStateFile);
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

// --- Permission grants (security boundary) ---

/** Read and validate persisted grants. Empty when missing/unparseable. */
export function readGrantsFile(): PluginGrantsFile {
	return readPluginFile(grantsPath(), validatePluginGrantsFile);
}

/** The grants for one plugin, typed as PermissionGrant[]. Empty when none. */
export function readGrants(pluginId: string): PermissionGrant[] {
	const file = readGrantsFile();
	const list = file.grants[pluginId] ?? [];
	// PersistedGrant.capability is a string; narrow to PluginCapability. The
	// broker's matcher only ever compares against known capabilities, so an
	// unknown stored capability simply never matches (still default-deny).
	return list as PermissionGrant[];
}

/** Persist the grants file (validated at the boundary), atomically. */
export function writeGrantsFile(file: unknown): PluginGrantsFile {
	return writePluginFile(grantsPath(), file, validatePluginGrantsFile);
}

/** Replace one plugin's grants and persist. Returns the new file. */
export function setGrants(pluginId: string, grants: PermissionGrant[]): PluginGrantsFile {
	const current = readGrantsFile();
	const next: PluginGrantsFile = {
		...current,
		grants: { ...current.grants, [pluginId]: grants },
	};
	return writeGrantsFile(next);
}

/** Forget a plugin's grants (used on uninstall / revoke-all). */
export function forgetGrants(pluginId: string): PluginGrantsFile {
	const current = readGrantsFile();
	const grants = { ...current.grants };
	delete grants[pluginId];
	return writeGrantsFile({ ...current, grants });
}
