/**
 * App lifecycle module exports.
 * Provides window management, error handling, CLI watching, and quit handling.
 */

export { setupGlobalErrorHandlers } from './error-handlers';
export { createCliWatcher, type CliWatcher, type CliWatcherDependencies } from './cli-watcher';
export {
	createWindowManager,
	type WindowManager,
	type WindowManagerDependencies,
} from './window-manager';
export {
	ensureCadenzaHudWindow,
	deliverCadenzaToHud,
	deliverCadenzaToExistingHud,
	getCadenzaHudWindow,
	closeCadenzaHudWindow,
	type CadenzaHudWindowDeps,
} from './cadenza-hud-window';
export { createQuitHandler, type QuitHandler, type QuitHandlerDependencies } from './quit-handler';
export {
	createSettingsWatcher,
	type SettingsWatcher,
	type SettingsWatcherDependencies,
} from './settings-watcher';
