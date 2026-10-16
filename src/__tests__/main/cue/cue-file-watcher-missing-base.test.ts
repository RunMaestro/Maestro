/**
 * Real-filesystem tests for a `file.changed` watch glob whose static folder
 * is missing when the watcher starts, or is deleted and created again.
 *
 * chokidar 3 watches a glob from its static folder (`inbox` for
 * `inbox/*.txt`); when that folder is missing it falls back to watching the
 * parent for an entry literally named `*.txt`, so a folder created later was
 * never picked up. These tests drive real chokidar against a temp directory.
 *
 * Windows: a watched folder cannot always be deleted right away, and watchers
 * close asynchronously, so every removal retries and recreation is retried.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createCueFileWatcher, staticWatchBase } from '../../../main/cue/cue-file-watcher';
import type { CueEvent } from '../../../main/cue/cue-types';

const DEBOUNCE_MS = 50;
const SETTLE_MS = 400;
const WAIT_TIMEOUT_MS = 8000;
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 } as const;
// Each test can wait up to WAIT_TIMEOUT_MS on top of several SETTLE_MS pauses,
// which a slow Windows runner can push past the suite's 10s default.
const TEST_TIMEOUT_MS = 30000;
// Windows and default macOS volumes match folder names case-insensitively.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await delay(25);
	}
}

/** mkdir that tolerates a folder Windows still holds pending-delete. */
async function mkdirWithRetry(dir: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			return;
		} catch (error) {
			if (attempt >= 20) throw error;
			await delay(50);
		}
	}
}

