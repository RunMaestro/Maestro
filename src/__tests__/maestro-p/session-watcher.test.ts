/**
 * @file session-watcher.test.ts
 * @description Tests for the maestro-p session-id discovery helper.
 *
 * These exercise real chokidar against a real temp directory — the playbook
 * specifically calls out "create a temp directory mimicking the claude
 * projects layout, drop a fake .jsonl file post-spawn-timestamp, and assert
 * the basename comes back." Mocking chokidar would defeat the point: the
 * value of this module is its fs-watching behavior, not its bookkeeping.
 *
 * Covers:
 *   - happy path: a .jsonl file appearing post-spawn returns its basename
 *   - timeout: no file → promise rejects after timeoutMs
 *   - non-jsonl files in the slug dir are ignored
 *   - stale .jsonl files (created before spawnTimestamp) are ignored
 *   - the slug directory is created if it does not exist
 *   - the cwd → slug encoding mirrors Claude's convention
 *   - the first qualifying file wins when multiple appear
 *
 * Real chokidar attaches asynchronously, so each test waits a short hold-off
 * after kicking off discovery before writing the candidate file. 200ms is
 * comfortably above what fsevents on macOS / inotify on Linux need to settle.
 * If this proves flaky on CI we should swap to `usePolling: true` via a test
 * injection seam, but for now real events keep the tests honest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { discoverSessionId } from '../../maestro-p/session-watcher';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';

// Polling interval used in tests via the `_chokidarOptions` injection seam.
// 50ms is fast enough that no test needs to wait long after a file write to
// see the resolution, but slow enough that the suite isn't burning CPU on a
// hot loop. Inside vitest's jsdom worker, native fsevents binding has been
// unreliable — polling makes the tests deterministic without depending on
// platform-specific watcher behavior. Production users get the default
// fsevents / inotify path; this seam is test-only.
const TEST_POLLING_INTERVAL_MS = 50;

// Generous hold-off for the polling watcher to attach. With a 50ms poll
// interval, 150ms covers at least two scan cycles, which is plenty.
const WATCHER_ATTACH_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polling-mode chokidar options for the test injection seam. Every test
// builds its discoverSessionId call through this helper so we don't drift.
const testChokidarOptions = {
	usePolling: true,
	interval: TEST_POLLING_INTERVAL_MS,
	binaryInterval: TEST_POLLING_INTERVAL_MS,
} as const;

describe('discoverSessionId', () => {
	let tempRoot: string;
	let configDir: string;
	// We pin a fake cwd path rather than using the real working directory so
	// the slug is independent of where the tests run from.
	const fakeCwd = '/tmp/fake-project-cwd';

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-p-session-'));
		// Mirror the layout the playbook describes: <configDir>/projects/<slug>/
		configDir = path.join(tempRoot, '.claude');
		await fs.mkdir(configDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	function slugDir(): string {
		return path.join(configDir, 'projects', encodeClaudeProjectPath(fakeCwd));
	}

	it('returns the basename of a fresh .jsonl file created after spawnTimestamp', async () => {
		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			timeoutMs: 5000,
			_chokidarOptions: testChokidarOptions,
		});

		// Give chokidar a moment to attach against the freshly-created slug
		// directory before we drop the candidate file.
		await sleep(WATCHER_ATTACH_DELAY_MS);

		const sessionId = 'abc-123-def-456';
		const filePath = path.join(slugDir(), `${sessionId}.jsonl`);
		await fs.writeFile(filePath, '{"type":"system"}\n');

		await expect(discovery).resolves.toBe(sessionId);
	});

	it('creates the slug directory if it does not exist', async () => {
		const slug = slugDir();

		// Pre-condition: slug dir is absent. The function must mkdir -p it.
		await expect(fs.stat(slug)).rejects.toMatchObject({ code: 'ENOENT' });

		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			// Short timeout — we only care that the dir is created promptly,
			// not that the promise resolves with a real session id.
			timeoutMs: 300,
			_chokidarOptions: testChokidarOptions,
		});

		await sleep(50);

		// Post-condition: slug dir exists (and is a directory).
		const stat = await fs.stat(slug);
		expect(stat.isDirectory()).toBe(true);

		// Let the discovery time out cleanly so it doesn't leak.
		await expect(discovery).rejects.toThrow(/timed out/);
	});

	it('rejects with a timeout error if no .jsonl file appears in time', async () => {
		const spawnTimestamp = Date.now();

		await expect(
			discoverSessionId({
				configDir,
				cwd: fakeCwd,
				spawnTimestamp,
				timeoutMs: 250,
				_chokidarOptions: testChokidarOptions,
			})
		).rejects.toThrow(/timed out after 250ms/);
	});

	it('ignores non-jsonl files dropped in the slug directory', async () => {
		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			timeoutMs: 600,
			_chokidarOptions: testChokidarOptions,
		});

		await sleep(WATCHER_ATTACH_DELAY_MS);

		// A .txt file appearing in the watched dir must not satisfy discovery.
		await fs.writeFile(path.join(slugDir(), 'not-a-session.txt'), 'noise');
		await fs.writeFile(path.join(slugDir(), 'README.md'), 'noise');

		await expect(discovery).rejects.toThrow(/timed out/);
	});

	it('ignores stale .jsonl files whose birthtime predates spawnTimestamp', async () => {
		// Drop a stale file BEFORE we set spawnTimestamp. Its birthtime
		// will be earlier than the threshold, so the race-window scan must
		// skip it and the chokidar 'add' event won't fire (ignoreInitial).
		await fs.mkdir(slugDir(), { recursive: true });
		const stalePath = path.join(slugDir(), 'stale-session-id.jsonl');
		await fs.writeFile(stalePath, '{"type":"old"}\n');

		// Pad enough for the filesystem's birthtime granularity to clearly
		// place the stale file before spawnTimestamp.
		await sleep(50);
		const spawnTimestamp = Date.now();

		await expect(
			discoverSessionId({
				configDir,
				cwd: fakeCwd,
				spawnTimestamp,
				timeoutMs: 400,
				_chokidarOptions: testChokidarOptions,
			})
		).rejects.toThrow(/timed out/);
	});

	it('uses Claude\'s slug convention (every non-alphanumeric → "-")', async () => {
		// `/tmp/fake-project-cwd` → `-tmp-fake-project-cwd`. We assert the
		// discovery picks up a file in *that* exact path, not a sibling.
		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			timeoutMs: 5000,
			_chokidarOptions: testChokidarOptions,
		});

		await sleep(WATCHER_ATTACH_DELAY_MS);

		const expectedSlug = '-tmp-fake-project-cwd';
		const expectedDir = path.join(configDir, 'projects', expectedSlug);
		const sessionId = 'sluggy-session';
		await fs.writeFile(path.join(expectedDir, `${sessionId}.jsonl`), '{}');

		await expect(discovery).resolves.toBe(sessionId);
	});

	it('returns the basename of the first qualifying file and locks on (does not flip)', async () => {
		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			timeoutMs: 5000,
			_chokidarOptions: testChokidarOptions,
		});

		await sleep(WATCHER_ATTACH_DELAY_MS);

		const firstId = 'first-arrival';
		const firstPath = path.join(slugDir(), `${firstId}.jsonl`);
		await fs.writeFile(firstPath, '{}');

		// First-resolution should already be in flight. Await it before we
		// drop the second file so the second can never racily satisfy the
		// promise — this isolates the assertion to "first wins" without
		// depending on chokidar's poll ordering when both files exist at
		// the same scan cycle.
		await expect(discovery).resolves.toBe(firstId);

		// Sanity check: dropping a second qualifying file after resolution
		// is a no-op. The promise is already settled. We don't await this
		// inside a setTimeout — async leak into the next test was the
		// original bug this rewrite avoids.
		await fs.writeFile(path.join(slugDir(), 'second-arrival.jsonl'), '{}');
		await expect(discovery).resolves.toBe(firstId);
	});

	it('strips only the .jsonl extension (not any embedded dots in the id)', async () => {
		// Defensive: if claude ever started naming sessions with dots, the
		// basename math must not eat them. `path.basename(p, '.jsonl')` is
		// the right primitive — this test pins that behavior.
		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			timeoutMs: 5000,
			_chokidarOptions: testChokidarOptions,
		});

		await sleep(WATCHER_ATTACH_DELAY_MS);

		const sessionId = 'session.with.dots.in.it';
		await fs.writeFile(path.join(slugDir(), `${sessionId}.jsonl`), '{}');

		await expect(discovery).resolves.toBe(sessionId);
	});

	it('defaults timeoutMs to 10000ms when not provided', async () => {
		// We don't want a real 10s wait in the suite, so we only assert that
		// the function accepts the missing field without crashing and that
		// discovery still resolves when a file is dropped quickly.
		const spawnTimestamp = Date.now();
		const discovery = discoverSessionId({
			configDir,
			cwd: fakeCwd,
			spawnTimestamp,
			_chokidarOptions: testChokidarOptions,
		});

		await sleep(WATCHER_ATTACH_DELAY_MS);

		const sessionId = 'default-timeout-ok';
		await fs.writeFile(path.join(slugDir(), `${sessionId}.jsonl`), '{}');

		await expect(discovery).resolves.toBe(sessionId);
	});
});
