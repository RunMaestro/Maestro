/**
 * Tests for SessionFileWatcher — generic on-disk watcher used to surface
 * activity from agent sessions Maestro did NOT spawn.
 *
 * These tests use real files under `os.tmpdir()` and a real chokidar watcher.
 * `fs` is intentionally NOT mocked. Time-sensitive assertions (idle window,
 * debounce) lean on `vi.useFakeTimers({ toFake: [...] })` with only the timer
 * APIs the watcher itself uses faked out, leaving `setImmediate`,
 * `process.nextTick`, etc. on real time so chokidar / libuv keep delivering
 * filesystem events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionFileWatcher } from '../../../main/storage/session-file-watcher';
import {
	EXTERNAL_ACTIVITY_IDLE_MS,
	type SessionActivityEvent,
} from '../../../shared/sessionActivity';

// Capture the real setTimeout / clearTimeout once at module load — these stay
// usable even after `vi.useFakeTimers()` swaps the globals.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// On macOS chokidar uses fsevents which can take a tick or two before it
// starts reporting events. This delay is short but real-time.
const CHOKIDAR_READY_MS = 250;
const CHOKIDAR_EVENT_MS = 250;

function realDelay(ms: number): Promise<void> {
	return new Promise((resolve) => realSetTimeout(resolve, ms));
}

function waitForEvent<T = SessionActivityEvent>(
	emitter: EventEmitter,
	event: string,
	timeoutMs = 3000
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = realSetTimeout(() => {
			emitter.off(event, handler);
			reject(new Error(`Timed out waiting for '${event}' after ${timeoutMs}ms`));
		}, timeoutMs);
		function handler(payload: T) {
			realClearTimeout(timer);
			resolve(payload);
		}
		emitter.once(event, handler);
	});
}

/**
 * Default matcher: relative paths shaped as `<project>/sess-<id>.jsonl`.
 * Anything else returns null, so the watcher must ignore it.
 */
function makeMatcher() {
	return (rel: string) => {
		const normalized = rel.split(path.sep).join('/');
		const match = normalized.match(/^(.+)\/sess-(.+)\.jsonl$/);
		if (!match) return null;
		return { projectPath: match[1], sessionId: match[2] };
	};
}

