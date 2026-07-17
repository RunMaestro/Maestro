/**
 * @file jsonl-tailer.test.ts
 * @description Tests for src/maestro-p/jsonl-tailer.ts - the poll-based
 * tailer that reads Claude's live session JSONL and emits structured
 * `entry` / `parse-error` events.
 *
 * Strategy: drive against real temp files with `fs.mkdtempSync` for
 * isolation and a 10ms poll interval for snappy assertions. Tests retain
 * real filesystem I/O; schedule-only polling and backoff waits use fake
 * timers so their timing does not dominate the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	JsonlTailer,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_EXISTS_TIMEOUT_MS,
	type ParseErrorPayload,
} from '../../maestro-p/jsonl-tailer';

const FAST_POLL_MS = 10;

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	if (!predicate()) {
		throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface TailerHarness {
	tailer: JsonlTailer;
	filePath: string;
	entries: unknown[];
	parseErrors: ParseErrorPayload[];
}

describe('JsonlTailer', () => {
	let tempDir: string;
	let activeTailer: JsonlTailer | null;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-p-tailer-'));
		activeTailer = null;
	});

	afterEach(() => {
		activeTailer?.stop();
		activeTailer = null;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function makeHarness(
		name: string,
		opts: { skipExisting?: boolean; pollIntervalMs?: number; existsTimeoutMs?: number } = {}
	): TailerHarness {
		const filePath = path.join(tempDir, name);
		const tailer = new JsonlTailer({
			path: filePath,
			pollIntervalMs: opts.pollIntervalMs ?? FAST_POLL_MS,
			skipExisting: opts.skipExisting,
			existsTimeoutMs: opts.existsTimeoutMs,
		});
		activeTailer = tailer;
		const entries: unknown[] = [];
		const parseErrors: ParseErrorPayload[] = [];
		tailer.on('entry', (entry: unknown) => entries.push(entry));
		tailer.on('parse-error', (err: unknown) => parseErrors.push(err as ParseErrorPayload));
		return { tailer, filePath, entries, parseErrors };
	}

	describe('exposed constants', () => {
		it('DEFAULT_POLL_INTERVAL_MS = 75 (snappy for streaming, cheap for idle)', () => {
			expect(DEFAULT_POLL_INTERVAL_MS).toBe(75);
		});

		it('DEFAULT_EXISTS_TIMEOUT_MS = 5000 (matches the spec fresh-session race window)', () => {
			expect(DEFAULT_EXISTS_TIMEOUT_MS).toBe(5000);
		});
	});

	describe('skipExisting: false (default)', () => {
		it('emits every pre-existing line as an entry, in order', async () => {
			const { tailer, filePath, entries } = makeHarness('pre.jsonl');
			fs.writeFileSync(filePath, '{"i":1}\n{"i":2}\n{"i":3}\n');
			await tailer.start();
			await waitUntil(() => entries.length === 3);
			expect(entries).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
		});
	});

	describe('skipExisting: true', () => {
		it('ignores pre-existing content', async () => {
			const { tailer, filePath, entries } = makeHarness('skip.jsonl', { skipExisting: true });
			fs.writeFileSync(filePath, '{"i":1}\n{"i":2}\n');
			vi.useFakeTimers();
			try {
				await tailer.start();
				// Drive several scheduler ticks to confirm nothing leaks through.
				await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 5);
				expect(entries).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('emits only entries appended after start()', async () => {
			const { tailer, filePath, entries } = makeHarness('skip-append.jsonl', {
				skipExisting: true,
			});
			fs.writeFileSync(filePath, '{"old":true}\n');
			await tailer.start();
			fs.appendFileSync(filePath, '{"new":true}\n');
			await waitUntil(() => entries.length === 1);
			expect(entries).toEqual([{ new: true }]);
		});
	});

	describe('post-start appends', () => {
		it('emits each appended entry in order', async () => {
			const { tailer, filePath, entries } = makeHarness('seq.jsonl');
			fs.writeFileSync(filePath, '');
			await tailer.start();
			fs.appendFileSync(filePath, '{"i":1}\n{"i":2}\n{"i":3}\n');
			await waitUntil(() => entries.length === 3);
			expect(entries).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
		});
	});

	describe('partial-line buffering', () => {
		it('does not parse a truncated line; finalizes once the newline arrives', async () => {
			const { tailer, filePath, entries, parseErrors } = makeHarness('partial.jsonl');
			fs.writeFileSync(filePath, '');
			await tailer.start();
			// First write leaves a partial trailing line - the tailer must
			// emit only the completed entry and buffer the rest, NOT throw a
			// parse-error on the half-formed `{"b":`.
			fs.appendFileSync(filePath, '{"a":1}\n{"b":');
			await waitUntil(() => entries.length === 1);
			expect(entries).toEqual([{ a: 1 }]);
			expect(parseErrors).toEqual([]);
			// Second write completes the buffered line.
			fs.appendFileSync(filePath, '2}\n');
			await waitUntil(() => entries.length === 2);
			expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
			expect(parseErrors).toEqual([]);
		});
	});

	describe('empty lines', () => {
		it('skips empty lines silently (no entries, no parse-errors)', async () => {
			const { tailer, filePath, entries, parseErrors } = makeHarness('empties.jsonl');
			fs.writeFileSync(filePath, '\n\n{"present":true}\n\n');
			vi.useFakeTimers();
			try {
				await tailer.start();
				// Let scheduler ticks process the real file and expose any erroneous trailing empties.
				await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
				expect(entries).toEqual([{ present: true }]);
				expect(parseErrors).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('malformed JSON', () => {
		it('emits parse-error and continues reading subsequent lines', async () => {
			const { tailer, filePath, entries, parseErrors } = makeHarness('bad.jsonl');
			fs.writeFileSync(filePath, '{"ok":1}\nnot-json\n{"ok":2}\n');
			await tailer.start();
			await waitUntil(() => entries.length === 2 && parseErrors.length === 1);
			expect(entries).toEqual([{ ok: 1 }, { ok: 2 }]);
			expect(parseErrors).toHaveLength(1);
			expect(parseErrors[0].line).toBe('not-json');
			expect(parseErrors[0].error).toBeInstanceOf(Error);
		});
	});

	describe('file appears after start()', () => {
		it('attaches and emits when the file is created within the timeout', async () => {
			const { tailer, filePath, entries } = makeHarness('late.jsonl', {
				existsTimeoutMs: 2000,
			});
			const startPromise = tailer.start();
			// Simulate the fresh-session race: file shows up shortly after
			// the runner started tailing.
			await sleep(50);
			fs.writeFileSync(filePath, '{"late":true}\n');
			await startPromise;
			await waitUntil(() => entries.length === 1);
			expect(entries).toEqual([{ late: true }]);
		});

		it('rejects when the file never appears within the timeout', async () => {
			const tailer = new JsonlTailer({
				path: path.join(tempDir, 'never.jsonl'),
				pollIntervalMs: FAST_POLL_MS,
				existsTimeoutMs: 100,
			});
			activeTailer = tailer;
			vi.useFakeTimers();
			try {
				const rejection = expect(tailer.start()).rejects.toThrow(/did not appear/);
				await vi.advanceTimersByTimeAsync(175);
				await rejection;
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('stop()', () => {
		it('halts polling - no further events fire after stop(), even on new appends', async () => {
			const { tailer, filePath, entries } = makeHarness('stop.jsonl');
			fs.writeFileSync(filePath, '{"i":1}\n');
			vi.useFakeTimers();
			try {
				await tailer.start();
				await vi.advanceTimersByTimeAsync(FAST_POLL_MS);
				expect(entries).toEqual([{ i: 1 }]);

				tailer.stop();
				const snapshotCount = entries.length;
				fs.appendFileSync(filePath, '{"i":2}\n{"i":3}\n');
				// Drive several poll cycles to prove the stopped tailer ignores the append.
				await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 8);
				expect(entries.length).toBe(snapshotCount);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('start() twice', () => {
		it('rejects a second start() call', async () => {
			const { tailer, filePath } = makeHarness('twice.jsonl');
			fs.writeFileSync(filePath, '');
			await tailer.start();
			await expect(tailer.start()).rejects.toThrow(/start\(\) called twice/);
		});
	});

	describe('getLastByteAt()', () => {
		it('advances when the tailer reads new bytes', async () => {
			const { tailer, filePath } = makeHarness('clock.jsonl');
			fs.writeFileSync(filePath, '');
			await tailer.start();
			const before = tailer.getLastByteAt();
			// Sleep so Date.now() observably advances past `before`.
			await sleep(20);
			fs.appendFileSync(filePath, '{"i":1}\n');
			await waitUntil(() => tailer.getLastByteAt() > before);
			expect(tailer.getLastByteAt()).toBeGreaterThan(before);
		});

		it('does not advance when no new bytes are read', async () => {
			const { tailer, filePath } = makeHarness('idle.jsonl');
			fs.writeFileSync(filePath, '');
			vi.useFakeTimers();
			try {
				await tailer.start();
				const before = tailer.getLastByteAt();
				await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 5);
				expect(tailer.getLastByteAt()).toBe(before);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
