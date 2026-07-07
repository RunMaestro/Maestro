/**
 * usePluginCommandBridge - mount ONCE near the App root. It does two things,
 * both against the SAME shared command registry the command palette reads:
 *
 *   1. Registers a curated set of STABLE global commands (open command palette,
 *      settings, usage dashboard, ...). Each `run` drives an existing modal
 *      store action, so the bridge needs nothing passed down from App - it is a
 *      single zero-arg hook call.
 *   2. Subscribes to the host's `plugins:run-ui-command` round-trip. When a
 *      plugin invokes the `ui:command` host method, the main process forwards
 *      the requested command id here; we run it through `runCommandById` (the
 *      exact registry the palette uses) and ack the boolean result so the host
 *      can report success/"unknown command" to the plugin.
 */

import { useEffect } from 'react';
import { registerCommand, runCommandById } from '../stores/pluginCommandRegistry';
import { getModalActions } from '../stores/modalStore';

/**
 * Curated global command ids. These are part of the plugin-facing contract
 * (plugins invoke them by id via `ui.runCommand`) - keep them stable. The
 * palette surfaces them through `buildRegistryCommands`, so a single
 * registration here makes a command BOTH palette-visible and plugin-invokable.
 */
function registerGlobalCommands(): () => void {
	const actions = getModalActions();
	const unregisters = [
		registerCommand({
			id: 'maestro.commandPalette.open',
			title: 'Open Command Palette',
			run: () => actions.setQuickActionOpen(true),
		}),
		registerCommand({
			id: 'maestro.settings.open',
			title: 'Open Settings',
			run: () => actions.openSettings(),
		}),
		registerCommand({
			id: 'maestro.usageDashboard.open',
			title: 'Open Usage Dashboard',
			run: () => actions.setUsageDashboardOpen(true),
		}),
		registerCommand({
			id: 'maestro.shortcutsHelp.open',
			title: 'Open Keyboard Shortcuts',
			run: () => actions.setShortcutsHelpOpen(true),
		}),
		registerCommand({
			id: 'maestro.about.open',
			title: 'About Maestro',
			run: () => actions.setAboutModalOpen(true),
		}),
	];
	return () => {
		for (const unregister of unregisters) unregister();
	};
}

export function usePluginCommandBridge(): void {
	useEffect(() => {
		const unregister = registerGlobalCommands();

		// The plugins API is absent in the web build (and before the preload
		// bridge is ready); the curated commands still register for the palette,
		// we just skip the host round-trip subscription.
		const plugins = window.maestro?.plugins;
		const unsubscribe = plugins?.onRunUiCommand
			? plugins.onRunUiCommand((commandId, args) => runCommandById(commandId, args))
			: undefined;

		return () => {
			unsubscribe?.();
			unregister();
		};
	}, []);
}
