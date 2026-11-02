import { canonicalJson } from '../../shared/canonicalJson';
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
import semver from 'semver';
import { HOST_API_VERSION } from '../../shared/plugins/host-api';
import {
	buildRecord,
	getRecord,
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
	collectContributions,
	type AggregatedContributions,
} from '../../shared/plugins/contributions';
import {
	isPermitted,
	isPermittedUnattended,
	type PermissionGrant,
} from '../../shared/plugins/permissions';
import { isRelayConversationIdentity } from '../../shared/plugins/relay-identity';
import { pluginJson } from './plugin-authority';
import { relayMailReadOperation } from './relay-mail/contract';
import { captureMailReadRequest } from './relay-mail/mail-service';
import type { RelayMailReader } from './relay-mail/reader';
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
import { createKeyedWriteQueue } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { scanPluginFiles } from './plugin-scan';
import type { AuthIdentity } from './authorization-ledger';
import type { AuthorizationStore } from './authorization-ledger';
import {
	RETIRED_AGENT_FLOW_ID,
	inspectRetiredAgentFlow,
	archiveRetiredAgentFlow,
} from './agent-flow-retirement';
import {
	extractPluginArchive,
	isPackedPluginArchivePath,
	type ExtractedPluginArchive,
} from '../../shared/plugins/plugin-archive';
import {
	PluginToolRunIdentity,
	type PluginToolCallerContext,
	type PluginToolRunAuthority,
} from './plugin-tool-run-identity';
import { PluginToolRunProofFiles, type PluginToolRunProofFile } from './plugin-tool-run-proof-file';
import { assertPluginAuthority } from './plugin-authority';
import { PluginAuthorityError } from './plugin-authority';

const MANIFEST_FILENAME = 'plugin.json';

const HOT_RELOAD_DEBOUNCE_MS = 150;

/**
 * The sandbox lifecycle the manager drives. PluginSandboxHost implements this
 * structurally; it is injected (optional) so the manager stays testable and the
 * heavy Electron wiring lives in main/index.ts.
 */
export interface PluginSandboxLifecycle {
	start: (pluginId: string, pluginDir: string, entryRelPath: string) => void;
	stop: (pluginId: string) => void | Promise<void>;
	stopAll: () => void | Promise<void>;
	isRunning: (pluginId: string) => boolean;
	runningIds: () => string[];
	/** Required for verified tools; captures the exact child, not just a running ID. */
	captureToolLifetime?: (pluginId: string) => () => void;
	invokeCommand: (pluginId: string, commandId: string, args?: unknown) => boolean;
	invokeTool: (
		pluginId: string,
		commandId: string,
		args?: unknown,
		options?: { callerAgentId?: string | null; runContext?: PluginToolCallerContext }
	) => Promise<unknown>;
}

