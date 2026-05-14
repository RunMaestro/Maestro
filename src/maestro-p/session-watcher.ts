// Session-id discovery for the maestro-p wrapper.
//
// Phase 1 task 6 responsibilities: after the wrapper has spawned the claude
// TUI, watch the Claude projects directory for the new JSONL session file the
// TUI creates. Its basename (minus extension) is the session_id we emit in the
// `system/init` event upstream.
//
// Why fs-watch instead of asking claude for its session id: the TUI doesn't
// surface it on a deterministic line we could scrape, and claude writes the
// file as soon as the session has any state to save. Watching the projects
// directory is the cheap, account-agnostic way to learn it.
//
// We use chokidar (already a project dep) rather than `fs.promises.watch`
// because the project standardizes on it everywhere else and its cross-
// platform behavior is the better-tested baseline.

import * as path from 'path';
import * as fs from 'fs/promises';
import chokidar, { FSWatcher, WatchOptions } from 'chokidar';

import { encodeClaudeProjectPath } from '../shared/pathUtils';

export interface DiscoverSessionIdOptions {
	// Resolved Claude config dir (e.g., `process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`).
	// The wrapper resolves this before calling — keeping the resolution out of
	// this module means tests can point at any temp directory without juggling
	// env-vars.
	configDir: string;
	// The cwd the TUI was spawned in. Combined with claude's slug convention
	// (every non-alphanumeric → `-`, see encodeClaudeProjectPath) to derive the
	// per-project subdirectory under `projects/`.
	cwd: string;
	// Millisecond epoch captured by the caller right before spawning the TUI.
	// Any jsonl file with `birthtimeMs < spawnTimestamp` is from a previous run
	// and must be ignored.
	spawnTimestamp: number;
	// Hard ceiling on how long we'll wait. Caller's choice on what to do with
	// the rejection — index.ts proceeds with session_id: 'unknown'.
	timeoutMs?: number;
	// Test injection seam. Real callers should leave this undefined and let
	// chokidar use its platform default (fsevents on macOS, inotify on
	// Linux). Tests pass `{ usePolling: true, interval: 50 }` to keep fs-
	// event timing deterministic across vitest's jsdom worker. Not part of
	// the public contract — name-prefixed with underscore to signal that.
	_chokidarOptions?: Partial<WatchOptions>;
}

export const DEFAULT_TIMEOUT_MS = 10000;

export async function discoverSessionId(options: DiscoverSessionIdOptions): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const slug = encodeClaudeProjectPath(options.cwd);
	const watchPath = path.join(options.configDir, 'projects', slug);

	// Claude creates the slug directory itself on first session save, but if
	// we attach a watcher to a non-existent path chokidar's behavior is
	// inconsistent across versions. Pre-creating it is harmless (empty dir is
	// fine; claude won't care) and gives us a stable target.
	await fs.mkdir(watchPath, { recursive: true });

	return new Promise<string>((resolve, reject) => {
		let resolved = false;
		let timer: NodeJS.Timeout | null = null;
		let watcher: FSWatcher | null = null;

		const finish = (err: Error | null, value?: string) => {
			if (resolved) return;
			resolved = true;
			if (timer) clearTimeout(timer);
			// Close the watcher asynchronously; swallow close errors so they
			// don't mask the resolution we already committed to.
			watcher?.close().catch(() => {
				/* watcher already torn down */
			});
			if (err) {
				reject(err);
			} else if (value !== undefined) {
				resolve(value);
			}
		};

		const consider = async (filePath: string): Promise<void> => {
			if (resolved) return;
			if (!filePath.endsWith('.jsonl')) return;
			try {
				const stat = await fs.stat(filePath);
				// birthtimeMs is reliable on macOS APFS and Linux ext4/btrfs;
				// the rare filesystems without it (very old ext3, some FUSE)
				// return 0 here, which fails the threshold check and is the
				// safest default — we'd rather time out than pick the wrong id.
				if (stat.birthtimeMs >= options.spawnTimestamp) {
					const basename = path.basename(filePath, '.jsonl');
					finish(null, basename);
				}
			} catch {
				// File may have been deleted between the event and our stat
				// (unlikely but possible if claude rotates). Skip silently —
				// either another candidate will appear or we'll time out.
			}
		};

		watcher = chokidar.watch(watchPath, {
			persistent: true,
			// We do our own race-window catch below; chokidar's initial scan
			// would spam us with stale jsonl files from prior sessions.
			ignoreInitial: true,
			// Intentionally no `ignored` pattern. The watch root itself lives
			// under `.claude/`, so any dot-prefixed regex (e.g., the canonical
			// `/(^|[/\\])\../`) would cause chokidar to ignore the entire
			// subtree. Downstream filtering in `consider()` already restricts
			// to `*.jsonl` candidates, so we don't need defense in depth here.
			...(options._chokidarOptions ?? {}),
		});

		watcher.on('add', (filePath) => {
			void consider(filePath);
		});

		watcher.on('error', (err) => {
			finish(err instanceof Error ? err : new Error(String(err)));
		});

		// Race-window scan: chokidar attaches asynchronously, so a file
		// created between spawnTimestamp and the watcher being live would be
		// missed by `ignoreInitial: true`. Sweep the directory once for any
		// jsonl with a fresh birthtime — covers the gap deterministically.
		fs.readdir(watchPath)
			.then(async (entries) => {
				for (const entry of entries) {
					if (resolved) return;
					if (!entry.endsWith('.jsonl')) continue;
					await consider(path.join(watchPath, entry));
				}
			})
			.catch(() => {
				// Directory was just created and could not be read; the
				// watcher will catch whatever appears next.
			});

		timer = setTimeout(() => {
			finish(
				new Error(
					`maestro-p: session-id discovery timed out after ${timeoutMs}ms (watching ${watchPath})`
				)
			);
		}, timeoutMs);
	});
}
