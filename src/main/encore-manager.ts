/**
 * Plugin Manager
 *
 * Orchestrates the encore lifecycle: discovery, enabling, and disabling.
 * Uses a singleton-via-getter pattern consistent with other Maestro managers.
 */

import type { App } from 'electron';
import type Store from 'electron-store';
import { logger } from './utils/logger';
import { getEncoresDir, discoverEncores, bootstrapBundledEncores } from './encore-loader';
import type { LoadedEncore } from '../shared/encore-types';
import type { EncoreHost } from './encore-host';
import type { MaestroSettings } from './stores/types';

const LOG_CONTEXT = '[Encores]';

/**
 * Manages the lifecycle of all encores.
 */
export class EncoreManager {
	private encores: Map<string, LoadedEncore> = new Map();
	private encoresDir: string;
	private host: EncoreHost | null = null;
	private settingsStore: Store<MaestroSettings> | null = null;

	constructor(app: App) {
		this.encoresDir = getEncoresDir(app);
	}

	/**
	 * Sets the EncoreHost used to create/destroy encore contexts.
	 */
	setHost(host: EncoreHost): void {
		this.host = host;
	}

	/**
	 * Sets the settings store for tracking user-explicit disables.
	 */
	setSettingsStore(store: Store<MaestroSettings>): void {
		this.settingsStore = store;
	}

	/**
	 * Discover and load all encores from the encores directory.
	 * All encores start disabled. Encores the user previously enabled are
	 * re-activated automatically (persisted via `encore:<id>:enabled` flag).
	 */
	async initialize(): Promise<void> {
		// Deactivate any currently active encores before re-scanning
		if (this.host) {
			for (const encore of this.encores.values()) {
				if (encore.state === 'active') {
					try {
						await this.host.deactivateEncore(encore.manifest.id);
					} catch (err) {
						logger.warn(`Failed to deactivate '${encore.manifest.id}' during re-init: ${err}`, LOG_CONTEXT);
					}
				}
			}
		}

		// Copy bundled first-party encores to userData/encores/ if not already present
		await bootstrapBundledEncores(this.encoresDir);

		const discovered = await discoverEncores(this.encoresDir);

		this.encores.clear();
		for (const encore of discovered) {
			this.encores.set(encore.manifest.id, encore);
		}

		const errorCount = discovered.filter((p) => p.state === 'error').length;
		const okCount = discovered.length - errorCount;
		logger.info(
			`Encore system initialized: ${okCount} valid, ${errorCount} with errors`,
			LOG_CONTEXT
		);

		// Re-enable encores the user had previously toggled on
		for (const encore of discovered) {
			if (encore.state !== 'discovered') continue;
			if (!this.isUserEnabled(encore.manifest.id)) continue;

			logger.info(`Restoring enabled encore '${encore.manifest.id}'`, LOG_CONTEXT);
			await this.enableEncore(encore.manifest.id);
		}
	}

	/**
	 * Checks if a user has previously enabled an encore (persisted across restarts).
	 */
	private isUserEnabled(encoreId: string): boolean {
		if (!this.settingsStore) return false;
		return this.settingsStore.get(`encore:${encoreId}:enabled` as any) === true;
	}

	/**
	 * Returns all discovered encores.
	 */
	getEncores(): LoadedEncore[] {
		return Array.from(this.encores.values());
	}

	/**
	 * Returns a specific encore by ID.
	 */
	getEncore(id: string): LoadedEncore | undefined {
		return this.encores.get(id);
	}

	/**
	 * Returns encores with state 'active'.
	 */
	getActiveEncores(): LoadedEncore[] {
		return this.getEncores().filter((p) => p.state === 'active');
	}

	/**
	 * Transitions an encore from 'discovered' or 'disabled' to 'active'.
	 * Calls EncoreHost.activateEncore() which loads and runs the module's activate().
	 */
	async enableEncore(id: string): Promise<boolean> {
		const encore = this.encores.get(id);
		if (!encore) {
			logger.warn(`Cannot enable unknown encore '${id}'`, LOG_CONTEXT);
			return false;
		}

		if (encore.state !== 'discovered' && encore.state !== 'disabled') {
			logger.warn(
				`Cannot enable encore '${id}' in state '${encore.state}'`,
				LOG_CONTEXT
			);
			return false;
		}

		if (this.host) {
			await this.host.activateEncore(encore);
			// activateEncore sets state to 'active' or 'error'
		} else {
			encore.state = 'active';
		}

		// Persist enabled state so the encore restores on next startup
		if (this.settingsStore && encore.state === 'active') {
			this.settingsStore.set(`encore:${id}:enabled` as any, true as any);
		}

		logger.info(`Encore '${id}' enabled (state: ${encore.state})`, LOG_CONTEXT);
		return encore.state === 'active';
	}

	/**
	 * Transitions an encore from 'active' to 'disabled'.
	 * Calls EncoreHost.deactivateEncore() which runs deactivate() and cleans up.
	 */
	async disableEncore(id: string): Promise<boolean> {
		const encore = this.encores.get(id);
		if (!encore) {
			logger.warn(`Cannot disable unknown encore '${id}'`, LOG_CONTEXT);
			return false;
		}

		if (encore.state !== 'active') {
			logger.warn(
				`Cannot disable encore '${id}' in state '${encore.state}'`,
				LOG_CONTEXT
			);
			return false;
		}

		if (this.host) {
			await this.host.deactivateEncore(id);
		}

		encore.state = 'disabled';

		// Clear persisted enabled state
		if (this.settingsStore) {
			this.settingsStore.set(`encore:${id}:enabled` as any, false as any);
		}

		logger.info(`Encore '${id}' disabled`, LOG_CONTEXT);
		return true;
	}

	/**
	 * Returns the encores directory path.
	 */
	getEncoresDir(): string {
		return this.encoresDir;
	}

	/**
	 * Get an encore-scoped setting value.
	 * Keys are namespaced to `encore:<id>:<key>`.
	 */
	getEncoreSetting(encoreId: string, key: string): unknown {
		if (!this.settingsStore) return undefined;
		return this.settingsStore.get(`encore:${encoreId}:${key}` as any);
	}

	/**
	 * Set an encore-scoped setting value.
	 * Keys are namespaced to `encore:<id>:<key>`.
	 */
	setEncoreSetting(encoreId: string, key: string, value: unknown): void {
		if (!this.settingsStore) return;
		this.settingsStore.set(`encore:${encoreId}:${key}` as any, value as any);
	}

	/**
	 * Get all settings for a specific encore (stripped of the namespace prefix).
	 */
	getAllEncoreSettings(encoreId: string): Record<string, unknown> {
		if (!this.settingsStore) return {};
		const prefix = `encore:${encoreId}:`;
		const all = this.settingsStore.store;
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(all)) {
			if (k.startsWith(prefix) && !k.endsWith(':enabled')) {
				result[k.slice(prefix.length)] = v;
			}
		}
		return result;
	}
}

// ============================================================================
// Singleton access (consistent with other Maestro managers)
// ============================================================================

let encoreManagerInstance: EncoreManager | null = null;

/**
 * Get the EncoreManager singleton.
 * Returns null if not yet initialized via createEncoreManager().
 */
export function getEncoreManager(): EncoreManager | null {
	return encoreManagerInstance;
}

/**
 * Create and store the EncoreManager singleton.
 * Call this once during app initialization.
 */
export function createEncoreManager(app: App): EncoreManager {
	encoreManagerInstance = new EncoreManager(app);
	return encoreManagerInstance;
}
