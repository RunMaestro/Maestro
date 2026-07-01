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
import * as crypto from 'crypto';
import semver from 'semver';
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
import { isPermitted, type PermissionGrant } from '../../shared/plugins/permissions';
import { createAgentRegistry, type AgentRegistry } from '../../shared/plugins/agent-registry';
import {
	pluginsDir,
	readPluginState,
	setPluginEnabled,
	forgetPlugin,
	forgetGrants,
	isSafePluginFolderName,
	readGrants,
} from './plugin-store-main';
import { verifyPluginSignature } from './plugin-signature';
import {
	extractPluginArchive,
	isPackedPluginArchivePath,
	type ExtractedPluginArchive,
} from '../../shared/plugins/plugin-archive';

const MANIFEST_FILENAME = 'plugin.json';

const HOT_RELOAD_DEBOUNCE_MS = 150;

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
	invokeTool: (pluginId: string, commandId: string, args?: unknown) => Promise<unknown>;
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
	/**
	 * Source of a plugin's VERIFIED granted capabilities, used to gate
	 * capability-scoped contributions. Defaults to the on-disk grants store;
	 * production injects the authorization ledger so gating reads sealed,
	 * anti-rollback grants rather than the forgeable plain-JSON store.
	 */
	getGrants?: (pluginId: string) => PermissionGrant[];
	/**
	 * Optional refresh-time authorization gate. For an enabled, runnable code-tier
	 * record, returns whether it must be force-DISABLED because its consented
	 * authorization no longer matches the plugin on disk (identity changed) or the
	 * plugin was removed/tombstoned. Production wires this to the sealed ledger's
	 * `verify()` + `pluginIdentity()`; absent => no extra gate (the enable toggle and
	 * consent govern). It only ever force-disables — never force-enables.
	 */
	verifyRecord?: (record: PluginRecord) => { disable: boolean };
	/** Optional sink for plugin hot-reload watcher/refresh failures. */
	onWatchError?: (error: unknown) => void;
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
	private pluginFingerprints = new Map<string, string>();
	private watchRoot: fs.FSWatcher | null = null;
	private watchedPluginDirs = new Map<string, fs.FSWatcher>();
	private watchRefreshTimer: NodeJS.Timeout | undefined;
	private watchDebounceMs = HOT_RELOAD_DEBOUNCE_MS;

	constructor(private readonly deps: PluginManagerDeps) {}

	/** The last discovered registry (call refresh() to rebuild from disk). */
	getRegistry(): PluginRegistry {
		return this.registry;
	}

	/** Records the host should activate (enabled AND loadable). Empty when the
	 * Encore flag is off, regardless of what is on disk. Tampered code (signature
	 * `invalid`) is excluded here — the single authoritative "active" filter — so
	 * no path (refresh, setEnabled, or any future toggle) can make it contribute,
	 * since `listActive` itself does not check the signature. */
	getActiveRecords(): PluginRecord[] {
		if (!this.deps.isEnabled()) return [];
		return listActive(this.registry).filter((r) => r.signature?.status !== 'invalid');
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
		// Secure-by-default: gate capability-scoped contributions (ui:contribute
		// items, ui:panel panels) by each plugin's VERIFIED grants. The grant source
		// is injected (`deps.getGrants`); production supplies the authorization
		// ledger, so this reads sealed, anti-rollback grants rather than the
		// forgeable plain-JSON store the default falls back to.
		const getGrants = this.deps.getGrants ?? readGrants;
		return aggregateContributions(manifests, (pluginId, cap) =>
			isPermitted(getGrants(pluginId), cap)
		);
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
			this.pluginFingerprints.clear();
			this.reconcileSandboxes();
			this.syncPluginWatchers();
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
				this.pluginFingerprints.clear();
				this.reconcileSandboxes();
				this.syncPluginWatchers();
				return this.registry;
			}
			throw error;
		}

		const state = readPluginState();
		const trustedKeys = this.deps.trustedKeys?.() ?? [];
		let next = emptyRegistry();
		const previousFingerprints = this.pluginFingerprints;
		const nextFingerprints = new Map<string, string>();
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
			// Refresh-time LEDGER authorization gate: a code plugin eligible to be
			// active (enabled, loadable, tier>=1, has entry) is force-DISABLED when the
			// injected gate rejects it (consented identity no longer matches the bytes
			// on disk, or it was removed). Absent by default. Tampered code (signature
			// `invalid`) is enforced separately and centrally in getActiveRecords() +
			// isRunnable(), so it is inert regardless of this gate or the enable toggle.
			let gated = signed;
			if (this.deps.verifyRecord) {
				const eligibleCode =
					signed.enabled &&
					signed.loadStatus === 'ok' &&
					!!signed.manifest &&
					signed.manifest.tier >= 1 &&
					!!signed.manifest.entry;
				if (eligibleCode && this.deps.verifyRecord(signed).disable) {
					gated = { ...signed, enabled: false };
				}
			}
			next = upsertRecord(next, gated);
			nextFingerprints.set(gated.id, this.fingerprintPluginDir(source));
		}

		this.registry = next;
		this.reconcileSandboxes(previousFingerprints, nextFingerprints);
		this.pluginFingerprints = nextFingerprints;
		this.syncPluginWatchers();
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/** Toggle a plugin on/off, persist, rebuild the registry, and reconcile the
	 * sandbox (start a newly-enabled tier-1 plugin, stop a disabled one). */
	setEnabled(id: string, enabled: boolean): PluginRegistry {
		if (!this.deps.isEnabled()) return this.registry;
		setPluginEnabled(id, enabled);
		this.registry = setEnabled(this.registry, id, enabled);
		this.reconcileSandboxes(this.pluginFingerprints, this.pluginFingerprints);
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
	 * to call repeatedly; no-op when no sandbox controller is injected. A runnable
	 * plugin whose on-disk fingerprint changed is deliberately stopped first so
	 * the next start observes the edited manifest/code instead of leaving a stale
	 * sandbox alive.
	 */
	private reconcileSandboxes(
		previousFingerprints = this.pluginFingerprints,
		nextFingerprints = this.pluginFingerprints
	): void {
		const sandbox = this.deps.sandbox;
		if (!sandbox) return;
		const shouldRun = new Set<string>();
		for (const record of this.registry.records) {
			if (!this.isRunnable(record) || !record.manifest?.entry) continue;
			shouldRun.add(record.id);
			const fingerprintChanged =
				previousFingerprints.get(record.id) !== nextFingerprints.get(record.id);
			if (sandbox.isRunning(record.id) && fingerprintChanged) {
				sandbox.stop(record.id);
			}
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
	 * Watch the installed plugin tree and refresh on adds/removes/edits. The
	 * watcher is intentionally thin: refresh() remains the single source of truth
	 * for registry rebuilds and sandbox reconciliation.
	 */
	startWatching(debounceMs = HOT_RELOAD_DEBOUNCE_MS): void {
		if (this.watchRoot) return;
		this.watchDebounceMs = debounceMs;
		try {
			fs.mkdirSync(pluginsDir(), { recursive: true });
			this.watchRoot = fs.watch(pluginsDir(), () => this.scheduleWatchedRefresh());
			this.watchRoot.on('error', (error) => this.deps.onWatchError?.(error));
			this.syncPluginWatchers();
		} catch (error) {
			this.deps.onWatchError?.(error);
			this.stopWatching();
		}
	}

	/** Stop the plugin hot-reload watcher and release all directory handles. */
	stopWatching(): void {
		if (this.watchRefreshTimer) {
			clearTimeout(this.watchRefreshTimer);
			this.watchRefreshTimer = undefined;
		}
		if (this.watchRoot) {
			this.watchRoot.close();
			this.watchRoot = null;
		}
		for (const watcher of this.watchedPluginDirs.values()) {
			watcher.close();
		}
		this.watchedPluginDirs.clear();
	}

	private scheduleWatchedRefresh(): void {
		clearTimeout(this.watchRefreshTimer);
		this.watchRefreshTimer = setTimeout(() => {
			this.watchRefreshTimer = undefined;
			try {
				this.refresh();
			} catch (error) {
				this.deps.onWatchError?.(error);
			}
		}, this.watchDebounceMs);
	}

	private syncPluginWatchers(): void {
		if (!this.watchRoot) return;
		const expected = new Set<string>();
		for (const record of this.registry.records) {
			for (const dir of this.collectWatchableDirs(record.source)) {
				expected.add(dir);
				if (this.watchedPluginDirs.has(dir)) continue;
				try {
					const watcher = fs.watch(dir, () => this.scheduleWatchedRefresh());
					watcher.on('error', (error) => this.deps.onWatchError?.(error));
					this.watchedPluginDirs.set(dir, watcher);
				} catch (error) {
					this.deps.onWatchError?.(error);
				}
			}
		}
		for (const [source, watcher] of this.watchedPluginDirs) {
			if (expected.has(source)) continue;
			watcher.close();
			this.watchedPluginDirs.delete(source);
		}
	}

	private collectWatchableDirs(source: string): string[] {
		const dirs: string[] = [];
		const visit = (dir: string): void => {
			dirs.push(dir);
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.isDirectory() && !entry.isSymbolicLink()) {
					visit(path.join(dir, entry.name));
				}
			}
		};
		visit(source);
		return dirs;
	}

	private fingerprintPluginDir(source: string): string {
		const hash = crypto.createHash('sha256');
		const visit = (dir: string, relDir: string): void => {
			let entries: fs.Dirent[];
			try {
				entries = fs
					.readdirSync(dir, { withFileTypes: true })
					.sort((a, b) => a.name.localeCompare(b.name));
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = path.join(dir, entry.name);
				const rel = relDir ? path.join(relDir, entry.name) : entry.name;
				hash.update(rel.split(path.sep).join('/'));
				hash.update('\0');
				try {
					const stat = fs.lstatSync(abs);
					hash.update(`${stat.mode}:${stat.size}:`);
					if (entry.isDirectory() && !entry.isSymbolicLink()) {
						hash.update('dir\n');
						visit(abs, rel);
					} else if (entry.isFile()) {
						hash.update('file\n');
						hash.update(fs.readFileSync(abs));
					} else if (entry.isSymbolicLink()) {
						hash.update(`link:${fs.readlinkSync(abs)}\n`);
					} else {
						hash.update('other\n');
					}
				} catch {
					hash.update('unreadable\n');
				}
			}
		};
		visit(source, '');
		return hash.digest('hex');
	}

	/**
	 * Copy a validated plugin source directory into the plugins dir under the
	 * manifest id. Refuses an invalid manifest, id collision, or symlinked tree.
	 */
	private installDirectory(sourceDir: string): InstallResult {
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
	 * Install a plugin from a source directory or a packed .tgz/.tar.gz archive.
	 * Archives are extracted into temporary staging outside installed plugins,
	 * reject traversal/link entries before writing, then use the same directory
	 * install path so manifest validation and symlink checks stay centralized.
	 */
	install(sourcePath: string): InstallResult {
		if (!this.deps.isEnabled()) return { success: false, error: 'plugins feature is disabled' };
		const resolvedSource = path.resolve(sourcePath);
		if (!isPackedPluginArchivePath(resolvedSource)) {
			return this.installDirectory(resolvedSource);
		}
		let extracted: ExtractedPluginArchive | null = null;
		try {
			extracted = extractPluginArchive(resolvedSource);
			return this.installDirectory(extracted.root);
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			extracted?.cleanup();
		}
	}

	/**
	 * Update an already-installed plugin in place from a new source directory.
	 *
	 * This is NOT install: the manifest id MUST already be installed. Updating an
	 * id that is not installed REJECTS (callers use install() for a first-time
	 * add) - update never creates a plugin, it only replaces the bytes of one the
	 * user already has. The source version MUST be strictly greater (semver) than
	 * the installed version; a downgrade or an equal version is REJECTED.
	 * Symlinks in the source tree are refused (the same escape guard install()
	 * uses). The running sandbox for the id is stopped before the files are
	 * swapped.
	 *
	 * The swap is atomic and OS-agnostic: the new tree is staged in a temp dir
	 * INSIDE the plugins dir (same filesystem, so fs.renameSync is a real atomic
	 * move on Windows/macOS/Linux), the old dir is moved aside, the staged dir is
	 * renamed into place, and the old dir is only then discarded. On any failure
	 * mid-swap the old dir is restored, so a partial update can never leave the
	 * plugin half-replaced.
	 *
	 * Trust is NOT carried forward: the persisted enable toggle survives (we never
	 * touch the state file, so an enabled plugin stays enabled), but refresh()
	 * re-validates the manifest and re-verifies the signature from the NEW bytes,
	 * so a new (possibly unsigned or tampered) version never inherits the old
	 * version's trust.
	 */
	async update(sourceDir: string): Promise<PluginRegistry> {
		if (!this.deps.isEnabled()) throw new Error('plugins feature is disabled');
		const rawManifest = this.readManifest(sourceDir);
		const { manifest, errors } = validatePluginManifest(rawManifest);
		if (!manifest) {
			throw new Error(`invalid plugin.json: ${errors.join('; ')}`);
		}
		const id = manifest.id;
		if (!isSafePluginFolderName(id)) {
			throw new Error(`plugin id "${id}" is not a safe folder name`);
		}
		const dir = pluginsDir();
		const dest = path.join(dir, id);
		// Update is not install: the id must already be installed on disk.
		if (!fs.existsSync(dest)) {
			throw new Error(`plugin "${id}" is not installed; install it before updating`);
		}
		const installed = validatePluginManifest(this.readManifest(dest)).manifest;
		if (!installed) {
			throw new Error(`installed plugin "${id}" has an unreadable manifest; cannot update`);
		}
		// Require a strictly newer version. Refuse a downgrade or an equal version.
		if (!semver.valid(manifest.version) || !semver.valid(installed.version)) {
			throw new Error(
				`cannot compare versions "${installed.version}" -> "${manifest.version}" (not valid semver)`
			);
		}
		if (!semver.gt(manifest.version, installed.version)) {
			throw new Error(
				`update version ${manifest.version} is not newer than installed ${installed.version}`
			);
		}
		// Reject a source tree containing symlinks (same escape guard as install()).
		if (containsSymlink(sourceDir)) {
			throw new Error('plugin source contains symlinks, which are not allowed');
		}
		// Stage the new tree on the SAME filesystem (inside the plugins dir) so the
		// rename into place is a real atomic move everywhere.
		fs.mkdirSync(dir, { recursive: true });
		const staging = fs.mkdtempSync(path.join(dir, `.update-${id}-`));
		const staged = path.join(staging, id);
		const backup = path.join(staging, `${id}.old`);
		try {
			// dereference:false keeps the copy faithful; we already rejected symlinks.
			fs.cpSync(sourceDir, staged, { recursive: true });
			// Stop the running sandbox before swapping files (mirrors uninstall's stop
			// path); refresh() below restarts it if the new version is still runnable.
			this.deps.sandbox?.stop(id);
			// Move the old dir aside, then move the new one into place. If the second
			// rename fails, restore the old dir so we never leave a partial state.
			fs.renameSync(dest, backup);
			try {
				fs.renameSync(staged, dest);
			} catch (swapError) {
				fs.renameSync(backup, dest);
				throw swapError;
			}
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
		}
		// refresh() re-reads the NEW bytes: re-validates the manifest and recomputes
		// signature trust from scratch. The enable toggle survives because we never
		// touched the persisted state, so an enabled plugin stays enabled.
		return this.refresh();
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
		this.pluginFingerprints.delete(id);
		this.registry = removeRecord(this.registry, id);
		this.syncPluginWatchers();
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
	 * Invoke a contributed tool and await its result. `toolId` is the namespaced
	 * contribution id (`<pluginId>/<localId>`); the local part is dispatched into
	 * the sandbox via a brokered request/response round-trip and the plugin
	 * handler's awaited return value is returned. Rejects if the id is malformed,
	 * no sandbox is wired, or the sandbox rejects (plugin not running, timeout,
	 * early child exit, handler error).
	 */
	invokeTool(toolId: string, args?: unknown): Promise<unknown> {
		const sep = toolId.indexOf('/');
		if (sep <= 0 || sep === toolId.length - 1) {
			return Promise.reject(new Error('InvalidToolId'));
		}
		const pluginId = toolId.slice(0, sep);
		const localId = toolId.slice(sep + 1);
		if (!this.deps.sandbox) return Promise.reject(new Error('sandbox not available'));
		return this.deps.sandbox.invokeTool(pluginId, localId, args);
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
			// Re-resolve symlinks and re-check containment against the REAL path: the
			// string check above is necessary but not sufficient (a symlink placed
			// inside the plugin dir could resolve outside it). Mirrors the fs broker's
			// realpath re-authorization; install()/update() also reject symlinked trees.
			const realDir = fs.realpathSync(dir);
			const realEntry = fs.realpathSync(entryAbs);
			if (realEntry !== realDir && !realEntry.startsWith(realDir + path.sep)) return null;
			return fs.readFileSync(realEntry, 'utf-8');
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