describe('cue-file-watcher with a missing static folder', { timeout: TEST_TIMEOUT_MS }, () => {
	let root: string;
	let events: CueEvent[];
	let cleanup: (() => void) | null;

	const start = (watchGlob: string) => {
		cleanup = createCueFileWatcher({
			watchGlob,
			projectRoot: root,
			debounceMs: DEBOUNCE_MS,
			triggerName: 'missing-base',
			onEvent: (event) => events.push(event),
		});
	};

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-watch-base-')));
		events = [];
		cleanup = null;
	});

	afterEach(async () => {
		cleanup?.();
		cleanup = null;
		// Watchers close asynchronously; give the handles a moment on Windows.
		await delay(50);
		try {
			fs.rmSync(root, RM_OPTIONS);
		} catch (error) {
			// A handle Windows has not released yet only leaves a temp folder
			// behind; it says nothing about the watcher under test.
			if (process.platform !== 'win32') throw error;
		}
	});

	it('fires once for a file written into a folder created after the watcher is ready', async () => {
		start('inbox/*.txt');
		await delay(SETTLE_MS);

		await mkdirWithRetry(path.join(root, 'inbox'));
		await delay(SETTLE_MS);
		fs.writeFileSync(path.join(root, 'inbox', 'a.txt'), 'one');

		await waitFor(() => events.length >= 1);
		await delay(SETTLE_MS);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('file.changed');
		expect(events[0].payload).toMatchObject({
			path: path.join(root, 'inbox', 'a.txt'),
			filename: 'a.txt',
			directory: path.join(root, 'inbox'),
			extension: '.txt',
			changeType: 'add',
		});
	});

	it('fires for a file written in the same tick the folder is created', async () => {
		start('inbox/*.txt');
		await delay(SETTLE_MS);

		await mkdirWithRetry(path.join(root, 'inbox'));
		fs.writeFileSync(path.join(root, 'inbox', 'fast.txt'), 'fast');

		await waitFor(() => events.length >= 1);
		await delay(SETTLE_MS);
		expect(events).toHaveLength(1);
		expect(events[0].payload).toMatchObject({ filename: 'fast.txt', changeType: 'add' });
	});

	it('fires for nested missing folders created one level at a time', async () => {
		start('a/b/*.md');
		await delay(SETTLE_MS);

		await mkdirWithRetry(path.join(root, 'a'));
		await delay(SETTLE_MS);
		await mkdirWithRetry(path.join(root, 'a', 'b'));
		await delay(SETTLE_MS);
		fs.writeFileSync(path.join(root, 'a', 'b', 'note.md'), '# note');

		await waitFor(() => events.length >= 1);
		await delay(SETTLE_MS);
		expect(events).toHaveLength(1);
		expect(events[0].payload).toMatchObject({
			path: path.join(root, 'a', 'b', 'note.md'),
			changeType: 'add',
		});
	});

	it('keeps firing after the folder is deleted and created again', async () => {
		await mkdirWithRetry(path.join(root, 'inbox'));
		start('inbox/*.txt');
		await delay(SETTLE_MS);

		fs.writeFileSync(path.join(root, 'inbox', 'first.txt'), '1');
		await waitFor(() => events.length >= 1);

		fs.rmSync(path.join(root, 'inbox'), RM_OPTIONS);
		await delay(SETTLE_MS);
		await mkdirWithRetry(path.join(root, 'inbox'));
		await delay(SETTLE_MS);
		const before = events.length;
		fs.writeFileSync(path.join(root, 'inbox', 'second.txt'), '2');

		await waitFor(() => events.some((e) => e.payload.filename === 'second.txt'));
		await delay(SETTLE_MS);
		const after = events.slice(before).filter((e) => e.payload.filename === 'second.txt');
		expect(after).toHaveLength(1);
		expect(after[0].payload.changeType).toBe('add');
	});

	it('keeps firing after a parent of the folder is deleted and the chain recreated', async () => {
		await mkdirWithRetry(path.join(root, 'a', 'b'));
		start('a/b/*.md');
		await delay(SETTLE_MS);

		fs.rmSync(path.join(root, 'a'), RM_OPTIONS);
		await delay(SETTLE_MS);
		await mkdirWithRetry(path.join(root, 'a', 'b'));
		await delay(SETTLE_MS);
		fs.writeFileSync(path.join(root, 'a', 'b', 'back.md'), 'back');

		await waitFor(() => events.length >= 1);
		await delay(SETTLE_MS);
		expect(events).toHaveLength(1);
		expect(events[0].payload).toMatchObject({ filename: 'back.md', changeType: 'add' });
	});

	it.runIf(CASE_INSENSITIVE_FS)(
		'fires for a folder created in a different case than the glob spells it',
		async () => {
			start('Inbox/*.txt');
			await delay(SETTLE_MS);

			await mkdirWithRetry(path.join(root, 'inbox'));
			await delay(SETTLE_MS);
			fs.writeFileSync(path.join(root, 'inbox', 'cased.txt'), 'cased');

			await waitFor(() => events.length >= 1);
			await delay(SETTLE_MS);
			expect(events).toHaveLength(1);
			expect(events[0].payload).toMatchObject({ filename: 'cased.txt', changeType: 'add' });
		}
	);

	it('does not report files already in a folder present at start', async () => {
		await mkdirWithRetry(path.join(root, 'inbox'));
		fs.writeFileSync(path.join(root, 'inbox', 'old.txt'), 'old');
		start('inbox/*.txt');
		await delay(SETTLE_MS * 2);

		expect(events).toHaveLength(0);
	});

	it('still fires for a glob with no static folder', async () => {
		start('**/*.md');
		await delay(SETTLE_MS);

		await mkdirWithRetry(path.join(root, 'deep', 'er'));
		await delay(SETTLE_MS);
		fs.writeFileSync(path.join(root, 'deep', 'er', 'x.md'), 'x');

		await waitFor(() => events.length >= 1);
		expect(events[0].payload).toMatchObject({
			path: path.join(root, 'deep', 'er', 'x.md'),
			changeType: 'add',
		});
	});
});

describe('staticWatchBase', () => {
	it.each([
		['inbox/*.txt', 'inbox'],
		['a/b/*.md', 'a/b'],
		['./inbox/*.txt', 'inbox'],
		['docs/readme.md', 'docs'],
		['readme.md', ''],
		['**/*.md', ''],
		['{a,b}/*.md', ''],
		['src/**/*.ts', 'src'],
	])('%s -> %j', (glob, base) => {
		expect(staticWatchBase(glob)).toBe(base);
	});
});
