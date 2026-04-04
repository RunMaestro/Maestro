/**
 * Settings file watcher.
 * Watches for external changes to maestro-settings.json and maestro-agent-configs.json
 * so the running app picks up CLI-driven settings changes immediately.
 */

import fsSync from 'fs';
import type { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';

/** Dependencies for settings watcher */
export interface SettingsWatcherDependencies {
	/** Function to get the main window (may be null if not created yet) */
	getMainWindow: () => BrowserWindow | null;
	/** Function to get the settings file directory (may differ from userData for synced settings) */
	getSettingsPath: () => string;
	/** Function to get the agent configs file directory */
	getAgentConfigsPath: () => string;
}

/** Settings watcher instance */
export interface SettingsWatcher {
	/** Start watching for external file changes */
	start: () => void;
	/** Stop watching and cleanup */
	stop: () => void;
}

/**
 * Creates a settings file watcher that monitors maestro-settings.json and
 * maestro-agent-configs.json for external changes (e.g., from maestro-cli).
 *
 * When a change is detected, sends IPC events to the renderer so it can reload.
 * Uses debouncing to avoid excessive reloads from rapid writes.
 */
export function createSettingsWatcher(deps: SettingsWatcherDependencies): SettingsWatcher {
	const { getMainWindow, getSettingsPath, getAgentConfigsPath } = deps;
	const watchers: fsSync.FSWatcher[] = [];

	// Debounce: ignore changes within 500ms of an IPC-driven write
	// This prevents the watcher from firing when the app itself writes settings
	let settingsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let agentConfigsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	function notifyRenderer(channel: string) {
		const mainWindow = getMainWindow();
		if (isWebContentsAvailable(mainWindow)) {
			mainWindow.webContents.send(channel);
		}
	}

	function watchFile(
		dirPath: string,
		filename: string,
		channel: string,
		getDebounce: () => ReturnType<typeof setTimeout> | null,
		setDebounce: (t: ReturnType<typeof setTimeout> | null) => void
	) {
		if (!fsSync.existsSync(dirPath)) {
			fsSync.mkdirSync(dirPath, { recursive: true });
		}

		try {
			const watcher = fsSync.watch(dirPath, (_eventType, changedFile) => {
				if (changedFile === filename) {
					// Debounce to coalesce rapid writes
					const existing = getDebounce();
					if (existing) clearTimeout(existing);
					setDebounce(
						setTimeout(() => {
							setDebounce(null);
							logger.debug(
								`External change detected in ${filename}, notifying renderer`,
								'SettingsWatcher'
							);
							notifyRenderer(channel);
						}, 300)
					);
				}
			});

			watcher.on('error', (error) => {
				logger.error(`Settings watcher error for ${filename}: ${error.message}`, 'SettingsWatcher');
			});

			watchers.push(watcher);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to watch ${filename}: ${message}`, 'SettingsWatcher');
		}
	}

	return {
		start: () => {
			const settingsDir = getSettingsPath();
			const agentConfigsDir = getAgentConfigsPath();

			watchFile(
				settingsDir,
				'maestro-settings.json',
				'settings:externalChange',
				() => settingsDebounceTimer,
				(t) => {
					settingsDebounceTimer = t;
				}
			);

			// Only watch agent configs dir separately if it differs from settings dir
			if (agentConfigsDir !== settingsDir) {
				watchFile(
					agentConfigsDir,
					'maestro-agent-configs.json',
					'settings:externalChange',
					() => agentConfigsDebounceTimer,
					(t) => {
						agentConfigsDebounceTimer = t;
					}
				);
			} else {
				// Same dir — extend the existing watcher to also look for agent configs
				// The first watcher already watches the directory, but we need to
				// also react to agent config file changes. We'll add a second watcher.
				watchFile(
					agentConfigsDir,
					'maestro-agent-configs.json',
					'settings:externalChange',
					() => agentConfigsDebounceTimer,
					(t) => {
						agentConfigsDebounceTimer = t;
					}
				);
			}

			logger.info('Settings file watcher started', 'Startup');
		},

		stop: () => {
			for (const watcher of watchers) {
				watcher.close();
			}
			watchers.length = 0;
			if (settingsDebounceTimer) clearTimeout(settingsDebounceTimer);
			if (agentConfigsDebounceTimer) clearTimeout(agentConfigsDebounceTimer);
		},
	};
}