export interface PluginManagerDeps {
	/** Host executor, not an SDK/plugin-selectable implementation. */
	relayMailReader?: RelayMailReader;
	serviceAvailable?: (pluginId: string, requirementId: string) => boolean;
	/** Whether the `plugins` Encore flag is currently on. Re-read on every call. */
	isEnabled: () => boolean;
	/** Optional change hook (e.g. to broadcast to the renderer) after mutations. */
	onChange?: (registry: PluginRegistry) => void;
	/** Trusted publisher public keys (base64) for signature verification. */
	trustedKeys?: () => string[];
	/** Optional sandbox controller for running tier-1 plugin code. */
	sandbox?: PluginSandboxLifecycle;
	/** Host-private verified ingress only; never a model/plugin-supplied registry. */
	toolIdentity?: PluginToolRunIdentity;
	/** Host-private resource owner bound to exactly toolIdentity. No implicit fallback. */
	toolProofFiles?: PluginToolRunProofFiles;
	/** Required only for hardened file issuance: live host storage policy, never plugin input. */
	assertToolProofStorageActive?: () => void;
	/** Required for verified tools: live sealed consent/on-disk identity and generation.
	 * Refresh-time verifyRecord and plain-JSON grants are not substitutes. */
	assertToolRecordActive?: (record: PluginRecord) => void;
	prepareToolRecordActive?: (record: PluginRecord) => Promise<void>;
	/** Optional: purge a plugin's host-owned data (KV store, plugins.<id>.*
	 * settings, live event subscriptions) on uninstall. The integrator wires this
	 * to plugin-host-handlers' purgePluginData so uninstall leaves nothing behind
	 * (invariant #8). Separate from forgetPlugin/forgetGrants below, which handle
	 * the enable-state and grants files. */
	purgePluginData?: (pluginId: string) => void | Promise<void>;
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
	 * consent govern). It only ever force-disables - never force-enables.
	 */
	verifyRecord?: (record: PluginRecord, identity: AuthIdentity | null) => { disable: boolean };
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
	private readonly mutationQueue = createKeyedWriteQueue();
	private readonly pendingMutations = new Map<string, number>();
	private readonly pendingReloads = new Map<string, symbol>();
	private readonly waitingForServiceDependencies = new Set<string>();
	private pluginFingerprints = new Map<string, string>();
	private watchRoot: fs.FSWatcher | null = null;
	private watchedPluginDirs = new Map<string, fs.FSWatcher>();
	private watchRefreshTimer: NodeJS.Timeout | undefined;
	private watchDebounceMs = HOT_RELOAD_DEBOUNCE_MS;
	private toolLifetime: object = {};
	private toolRunLifetime = new AbortController();
	private toolStopping = false;
	private toolAuthorityStopped = false;
	private readonly toolIdentity?: PluginToolRunIdentity;
	private readonly toolProofFiles?: PluginToolRunProofFiles;
	private readonly assertToolProofStorageActive?: () => void;
	private readonly toolSandbox?: PluginSandboxLifecycle;
	private readonly assertToolRecordActive?: (record: PluginRecord) => void;
	private readonly isToolFeatureEnabled: () => boolean;

	constructor(private readonly deps: PluginManagerDeps) {
		this.toolIdentity = deps.toolIdentity;
		this.toolProofFiles = deps.toolProofFiles;
		this.assertToolProofStorageActive =
			typeof deps.assertToolProofStorageActive === 'function'
				? deps.assertToolProofStorageActive.bind(deps)
				: undefined;
		this.toolSandbox = deps.sandbox;
		this.isToolFeatureEnabled = deps.isEnabled.bind(deps);
		this.assertToolRecordActive =
			typeof deps.assertToolRecordActive === 'function'
				? deps.assertToolRecordActive.bind(deps)
				: undefined;
	}

	/** The last discovered registry (call refresh() to rebuild from disk). */
	getRegistry(): PluginRegistry {
		return this.registry;
	}

	/** Host-private verified policy seam. Reuse the reconciled child fingerprint:
	 * re-consenting changed disk bytes cannot authorize an older running child. */
	assertToolRecordCurrent(record: PluginRecord): void {
		try {
			const expected = this.pluginFingerprints.get(record.id);
			if (
				getRecord(this.registry, record.id) !== record ||
				!this.isRunnable(record) ||
				!expected ||
				getRecord(this.registry, record.id) !== record
			)
				throw new PluginAuthorityError('PLUGIN_DENIED');
		} catch {
			throw new PluginAuthorityError('PLUGIN_DENIED');
		}
	}

	async prepareToolRecordCurrent(record: PluginRecord): Promise<AuthIdentity> {
		this.assertToolRecordCurrent(record);
		const keys = this.deps.trustedKeys?.() ?? [];
		const scan = await scanPluginFiles(record.source, keys);
		this.assertToolRecordCurrent(record);
		if (
			!scan.identity ||
			scan.fingerprint !== this.pluginFingerprints.get(record.id) ||
			canonicalJson(keys) !== canonicalJson(this.deps.trustedKeys?.() ?? [])
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		return scan.identity;
	}

	/** Records the host should activate (enabled AND loadable). Empty when the
	 * Encore flag is off, regardless of what is on disk. Tampered code (signature
	 * `invalid`) is excluded here - the single authoritative "active" filter - so
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
		const contributions = aggregateContributions(manifests, (pluginId, cap) =>
			isPermitted(getGrants(pluginId), cap)
		);
		// Settings destinations are executable plugin UI. Fail closed unless the
		// active record has a verified trusted publisher and a live ui:panel grant.
		const trusted = new Set(
			this.getActiveRecords()
				.filter((r) => r.signature?.status === 'trusted')
				.map((r) => r.id)
		);
		contributions.panels = contributions.panels.filter(
			(p) => p.placement !== 'settings' || trusted.has(p.pluginId)
		);
		return contributions;
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
	async refresh(): Promise<PluginRegistry> {
		return this.refreshRegistry();
	}

	/** A completed hot reload must not restart unrelated crashed sandboxes. */
	private async refreshRegistry(onlyPluginId?: string): Promise<PluginRegistry> {
		const before = this.registry;
		if (!this.deps.isEnabled()) {
			this.registry = emptyRegistry();
			this.pluginFingerprints.clear();
			this.reconcileSandboxes();
			this.syncPluginWatchers();
			return this.registry;
		}

		const dir = pluginsDir();
		const onlyPluginSource =
			onlyPluginId === undefined
				? undefined
				: this.registry.records.find((record) => record.id === onlyPluginId)?.source;
		let folders: string[];
		try {
			folders = fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.filter(isSafePluginFolderName)
				.filter(
					(folder) => onlyPluginId === undefined || path.join(dir, folder) === onlyPluginSource
				);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.registry =
					onlyPluginId === undefined ? emptyRegistry() : removeRecord(this.registry, onlyPluginId);
				if (onlyPluginId === undefined) this.pluginFingerprints.clear();
				else this.pluginFingerprints.delete(onlyPluginId);
				this.reconcileSandboxes(this.pluginFingerprints, this.pluginFingerprints, onlyPluginId);
				this.syncPluginWatchers();
				return this.registry;
			}
			throw error;
		}

		const state = readPluginState();
		const trustedKeys = this.deps.trustedKeys?.() ?? [];
		let next =
			onlyPluginId === undefined ? emptyRegistry() : removeRecord(this.registry, onlyPluginId);
		const previousFingerprints = this.pluginFingerprints;
		const nextFingerprints =
			onlyPluginId === undefined ? new Map<string, string>() : new Map(this.pluginFingerprints);
		if (onlyPluginId !== undefined) nextFingerprints.delete(onlyPluginId);
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
			// A scoped reload owns only this identity. Renamed manifests await a
			// normal discovery pass and cannot overwrite another plugin's record.
			if (onlyPluginId !== undefined && record.id !== onlyPluginId) continue;
			// Attach signature trust (the pure builder cannot read files).
			let signed = record;
			let scannedIdentity: AuthIdentity | null = null;
			let fingerprint: string | undefined;
			try {
				const fileScan = await scanPluginFiles(source, trustedKeys);
				const check = fileScan.signature;
				scannedIdentity = fileScan.identity;
				fingerprint = fileScan.fingerprint;
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
			// on disk, or it was removed). Absent by default. Signature trust is
			// enforced separately and centrally: tampered code (`invalid`) is inert via
			// getActiveRecords(), and CODE EXECUTION additionally requires `trusted`
			// via isRunnable() - regardless of this gate or the enable toggle.
			let gated = signed;
			if (this.deps.verifyRecord) {
				const eligibleCode =
					signed.enabled &&
					signed.loadStatus === 'ok' &&
					!!signed.manifest &&
					signed.manifest.tier >= 1 &&
					!!signed.manifest.entry;
				if (eligibleCode && this.deps.verifyRecord(signed, scannedIdentity).disable) {
					gated = { ...signed, enabled: false };
				}
			}
			next = upsertRecord(next, gated);
			if (fingerprint) nextFingerprints.set(gated.id, fingerprint);
		}

		if (
			this.registry !== before ||
			!this.deps.isEnabled() ||
			canonicalJson(trustedKeys) !== canonicalJson(this.deps.trustedKeys?.() ?? [])
		)
			return this.registry;
		this.registry = next;
		this.reconcileSandboxes(previousFingerprints, nextFingerprints, onlyPluginId);
		this.pluginFingerprints = nextFingerprints;
		this.syncPluginWatchers();
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/** Toggle a plugin on/off, persist, rebuild the registry, and reconcile the
	 * sandbox. Code-tier activation must verify the current on-disk identity
	 * against its consented authorization before persisting or starting code;
	 * refresh() applies the same gate to previously enabled plugins. */
	async setEnabled(id: string, enabled: boolean): Promise<PluginRegistry> {
		if (!this.deps.isEnabled()) return this.registry;
		const record = this.registry.records.find((item) => item.id === id);
		const trustedKeys = this.deps.trustedKeys?.() ?? [];
		if (
			enabled &&
			record?.manifest &&
			record.manifest.tier >= 1 &&
			this.deps.verifyRecord?.(record, (await scanPluginFiles(record.source, trustedKeys)).identity)
				.disable
		) {
			throw new Error('PluginNotAuthorized');
		}
		if (
			enabled &&
			(!this.deps.isEnabled() ||
				this.registry.records.find((r) => r.id === id) !== record ||
				canonicalJson(trustedKeys) !== canonicalJson(this.deps.trustedKeys?.() ?? []))
		)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		setPluginEnabled(id, enabled);
		this.registry = setEnabled(this.registry, id, enabled);
		this.reconcileSandboxes(this.pluginFingerprints, this.pluginFingerprints);
		this.deps.onChange?.(this.registry);
		return this.registry;
	}

	/**
	 * Whether a record is allowed to RUN sandboxed code: enabled, loadable, a
	 * code tier, has an entry, and its signature is TRUSTED (Option-B gate:
	 * running code requires a valid signature from a trusted publisher key).
	 * Unsigned/untrusted/tampered plugins never execute code; they remain
	 * installable + enableable for DECLARATIVE contributions only (themes,
	 * prompts, UI slots - see getActiveRecords/getContributions, which
	 * deliberately do NOT use this gate and only exclude tampered `invalid`).
	 * Pass requireAvailableServices=false to identify consumers that meet all
	 * execution gates but must wait for a mandatory service to become available.
	 */
	private isRunnable(record: PluginRecord, requireAvailableServices = true): boolean {
		return (
			this.deps.isEnabled() &&
			!this.pendingMutations.has(record.id) &&
			record.enabled &&
			record.loadStatus === 'ok' &&
			!!record.manifest &&
			record.manifest.tier >= 1 &&
			!!record.manifest.entry &&
			record.signature?.status === 'trusted' &&
			(!requireAvailableServices ||
				(record.manifest.requires ?? []).every(
					(r) => r.optional === true || this.deps.serviceAvailable?.(record.id, r.id) === true
				))
		);
	}

	/** Resume consumers held for missing services; crashes remain owned by their supervisor. */
	reconcileServiceDependencies(): void {
		if (!this.deps.isEnabled()) return;
		const sandbox = this.deps.sandbox;
		if (!sandbox) return;
		for (const record of this.registry.records) {
			if (!record.manifest?.requires?.some((r) => !r.optional)) {
				this.waitingForServiceDependencies.delete(record.id);
				continue;
			}
			if (!this.isRunnable(record)) {
				if (!this.isRunnable(record, false)) this.waitingForServiceDependencies.delete(record.id);
				else if (sandbox.isRunning(record.id)) this.waitingForServiceDependencies.add(record.id);
				if (sandbox.isRunning(record.id)) {
					// Provider registration can race both child exit and resource cleanup.
					// Re-read the current registry and availability only after a successful drain.
					void Promise.resolve(sandbox.stop(record.id)).then(
						() => this.reconcileServiceDependencies(),
						() => {
							/* retain failed cleanup barriers */
						}
					);
				}
			} else if (
				this.waitingForServiceDependencies.has(record.id) &&
				!this.pendingReloads.has(record.id) &&
				!sandbox.isRunning(record.id) &&
				record.manifest.entry
			) {
				try {
					sandbox.start(record.id, record.source, record.manifest.entry);
					this.waitingForServiceDependencies.delete(record.id);
				} catch (error) {
					if (error instanceof Error && error.message === 'PluginDrainPending') continue;
					void captureException(error, { operation: 'plugins:start', pluginId: record.id });
				}
			}
		}
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
		nextFingerprints = this.pluginFingerprints,
		onlyPluginId?: string
	): void {
		const sandbox = this.deps.sandbox;
		if (!sandbox) return;
		for (const id of this.waitingForServiceDependencies) {
			if (!this.registry.records.some((record) => record.id === id))
				this.waitingForServiceDependencies.delete(id);
		}
		const shouldRun = new Set<string>();
		for (const record of this.registry.records) {
			if (onlyPluginId !== undefined && record.id !== onlyPluginId) continue;
			if (!this.isRunnable(record) || !record.manifest?.entry) {
				// Explicit discovery/toggles also remember initially blocked consumers.
				if (this.isRunnable(record, false)) this.waitingForServiceDependencies.add(record.id);
				else this.waitingForServiceDependencies.delete(record.id);
				continue;
			}
			shouldRun.add(record.id);
			if (this.pendingReloads.has(record.id)) continue;
			const fingerprintChanged =
				previousFingerprints.get(record.id) !== nextFingerprints.get(record.id);
			if (sandbox.isRunning(record.id) && fingerprintChanged) {
				const reload = Symbol();
				this.pendingReloads.set(record.id, reload);
				void (async () => {
					try {
						// Stopping closes admission immediately, but the old child and its
						// resources remain owned until this drain completes.
						await sandbox.stop(record.id);
						if (this.pendingReloads.get(record.id) !== reload) return;
						this.pendingReloads.delete(record.id);
						// Re-read identity, enable state and entry after the wait: disable,
						// uninstall, edits or permission changes may have happened meanwhile.
						await this.refreshRegistry(record.id);
					} catch (error) {
						if (this.pendingReloads.get(record.id) === reload)
							this.pendingReloads.delete(record.id);
						logger.warn(`Could not reload plugin "${record.id}": ${String(error)}`, 'Plugins');
						void captureException(error, { operation: 'plugins:reload', pluginId: record.id });
					}
				})();
				continue;
			}
			if (!sandbox.isRunning(record.id)) {
				try {
					sandbox.start(record.id, record.source, record.manifest.entry);
					this.waitingForServiceDependencies.delete(record.id);
				} catch (error) {
					if (error instanceof Error && error.message === 'PluginDrainPending') continue;
					// A failed start is isolated to that plugin; leave it stopped.
					logger.warn(`Could not start plugin "${record.id}": ${String(error)}`, 'Plugins');
					void captureException(error, { operation: 'plugins:start', pluginId: record.id });
				}
			}
		}
		// Stop anything running that should no longer run (disabled, uninstalled,
		// or now-invalid), using the sandbox's own view of what is alive.
		for (const id of sandbox.runningIds()) {
			if (!shouldRun.has(id) && (onlyPluginId === undefined || onlyPluginId === id))
				sandbox.stop(id);
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
		this.watchRefreshTimer = setTimeout(async () => {
			this.watchRefreshTimer = undefined;
			try {
				await this.refresh();
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

	/**
	 * Copy a validated plugin source directory into the plugins dir under the
	 * manifest id. Refuses an invalid manifest, id collision, or symlinked tree.
	 */
	private async installDirectory(sourceDir: string): Promise<InstallResult> {
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
		await this.refresh();
		const record = this.registry.records.find((r) => r.id === manifest.id);
		return { success: true, ...(record ? { record } : {}) };
	}

	/**
	 * Install a plugin from a source directory or a packed .tgz/.tar.gz archive.
	 * Archives are extracted into temporary staging outside installed plugins,
	 * reject traversal/link entries before writing, then use the same directory
	 * install path so manifest validation and symlink checks stay centralized.
	 */
	async install(sourcePath: string): Promise<InstallResult> {
		if (!this.deps.isEnabled()) return { success: false, error: 'plugins feature is disabled' };
		const resolvedSource = path.resolve(sourcePath);
		if (!isPackedPluginArchivePath(resolvedSource)) {
			return this.installDirectory(resolvedSource);
		}
		let extracted: ExtractedPluginArchive | null = null;
		try {
			extracted = extractPluginArchive(resolvedSource);
			return await this.installDirectory(extracted.root);
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
		return this.mutatePlugin(id, async () => {
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
				await this.stopAndDrain(id);
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
			return await this.refresh();
		});
	}

	/**
	 * Uninstall a plugin: remove its directory and forget its persisted toggle.
	 * No-op (success:false) when the id is unknown.
	 */
	uninstall(id: string): Promise<{ success: boolean; error?: string }> {
		return this.mutatePlugin(id, async () => {
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
			await this.stopAndDrain(id);
			fs.rmSync(resolved, { recursive: true, force: true });
			await this.purgeUninstalledPlugin(id);
			return { success: true };
		});
	}

	/** Host-only startup migration, before discovery. Unlike user uninstall this
	 * also completes cleanup when #1740's old package was already removed.
	 * Authorization uses the normal tombstone/freshness contract, never raw storage.
	 * Errors reject; a later run retries even after the package was archived. */
	retireBundledAgentFlow(
		authorization: Pick<AuthorizationStore, 'uninstall'>
	): Promise<{ recoveryPath?: string; preserved?: string }> {
		const id = RETIRED_AGENT_FLOW_ID;
		return this.mutatePlugin(id, async () => {
			if (!this.deps.isEnabled()) return {};
			let inspection = inspectRetiredAgentFlow();
			if (inspection.kind === 'preserved') return { preserved: inspection.reason };
			await this.stopAndDrain(id);
			if (!this.deps.isEnabled()) return {};
			// Recheck after the asynchronous drain: a changed copy must be preserved.
			inspection = inspectRetiredAgentFlow();
			if (inspection.kind === 'preserved') return { preserved: inspection.reason };
			// Inspection, revocation and archive are synchronous from here on.
			// A failed archive/purge must not restart a cached enabled record when
			// mutatePlugin releases its barrier. The next refresh verifies the tombstone.
			this.registry = setEnabled(this.registry, id, false);
			// Revoke before moving/purging: cleanup failure must never retain access.
			authorization.uninstall(id);
			const recoveryPath =
				inspection.kind === 'bundle' ? archiveRetiredAgentFlow(inspection.path) : undefined;
			await this.purgeUninstalledPlugin(id);
			return { recoveryPath };
		});
	}

	private async purgeUninstalledPlugin(id: string): Promise<void> {
		forgetPlugin(id);
		forgetGrants(id);
		// Retire cached admission before cleanup yields or rejects. Failed cleanup
		// must never let mutatePlugin's finally restart an enabled cached record.
		this.pluginFingerprints.delete(id);
		this.waitingForServiceDependencies.delete(id);
		this.registry = removeRecord(this.registry, id);
		try {
			await this.deps.purgePluginData?.(id);
		} finally {
			this.syncPluginWatchers();
			this.deps.onChange?.(this.registry);
		}
	}

	/** Serialize file mutations and suppress all automatic starts until queued work is complete. */
	private async mutatePlugin<T>(id: string, operation: () => Promise<T>): Promise<T> {
		this.pendingMutations.set(id, (this.pendingMutations.get(id) ?? 0) + 1);
		try {
			return await this.mutationQueue.enqueue(id, operation);
		} finally {
			const remaining = (this.pendingMutations.get(id) ?? 1) - 1;
			if (remaining > 0) this.pendingMutations.set(id, remaining);
			else this.pendingMutations.delete(id);
			this.reconcileSandboxes(this.pluginFingerprints, this.pluginFingerprints, id);
			this.reconcileServiceDependencies();
		}
	}

	/** Host mutation barrier: stop invalidates immediately; await confirms exit and media cleanup. */
	async stopAndDrain(id: string): Promise<void> {
		await this.deps.sandbox?.stop(id);
	}

	/** Stop all sandboxes (app shutdown / feature disable). */
	stopAllSandboxes(): void {
		this.pendingReloads.clear();
		this.waitingForServiceDependencies.clear();
		// Invalidate before stop callbacks, including a reentrant stop/restart.
		this.toolLifetime = {};
		const lifetime = this.toolRunLifetime;
		this.toolRunLifetime = new AbortController();
		const wasStopping = this.toolStopping;
		this.toolStopping = true;
		try {
			// Registry abort synchronously revokes proofs/handles and disposes files.
			lifetime.abort();
			this.deps.sandbox?.stopAll();
		} finally {
			this.toolStopping = wasStopping;
		}
	}

	/** Replacement requires fresh authority owners. Sharing them would permanently
	 * retire the candidate while stopping its predecessor. Reject before either changes. */
	assertIndependentToolAuthority(replacement: PluginManager): void {
		if (
			(this.toolIdentity && this.toolIdentity === replacement.toolIdentity) ||
			(this.toolProofFiles && this.toolProofFiles === replacement.toolProofFiles)
		)
			throw new PluginAuthorityError('PLUGIN_CONFLICT');
	}

	/** Host replacement/shutdown only. Ordinary plugin tools remain independent.
	 * Fence permanently before callbacks; repeated calls retry bounded file cleanup
	 * without ever restoring proof authority. Feature toggles use stopAllSandboxes. */
	stopToolAuthority(): void {
		this.toolAuthorityStopped = true;
		this.toolLifetime = {};
		let failed = false;
		try {
			// The registry stops admission before aborting any run/nested handle.
			this.toolIdentity?.stop();
		} catch {
			failed = true;
		}
		try {
			this.toolRunLifetime.abort();
		} catch {
			failed = true;
		}
		try {
			// Attempt cleanup even if another retirement step failed; retain its latch.
			this.toolProofFiles?.stop();
		} catch {
			failed = true;
		}
		if (failed) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
	}

	/** Host spawn lifecycle only; never expose via IPC/RPC or accept model authority.
	 * Production must inject the same registry used by invokeVerifiedTool. */
	createToolRunProofFile(
		agentId: unknown,
		authority: PluginToolRunAuthority,
		ttlMs?: number
	): PluginToolRunProofFile {
		let resource: PluginToolRunProofFile | undefined;
		try {
			const identity = this.toolIdentity;
			const files = this.toolProofFiles;
			const sandbox = this.toolSandbox;
			const assertStorage = this.assertToolProofStorageActive;
			if (
				!(identity instanceof PluginToolRunIdentity) ||
				!(files instanceof PluginToolRunProofFiles) ||
				!sandbox ||
				typeof sandbox.captureToolLifetime !== 'function' ||
				!this.assertToolRecordActive ||
				!assertStorage ||
				!(authority?.signal instanceof AbortSignal) ||
				typeof authority.assertActive !== 'function'
			)
				throw new PluginAuthorityError('PLUGIN_DENIED');
			const source = authority.signal;
			const checkRun = authority.assertActive.bind(authority);
			const lifetime = this.toolRunLifetime;
			const signal = AbortSignal.any([source, lifetime.signal]);
			const assertCurrent = () => {
				if (
					this.toolAuthorityStopped ||
					this.toolStopping ||
					signal.aborted ||
					this.toolRunLifetime !== lifetime ||
					this.deps.toolIdentity !== identity ||
					this.deps.toolProofFiles !== files ||
					this.deps.sandbox !== sandbox
				)
					throw new PluginAuthorityError('PLUGIN_DENIED');
			};
			const assertActive = () => {
				assertCurrent();
				if (!this.isToolFeatureEnabled()) throw new PluginAuthorityError('PLUGIN_DENIED');
				assertCurrent();
				files.assertIdentity(identity);
				assertPluginAuthority(assertStorage);
				assertCurrent();
				assertPluginAuthority(checkRun);
				assertCurrent();
				if (!this.isToolFeatureEnabled()) throw new PluginAuthorityError('PLUGIN_DENIED');
				assertCurrent();
			};
			assertActive();
			resource = files.create(
				agentId,
				Object.freeze({ signal, assertActive, unattended: authority.unattended }),
				ttlMs
			);
			resource.assertActive();
			return resource;
		} catch (error) {
			// Dispose revokes first and latches cleanup failures without disclosing paths.
			resource?.dispose();
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_DENIED'
			);
		}
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
	 * early child exit, handler error). Reserved service: handlers reject with ServiceDenied
	 * before sandbox dispatch; only the host service broker may invoke them.
	 */
	invokeTool(
		toolId: string,
		args?: unknown,
		context: { callerAgentId: string | null } = { callerAgentId: null }
	): Promise<unknown> {
		const sep = toolId.indexOf('/');
		if (sep <= 0 || sep === toolId.length - 1) {
			return Promise.reject(new Error('InvalidToolId'));
		}
		const pluginId = toolId.slice(0, sep);
		const localId = toolId.slice(sep + 1);
		if (localId.startsWith('service:')) return Promise.reject(new Error('ServiceDenied'));
		if (!this.deps.sandbox) return Promise.reject(new Error('sandbox not available'));
		return this.deps.sandbox.invokeTool(pluginId, localId, args, context);
	}

	/** Host-only ingress. The opaque run proof is outside args and never reaches
	 * the child. A trusted synchronous publisher can check retained authority at
	 * the actual send boundary, without another awaited continuation. */
	async invokeVerifiedTool(
		toolId: string,
		args: unknown,
		runProof: unknown,
		publish?: (result: unknown, assertActive: () => void) => void
	): Promise<unknown> {
		let invocationId: string | undefined;
		try {
			if (publish !== undefined && typeof publish !== 'function')
				throw new PluginAuthorityError('PLUGIN_DENIED');
			const identity = this.toolIdentity;
			const sandbox = this.toolSandbox;
			const assertRecord = this.assertToolRecordActive;
			if (
				!(identity instanceof PluginToolRunIdentity) ||
				!sandbox ||
				typeof sandbox.captureToolLifetime !== 'function' ||
				typeof assertRecord !== 'function'
			)
				throw new PluginAuthorityError('PLUGIN_DENIED');
			if (typeof toolId !== 'string') throw new PluginAuthorityError('PLUGIN_INVALID');
			const sep = toolId.indexOf('/');
			if (sep <= 0 || sep === toolId.length - 1) throw new PluginAuthorityError('PLUGIN_INVALID');
			const pluginId = toolId.slice(0, sep);
			const localId = toolId.slice(sep + 1);
			const lifetime = this.toolLifetime;
			const record = getRecord(this.registry, pluginId);
			const declared =
				record?.manifest &&
				collectContributions(record.manifest).tools.find((t) => t.id === toolId);
			const mailOperation = declared ? relayMailReadOperation(declared) : undefined;
			// Snapshot data before asynchronous admission, without executing accessors/toJSON.
			if (mailOperation) captureMailReadRequest(mailOperation, args);
			const readArgs = mailOperation ? pluginJson(args, 16 * 1024) : undefined;
			const assertChild = sandbox.captureToolLifetime(pluginId);
			if (typeof assertChild !== 'function') throw new PluginAuthorityError('PLUGIN_DENIED');
			const assertCurrent = () => {
				if (
					this.toolAuthorityStopped ||
					this.toolStopping ||
					this.toolLifetime !== lifetime ||
					this.deps.sandbox !== sandbox ||
					!record ||
					getRecord(this.registry, pluginId) !== record ||
					!this.isRunnable(record)
				)
					throw new PluginAuthorityError('PLUGIN_DENIED');
			};
			const assertRuntime = () => {
				assertCurrent();
				if (!this.isToolFeatureEnabled()) throw new PluginAuthorityError('PLUGIN_DENIED');
				assertCurrent();
				if (!sandbox.isRunning(pluginId)) throw new PluginAuthorityError('PLUGIN_DENIED');
				assertCurrent();
				assertChild();
				assertCurrent();
				// Canonical pure declaration parser; never fall back to commands or disk grants.
				if (!collectContributions(record!.manifest!).tools.some((tool) => tool.id === toolId))
					throw new PluginAuthorityError('PLUGIN_DENIED');
				assertCurrent();
			};
			assertRuntime();
			// resolve rejects forged/expired proofs without inspecting caller-supplied IDs.
			const context = identity.resolveVerified(runProof);
			const assertActive = () => {
				assertRuntime();
				context.assertActive();
				assertRuntime();
				assertRecord(record!);
				assertRuntime();
				context.assertActive();
				assertRuntime();
				if (
					mailOperation &&
					(!this.deps.relayMailReader ||
						!isRelayConversationIdentity(pluginId, record?.signature) ||
						(context.unattended &&
							!isPermittedUnattended(
								this.deps.getGrants?.(pluginId) ?? [],
								'agents:dispatch',
								context.callerAgentId
							)))
				)
					throw new PluginAuthorityError('PLUGIN_DENIED');
			};
			if (!this.deps.prepareToolRecordActive) throw new PluginAuthorityError('PLUGIN_DENIED');
			await this.deps.prepareToolRecordActive(record!);
			assertActive();
			// Ordinary tools retain sandbox snapshotting and child-owned cleanup.
			// The six known reads use the Host's bounded executor and invocation lease.
			let result: unknown;
			if (mailOperation) {
				invocationId = identity.issueInvocation(context, pluginId, {
					signal: this.toolRunLifetime.signal,
					assertActive,
				});
				result = await this.deps.relayMailReader!.invoke(mailOperation, readArgs, {
					callerAgentId: context.callerAgentId,
					invocationId,
				});
				// Match the existing bounded tool transport; never publish raw MIME or secrets.
				result = pluginJson(result, 1_000_000);
			} else {
				result = await sandbox.invokeTool(pluginId, localId, args, { runContext: context });
			}
			if (!this.deps.prepareToolRecordActive) throw new PluginAuthorityError('PLUGIN_DENIED');
			await this.deps.prepareToolRecordActive(record!);
			assertActive();
			// Host callback only, never plugin/serialized input. Its send must be
			// synchronous and follow its own transport check + this live assertion.
			const assertCompletion = () => {
				assertActive();
				if (invocationId) identity.resolveInvocation(pluginId, invocationId).assertActive();
			};
			assertCompletion();
			publish?.(result, assertCompletion);
			return result;
		} catch (error) {
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_DENIED'
			);
		} finally {
			if (invocationId) this.toolIdentity?.releaseInvocation(invocationId);
		}
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
