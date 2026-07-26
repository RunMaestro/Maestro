/**
 * Preload API for the plugin subsystem (window.maestro.plugins).
 *
 * Phase 0 is list-only management: enumerate discovered plugins, toggle them,
 * and install/uninstall by path. No plugin code executes yet. All channels are
 * gated in the main process on the `plugins` Encore flag; when it is off they
 * reject with 'PluginsDisabled', which callers treat as "feature off".
 *
 * NOTE: this object becomes part of the permanent, semver-managed public host
 * contract the moment the first plugin ships. Add to it additively; do not
 * remove or change the meaning of an existing method without a host-API major.
 */

import { ipcRenderer } from 'electron';
import type {
	PluginListSnapshot,
	PluginGrantsSnapshot,
	PluginActivityMap,
	PluginGroupingSnapshot,
} from '../ipc/handlers/plugins';
import type { InstallResult } from '../plugins/plugin-manager';
import type { AggregatedContributions } from '../../shared/plugins/contributions';
import type { FirstPartyBridgeState } from '../plugins/first-party-bridge';
import type { FirstPartyEncoreFlag } from '../../shared/plugins/first-party';

/** Creates the plugins API object for contextBridge exposure. */
export function createPluginsApi() {
	return {
		/**
		 * List discovered plugins (re-reads disk) plus the host API version the UI
		 * should display. Each record carries its manifest (or null when invalid),
		 * load status, enable toggle, and any validation/compat errors.
		 */
		list: (): Promise<PluginListSnapshot> => ipcRenderer.invoke('plugins:list'),

		/** Enable or disable a plugin by id; returns the updated snapshot. */
		setEnabled: (id: string, enabled: boolean): Promise<PluginListSnapshot> =>
			ipcRenderer.invoke('plugins:set-enabled', id, enabled),

		/**
		 * Enable/disable a first-party Encore feature through its host-owned
		 * lifecycle bridge (grant mint + supervised-service reconcile/stop), not a
		 * bare settings write. Returns the settled bridge state. NOT gated on the
		 * `plugins` subsystem flag - first-party features are independent of it.
		 */
		setFirstPartyEnabled: (
			flag: FirstPartyEncoreFlag,
			enabled: boolean
		): Promise<FirstPartyBridgeState> =>
			ipcRenderer.invoke('plugins:first-party-set-enabled', flag, enabled),

		/** Install a plugin by copying a directory that contains a plugin.json. */
		install: (sourceDir: string): Promise<InstallResult> =>
			ipcRenderer.invoke('plugins:install', sourceDir),

		/**
		 * Update an already-installed plugin to a newer version by copying a new
		 * source directory over it. Rejects unless the id is already installed and
		 * the source version is strictly newer (semver). Returns the updated list.
		 */
		update: (sourceDir: string): Promise<PluginListSnapshot> =>
			ipcRenderer.invoke('plugins:update', sourceDir),

		/** Uninstall a plugin by id (removes its directory and forgets its toggle). */
		uninstall: (id: string): Promise<{ success: boolean; error?: string }> =>
			ipcRenderer.invoke('plugins:uninstall', id),

		/**
		 * Tier 0 contributions (themes, prompts, settings, command macros)
		 * aggregated across all active plugins, plus per-plugin errors. This is the
		 * read seam host registries consume plugin-supplied data from.
		 */
		contributions: (): Promise<AggregatedContributions> =>
			ipcRenderer.invoke('plugins:contributions'),

		/** Read a plugin's requested permissions and what the user has granted. */
		getGrants: (id: string): Promise<PluginGrantsSnapshot> =>
			ipcRenderer.invoke('plugins:get-grants', id),

		/**
		 * Ask the MAIN process to open the dedicated, host-owned consent window for
		 * a plugin. The window (not this renderer) collects the approval and mints
		 * the grant through the isolated minter; the renderer never sees the nonce.
		 */
		requestConsent: (id: string): Promise<{ opened: boolean }> =>
			ipcRenderer.invoke('plugins:request-consent', id),

		/** Revoke all of a plugin's grants. */
		revokeGrants: (id: string): Promise<PluginGrantsSnapshot> =>
			ipcRenderer.invoke('plugins:revoke-grants', id),

		/**
		 * Host-managed dispatch allowlist (issue #1250): replace which agents a
		 * plugin's already-consented agents:dispatch grant may target. The main
		 * process re-mints the grant SCOPE into the sealed ledger; the plugin is
		 * never involved. Only the trusted main renderer may call it. Returns the
		 * refreshed requested/granted snapshot.
		 */
		setAgentAllowlist: (id: string, agentIds: string[]): Promise<PluginGrantsSnapshot> =>
			ipcRenderer.invoke('plugins:set-agent-allowlist', id, agentIds),

		/** Invoke a contributed command (`<pluginId>/<localId>`) in its sandbox. */
		invokeCommand: (commandId: string, args?: unknown): Promise<{ dispatched: boolean }> =>
			ipcRenderer.invoke('plugins:invoke-command', commandId, args),

		/**
		 * Invoke a contributed tool (`<pluginId>/<localId>`) and await its result.
		 * Unlike invokeCommand (fire-and-forget), this is a brokered request/
		 * response round-trip: the resolved value carries the plugin handler's
		 * return value under `result`.
		 */
		invokeTool: (toolId: string, args?: unknown): Promise<{ result: unknown }> =>
			ipcRenderer.invoke('plugins:invoke-tool', toolId, args),

		/**
		 * Read-only per-plugin observability for running tier-1 plugins: total
		 * host calls, current/peak in-flight, last-activity timestamp, crash count,
		 * and a bounded buffer of recent log lines. Keyed by plugin id.
		 */
		getActivity: (): Promise<PluginActivityMap> => ipcRenderer.invoke('plugins:get-activity'),

		/** Presentation-only virtual groupings from currently running plugins. */
		getGroupings: (): Promise<PluginGroupingSnapshot> =>
			ipcRenderer.invoke('plugins:get-groupings'),

		/**
		 * Subscribe to plugin-registry changes (install/uninstall/enable/disable/
		 * refresh). The callback receives no payload - it is a signal to re-read
		 * `list()` / `contributions()`. Returns an unsubscribe function.
		 */
		onChanged: (callback: () => void): (() => void) => {
			const handler = (): void => callback();
			ipcRenderer.on('plugins:changed', handler);
			return () => {
				ipcRenderer.removeListener('plugins:changed', handler);
			};
		},

		/**
		 * Subscribe to host-to-panel data pushes (`ui.panelPost`). The main process
		 * broadcasts `plugins:panel-data` with the already-namespaced panel id and
		 * validated, size-capped JSON data; the panel frame forwards it into the
		 * matching webview guest. Read-only signal - there is no reply channel.
		 */
		onPanelData: (
			callback: (payload: { pluginId: string; panelId: string; data: unknown }) => void
		): (() => void) => {
			const handler = (
				_event: unknown,
				payload: { pluginId: string; panelId: string; data: unknown }
			): void => callback(payload);
			ipcRenderer.on('plugins:panel-data', handler);
			return () => {
				ipcRenderer.removeListener('plugins:panel-data', handler);
			};
		},

		onGroupingsChanged: (callback: () => void): (() => void) => {
			const handler = (): void => callback();
			ipcRenderer.on('plugins:groupings-changed', handler);
			return () => ipcRenderer.removeListener('plugins:groupings-changed', handler);
		},

		/**
		 * Subscribe to the host's `ui.runCommand` round-trip. When a plugin
		 * invokes the `ui:command` host method, the main process forwards the
		 * requested command id (+ args) here on `plugins:run-ui-command` with a
		 * unique responseChannel. The callback runs the command against the
		 * renderer's shared command registry and returns whether it ran; we ack
		 * that boolean on the responseChannel so the host resolves the plugin
		 * call (true) or reports "unknown command" (false). The responseChannel
		 * never leaves preload - the renderer callback only sees (commandId, args).
		 */
		onRunUiCommand: (
			callback: (commandId: string, args: unknown) => boolean | Promise<boolean>
		): (() => void) => {
			const handler = (
				_: unknown,
				commandId: string,
				args: unknown,
				responseChannel: string
			): void => {
				try {
					Promise.resolve(callback(commandId, args)).then(
						(ok) => ipcRenderer.send(responseChannel, ok === true),
						() => ipcRenderer.send(responseChannel, false)
					);
				} catch {
					ipcRenderer.send(responseChannel, false);
				}
			};
			ipcRenderer.on('plugins:run-ui-command', handler);
			return () => ipcRenderer.removeListener('plugins:run-ui-command', handler);
		},
	};
}

export type PluginsApi = ReturnType<typeof createPluginsApi>;
