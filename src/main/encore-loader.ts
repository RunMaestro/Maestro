/**
 * Plugin Discovery and Loader
 *
 * Discovers encores from the userData/encores/ directory, reads and validates
 * their manifest.json files, and returns LoadedEncore objects.
 *
 * Plugins with invalid manifests are returned with state 'error' rather than
 * throwing, so that other encores can still load.
 */

import fs from 'fs/promises';
import path from 'path';
import type { App } from 'electron';
import { logger } from './utils/logger';
import type { EncoreManifest, LoadedEncore } from '../shared/encore-types';
import { KNOWN_PERMISSIONS } from '../shared/encore-types';

const LOG_CONTEXT = '[Encores]';

/**
 * Valid slug pattern: lowercase alphanumeric and hyphens only.
 */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Returns the encores directory path under userData.
 */
export function getEncoresDir(app: App): string {
	return path.join(app.getPath('userData'), 'encores');
}

/**
 * Type guard that validates an unknown value is a valid EncoreManifest.
 * Checks required fields, slug format, and permissions.
 * Logs warnings for unknown fields (forward compatibility).
 */
export function validateEncoreManifest(manifest: unknown): manifest is EncoreManifest {
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
 * Loads a single encore from a directory path.
 * Reads manifest.json, validates it, and returns a LoadedEncore.
 * On validation failure, returns a LoadedEncore with state 'error'.
 */
export async function loadEncore(pluginPath: string): Promise<LoadedEncore> {
	const manifestPath = path.join(pluginPath, 'manifest.json');

	// Create a minimal error manifest for failure cases
	const errorPlugin = (error: string): LoadedEncore => ({
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

	if (!validateEncoreManifest(parsed)) {
		const message = 'Manifest validation failed: check required fields, id format, and permissions';
		logger.warn(message, LOG_CONTEXT, { pluginPath });
		return errorPlugin(message);
	}

	// Attempt to load README.md if present
	let readme: string | undefined;
	try {
		readme = await fs.readFile(path.join(pluginPath, 'README.md'), 'utf-8');
	} catch {
		// No README — that's fine
	}

	return {
		manifest: parsed,
		state: 'discovered',
		path: pluginPath,
		readme,
	};
}

/**
 * Copies bundled first-party encores from src/encores/ to userData/encores/.
 * Only copies if the encore doesn't already exist in userData (preserves user modifications).
 * On version mismatch, overwrites with the bundled version (first-party encores are always updated).
 */
export async function bootstrapBundledEncores(encoresDir: string): Promise<void> {
	// Resolve bundled encores directory relative to the app root
	// In dev: src/encores/  In production: resources/encores/ (if packaged)
	const bundledDir = path.join(__dirname, '..', 'encores');

	let bundledEntries: string[];
	try {
		bundledEntries = await fs.readdir(bundledDir);
	} catch {
		// No bundled encores directory — this is fine in some build configurations
		logger.debug('No bundled encores directory found, skipping bootstrap', LOG_CONTEXT);
		return;
	}

	await fs.mkdir(encoresDir, { recursive: true });

	// Clean up deprecated/renamed encore directories
	const deprecatedEncores = ['agent-dashboard'];
	for (const oldId of deprecatedEncores) {
		const oldPath = path.join(encoresDir, oldId);
		try {
			await fs.rm(oldPath, { recursive: true, force: true });
			logger.info(`Removed deprecated encore directory '${oldId}'`, LOG_CONTEXT);
		} catch {
			// Doesn't exist or already removed — fine
		}
	}

	for (const entry of bundledEntries) {
		const srcPath = path.join(bundledDir, entry);
		const destPath = path.join(encoresDir, entry);

		try {
			const stat = await fs.stat(srcPath);
			if (!stat.isDirectory()) continue;

			// Check if bundled encore has a valid manifest
			const srcManifestPath = path.join(srcPath, 'manifest.json');
			let srcManifestRaw: string;
			try {
				srcManifestRaw = await fs.readFile(srcManifestPath, 'utf-8');
			} catch {
				continue; // Skip entries without manifest.json
			}

			const srcManifest = JSON.parse(srcManifestRaw);

			// Check if destination already exists
			let shouldCopy = false;
			try {
				const destManifestPath = path.join(destPath, 'manifest.json');
				const destManifestRaw = await fs.readFile(destManifestPath, 'utf-8');
				const destManifest = JSON.parse(destManifestRaw);
				// Overwrite if version differs (update bundled encores)
				if (destManifest.version !== srcManifest.version) {
					shouldCopy = true;
					logger.info(`Updating bundled encore '${entry}' from v${destManifest.version} to v${srcManifest.version}`, LOG_CONTEXT);
				}
			} catch {
				// Destination doesn't exist or has invalid manifest — copy it
				shouldCopy = true;
				logger.info(`Installing bundled encore '${entry}' v${srcManifest.version}`, LOG_CONTEXT);
			}

			if (shouldCopy) {
				// Remove existing destination if it exists
				await fs.rm(destPath, { recursive: true, force: true });

				// Copy entire encore directory (including subdirectories)
				await fs.cp(srcPath, destPath, { recursive: true });
			}
		} catch (err) {
			logger.warn(`Failed to bootstrap bundled encore '${entry}': ${err instanceof Error ? err.message : String(err)}`, LOG_CONTEXT);
		}
	}
}

/**
 * Scans the encores directory for subdirectories and loads each one.
 * Creates the encores directory if it doesn't exist.
 * Non-directory entries are skipped.
 */
export async function discoverEncores(encoresDir: string): Promise<LoadedEncore[]> {
	// Ensure encores directory exists
	await fs.mkdir(encoresDir, { recursive: true });

	let entries: string[];
	try {
		entries = await fs.readdir(encoresDir);
	} catch (err) {
		logger.error(`Failed to read encores directory: ${err instanceof Error ? err.message : String(err)}`, LOG_CONTEXT);
		return [];
	}

	const encores: LoadedEncore[] = [];

	for (const entry of entries) {
		const entryPath = path.join(encoresDir, entry);

		try {
			const stat = await fs.stat(entryPath);
			if (!stat.isDirectory()) {
				continue;
			}
		} catch {
			continue;
		}

		const encore = await loadEncore(entryPath);
		encores.push(encore);
	}

	logger.info(`Discovered ${encores.length} encore(s) in ${encoresDir}`, LOG_CONTEXT);
	return encores;
}
