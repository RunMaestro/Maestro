import {
	PluginHostViewRegistry,
	type HostViewMutation,
} from '../plugins/plugin-host-view-registry';
import { forwardPluginHostViewToRenderer } from '../plugins/plugin-host-view-forwarder';
import { deliverCadenzaToExistingHud } from '../app-lifecycle';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { PluginHostViewBridgeDependencies } from './types';

/**
 * Concerto/plugin host-view forwarding gate + PluginHostViewRegistry
 * construction. This is a cross-cutting concern between the Cadenza and
 * plugin subsystems - it needs plugin state (getPluginManager) as much as
 * cadenza state (deliverCadenza), so it's its own bridge rather than folded
 * into cadenza-bridge/.
 */
export function createPluginHostViewBridge(deps: PluginHostViewBridgeDependencies) {
	/** Host views are a bridge between two opt-in Encore features. Re-read both
	 * flags on every mutation: a disabled feature must never retain a pending view. */
	const arePluginHostViewsEnabled = (): boolean => {
		const features = deps.settingsStore.get('encoreFeatures', {}) as Record<string, boolean>;
		return features.plugins === true && features.concerto === true;
	};

	/** Forward one host-owned mutation over the exact Concerto renderer channels
	 * used by the CLI bridge. No renderer handles or plugin code cross this seam. */
	const forwardPluginHostView = (mutation: HostViewMutation): boolean => {
		if (!(mutation.kind === 'remove' && mutation.force) && !arePluginHostViewsEnabled())
			return false;
		const mainWindow = deps.getMainWindow();
		if (!mainWindow || mainWindow.isDestroyed() || !isWebContentsAvailable(mainWindow))
			return false;
		const targetWindow = mainWindow;
		const pluginManager = deps.getPluginManager();
		const sourcePlugin =
			pluginManager?.getRegistry().records.find((record) => record.id === mutation.view.pluginId)
				?.manifest?.name ?? mutation.view.pluginId;
		return forwardPluginHostViewToRenderer(mutation, {
			sourcePlugin,
			isCadenzaEnabled: deps.settingsStore.get('encoreFeatures', {})?.concerto === true,
			sendToMain: (channel, payload) => targetWindow.webContents.send(channel, payload),
			deliverCadenza: deps.deliverCadenza,
			deliverCadenzaToExistingHud,
		});
	};

	const pluginHostViews = new PluginHostViewRegistry({
		isEnabled: arePluginHostViewsEnabled,
		getHostViews: () => deps.getPluginManager()?.getContributions().hostViews ?? [],
		isPluginRecordPresent: (pluginId) =>
			deps
				.getPluginManager()
				?.getRegistry()
				.records.some((record) => record.id === pluginId) ?? false,
		forward: forwardPluginHostView,
	});

	return { arePluginHostViewsEnabled, pluginHostViews };
}
