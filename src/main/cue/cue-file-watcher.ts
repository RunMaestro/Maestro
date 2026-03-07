/**
 * File watcher provider for Maestro Cue file.changed subscriptions.
 *
 * Wraps chokidar to watch glob patterns with per-file debouncing
 * and produces CueEvent instances for the engine.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import * as chokidar from 'chokidar';
import type { CueEvent } from './cue-types';

export interface CueFileWatcherConfig {
	watchGlob: string;
	projectRoot: string;
	debounceMs: number;
	onEvent: (event: CueEvent) => void;
	triggerName: string;
}

/**
 * Creates a chokidar file watcher for a Cue file.changed subscription.
 * Returns a cleanup function to stop watching.
 */
export function createCueFileWatcher(config: CueFileWatcherConfig): () => void {
	const { watchGlob, projectRoot, debounceMs, onEvent, triggerName } = config;
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const watcher = chokidar.watch(watchGlob, {
		cwd: projectRoot,
		ignoreInitial: true,
		persistent: true,
	});

	const handleEvent = (changeType: 'change' | 'add' | 'unlink') => (filePath: string) => {
		const existingTimer = debounceTimers.get(filePath);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		debounceTimers.set(
			filePath,
			setTimeout(() => {
				debounceTimers.delete(filePath);

				const absolutePath = path.resolve(projectRoot, filePath);
				const event: CueEvent = {
					id: crypto.randomUUID(),
					type: 'file.changed',
					timestamp: new Date().toISOString(),
					triggerName,
					payload: {
						path: absolutePath,
						filename: path.basename(filePath),
						directory: path.dirname(absolutePath),
						extension: path.extname(filePath),
						changeType,
					},
				};

				onEvent(event);
			}, debounceMs)
		);
	};

	watcher.on('change', handleEvent('change'));
	watcher.on('add', handleEvent('add'));
	watcher.on('unlink', handleEvent('unlink'));

	watcher.on('error', (error) => {
		// Log but don't crash — the parent engine will handle logging
		console.error(`[CUE] File watcher error for "${triggerName}":`, error);
	});

	return () => {
		for (const timer of debounceTimers.values()) {
			clearTimeout(timer);
		}
		debounceTimers.clear();
		watcher.close();
	};
}
