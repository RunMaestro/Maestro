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
import {
	grantsFromRequests,
	isPluginCapability,
	type PermissionRequest,
	type PermissionGrant,
} from '../../../shared/plugins/permissions';
import type { PluginManager, InstallResult } from '../../plugins/plugin-manager';
import { readGrants, setGrants, forgetGrants } from '../../plugins/plugin-store-main';
import { PLUGIN_ID_PATTERN } from '../../../shared/plugins/plugin-manifest';

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

export interface PluginsHandlerDependencies {
	settingsStore: {
		get: (key: string) => unknown;
	};
	manager: PluginManager;
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
	const { settingsStore, manager } = deps;

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
	const wrappedUninstall = withIpcErrorLogging(
		handlerOpts('uninstall'),
		async (id: unknown): Promise<{ success: boolean; error?: string }> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			return manager.uninstall(id);
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
			return { requested: manager.getRequestedPermissions(id) ?? [], granted: readGrants(id) };
		}
	);
	const wrappedSetGrants = withIpcErrorLogging(
		handlerOpts('setGrants'),
		// The consent action: the user approves a subset of the plugin's REQUESTED
		// permissions. We never grant a capability the manifest did not request
		// (an over-broad grant cannot be smuggled in via the renderer), and only
		// known capabilities survive.
		async (id: unknown, approvedCapabilities: unknown): Promise<PluginGrantsSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			if (!Array.isArray(approvedCapabilities)) throw new Error('InvalidApproval');
			const approved = new Set(approvedCapabilities.filter(isPluginCapability));
			const requested = manager.getRequestedPermissions(id) ?? [];
			const toGrant = requested.filter((r) => approved.has(r.capability));
			const grants = grantsFromRequests(toGrant, Date.now());
			setGrants(id, grants);
			return { requested, granted: grants };
		}
	);
	const wrappedRevokeGrants = withIpcErrorLogging(
		handlerOpts('revokeGrants'),
		async (id: unknown): Promise<PluginGrantsSnapshot> => {
			if (typeof id !== 'string' || id.length === 0) throw new Error('InvalidPluginId');
			if (!PLUGIN_ID_PATTERN.test(id)) throw new Error('InvalidPluginId');
			forgetGrants(id);
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
	const wrappedPanelHtml = withIpcErrorLogging(
		handlerOpts('panelHtml'),
		async (panelId: unknown): Promise<{ html: string | null }> => {
			if (typeof panelId !== 'string' || panelId.length === 0) throw new Error('InvalidPanelId');
			return { html: manager.getPanelHtml(panelId) };
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
		'plugins:set-grants',
		async (event, id: unknown, approvedCapabilities: unknown): Promise<PluginGrantsSnapshot> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedSetGrants(event, id, approvedCapabilities);
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
		'plugins:panel-html',
		async (event, panelId: unknown): Promise<{ html: string | null }> => {
			if (!isPluginsEnabled(settingsStore)) throw new Error('PluginsDisabled');
			return wrappedPanelHtml(event, panelId);
		}
	);
}
