/**
 * Plugins IPC Handlers
 *
 * Exposes the (Phase 0, list-only) plugin subsystem to the renderer: list
 * discovered plugins, toggle a plugin on/off, and install/uninstall by path.
 * Thin transport over the main-process PluginManager.
 *
 * Gated at the handler on `encoreFeatures.plugins`. Unlike a read-only feature,
 * a disabled flag throws `'PluginsDisabled'` so the renderer can tell "feature
 * off" from "no plugins installed". The gate runs OUTSIDE withIpcErrorLogging so
 * the sentinel is not logged as an unexpected IPC failure.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { HOST_API_VERSION } from '../../../shared/plugins/host-api';
import type { PluginRecord, PluginRegistry } from '../../../shared/plugins/plugin-registry';
import type { AggregatedContributions } from '../../../shared/plugins/contributions';
import type { PermissionRequest, PermissionGrant } from '../../../shared/plugins/permissions';
import type { PluginManager, InstallResult } from '../../plugins/plugin-manager';
import type { ActivitySnapshot } from '../../plugins/plugin-sandbox-host';
import type { PluginPublishedGrouping } from '../../plugins/plugin-grouping-registry';
import { PLUGIN_ID_PATTERN } from '../../../shared/plugins/plugin-manifest';
import { setPanelHtmlProvider } from '../../plugins/plugin-panel-host';
import { getFirstPartyBridge, type FirstPartyBridgeState } from '../../plugins/first-party-bridge';
import {
	FIRST_PARTY_PLUGINS,
	type FirstPartyEncoreFlag,
} from '../../../shared/plugins/first-party';

const LOG_CONTEXT = '[Plugins]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Serializable snapshot returned by list/toggle channels. */
export interface PluginListSnapshot {
	hostApiVersion: string;
	plugins: PluginRecord[];
}

/** A plugin's requested permissions plus what the user has currently granted. */
export interface PluginGrantsSnapshot {
	requested: PermissionRequest[];
	granted: PermissionGrant[];
}

/** Per-plugin read-only observability keyed by plugin id (running tier-1 only). */
export type PluginActivityMap = Record<string, ActivitySnapshot>;
export type { ActivitySnapshot };
export type PluginGroupingSnapshot = readonly PluginPublishedGrouping[];

export interface PluginsHandlerDependencies {
	settingsStore: {
		get: (key: string) => unknown;
	};
	manager: PluginManager;
	/** Optional read-only observability source for running tier-1 plugins. When
	 *  absent (e.g. before the sandbox host is constructed), activity reads as {}. */
	sandboxHost?: { getActivity(): PluginActivityMap };
	/** Process-local presentation snapshots published by running plugins. */
	groupingRegistry?: { snapshot(): PluginGroupingSnapshot };
	/** The sealed authorization ledger - the live grant source. `get-grants` reads
	 * it, `revoke`/`uninstall` mutate it, and `set-enabled` gates code-tier
	 * activation on it (a tier>=1 plugin may only be enabled once it holds a
	 * consented ledger grant, minted by the consent window). */
	authStore: {
		readGrants: (pluginId: string) => PermissionGrant[];
		revoke: (pluginId: string) => void;
		uninstall: (pluginId: string) => void;
		isEnabled: (pluginId: string) => boolean;
	};
}

/** True only when `encoreFeatures.plugins` is explicitly enabled. Read per call. */
function isPluginsEnabled(settingsStore: { get: (key: string) => unknown }): boolean {
	const ef = (settingsStore.get('encoreFeatures') ?? {}) as Record<string, unknown>;
	return ef.plugins === true;
}

function snapshotOf(registry: PluginRegistry): PluginListSnapshot {
	return { hostApiVersion: HOST_API_VERSION, plugins: registry.records };
}

