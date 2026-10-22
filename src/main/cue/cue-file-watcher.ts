/**
 * File watcher provider for Maestro Cue file.changed subscriptions.
 *
 * Wraps chokidar to watch glob patterns with per-file debouncing
 * and produces CueEvent instances for the engine.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as chokidar from 'chokidar';
import picomatch from 'picomatch';
import { isMacOS, isWindows } from '../../shared/platformDetection';
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
 * The static folder a watch glob is rooted at, relative to the project root
 * and in POSIX form (`inbox/*.txt` -> `inbox`, `a/b/*.md` -> `a/b`). Empty
 * when the glob starts with a magic segment (`**\/*.md`, `{a,b}/*.md`): the
 * glob is then rooted at the project root, which always exists. A literal
 * path (`docs/readme.md`) is rooted at its parent folder.
 */
export function staticWatchBase(watchGlob: string): string {
	const scan = picomatch.scan(watchGlob);
	const base = scan.isGlob ? scan.base : path.posix.dirname(watchGlob);
	const trimmed = base.replace(/^\.\/+/, '').replace(/\/+$/, '');
	return trimmed === '.' ? '' : trimmed;
}

/**
 * `watchGlob` with its static folder `base` spelled the way the folder is
 * spelled on disk, for a case-insensitive volume where the two can differ
 * (`Inbox/*.txt` over a folder created as `inbox` -> `inbox/*.txt`). Each
 * segment keeps its own spelling when an exact match exists. Returns
 * `watchGlob` unchanged when the folder cannot be read.
 */
export function globOnDisk(rootAbs: string, base: string, watchGlob: string): string {
	const glob = watchGlob.replace(/^\.\/+/, '');
	if (!glob.startsWith(base)) return watchGlob;
	const names: string[] = [];
	let dir = rootAbs;
	try {
		for (const segment of base.split('/').filter(Boolean)) {
			const entries = fs.readdirSync(dir);
			const match =
				entries.find((entry) => entry === segment) ??
				entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
			if (!match) return watchGlob;
			names.push(match);
			dir = path.join(dir, match);
		}
	} catch {
		return watchGlob; // the folder vanished again; the chain watcher will retry
	}
	return names.join('/') + glob.slice(base.length);
}

/**
 * Creates a chokidar file watcher for a Cue file.changed subscription.
 * Returns a cleanup function to stop watching.
 */
export function createCueFileWatcher(config: CueFileWatcherConfig): () => void {
	const { watchGlob, projectRoot, debounceMs, onEvent, triggerName } = config;
	const isActive = config.isActive ?? (() => true);
	const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

	const handleError = (error: unknown) => {
		const message = `[CUE] File watcher error for "${triggerName}": ${error}`;
		if (config.onLog) {
			config.onLog('error', message);
		} else {
			console.error(message);
		}
	};

	const attachGlobWatcher = (ignoreInitial: boolean, glob = watchGlob): chokidar.FSWatcher => {
		const globWatcher = chokidar.watch(glob, {
			cwd: projectRoot,
			ignoreInitial,
			persistent: true,
		});
		globWatcher.on('change', handleEvent('change'));
		globWatcher.on('add', handleEvent('add'));
		globWatcher.on('unlink', handleEvent('unlink'));
		globWatcher.on('error', handleError);
		return globWatcher;
	};

	let watcher: chokidar.FSWatcher | null = attachGlobWatcher(true);
	const baseWatcher = watchStaticBase();

	/**
	 * chokidar 3 watches a glob from its static folder (`inbox` for
	 * `inbox/*.txt`). When that folder is missing it falls back to watching the
	 * parent for an entry literally named `*.txt`, so a folder created later is
	 * never picked up, and nothing above the folder notices it being deleted
	 * and created again. This watches only the chain of folders from the
	 * project root down to the static folder, one level each (never the tree
	 * below), and re-attaches the glob watcher whenever the folder appears.
	 */
	function watchStaticBase(): chokidar.FSWatcher | null {
		const base = staticWatchBase(watchGlob);
		if (!base) return null;

		// Windows and default macOS volumes are case-insensitive, so a glob
		// written `Inbox/*.txt` names a folder created as `inbox`, while
		// chokidar reports the folder in its on-disk case. Compare chain paths
		// case-folded there; every match is confirmed with fs.existsSync on the
		// glob's own spelling before the glob watcher is re-attached, and the
		// re-attached glob is rewritten to the on-disk spelling: on macOS
		// FSEvents reports `inbox/a.txt`, which the glob's case-sensitive
		// matcher would never accept as `Inbox/*.txt`.
		const foldCase = isWindows() || isMacOS();
		const chainKey = (p: string) => {
			const resolved = path.resolve(p);
			return foldCase ? resolved.toLowerCase() : resolved;
		};

		const rootAbs = path.resolve(projectRoot);
		const segments = base.split('/').filter(Boolean);
		const chain = new Set<string>([chainKey(rootAbs)]);
		for (let i = 1; i <= segments.length; i++) {
			chain.add(chainKey(path.resolve(rootAbs, ...segments.slice(0, i))));
		}
		const baseAbs = path.resolve(rootAbs, ...segments);
		const baseKey = chainKey(baseAbs);

		// Whether the glob watcher currently sits on an existing base folder.
		// Recorded synchronously, so a folder created before this watcher's
		// initial scan finishes is caught by the re-check on `ready`.
		let basePresent = fs.existsSync(baseAbs);
		let ready = false;

		const onBaseAppeared = () => {
			if (basePresent) return;
			basePresent = true;
			// Everything in a folder that appeared after start is new, so files
			// already written into it (`mkdir -p inbox && echo > inbox/a.txt`)
			// report `add` rather than being skipped as initial.
			watcher?.close();
			watcher = attachGlobWatcher(
				false,
				foldCase ? globOnDisk(rootAbs, base, watchGlob) : watchGlob
			);
		};

		const chainWatcher = chokidar.watch(rootAbs, {
			ignoreInitial: true,
			persistent: true,
			depth: segments.length - 1,
			ignored: (candidate: string) => !chain.has(chainKey(candidate)),
		});
		chainWatcher.on('addDir', (dirPath: string) => {
			if (ready && chainKey(dirPath) === baseKey && fs.existsSync(baseAbs)) onBaseAppeared();
		});
		chainWatcher.on('unlinkDir', (dirPath: string) => {
			if (chainKey(dirPath) !== baseKey || !basePresent) return;
			basePresent = false;
			// Release the handle on the deleted folder (Windows keeps a watched
			// folder pending-delete) and wait for it to come back.
			watcher?.close();
			watcher = null;
		});
		chainWatcher.on('ready', () => {
			ready = true;
			if (!basePresent && fs.existsSync(baseAbs)) onBaseAppeared();
		});
		chainWatcher.on('error', handleError);
		return chainWatcher;
	}

	return () => {
		for (const timer of debounceTimers.values()) {
			clearTimeout(timer);
		}
		debounceTimers.clear();
		watcher?.close();
		watcher = null;
		baseWatcher?.close();
	};
}
