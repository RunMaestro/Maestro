/**
 * @file session-watcher.test.ts
 * @description Tests for src/maestro-p/session-watcher.ts - discovers a
 * freshly-spawned claude TUI's session id by polling
 * `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/` for the first new `*.jsonl`
 * whose creation time is at or after the recorded spawn timestamp.
 *
 * Strategy: drive against real temp directories with `fs.mkdtempSync`
 * for isolation and a small poll interval for snappy assertions. Terminal
 * timeout cases fake only scheduler time; positive filesystem behavior keeps
 * native timers so birthtime, readdir, and ENOENT recovery stay exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	DEFAULT_DISCOVERY_POLL_INTERVAL_MS,
	DEFAULT_DISCOVERY_TIMEOUT_MS,
	cwdSlug,
	discoverSessionId,
} from '../../maestro-p/session-watcher';

const FAST_POLL_MS = 10;

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe('session-watcher', () => {
	let tempDir: string;
	let configDir: string;
	const cwd = '/Users/test/example-proj';
	const expectedSlug = '-Users-test-example-proj';

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-p-session-watcher-'));
		configDir = path.join(tempDir, '.claude');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function projectsDir(): string {
		return path.join(configDir, 'projects', expectedSlug);
	}

	function ensureProjectsDir(): void {
		fs.mkdirSync(projectsDir(), { recursive: true });
	}

	function writeJsonl(sessionId: string, content = ''): string {
		ensureProjectsDir();
		const full = path.join(projectsDir(), `${sessionId}.jsonl`);
		fs.writeFileSync(full, content);
		return full;
	}

	describe('exposed constants', () => {
		it('DEFAULT_DISCOVERY_TIMEOUT_MS = 10000 (matches the run-mode spec)', () => {
			expect(DEFAULT_DISCOVERY_TIMEOUT_MS).toBe(10000);
		});

		it('DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 75 (matches JsonlTailer cadence)', () => {
			expect(DEFAULT_DISCOVERY_POLL_INTERVAL_MS).toBe(75);
		});
	});

	describe('cwdSlug()', () => {
		it('replaces every non-alphanumeric character with `-` (canonical claude rule)', () => {
			expect(cwdSlug('/Users/test/example-proj')).toBe('-Users-test-example-proj');
		});

		it('replaces dots (which look alphanumeric to the eye) with `-`', () => {
			// `/Users/foo/.claude-mem/observer` and `/Users/foo/.claude-mem-observer`
			// collide under this rule - that's a known claude behavior, not our
			// problem to disambiguate.
			expect(cwdSlug('/Users/foo/.claude-mem/observer')).toBe('-Users-foo--claude-mem-observer');
		});

		it('handles a path that is already all dashes / hyphens', () => {
			expect(cwdSlug('---')).toBe('---');
		});

		it('handles an empty string', () => {
			expect(cwdSlug('')).toBe('');
		});
	});

	describe('discoverSessionId()', () => {
		it('returns the basename and full path of a file dropped after spawnTimestamp', async () => {
			const spawnTimestamp = Date.now();
			// Tiny wait so the file's birthtime is strictly after spawnTimestamp
			// on filesystems with coarse-grained timestamps.
			await sleep(5);
			const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
			const filePath = writeJsonl(sessionId);

			const result = await discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				timeoutMs: 1000,
				pollIntervalMs: FAST_POLL_MS,
			});

			expect(result.sessionId).toBe(sessionId);
			expect(result.jsonlPath).toBe(filePath);
		});

		it('ignores pre-existing files whose creation time is before spawnTimestamp', async () => {
			ensureProjectsDir();
			writeJsonl('old-session-id');

			// Wait so `Date.now()` is observably after the old file's birthtime.
			await sleep(20);
			const spawnTimestamp = Date.now();
			await sleep(5);

			const newId = 'new-session-id';
			writeJsonl(newId);

			const result = await discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				timeoutMs: 1000,
				pollIntervalMs: FAST_POLL_MS,
			});

			expect(result.sessionId).toBe(newId);
		});

		it('picks the earliest among multiple eligible candidates', async () => {
			const spawnTimestamp = Date.now();
			await sleep(5);
			const firstId = 'first-id';
			const firstPath = writeJsonl(firstId);
			// Stagger so birthtimes differ even on coarse-resolution filesystems.
			await sleep(30);
			writeJsonl('second-id');

			const result = await discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				timeoutMs: 1000,
				pollIntervalMs: FAST_POLL_MS,
			});

			expect(result.sessionId).toBe(firstId);
			expect(result.jsonlPath).toBe(firstPath);
		});

		it('with expectSessionId, returns THAT file even when a sibling appears first (no cross-talk)', async () => {
			const spawnTimestamp = Date.now();
			await sleep(5);
			// A concurrent sibling session writes its transcript FIRST. The legacy
			// earliest-new heuristic would wrongly attach to this one.
			writeJsonl('sibling-concurrent-id');
			await sleep(30);
			const mineId = 'my-pre-assigned-id';
			const minePath = writeJsonl(mineId);

			const result = await discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				expectSessionId: mineId,
				timeoutMs: 1000,
				pollIntervalMs: FAST_POLL_MS,
			});

			// Must resolve to the pre-assigned id, NOT the earlier sibling.
			expect(result.sessionId).toBe(mineId);
			expect(result.jsonlPath).toBe(minePath);
		});

		it('with expectSessionId, waits for the specific file and ignores unrelated ones', async () => {
			const spawnTimestamp = Date.now();
			const mineId = 'expected-late-id';
			const discoveryPromise = discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				expectSessionId: mineId,
				timeoutMs: 1500,
				pollIntervalMs: FAST_POLL_MS,
			});
			// An unrelated session appears first; discovery must NOT resolve on it.
			await sleep(30);
			writeJsonl('unrelated-id');
			await sleep(30);
			const minePath = writeJsonl(mineId);

			const result = await discoveryPromise;
			expect(result.sessionId).toBe(mineId);
			expect(result.jsonlPath).toBe(minePath);
		});

		it('with expectSessionId, rejects with a descriptive error if that file never appears', async () => {
			const spawnTimestamp = Date.now();
			// A different session shows up, but never the expected one.
			writeJsonl('some-other-id');
			vi.useFakeTimers();
			try {
				const rejection = expect(
					discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						expectSessionId: 'never-written-id',
						timeoutMs: 250,
						pollIntervalMs: FAST_POLL_MS,
					})
				).rejects.toThrow(/never-written-id\.jsonl did not appear/);
				await vi.advanceTimersByTimeAsync(250);
				await rejection;
			} finally {
				vi.useRealTimers();
			}
		});

		it('tolerates the projects dir not existing yet - picks up the file once it appears', async () => {
			const spawnTimestamp = Date.now();
			// Kick off discovery before the directory exists. Claude lazily
			// creates `projects/<slug>/` on the first session for a cwd.
			const discoveryPromise = discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				timeoutMs: 1500,
				pollIntervalMs: FAST_POLL_MS,
			});
			// Drop the file mid-flight after a brief delay.
			await sleep(40);
			const sessionId = 'late-session-id';
			const filePath = writeJsonl(sessionId);

			const result = await discoveryPromise;
			expect(result.sessionId).toBe(sessionId);
			expect(result.jsonlPath).toBe(filePath);
		});

		it('ignores non-.jsonl entries in the projects dir', async () => {
			ensureProjectsDir();
			const spawnTimestamp = Date.now();
			await sleep(5);
			fs.writeFileSync(path.join(projectsDir(), 'README.md'), 'noise');
			fs.writeFileSync(path.join(projectsDir(), 'config.json'), '{}');
			const sessionId = 'real-session';
			const filePath = writeJsonl(sessionId);

			const result = await discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				timeoutMs: 1000,
				pollIntervalMs: FAST_POLL_MS,
			});

			expect(result.sessionId).toBe(sessionId);
			expect(result.jsonlPath).toBe(filePath);
		});

		it('ignores subdirectories that happen to end in .jsonl', async () => {
			ensureProjectsDir();
			const spawnTimestamp = Date.now();
			await sleep(5);
			fs.mkdirSync(path.join(projectsDir(), 'weird-dir.jsonl'));
			const sessionId = 'real-session';
			writeJsonl(sessionId);

			const result = await discoverSessionId({
				configDir,
				cwd,
				spawnTimestamp,
				timeoutMs: 1000,
				pollIntervalMs: FAST_POLL_MS,
			});

			expect(result.sessionId).toBe(sessionId);
		});

		it('rejects with a descriptive error when no file appears within the timeout', async () => {
			const spawnTimestamp = Date.now();
			vi.useFakeTimers();
			try {
				const rejection = expect(
					discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 100,
						pollIntervalMs: FAST_POLL_MS,
					})
				).rejects.toThrow(/no new \.jsonl appeared/);
				await vi.advanceTimersByTimeAsync(100);
				await rejection;
			} finally {
				vi.useRealTimers();
			}
		});

		it('rejects when only pre-spawn files exist (i.e., none satisfy the timestamp filter)', async () => {
			ensureProjectsDir();
			writeJsonl('stale-session');
			await sleep(20);
			const spawnTimestamp = Date.now();
			vi.useFakeTimers();
			try {
				const rejection = expect(
					discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 100,
						pollIntervalMs: FAST_POLL_MS,
					})
				).rejects.toThrow(/no new \.jsonl appeared/);
				await vi.advanceTimersByTimeAsync(100);
				await rejection;
			} finally {
				vi.useRealTimers();
			}
		});

		it('builds the watch path from configDir + projects/ + cwdSlug(cwd)', async () => {
			// Files dropped in the WRONG cwd-slug must not be picked up.
			const otherSlugDir = path.join(configDir, 'projects', '-Users-test-other');
			fs.mkdirSync(otherSlugDir, { recursive: true });
			const spawnTimestamp = Date.now();
			await sleep(5);
			fs.writeFileSync(path.join(otherSlugDir, 'wrong-session.jsonl'), '');

			vi.useFakeTimers();
			try {
				const wrongPathRejection = expect(
					discoverSessionId({
						configDir,
						cwd,
						spawnTimestamp,
						timeoutMs: 100,
						pollIntervalMs: FAST_POLL_MS,
					})
				).rejects.toThrow(/no new \.jsonl appeared/);
				await vi.advanceTimersByTimeAsync(100);
				await wrongPathRejection;

				// And the error mentions the correct (expected) directory.
				let caught: Error | null = null;
				const expectedPathRejection = discoverSessionId({
					configDir,
					cwd,
					spawnTimestamp,
					timeoutMs: 50,
					pollIntervalMs: FAST_POLL_MS,
				});
				await vi.advanceTimersByTimeAsync(50);
				try {
					await expectedPathRejection;
				} catch (err) {
					caught = err as Error;
				}
				expect(caught).not.toBeNull();
				expect(caught!.message).toContain(expectedSlug);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
