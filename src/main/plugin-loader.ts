/**
 * Plugin Discovery and Loader
 *
 * Discovers plugins from the userData/plugins/ directory, reads and validates
 * their manifest.json files, and returns LoadedPlugin objects.
 *
 * Plugins with invalid manifests are returned with state 'error' rather than
 * throwing, so that other plugins can still load.
 */

import fs from 'fs/promises';
import path from 'path';
import type { App } from 'electron';
import { logger } from './utils/logger';
import type { PluginManifest, LoadedPlugin } from '../shared/plugin-types';
import { KNOWN_PERMISSIONS } from '../shared/plugin-types';

const LOG_CONTEXT = '[Plugins]';

/**
 * Valid slug pattern: lowercase alphanumeric and hyphens only.
 */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Returns the plugins directory path under userData.
 */
export function getPluginsDir(app: App): string {
	return path.join(app.getPath('userData'), 'plugins');
}

/**
 * Type guard that validates an unknown value is a valid PluginManifest.
 * Checks required fields, slug format, and permissions.
 * Logs warnings for unknown fields (forward compatibility).
 */
export function validateManifest(manifest: unknown): manifest is PluginManifest {
	if (!manifest || typeof manifest !== 'object') {
		return false;
	}

	const obj = manifest as Record<string, unknown>;

	// Required string fields
	const requiredStrings = ['id', 'name', 'version', 'description', 'author', 'main'] as const;
	for (const field of requiredStrings) {
		if (typeof obj[field] !== 'string' || (obj[field] as string).trim() === '') {
			logger.debug(`Manifest validation failed: missing or empty required field '${field}'`, LOG_CONTEXT);
			return false;
		}
	}

	// Validate id is a valid slug
	if (!SLUG_REGEX.test(obj.id as string)) {
		logger.debug(`Manifest validation failed: invalid slug format for id '${obj.id}'`, LOG_CONTEXT);
		return false;
	}

	// Validate permissions array
	if (!Array.isArray(obj.permissions)) {
		logger.debug('Manifest validation failed: permissions must be an array', LOG_CONTEXT);
		return false;
	}

	const knownSet = new Set<string>(KNOWN_PERMISSIONS);
	for (const perm of obj.permissions) {
		if (typeof perm !== 'string' || !knownSet.has(perm)) {
			logger.debug(`Manifest validation failed: unknown permission '${perm}'`, LOG_CONTEXT);
			return false;
		}
	}

	// Log warnings for unknown top-level fields (forward compatibility)
	const knownFields = new Set([
		'id', 'name', 'version', 'description', 'author', 'authorLink',
		'minMaestroVersion', 'main', 'renderer', 'permissions', 'ui',
		'settings', 'tags', 'firstParty',
	]);
	for (const key of Object.keys(obj)) {
		if (!knownFields.has(key)) {
			logger.debug(`Manifest contains unknown field '${key}' (ignored for forward compatibility)`, LOG_CONTEXT);
		}
	}

	return true;
}

/**
 * Loads a single plugin from a directory path.
 * Reads manifest.json, validates it, and returns a LoadedPlugin.
 * On validation failure, returns a LoadedPlugin with state 'error'.
 */
export async function loadPlugin(pluginPath: string): Promise<LoadedPlugin> {
	const manifestPath = path.join(pluginPath, 'manifest.json');

	// Create a minimal error manifest for failure cases
	const errorPlugin = (error: string): LoadedPlugin => ({
		manifest: {
			id: path.basename(pluginPath),
			name: path.basename(pluginPath),
			version: '0.0.0',
			description: '',
			author: '',
			main: '',
			permissions: [],
		},
		state: 'error',
		path: pluginPath,
		error,
	});

	let raw: string;
	try {
		raw = await fs.readFile(manifestPath, 'utf-8');
	} catch (err) {
		const message = `Failed to read manifest.json: ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(message, LOG_CONTEXT, { pluginPath });
		return errorPlugin(message);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const message = `Invalid JSON in manifest.json: ${err instanceof Error ? err.message : String(err)}`;
		logger.warn(message, LOG_CONTEXT, { pluginPath });
		return errorPlugin(message);
	}

	if (!validateManifest(parsed)) {
		const message = 'Manifest validation failed: check required fields, id format, and permissions';
		logger.warn(message, LOG_CONTEXT, { pluginPath });
		return errorPlugin(message);
	}

	return {
		manifest: parsed,
		state: 'discovered',
		path: pluginPath,
	};
}

/**
 * Scans the plugins directory for subdirectories and loads each one.
 * Creates the plugins directory if it doesn't exist.
 * Non-directory entries are skipped.
 */
export async function discoverPlugins(pluginsDir: string): Promise<LoadedPlugin[]> {
	// Ensure plugins directory exists
	await fs.mkdir(pluginsDir, { recursive: true });

	let entries: string[];
	try {
		entries = await fs.readdir(pluginsDir);
	} catch (err) {
		logger.error(`Failed to read plugins directory: ${err instanceof Error ? err.message : String(err)}`, LOG_CONTEXT);
		return [];
	}

	const plugins: LoadedPlugin[] = [];

	for (const entry of entries) {
		const entryPath = path.join(pluginsDir, entry);

		try {
			const stat = await fs.stat(entryPath);
			if (!stat.isDirectory()) {
				continue;
			}
		} catch {
			continue;
		}

		const plugin = await loadPlugin(entryPath);
		plugins.push(plugin);
	}

	logger.info(`Discovered ${plugins.length} plugin(s) in ${pluginsDir}`, LOG_CONTEXT);
	return plugins;
}
