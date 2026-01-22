/**
 * CLI activity file watcher.
 * Watches for changes to cli-activity.json to detect CLI playbook runs.
 */

import fsSync from 'fs';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

/** Dependencies for CLI activity watcher */
export interface CliWatcherDependencies {
	/** Function to get the main window (may be null if not created yet) */
	getMainWindow: () => BrowserWindow | null;
	/** Function to get the user data directory path */
	getUserDataPath: () => string;
}

/** CLI activity watcher instance */
export interface CliWatcher {
	/** Start watching for CLI activity file changes */
	start: () => void;
	/** Stop watching and cleanup */
	stop: () => void;
	/** Get the underlying FSWatcher (for testing) */
	getWatcher: () => fsSync.FSWatcher | null;
}

/**
 * Creates a CLI activity watcher that monitors cli-activity.json for changes.
 * Uses fs.watch() for event-driven detection when CLI is running playbooks.
 *
 * @param deps - Dependencies including mainWindow getter and userData path getter
 * @returns CliWatcher instance with start/stop methods
 */
export function createCliWatcher(deps: CliWatcherDependencies): CliWatcher {
	const { getMainWindow, getUserDataPath } = deps;
	let watcher: fsSync.FSWatcher | null = null;

	return {
		start: () => {
			const cliActivityPath = path.join(getUserDataPath(), 'cli-activity.json');
			const cliActivityDir = path.dirname(cliActivityPath);

			// Ensure directory exists for watching
			if (!fsSync.existsSync(cliActivityDir)) {
				fsSync.mkdirSync(cliActivityDir, { recursive: true });
			}

			// Watch the directory for file changes (handles file creation/deletion)
			// Using directory watch because fs.watch on non-existent file throws
			try {
				watcher = fsSync.watch(cliActivityDir, (_eventType, filename) => {
					if (filename === 'cli-activity.json') {
						logger.debug('CLI activity file changed, notifying renderer', 'CliActivityWatcher');
						const mainWindow = getMainWindow();
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send('cli:activityChange');
						}
					}
				});

				watcher.on('error', (error) => {
					logger.error(`CLI activity watcher error: ${error.message}`, 'CliActivityWatcher');
				});

				logger.info('CLI activity watcher started', 'Startup');
			} catch (error) {
				logger.error(`Failed to start CLI activity watcher: ${error}`, 'CliActivityWatcher');
			}
		},

		stop: () => {
			if (watcher) {
				watcher.close();
				watcher = null;
			}
		},

		getWatcher: () => watcher,
	};
}
