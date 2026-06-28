/**
 * Active PluginManager accessor (main process).
 *
 * The PluginManager is constructed during core-service init in `index.ts` and
 * held in a module-local there. The web-server message handlers run in the same
 * main process but are not on that wiring path, so - mirroring the StatsDB
 * singleton (`stats/singleton.ts`) - this exposes the live instance to them
 * without threading it through the handler constructor.
 *
 * The live `encoreFeatures.plugins` predicate is captured alongside the manager:
 * handlers MUST gate on {@link isPluginsFeatureEnabled} rather than inferring the
 * flag from `getContributions()` (which aggregates active records and can be
 * stale relative to a freshly-toggled flag), matching the IPC handlers' gate.
 */
import type { PluginManager } from './plugin-manager';

let activePluginManager: PluginManager | null = null;
let pluginsEnabledCheck: (() => boolean) | null = null;

export function setActivePluginManager(
	manager: PluginManager | null,
	isEnabled?: () => boolean
): void {
	activePluginManager = manager;
	pluginsEnabledCheck = isEnabled ?? null;
}

export function getActivePluginManager(): PluginManager | null {
	return activePluginManager;
}

export function isPluginsFeatureEnabled(): boolean {
	return pluginsEnabledCheck ? pluginsEnabledCheck() : false;
}
