/**
 * The single, app-level mount for `modal`-placement plugin panels.
 *
 * Which panel is open (if any) lives in `uiStore.openPluginPanelId` as a
 * namespaced `<pluginId>/<panelId>`. Two paths write it and they converge here
 * so only one webview guest ever exists for a panel:
 *  - Settings -> Encore -> Plugins launch button (sets the store field).
 *  - A plugin summoning its OWN panel via `ui.openPanel` / `ui.closePanel` /
 *    `ui.togglePanel`, which main broadcasts on `plugins:panel-visibility`
 *    (already own-panel-resolved and namespaced host-side).
 *
 * Renders nothing when no panel is open, when the `plugins` Encore flag is off
 * (then `usePluginContributions` returns empty buckets), or when the open id no
 * longer resolves to a live panel - so uninstalling or disabling a plugin with
 * its overlay up cleanly drops the overlay instead of stranding it. Resolution
 * is by id alone: the Settings launch button has always been able to pop a
 * DOCKED panel into this host too, and the modal-only restriction belongs on
 * the `ui.*Panel` verbs (where it is enforced) rather than here.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Theme } from '../../types';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { pluginSettingsId } from '../../../shared/plugins/panel-host';
import { useModalStore } from '../../stores/modalStore';
import { useUIStore } from '../../stores/uiStore';
import { PluginPanelHost } from '../Settings/PluginPanelHost';

export function PluginModalPanelMount({ theme }: { theme: Theme }) {
	const contributions = usePluginContributions();
	const panelsRef = useRef(contributions.panels);
	panelsRef.current = contributions.panels;
	const openPluginPanelId = useUIStore((s) => s.openPluginPanelId);
	const setOpenPluginPanelId = useUIStore((s) => s.setOpenPluginPanelId);
	const toggleOpenPluginPanelId = useUIStore((s) => s.toggleOpenPluginPanelId);

	useEffect(() => {
		const plugins = window.maestro?.plugins;
		if (!plugins?.onPanelVisibility) return;
		return plugins.onPanelVisibility(({ panelId, action }) => {
			const panel = panelsRef.current.find((p) => p.id === panelId);
			if (panel?.placement === 'settings') {
				if (action === 'open')
					useModalStore
						.getState()
						.openModal('settings', { tab: 'encore', settingId: pluginSettingsId(panelId) });
				return;
			}
			if (action === 'open') setOpenPluginPanelId(panelId);
			else if (action === 'toggle') toggleOpenPluginPanelId(panelId);
			// `close` only ever closes the plugin's OWN panel, never whatever else
			// happens to be open.
			else if (useUIStore.getState().openPluginPanelId === panelId) setOpenPluginPanelId(null);
		});
	}, [setOpenPluginPanelId, toggleOpenPluginPanelId]);

	const panel = useMemo(
		() =>
			openPluginPanelId
				? (contributions.panels.find((p) => p.id === openPluginPanelId) ?? null)
				: null,
		[contributions.panels, openPluginPanelId]
	);
	useEffect(() => {
		if (panel?.placement !== 'settings') return;
		useModalStore
			.getState()
			.openModal('settings', { tab: 'encore', settingId: pluginSettingsId(panel.id) });
		setOpenPluginPanelId(null);
	}, [panel, setOpenPluginPanelId]);

	if (!panel || panel.placement === 'settings') return null;

	return <PluginPanelHost theme={theme} panel={panel} onClose={() => setOpenPluginPanelId(null)} />;
}
