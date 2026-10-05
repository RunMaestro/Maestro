/**
 * The seams the desktop fills in when it hosts the runtime: what only main can answer.
 *
 * Everything else takes the library's default (the real clock, the real probes, `unusableCwdReason`
 * for a working directory), which is what a TUI or a detached host runs.
 */

import { tabDefaultsFromSettings } from '../../shared/maestro-lib/agents/rules';
import type { RuntimeDeps } from '../../shared/maestro-lib/runtime';
import type { SettingsStoreInterface } from '../stores/types';
import { createDesktopRuntimeProcesses, type DesktopProcessSource } from './processes';

export interface DesktopRuntimeDepsOptions {
	/** The settings store, read live: a new tab starts from what the person set a moment ago. */
	settingsStore: Pick<SettingsStoreInterface, 'get'>;
	/** ProcessManager, which does not exist until the app is ready. */
	getProcessManager: () => DesktopProcessSource | null;
}

export function buildDesktopRuntimeDeps(
	options: DesktopRuntimeDepsOptions
): Pick<RuntimeDeps, 'processes' | 'readTabDefaults'> {
	return {
		processes: createDesktopRuntimeProcesses(options.getProcessManager),
		readTabDefaults: async () =>
			tabDefaultsFromSettings({
				defaultSaveToHistory: options.settingsStore.get('defaultSaveToHistory'),
				defaultShowThinking: options.settingsStore.get('defaultShowThinking'),
				newTabPlacement: options.settingsStore.get('newTabPlacement'),
			}),
	};
}
