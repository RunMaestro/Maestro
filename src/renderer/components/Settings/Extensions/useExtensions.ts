/**
 * Data + actions hook for the Extensions (Encore) marketplace.
 *
 * Loads the discovered plugin list and aggregated contributions, keeps them in
 * sync with `plugins:changed`, and exposes the first-party Encore flags (from
 * the settings store) so the view can render both as one unified grid. Plugin
 * mutations mirror PluginsPanel's proven flow: disabling/tier-0-enabling is
 * immediate, code-tier enabling routes through the host-owned consent window.
 */

import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { notifyToast } from '../../../stores/notificationStore';
import type { PluginRecord } from '../../../../shared/plugins/plugin-registry';
import type {
	PluginGrantsSnapshot,
	PluginListSnapshot,
} from '../../../../main/ipc/handlers/plugins';
import type { AggregatedContributions } from '../../../../shared/plugins/contributions';
import type { EncoreFeatureFlags } from '../../../types';
import { buildExtensions, type UnifiedExtension } from './extensionModel';

export interface UseExtensionsResult {
	extensions: UnifiedExtension[];
	encoreFeatures: EncoreFeatureFlags;
	contributions: AggregatedContributions | null;
	/** False when the `plugins` Encore subsystem flag is off (list() is blocked). */
	pluginsSubsystemEnabled: boolean;
	loading: boolean;
	busyId: string | null;
	reload: () => Promise<void>;
	toggleBuiltin: (flag: keyof EncoreFeatureFlags) => void;
	enablePluginsSubsystem: () => void;
	togglePlugin: (record: PluginRecord) => Promise<void>;
	installPlugin: () => Promise<void>;
	uninstallPlugin: (record: PluginRecord) => Promise<void>;
	revokePlugin: (id: string) => Promise<void>;
	getGrants: (id: string) => Promise<PluginGrantsSnapshot>;
}

export function useExtensions(): UseExtensionsResult {
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	const setEncoreFeatures = useSettingsStore((s) => s.setEncoreFeatures);

	const [plugins, setPlugins] = useState<PluginRecord[]>([]);
	const [contributions, setContributions] = useState<AggregatedContributions | null>(null);
	const [pluginsSubsystemEnabled, setPluginsSubsystemEnabled] = useState(true);
	const [loading, setLoading] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			const snap: PluginListSnapshot = await window.maestro.plugins.list();
			setPlugins(snap.plugins);
			setPluginsSubsystemEnabled(true);
			try {
				setContributions(await window.maestro.plugins.contributions());
			} catch {
				setContributions(null);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes('PluginsDisabled')) {
				setPlugins([]);
				setContributions(null);
				setPluginsSubsystemEnabled(false);
			} else {
				notifyToast({
					color: 'red',
					title: 'Extensions',
					message: `Failed to load plugins: ${String(err)}`,
				});
			}
		} finally {
			setLoading(false);
		}
	}, []);

	// Reload on mount and whenever the plugin subsystem flag flips (enabling it
	// unblocks plugins:list, which otherwise rejects with 'PluginsDisabled').
	useEffect(() => {
		void reload();
	}, [reload, encoreFeatures.plugins]);

	// The consent window mints grants and the main process then enables the
	// plugin, broadcasting 'plugins:changed' — re-read so the grid reflects the
	// new enabled/grant state without a manual refresh.
	useEffect(() => {
		const unsubscribe = window.maestro.plugins.onChanged(() => {
			void reload();
		});
		return unsubscribe;
	}, [reload]);

	const toggleBuiltin = useCallback(
		(flag: keyof EncoreFeatureFlags) => {
			setEncoreFeatures({ ...encoreFeatures, [flag]: !encoreFeatures[flag] });
		},
		[encoreFeatures, setEncoreFeatures]
	);

	const enablePluginsSubsystem = useCallback(() => {
		setEncoreFeatures({ ...encoreFeatures, plugins: true });
	}, [encoreFeatures, setEncoreFeatures]);

	const togglePlugin = useCallback(async (record: PluginRecord) => {
		if (record.loadStatus !== 'ok') return;
		// Disabling is always immediate; enabling a tier-0 (data) plugin applies
		// directly. Enabling a code-tier plugin routes through the host-owned
		// consent window, which mints the grant and enables the plugin itself.
		const isCodeTier = (record.manifest?.tier ?? 0) >= 1;
		if (record.enabled || !isCodeTier) {
			setBusyId(record.id);
			try {
				const snap = await window.maestro.plugins.setEnabled(record.id, !record.enabled);
				setPlugins(snap.plugins);
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Extensions',
					message: `Toggle failed: ${String(err)}`,
				});
			} finally {
				setBusyId(null);
			}
			return;
		}
		try {
			await window.maestro.plugins.requestConsent(record.id);
		} catch (err) {
			notifyToast({
				color: 'red',
				title: 'Extensions',
				message: `Could not open the permission prompt: ${String(err)}`,
			});
		}
	}, []);

	const installPlugin = useCallback(async () => {
		const dir = await window.maestro.dialog.selectFolder();
		if (!dir) return;
		setLoading(true);
		try {
			const result = await window.maestro.plugins.install(dir);
			if (result.success) {
				notifyToast({
					color: 'green',
					title: 'Extensions',
					message: `Installed ${result.record?.manifest?.name ?? result.record?.id ?? 'plugin'}`,
				});
				await reload();
			} else {
				notifyToast({
					color: 'orange',
					title: 'Extensions',
					message: `Install failed: ${result.error ?? 'unknown error'}`,
				});
			}
		} catch (err) {
			notifyToast({ color: 'red', title: 'Extensions', message: `Install failed: ${String(err)}` });
		} finally {
			setLoading(false);
		}
	}, [reload]);

	const uninstallPlugin = useCallback(
		async (record: PluginRecord) => {
			setBusyId(record.id);
			try {
				const result = await window.maestro.plugins.uninstall(record.id);
				if (result.success) {
					notifyToast({ color: 'green', title: 'Extensions', message: `Uninstalled ${record.id}` });
					await reload();
				} else {
					notifyToast({
						color: 'orange',
						title: 'Extensions',
						message: `Uninstall failed: ${result.error ?? 'unknown error'}`,
					});
				}
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Extensions',
					message: `Uninstall failed: ${String(err)}`,
				});
			} finally {
				setBusyId(null);
			}
		},
		[reload]
	);

	const revokePlugin = useCallback(
		async (id: string) => {
			setBusyId(id);
			try {
				await window.maestro.plugins.revokeGrants(id);
				notifyToast({ color: 'green', title: 'Extensions', message: 'Revoked all permissions' });
				await reload();
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Extensions',
					message: `Revoke failed: ${String(err)}`,
				});
			} finally {
				setBusyId(null);
			}
		},
		[reload]
	);

	const getGrants = useCallback(
		(id: string): Promise<PluginGrantsSnapshot> => window.maestro.plugins.getGrants(id),
		[]
	);

	const extensions = buildExtensions(encoreFeatures, plugins);

	return {
		extensions,
		encoreFeatures,
		contributions,
		pluginsSubsystemEnabled,
		loading,
		busyId,
		reload,
		toggleBuiltin,
		enablePluginsSubsystem,
		togglePlugin,
		installPlugin,
		uninstallPlugin,
		revokePlugin,
		getGrants,
	};
}
