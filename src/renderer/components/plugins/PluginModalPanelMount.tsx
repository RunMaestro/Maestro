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

import { useEffect, useMemo } from 'react';
import type { Theme } from '../../types';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { useUIStore } from '../../stores/uiStore';
import { PluginPanelHost } from '../Settings/PluginPanelHost';

export function PluginModalPanelMount({ theme }: { theme: Theme }) {
	const contributions = usePluginContributions();
	const openPluginPanelId = useUIStore((s) => s.openPluginPanelId);
	const setOpenPluginPanelId = useUIStore((s) => s.setOpenPluginPanelId);
	const toggleOpenPluginPanelId = useUIStore((s) => s.toggleOpenPluginPanelId);

	useEffect(() => {
		const plugins = window.maestro?.plugins;
		if (!plugins?.onPanelVisibility) return;
		return plugins.onPanelVisibility(({ panelId, action }) => {
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

	if (!panel) return null;

	return <PluginPanelHost theme={theme} panel={panel} onClose={() => setOpenPluginPanelId(null)} />;
}
