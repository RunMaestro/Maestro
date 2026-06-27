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
import { createAgentRegistry, type AgentRegistry } from '../../shared/plugins/agent-registry';
import {
	pluginsDir,
	readPluginState,
	setPluginEnabled,
	forgetPlugin,
	forgetGrants,
	isSafePluginFolderName,
} from './plugin-store-main';
import { verifyPluginSignature } from './plugin-signature';

const MANIFEST_FILENAME = 'plugin.json';

/**
 * The sandbox lifecycle the manager drives. PluginSandboxHost implements this
 * structurally; it is injected (optional) so the manager stays testable and the
 * heavy Electron wiring lives in main/index.ts.
 */
export interface PluginSandboxLifecycle {
	start: (pluginId: string, pluginDir: string, entryRelPath: string) => void;
	stop: (pluginId: string) => void;
	stopAll: () => void;
	isRunning: (pluginId: string) => boolean;
	runningIds: () => string[];
	invokeCommand: (pluginId: string, commandId: string, args?: unknown) => boolean;
}

export interface PluginManagerDeps {
	/** Whether the `plugins` Encore flag is currently on. Re-read on every call. */
	isEnabled: () => boolean;
	/** Optional change hook (e.g. to broadcast to the renderer) after mutations. */
	onChange?: (registry: PluginRegistry) => void;
	/** Trusted publisher public keys (base64) for signature verification. */
	trustedKeys?: () => string[];
	/** Optional sandbox controller for running tier-1 plugin code. */
	sandbox?: PluginSandboxLifecycle;
	/** Optional: purge a plugin's host-owned data (KV store, plugins.<id>.*
	 * settings, live event subscriptions) on uninstall. The integrator wires this
	 * to plugin-host-handlers' purgePluginData so uninstall leaves nothing behind
	 * (invariant #8). Separate from forgetPlugin/forgetGrants below, which handle
	 * the enable-state and grants files. */
	purgePluginData?: (pluginId: string) => void;
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
	 * The runtime agent registry: built-in agents plus any agents contributed by
	 * active plugins. Built-ins always win on a collision, so a plugin can never
	 * shadow a first-party agent. Empty of runtime agents when the Encore flag is
	 * off. NOTE: this exposes runtime agents for discovery/UI; actually spawning
	 * one is a separate, security-reviewed step (arbitrary binary execution).
	 */
	getAgentRegistry(): AgentRegistry {
		return createAgentRegistry(this.getContributions().agents);
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
		const trustedKeys = this.deps.trustedKeys?.() ?? [];
		let next = emptyRegistry();
		for (const folder of folders) {
			const source = path.join(dir, folder);
			const rawManifest = this.readManifest(source);
			// A folder without a readable manifest still gets a record so the user
			// can see (and uninstall) it; buildRecord marks it invalid.
			const parsed = validatePluginManifest(rawManifest);
			const id = parsed.manifest?.id;
			const tier = parsed.manifest?.tier ?? 0;
			// Default: tier 0 (data-only) auto-enables on discovery; tier >= 1 runs
			// code, so it stays DISABLED until the user explicitly enables it (the
			// consent gate). A stored toggle always wins over the default.
			const enabled = id && id in state.plugins ? state.plugins[id].enabled : tier === 0;
			const record = buildRecord({
				source,
				folderName: folder,
				rawManifest,
				enabled,
				hostVersion: HOST_API_VERSION,
			});
			// Attach signature trust (the pure builder cannot read files).
			let signed = record;
			try {
				const check = verifyPluginSignature(source, trustedKeys);
				signed = {
					...record,
					signature: {
						status: check.status,
						...(check.signerKey ? { signerKey: check.signerKey } : {}),
						...(check.detail ? { detail: check.detail } : {}),
					},
				};
			} catch {
				// Verification failure is non-fatal for listing; leave signature unset.
			}
			next = upsertRecord(next, signed);
		}

		this.registry = next;
		this.reconcileSandboxes();
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/** Toggle a plugin on/off, persist, rebuild the registry, and reconcile the
	 * sandbox (start a newly-enabled tier-1 plugin, stop a disabled one). */
	setEnabled(id: string, enabled: boolean): PluginRegistry {
		if (!this.deps.isEnabled()) return this.registry;
		setPluginEnabled(id, enabled);
		this.registry = setEnabled(this.registry, id, enabled);
		this.reconcileSandboxes();
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/**
	 * Whether a record is allowed to RUN sandboxed code: enabled, loadable, a
	 * code tier, has an entry, and its signature is not invalid (tampered code is
	 * never run; unsigned/untrusted may run once the user has enabled = consented).
	 */
	private isRunnable(record: PluginRecord): boolean {
		return (
			record.enabled &&
			record.loadStatus === 'ok' &&
			!!record.manifest &&
			record.manifest.tier >= 1 &&
			!!record.manifest.entry &&
			record.signature?.status !== 'invalid'
		);
	}

	/**
	 * Start sandboxes that should be running and stop those that should not. Safe
	 * to call repeatedly; no-op when no sandbox controller is injected.
	 */
	private reconcileSandboxes(): void {
		const sandbox = this.deps.sandbox;
		if (!sandbox) return;
		const shouldRun = new Set<string>();
		for (const record of this.registry.records) {
			if (!this.isRunnable(record) || !record.manifest?.entry) continue;
			shouldRun.add(record.id);
			if (!sandbox.isRunning(record.id)) {
				try {
					sandbox.start(record.id, record.source, record.manifest.entry);
				} catch {
					// A failed start is isolated to that plugin; leave it stopped.
				}
			}
		}
		// Stop anything running that should no longer run (disabled, uninstalled,
		// or now-invalid), using the sandbox's own view of what is alive.
		for (const id of sandbox.runningIds()) {
			if (!shouldRun.has(id)) sandbox.stop(id);
		}
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
		// Reject a source tree containing symlinks: they can point outside the
		// plugin dir (a read/write escape) and would otherwise be copied verbatim.
		if (containsSymlink(sourceDir)) {
			return { success: false, error: 'plugin source contains symlinks, which are not allowed' };
		}
		fs.mkdirSync(pluginsDir(), { recursive: true });
		// dereference:false keeps the copy faithful; we already rejected symlinks.
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
		// Stop any running sandbox for this plugin before removing its files, then
		// purge everything it owns: enable toggle, permission grants, and (via the
		// injected host-data purge) its KV store, plugins.<id>.* settings, and live
		// event subscriptions - so uninstall leaves nothing behind (invariant #8).
		this.deps.sandbox?.stop(id);
		fs.rmSync(resolved, { recursive: true, force: true });
		forgetPlugin(id);
		forgetGrants(id);
		this.deps.purgePluginData?.(id);
		this.registry = removeRecord(this.registry, id);
		this.deps.onChange?.(this.registry);
		return { success: true };
	}

	/** Stop all sandboxes (app shutdown / feature disable). */
	stopAllSandboxes(): void {
		this.deps.sandbox?.stopAll();
	}

	/** The permissions a plugin's manifest requests (empty for tier 0 / unknown). */
	getRequestedPermissions(id: string): PluginManifest['permissions'] {
		const record = this.registry.records.find((r) => r.id === id);
		return record?.manifest?.permissions ?? [];
	}

	/**
	 * Invoke a contributed command. `commandId` is the namespaced contribution id
	 * (`<pluginId>/<localId>`); the local part is dispatched into the plugin's
	 * sandbox. Returns false if the plugin is not running or the id is malformed.
	 */
	invokeCommand(commandId: string, args?: unknown): boolean {
		const sep = commandId.indexOf('/');
		if (sep <= 0) return false;
		const pluginId = commandId.slice(0, sep);
		const localId = commandId.slice(sep + 1);
		return this.deps.sandbox?.invokeCommand(pluginId, localId, args) ?? false;
	}

	/**
	 * Read a contributed panel's HTML, for rendering in a sandboxed iframe. Reads
	 * the panel entry file from inside the (active) plugin's directory, with a
	 * containment check. Returns null if the panel id is unknown or unreadable.
	 */
	getPanelHtml(panelId: string): string | null {
		const contributions = this.getContributions();
		const panel = contributions.panels.find((p) => p.id === panelId);
		if (!panel) return null;
		const record = this.registry.records.find((r) => r.id === panel.pluginId);
		if (!record) return null;
		const dir = path.resolve(record.source);
		const entryAbs = path.resolve(dir, panel.entry);
		if (entryAbs !== dir && !entryAbs.startsWith(dir + path.sep)) return null;
		try {
			return fs.readFileSync(entryAbs, 'utf-8');
		} catch {
			return null;
		}
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

/** Does a directory tree contain any symbolic link? Used to refuse installing a
 * plugin whose files could escape the plugin directory via a symlink. */
function containsSymlink(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) return true;
		if (entry.isDirectory() && containsSymlink(path.join(dir, entry.name))) return true;
	}
	return false;
}