describe('SessionFileWatcher', () => {
	let tmpRoot: string;
	let watcher: SessionFileWatcher | null = null;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sfw-'));
	});

	afterEach(async () => {
		if (watcher) {
			await watcher.stop();
			watcher = null;
		}
		vi.useRealTimers();
		await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
	});

	it('emits "create" when a new matching session file appears', async () => {
		watcher = new SessionFileWatcher({
			agentId: 'claude-code',
			storageDir: tmpRoot,
			fileMatcher: makeMatcher(),
			debounceMs: 25,
		});
		await watcher.start();
		await realDelay(CHOKIDAR_READY_MS);

		const projectDir = path.join(tmpRoot, 'proj-1');
		await fs.mkdir(projectDir);

		const eventPromise = waitForEvent(watcher, 'create');
		const filePath = path.join(projectDir, 'sess-abc.jsonl');
		const initialContent = 'first line\n';
		await fs.writeFile(filePath, initialContent);

		const event = await eventPromise;
		expect(event.agentId).toBe('claude-code');
		expect(event.sessionId).toBe('abc');
		expect(event.projectPath).toBe('proj-1');
		expect(event.source).toBe('external');
		expect(event.sizeBytes).toBe(initialContent.length);
		expect(event.lastActivityAt).toBeGreaterThan(0);
		expect(Date.now() - event.lastActivityAt).toBeLessThan(5000);
	});

	it('emits "append" when an existing session file grows', async () => {
		const projectDir = path.join(tmpRoot, 'proj-2');
		await fs.mkdir(projectDir);
		const filePath = path.join(projectDir, 'sess-xyz.jsonl');
		const initialContent = 'existing\n';
		await fs.writeFile(filePath, initialContent);

		watcher = new SessionFileWatcher({
			agentId: 'claude-code',
			storageDir: tmpRoot,
			fileMatcher: makeMatcher(),
			debounceMs: 25,
		});
		await watcher.start();
		await realDelay(CHOKIDAR_READY_MS);

		const eventPromise = waitForEvent(watcher, 'append');
		const before = Date.now();
		await fs.appendFile(filePath, 'more bytes here\n');
		const event = await eventPromise;

		expect(event.sessionId).toBe('xyz');
		expect(event.projectPath).toBe('proj-2');
		expect(event.source).toBe('external');
		expect(event.sizeBytes).toBeGreaterThan(initialContent.length);
		expect(event.lastActivityAt).toBeGreaterThanOrEqual(before);
	});

	it('emits no events for files where fileMatcher returns null', async () => {
		watcher = new SessionFileWatcher({
			agentId: 'claude-code',
			storageDir: tmpRoot,
			fileMatcher: makeMatcher(),
			debounceMs: 25,
		});
		await watcher.start();
		await realDelay(CHOKIDAR_READY_MS);

		let createCount = 0;
		let appendCount = 0;
		watcher.on('create', () => {
			createCount += 1;
		});
		watcher.on('append', () => {
			appendCount += 1;
		});

		// Two unrelated paths: a top-level non-jsonl file, and a jsonl file
		// that doesn't match the `sess-*` shape the matcher requires.
		await fs.writeFile(path.join(tmpRoot, 'random.txt'), 'hello');
		const otherDir = path.join(tmpRoot, 'proj-3');
		await fs.mkdir(otherDir);
		await fs.writeFile(path.join(otherDir, 'not-a-session.jsonl'), 'noise\n');

		// Give chokidar more than enough time to deliver + debounce both events.
		await realDelay(CHOKIDAR_EVENT_MS + 100);

		expect(createCount).toBe(0);
		expect(appendCount).toBe(0);
	});

	it('debounces rapid appends into a single event', async () => {
		const projectDir = path.join(tmpRoot, 'proj-4');
		await fs.mkdir(projectDir);
		const filePath = path.join(projectDir, 'sess-rapid.jsonl');
		await fs.writeFile(filePath, 'init\n');

		watcher = new SessionFileWatcher({
			agentId: 'claude-code',
			storageDir: tmpRoot,
			fileMatcher: makeMatcher(),
			debounceMs: 200,
		});
		await watcher.start();
		await realDelay(CHOKIDAR_READY_MS);

		let appendCount = 0;
		watcher.on('append', () => {
			appendCount += 1;
		});

		// 10 rapid appends within the debounce window.
		for (let i = 0; i < 10; i += 1) {
			await fs.appendFile(filePath, `line ${i}\n`);
		}

		// Wait long enough that the debounce timer flushes exactly once.
		await realDelay(500);
		expect(appendCount).toBe(1);
	});

	it('resolves start() without throwing on a non-existent root dir', async () => {
		const missingDir = path.join(tmpRoot, 'definitely-not-here');
		watcher = new SessionFileWatcher({
			agentId: 'claude-code',
			storageDir: missingDir,
			fileMatcher: makeMatcher(),
		});

		await expect(watcher.start()).resolves.toBeUndefined();

		// And stop() should be a clean no-op too.
		await expect(watcher.stop()).resolves.toBeUndefined();
	});

	it('emits "idle" after EXTERNAL_ACTIVITY_IDLE_MS of quiet', async () => {
		// Fake only the timer APIs the watcher itself uses. Leave setImmediate,
		// setInterval, Date, and process.nextTick on real time so chokidar /
		// fsevents continue delivering FS events normally.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		const projectDir = path.join(tmpRoot, 'proj-5');
		await fs.mkdir(projectDir);

		watcher = new SessionFileWatcher({
			agentId: 'claude-code',
			storageDir: tmpRoot,
			fileMatcher: makeMatcher(),
			debounceMs: 50,
		});

		const createEvents: SessionActivityEvent[] = [];
		const idleEvents: SessionActivityEvent[] = [];
		watcher.on('create', (e: SessionActivityEvent) => createEvents.push(e));
		watcher.on('idle', (e: SessionActivityEvent) => idleEvents.push(e));

		await watcher.start();
		await realDelay(CHOKIDAR_READY_MS);

		// Write a matching file. Chokidar will deliver 'add' on real time;
		// the watcher will then schedule debounce + idle via FAKE setTimeout.
		await fs.writeFile(path.join(projectDir, 'sess-idle.jsonl'), 'data\n');
		await realDelay(CHOKIDAR_EVENT_MS);

		// Flush the debounce timer → 'create' fires.
		await vi.advanceTimersByTimeAsync(100);
		expect(createEvents).toHaveLength(1);
		expect(idleEvents).toHaveLength(0);

		// Idle should NOT have fired yet — we're well inside the window.
		await vi.advanceTimersByTimeAsync(EXTERNAL_ACTIVITY_IDLE_MS - 200);
		expect(idleEvents).toHaveLength(0);

		// Cross the idle boundary.
		await vi.advanceTimersByTimeAsync(500);
		expect(idleEvents).toHaveLength(1);
		expect(idleEvents[0].sessionId).toBe('idle');
		expect(idleEvents[0].source).toBe('external');
		expect(idleEvents[0].agentId).toBe('claude-code');
	});
});