export function registerPluginsHandlers(deps: PluginsHandlerDependencies): void {
	const { settingsStore, manager, sandboxHost, authStore, groupingRegistry } = deps;

	const wrappedList = withIpcErrorLogging(
		handlerOpts('list'),
		async (): Promise<PluginListSnapshot> => snapshotOf(manager.getRegistry())
	);
	const wrappedSetEnabled = withIpcErrorLogging(
		handlerOpts('setEnabled'),
		async (id: unknown, enabled: unknown): Promise<PluginListSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			if (typeof enabled !== 'boolean') throw new Error('InvalidEnabledFlag');
			if (enabled) {
				const record = manager.getRegistry().records.find((r) => r.id === id);
				const tier = record?.manifest?.tier ?? 0;
				// A code-tier plugin runs sandboxed code, so it may only be enabled once
				// it holds a consented ledger grant (minted by the host-owned consent
				// window via plugins:request-consent). The renderer cannot flip it on.
				if (tier >= 1 && !authStore.isEnabled(id)) throw new Error('PluginNotAuthorized');
			}
			return snapshotOf(manager.setEnabled(id, enabled));
		}
	);
	const wrappedInstall = withIpcErrorLogging(
		handlerOpts('install'),
		async (sourceDir: unknown): Promise<InstallResult> => {
			if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
				throw new Error('InvalidSourceDir');
			}
			return manager.install(sourceDir);
		}
	);
	const wrappedUpdate = withIpcErrorLogging(
		handlerOpts('update'),
		async (sourceDir: unknown): Promise<PluginListSnapshot> => {
			if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
				throw new Error('InvalidSourceDir');
			}
			return snapshotOf(await manager.update(sourceDir));
		}
	);
	const wrappedUninstall = withIpcErrorLogging(
		handlerOpts('uninstall'),
		async (id: unknown): Promise<{ success: boolean; error?: string }> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			const result = manager.uninstall(id);
			// Authoritative removal in the ledger too (tombstone), so a restored folder
			// is recognized as removed-by-user and cannot silently re-enable.
			authStore.uninstall(id);
			return result;
		}
	);
	const wrappedContributions = withIpcErrorLogging(
		handlerOpts('contributions'),
		// Reads are pure: they MUST NOT call refresh(), which reconciles sandboxes
		// and fires onChange -> 'plugins:changed' -> renderer re-fetch -> read again
		// (an infinite IPC loop that freezes the app). Discovery happens at startup
		// and on mutations (install/uninstall/setEnabled).
		async (): Promise<AggregatedContributions> => manager.getContributions()
	);
	const wrappedGetGrants = withIpcErrorLogging(
		handlerOpts('getGrants'),
		async (id: unknown): Promise<PluginGrantsSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			return {
				requested: manager.getRequestedPermissions(id) ?? [],
				granted: authStore.readGrants(id),
			};
		}
	);
	const wrappedGetGroupings = withIpcErrorLogging(
		handlerOpts('getGroupings'),
		async (): Promise<PluginGroupingSnapshot> => groupingRegistry?.snapshot() ?? []
	);
	const wrappedRevokeGrants = withIpcErrorLogging(
		handlerOpts('revokeGrants'),
		async (id: unknown): Promise<PluginGrantsSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			// Revoke drops the sealed grant AND disables the plugin: a code-tier plugin
			// must not keep running without grants.
			authStore.revoke(id);
			manager.setEnabled(id, false);
			return { requested: manager.getRequestedPermissions(id) ?? [], granted: [] };
		}
	);
	const wrappedInvokeCommand = withIpcErrorLogging(
		handlerOpts('invokeCommand'),
		async (commandId: unknown, args: unknown): Promise<{ dispatched: boolean }> => {
			if (typeof commandId !== 'string' || commandId.length === 0) {
				throw new Error('InvalidCommandId');
			}
			return { dispatched: manager.invokeCommand(commandId, args) };
		}
	);
	const wrappedInvokeTool = withIpcErrorLogging(
		handlerOpts('invokeTool'),
		async (toolId: unknown, args: unknown): Promise<{ result: unknown }> => {
			if (typeof toolId !== 'string' || toolId.length === 0) {
				throw new Error('InvalidToolId');
			}
			return { result: await manager.invokeTool(toolId, args) };
		}
	);
	// The render host serves only canonical interactive panel URLs. The provider
	// re-checks the feature flag, owner-bound active contributions, and the
	// current verified snapshot on every document fetch.
	setPanelHtmlProvider((ownerPluginId, panelLocalId) =>
		isPluginsEnabled(settingsStore)
			? manager.getInteractivePanelHtml(ownerPluginId, panelLocalId)
			: null
	);
	const wrappedGetActivity = withIpcErrorLogging(
		handlerOpts('getActivity'),
		async (): Promise<PluginActivityMap> => sandboxHost?.getActivity() ?? {}
	);
	// First-party Encore features: route the marketplace toggle through the
	// host-owned lifecycle bridge (flag flip + grant mint + supervised-work
	// reconcile/stop) instead of a bare settings write. Deliberately NOT gated
	// on `encoreFeatures.plugins` — first-party features are independent of the
	// community-plugin subsystem, and their tiles render even when it is off.
	const wrappedFirstPartySetEnabled = withIpcErrorLogging(
		handlerOpts('firstPartySetEnabled'),
		async (flag: unknown, enabled: unknown): Promise<FirstPartyBridgeState> => {
			if (
				typeof flag !== 'string' ||
				!Object.prototype.hasOwnProperty.call(FIRST_PARTY_PLUGINS, flag)
			) {
				throw new Error('InvalidFirstPartyFlag');
			}
			if (typeof enabled !== 'boolean') throw new Error('InvalidEnabledFlag');
			const bridge = getFirstPartyBridge(flag as FirstPartyEncoreFlag);
			if (!bridge) throw new Error('FirstPartyBridgeUnavailable');
			return bridge.setEnabled(enabled);
		}
	);

	ipcMain.handle('plugins:list', async (event): Promise<PluginListSnapshot> => {
		if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
		return wrappedList(event);
	});

	ipcMain.handle(
		'plugins:set-enabled',
		async (event, id: unknown, enabled: unknown): Promise<PluginListSnapshot> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedSetEnabled(event, id, enabled);
		}
	);

	ipcMain.handle('plugins:install', async (event, sourceDir: unknown): Promise<InstallResult> => {
		if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
		return wrappedInstall(event, sourceDir);
	});

	ipcMain.handle(
		'plugins:update',
		async (event, sourceDir: unknown): Promise<PluginListSnapshot> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedUpdate(event, sourceDir);
		}
	);

	ipcMain.handle(
		'plugins:uninstall',
		async (event, id: unknown): Promise<{ success: boolean; error?: string }> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedUninstall(event, id);
		}
	);

	ipcMain.handle('plugins:contributions', async (event): Promise<AggregatedContributions> => {
		if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
		return wrappedContributions(event);
	});

	ipcMain.handle(
		'plugins:get-grants',
		async (event, id: unknown): Promise<PluginGrantsSnapshot> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedGetGrants(event, id);
		}
	);

	ipcMain.handle(
		'plugins:revoke-grants',
		async (event, id: unknown): Promise<PluginGrantsSnapshot> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedRevokeGrants(event, id);
		}
	);

	ipcMain.handle(
		'plugins:invoke-command',
		async (event, commandId: unknown, args: unknown): Promise<{ dispatched: boolean }> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedInvokeCommand(event, commandId, args);
		}
	);

	ipcMain.handle(
		'plugins:invoke-tool',
		async (event, toolId: unknown, args: unknown): Promise<{ result: unknown }> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedInvokeTool(event, toolId, args);
		}
	);

	ipcMain.handle('plugins:get-activity', async (event): Promise<PluginActivityMap> => {
		if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
		return wrappedGetActivity(event);
	});

	ipcMain.handle('plugins:get-groupings', async (event): Promise<PluginGroupingSnapshot> => {
		if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
		return wrappedGetGroupings(event);
	});

	ipcMain.handle(
		'plugins:first-party-set-enabled',
		async (event, flag: unknown, enabled: unknown): Promise<FirstPartyBridgeState> =>
			wrappedFirstPartySetEnabled(event, flag, enabled)
	);
}
