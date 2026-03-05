/**
 * Task scanner provider for Maestro Cue task.pending subscriptions.
 *
 * Polls markdown files matching a glob pattern for unchecked tasks (- [ ]),
 * tracks content hashes to avoid re-triggering on unchanged files,
 * and fires one CueEvent per file that has pending tasks.
 *
 * Follows the same factory pattern as cue-file-watcher.ts and cue-github-poller.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import picomatch from 'picomatch';
import type { CueEvent } from './cue-types';

export interface CueTaskScannerConfig {
	watchGlob: string;
	pollMinutes: number;
	projectRoot: string;
	onEvent: (event: CueEvent) => void;
	onLog: (level: string, message: string) => void;
	triggerName: string;
}

/** A pending task extracted from a markdown file */
export interface PendingTask {
	line: number;
	text: string;
}

/**
 * Parse a markdown file's content and extract all unchecked tasks.
 * Returns the list of pending tasks with line numbers and text.
 */
export function extractPendingTasks(content: string): PendingTask[] {
	const tasks: PendingTask[] = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Match: optional whitespace, list marker (- * +), space, [ ], space, then task text
		if (/^\s*[-*+]\s+\[ \]/.test(line)) {
			const text = line.replace(/^\s*[-*+]\s+\[ \]\s*/, '').trim();
			if (text.length > 0) {
				tasks.push({ line: i + 1, text });
			}
		}
	}

	return tasks;
}

/**
 * Recursively walk a directory and return all file paths (relative to root).
 */
function walkDir(dir: string, root: string): string[] {
	const results: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip common non-content directories
			if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') {
				continue;
			}
			results.push(...walkDir(fullPath, root));
		} else if (entry.isFile()) {
			results.push(path.relative(root, fullPath));
		}
	}

	return results;
}

/**
 * Creates a task scanner for a Cue task.pending subscription.
 * Returns a cleanup function to stop scanning.
 */
export function createCueTaskScanner(config: CueTaskScannerConfig): () => void {
	const { watchGlob, pollMinutes, projectRoot, onEvent, onLog, triggerName } = config;

	let stopped = false;
	let initialTimeout: ReturnType<typeof setTimeout> | null = null;
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	// Track content hashes per file to only trigger on changes
	const fileHashes = new Map<string, string>();

	const isMatch = picomatch(watchGlob);

	function hashContent(content: string): string {
		return crypto.createHash('sha256').update(content).digest('hex');
	}

	async function doScan(): Promise<void> {
		if (stopped) return;

		try {
			const allFiles = walkDir(projectRoot, projectRoot);
			const matchedFiles = allFiles.filter((f) => isMatch(f));

			for (const relPath of matchedFiles) {
				if (stopped) return;

				const absPath = path.resolve(projectRoot, relPath);

				let content: string;
				try {
					content = fs.readFileSync(absPath, 'utf-8');
				} catch {
					continue;
				}

				// Check if content changed since last scan
				const hash = hashContent(content);
				const prevHash = fileHashes.get(relPath);

				if (prevHash === hash) {
					continue;
				}

				fileHashes.set(relPath, hash);

				// On first scan, seed the hash but don't fire events
				if (prevHash === undefined) {
					continue;
				}

				// Extract pending tasks
				const pendingTasks = extractPendingTasks(content);
				if (pendingTasks.length === 0) {
					continue;
				}

				const taskList = pendingTasks.map((t) => `L${t.line}: ${t.text}`).join('\n');

				const event: CueEvent = {
					id: crypto.randomUUID(),
					type: 'task.pending',
					timestamp: new Date().toISOString(),
					triggerName,
					payload: {
						path: absPath,
						filename: path.basename(relPath),
						directory: path.dirname(absPath),
						extension: path.extname(relPath),
						taskCount: pendingTasks.length,
						taskList,
						tasks: pendingTasks,
						content: content.slice(0, 10000),
					},
				};

				onEvent(event);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			onLog('error', `[CUE] Task scan error for "${triggerName}": ${message}`);
		}
	}

	// Initial scan after 2-second delay (same pattern as GitHub poller)
	initialTimeout = setTimeout(() => {
		if (stopped) return;
		doScan().then(() => {
			if (stopped) return;
			pollInterval = setInterval(
				() => {
					doScan();
				},
				pollMinutes * 60 * 1000
			);
		});
	}, 2000);

	return () => {
		stopped = true;
		if (initialTimeout) {
			clearTimeout(initialTimeout);
			initialTimeout = null;
		}
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	};
}
