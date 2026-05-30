/**
 * File watcher provider for Maestro Cue file.changed subscriptions.
 *
 * Wraps chokidar to watch glob patterns with per-file debouncing
 * and produces CueEvent instances for the engine.
 */

import * as path from 'path';
import * as chokidar from 'chokidar';
import { createCueEvent, type CueEvent } from './cue-types';

export interface CueFileWatcherConfig {
	watchGlob: string;
	projectRoot: string;
	debounceMs: number;
	onEvent: (event: CueEvent) => void;
	triggerName: string;
	onLog?: (level: string, message: string) => void;
	/**
	 * Optional gate: when this returns `false`, debounced events are dropped
	 * instead of dispatched. The chokidar watcher itself stays subscribed
	 * (OS file-watch is nearly free) — only the downstream emit + filter +
	 * dispatch is skipped. Used by the visibility-aware pause; see
	 * CLAUDE-PERFORMANCE.md§"Visibility-Aware Operations". Defaults to
	 * always-active when omitted.
	 */
	isActive?: () => boolean;
}

/**
 * Creates a chokidar file watcher for a Cue file.changed subscription.
 * Returns a cleanup function to stop watching.
 */
export function createCueFileWatcher(config: CueFileWatcherConfig): () => void {
	const { watchGlob, projectRoot, debounceMs, onEvent, triggerName } = config;
	const isActive = config.isActive ?? (() => true);
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const watcher = chokidar.watch(watchGlob, {
		cwd: projectRoot,
		ignoreInitial: true,
		persistent: true,
	});

	// Pre-compute the normalized project root (with trailing separator) so the
	// per-event guard below can do a cheap prefix check. `path.resolve` does not
	// follow symlinks — a link inside projectRoot pointing outside would slip
	// through this guard. That is an accepted project-trust limitation, not a
	// Cue concern (the validator already rejects `../` patterns up-front).
	const normalizedRoot = path.resolve(projectRoot) + path.sep;

	const handleEvent = (changeType: 'change' | 'add' | 'unlink') => (filePath: string) => {
		const existingTimer = debounceTimers.get(filePath);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		debounceTimers.set(
			filePath,
			setTimeout(() => {
				debounceTimers.delete(filePath);

				// Visibility-aware pause: drop the event when inactive. We don't
				// queue it for later — file changes that happened while hidden
				// can be re-discovered on resume via re-scan paths.
				if (!isActive()) return;

				const absolutePath = path.resolve(projectRoot, filePath);

				// Defense-in-depth: even if the validator rejected `../` patterns,
				// a misconfigured watch glob combined with chokidar's symlink
				// following could produce an event whose resolved path escapes the
				// project root. Drop those events with a warn log instead of
				// dispatching an arbitrary-file trigger.
				if (!absolutePath.startsWith(normalizedRoot)) {
					if (config.onLog) {
						config.onLog(
							'warn',
							`[CUE] Dropped file event outside projectRoot: ${absolutePath} (trigger: ${triggerName})`
						);
					}
					return;
				}

				const event = createCueEvent('file.changed', triggerName, {
					path: absolutePath,
					filename: path.basename(filePath),
					directory: path.dirname(absolutePath),
					extension: path.extname(filePath),
					changeType,
				});

				onEvent(event);
			}, debounceMs)
		);
	};

	watcher.on('change', handleEvent('change'));
	watcher.on('add', handleEvent('add'));
	watcher.on('unlink', handleEvent('unlink'));

	watcher.on('error', (error) => {
		const message = `[CUE] File watcher error for "${triggerName}": ${error}`;
		if (config.onLog) {
			config.onLog('error', message);
		} else {
			console.error(message);
		}
	});

	return () => {
		for (const timer of debounceTimers.values()) {
			clearTimeout(timer);
		}
		debounceTimers.clear();
		watcher.close();
	};
}
