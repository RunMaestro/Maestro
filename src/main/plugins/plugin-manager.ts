/**
 * Plugin manager (main process).
 *
 * Owns discovery and lifecycle for installed plugins. Phase 0 deliberately does
 * NOT execute any plugin code or wire `contributes` into host registries - it
 * discovers plugin folders, validates their manifests, derives a registry, and
 * persists the user's enable/disable toggle. That makes the whole subsystem
 * inert by default (gated behind the `plugins` Encore flag) while establishing
 * the permanent contract every later tier builds on.
 *
 * Side effects (fs, logging) live here; the rules (validation, registry shape,
 * migrations) are pure and shared.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HOST_API_VERSION } from '../../shared/plugins/host-api';
import {
	buildRecord,
	emptyRegistry,
	listActive,
	removeRecord,
	setEnabled,
	upsertRecord,
	type PluginRecord,
	type PluginRegistry,
} from '../../shared/plugins/plugin-registry';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/plugin-manifest';
import {
	aggregateContributions,
	type AggregatedContributions,
} from '../../shared/plugins/contributions';
import {
	pluginsDir,
	readPluginState,
	setPluginEnabled,
	forgetPlugin,
	isSafePluginFolderName,
} from './plugin-store-main';

const MANIFEST_FILENAME = 'plugin.json';

export interface PluginManagerDeps {
	/** Whether the `plugins` Encore flag is currently on. Re-read on every call. */
	isEnabled: () => boolean;
	/** Optional change hook (e.g. to broadcast to the renderer) after mutations. */
	onChange?: (registry: PluginRegistry) => void;
}

export interface InstallResult {
	success: boolean;
	record?: PluginRecord;
	error?: string;
}

/**
 * Discovers and tracks installed plugins. Stateless between calls except for a
 * cached registry; discovery re-reads disk so external changes (manual install,
 * uninstall) are picked up on the next refresh.
 */
export class PluginManager {
	private registry: PluginRegistry = emptyRegistry();

	constructor(private readonly deps: PluginManagerDeps) {}

	/** The last discovered registry (call refresh() to rebuild from disk). */
	getRegistry(): PluginRegistry {
		return this.registry;
	}

	/** Records the host should activate (enabled AND loadable). Empty when the
	 * Encore flag is off, regardless of what is on disk. */
	getActiveRecords(): PluginRecord[] {
		if (!this.deps.isEnabled()) return [];
		return listActive(this.registry);
	}

	/**
	 * Tier 0 contributions aggregated across all active plugins. Empty when the
	 * Encore flag is off. This is the single seam host registries (theme picker,
	 * prompt catalog, command palette) read plugin-supplied data from.
	 */
	getContributions(): AggregatedContributions {
		const manifests = this.getActiveRecords()
			.map((r) => r.manifest)
			.filter((m): m is PluginManifest => m !== null);
		return aggregateContributions(manifests);
	}

	/**
	 * Rebuild the registry from disk: read each folder's plugin.json, validate,
	 * apply the persisted enable toggle (defaulting newly seen plugins to
	 * enabled), and host-compatibility-check. Returns the new registry. When the
	 * Encore flag is off this returns an empty registry without touching disk.
	 */
	refresh(): PluginRegistry {
		if (!this.deps.isEnabled()) {
			this.registry = emptyRegistry();
			return this.registry;
		}

		const dir = pluginsDir();
		let folders: string[];
		try {
			folders = fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.filter(isSafePluginFolderName);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.registry = emptyRegistry();
				return this.registry;
			}
			throw error;
		}

		const state = readPluginState();
		let next = emptyRegistry();
		for (const folder of folders) {
			const source = path.join(dir, folder);
			const rawManifest = this.readManifest(source);
			// A folder without a readable manifest still gets a record so the user
			// can see (and uninstall) it; buildRecord marks it invalid.
			const parsed = validatePluginManifest(rawManifest);
			const id = parsed.manifest?.id;
			// Default a never-seen plugin to enabled; respect a stored toggle otherwise.
			const enabled = id && id in state.plugins ? state.plugins[id].enabled : true;
			const record = buildRecord({
				source,
				folderName: folder,
				rawManifest,
				enabled,
				hostVersion: HOST_API_VERSION,
			});
			next = upsertRecord(next, record);
		}

		this.registry = next;
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/** Toggle a plugin on/off, persist, and rebuild the in-memory registry. */
	setEnabled(id: string, enabled: boolean): PluginRegistry {
		if (!this.deps.isEnabled()) return this.registry;
		setPluginEnabled(id, enabled);
		this.registry = setEnabled(this.registry, id, enabled);
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/**
	 * Install a plugin by copying a source directory (which must contain a valid
	 * plugin.json) into the plugins dir under the manifest id. Refuses an invalid
	 * manifest or an id collision with an already-installed plugin.
	 */
	install(sourceDir: string): InstallResult {
		if (!this.deps.isEnabled()) return { success: false, error: 'plugins feature is disabled' };
		const rawManifest = this.readManifest(sourceDir);
		const { manifest, errors } = validatePluginManifest(rawManifest);
		if (!manifest) {
			return { success: false, error: `invalid plugin.json: ${errors.join('; ')}` };
		}
		if (!isSafePluginFolderName(manifest.id)) {
			return { success: false, error: `plugin id "${manifest.id}" is not a safe folder name` };
		}
		const dest = path.join(pluginsDir(), manifest.id);
		if (fs.existsSync(dest)) {
			return { success: false, error: `plugin "${manifest.id}" is already installed` };
		}
		fs.mkdirSync(pluginsDir(), { recursive: true });
		fs.cpSync(sourceDir, dest, { recursive: true });
		this.refresh();
		const record = this.registry.records.find((r) => r.id === manifest.id);
		return { success: true, ...(record ? { record } : {}) };
	}

	/**
	 * Uninstall a plugin: remove its directory and forget its persisted toggle.
	 * No-op (success:false) when the id is unknown.
	 */
	uninstall(id: string): { success: boolean; error?: string } {
		if (!this.deps.isEnabled()) return { success: false, error: 'plugins feature is disabled' };
		const record = this.registry.records.find((r) => r.id === id);
		if (!record) return { success: false, error: `plugin "${id}" is not installed` };
		// Defense in depth: only delete inside the plugins dir.
		const dir = pluginsDir();
		const resolved = path.resolve(record.source);
		if (resolved !== path.resolve(dir, path.basename(resolved)) || !resolved.startsWith(dir)) {
			return { success: false, error: 'refusing to remove a path outside the plugins directory' };
		}
		fs.rmSync(resolved, { recursive: true, force: true });
		forgetPlugin(id);
		this.registry = removeRecord(this.registry, id);
		this.deps.onChange?.(this.registry);
		return { success: true };
	}

	/** Read and JSON-parse a plugin's manifest, or null when absent/unreadable. */
	private readManifest(source: string): unknown {
		try {
			const content = fs.readFileSync(path.join(source, MANIFEST_FILENAME), 'utf-8');
			return JSON.parse(content);
		} catch {
			return null;
		}
	}
}
