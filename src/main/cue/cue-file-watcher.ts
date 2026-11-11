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
	 * (OS file-watch is nearly free) - only the downstream emit + filter +
	 * dispatch is skipped. Used by the visibility-aware pause; see
	 * CLAUDE-PERFORMANCE.md§"Visibility-Aware Operations". Defaults to
	 * always-active when omitted.
	 */
	isActive?: () => boolean;
}

/**
 * Error codes that mean the OS refused to hand out another native file watch:
 * `EMFILE` when the user's inotify INSTANCE limit (`fs.inotify.max_user_instances`,
 * often 128, shared by every process of that uid, across containers too) is
 * spent, `ENOSPC` when the WATCH limit (`max_user_watches`) is. A native
 * watcher in that state reports the error once and then never fires, so a
 * `file.changed` subscription looked healthy while dropping every event.
 */
const WATCH_LIMIT_ERROR_CODES = new Set(['EMFILE', 'ENOSPC']);

/** Poll interval once the native watch is refused. Cue globs are narrow. */
export const CUE_POLLING_FALLBACK_INTERVAL_MS = 1000;

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' ? code : undefined;
}

/**
 * Creates a chokidar file watcher for a Cue file.changed subscription.
 * Returns a cleanup function to stop watching.
 *
 * When the OS refuses a native watch (see `WATCH_LIMIT_ERROR_CODES`), the
 * watcher restarts itself in polling mode and logs a warning naming the limit,
 * so the subscription keeps firing instead of going silent.
 */
export function createCueFileWatcher(config: CueFileWatcherConfig): () => void {
	const { watchGlob, projectRoot, debounceMs, onEvent, triggerName } = config;
	const isActive = config.isActive ?? (() => true);
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	let polling = false;
	let closed = false;
	const startWatcher = (): chokidar.FSWatcher =>
		chokidar.watch(watchGlob, {
			cwd: projectRoot,
			ignoreInitial: true,
			persistent: true,
			...(polling
				? {
						usePolling: true,
						interval: CUE_POLLING_FALLBACK_INTERVAL_MS,
						binaryInterval: CUE_POLLING_FALLBACK_INTERVAL_MS,
					}
				: {}),
		});

	// Pre-compute the normalized project root (with trailing separator) so the
	// per-event guard below can do a cheap prefix check. `path.resolve` does not
	// follow symlinks - a link inside projectRoot pointing outside would slip
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
				// queue it for later - file changes that happened while hidden
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

	const log = (level: string, message: string) => {
		if (config.onLog) {
			config.onLog(level, message);
		} else if (level === 'error') {
			console.error(message);
		} else {
			console.warn(message);
		}
	};

	const attach = (target: chokidar.FSWatcher) => {
		target.on('change', handleEvent('change'));
		target.on('add', handleEvent('add'));
		target.on('unlink', handleEvent('unlink'));
		target.on('error', (error) => {
			const code = errorCode(error);
			if (!polling && !closed && code && WATCH_LIMIT_ERROR_CODES.has(code)) {
				polling = true;
				log(
					'warn',
					`[CUE] "${triggerName}" could not get a native file watch (${code}: the OS file-watch limit is used up); polling "${watchGlob}" every ${CUE_POLLING_FALLBACK_INTERVAL_MS / 1000}s instead. On Linux, raise fs.inotify.max_user_instances (EMFILE) or fs.inotify.max_user_watches (ENOSPC) on the host.`
				);
				void target.close();
				watcher = startWatcher();
				attach(watcher);
				return;
			}
			log('error', `[CUE] File watcher error for "${triggerName}": ${error}`);
		});
	};

	let watcher = startWatcher();
	attach(watcher);

	return () => {
		closed = true;
		for (const timer of debounceTimers.values()) {
			clearTimeout(timer);
		}
		debounceTimers.clear();
		void watcher.close();
	};
}
