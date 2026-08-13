// Poll-based JSONL tailer for maestro-p run mode.
//
// Reads Claude's live session transcript (one JSON object per \n-terminated
// line) and emits structured `'entry'` events the runner forwards to stdout.
// This is the source of truth for assistant / user / tool-result events -
// the TUI screen is only used for startup readiness and quota-limit
// detection. See MAESTRO-P-01-binary.md task 5 for the full contract.
//
// Polling, not fs-watch
// ---------------------
// fs-watch event semantics around large appends are inconsistent across
// macOS / Linux / network mounts, and we have hard requirements about
// ordered delivery of complete lines. A short polling interval (default
// 75ms ≈ 13 polls/sec) is snappy enough that streamed assistant messages
// feel live, cheap enough that the cost is negligible on a small file.
//
// Skip-existing semantics
// -----------------------
// When `skipExisting: true` (used by `--resume`), `start()` seeds the
// internal offset to the file's current size - only bytes written AFTER
// `start()` are emitted. This is what makes resume clean: prior turns are
// not re-streamed to stdout. With `skipExisting: false` (fresh-session
// discovery path), the offset starts at 0 and the entire file is replayed.
//
// Fresh-session race
// ------------------
// The runner spawns the TUI and may begin tailing before claude has had
// time to create the new `*.jsonl` file. `start()` waits with exponential
// backoff (25ms → 250ms, capped) up to `existsTimeoutMs` (default 5000ms)
// for the file to appear, then proceeds normally.

import { EventEmitter } from 'node:events';
import * as fs from 'fs';

export interface JsonlTailerOptions {
	path: string;
	pollIntervalMs?: number;
	skipExisting?: boolean;
	/** Wait window for the file to appear at start() time. Default 5000ms. */
	existsTimeoutMs?: number;
}

export interface ParseErrorPayload {
	line: string;
	error: Error;
}

export const DEFAULT_POLL_INTERVAL_MS = 75;
export const DEFAULT_EXISTS_TIMEOUT_MS = 5000;

const EXISTS_BACKOFF_INITIAL_MS = 25;
const EXISTS_BACKOFF_MAX_MS = 250;

export type JsonlTailerEvent = 'entry' | 'parse-error';

export class JsonlTailer extends EventEmitter {
	private readonly path: string;
	private readonly pollIntervalMs: number;
	private readonly skipExisting: boolean;
	private readonly existsTimeoutMs: number;

	private lastOffset = 0;
	private pendingBuffer = '';
	private lastByteAt = 0;
	private pollTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	private running = false;

	constructor(options: JsonlTailerOptions) {
		super();
		this.path = options.path;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.skipExisting = options.skipExisting ?? false;
		this.existsTimeoutMs = options.existsTimeoutMs ?? DEFAULT_EXISTS_TIMEOUT_MS;
	}

	async start(): Promise<void> {
		if (this.running) {
			throw new Error('JsonlTailer.start() called twice');
		}
		await this.waitForFile();
		if (this.stopped) return;
		const stat = fs.statSync(this.path);
		this.lastOffset = this.skipExisting ? stat.size : 0;
		// Seed the watchdog clock with start time so callers measuring
		// `now - getLastByteAt()` get a sensible window from the start
		// rather than an epoch-anchored "always-stale" value.
		this.lastByteAt = Date.now();
		this.running = true;
		this.scheduleNextPoll();
	}

	stop(): void {
		this.stopped = true;
		this.running = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	getLastByteAt(): number {
		return this.lastByteAt;
	}

	private async waitForFile(): Promise<void> {
		const deadline = Date.now() + this.existsTimeoutMs;
		let backoff = EXISTS_BACKOFF_INITIAL_MS;
		if (this.fileExists()) return;
		while (!this.stopped) {
			if (Date.now() >= deadline) {
				throw new Error(
					`JsonlTailer: file did not appear within ${this.existsTimeoutMs}ms: ${this.path}`
				);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, backoff));
			if (this.stopped) return;
			if (this.fileExists()) return;
			backoff = Math.min(backoff * 2, EXISTS_BACKOFF_MAX_MS);
		}
	}

	private fileExists(): boolean {
		try {
			const stat = fs.statSync(this.path);
			return stat.isFile();
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw err;
		}
	}

	private scheduleNextPoll(): void {
		if (!this.running || this.stopped) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			this.pollOnce();
			this.scheduleNextPoll();
		}, this.pollIntervalMs);
	}

	private pollOnce(): void {
		if (!this.running || this.stopped) return;

		let stat: fs.Stats;
		try {
			stat = fs.statSync(this.path);
		} catch (err) {
			// Transient ENOENT (file rotated / temporarily missing) is tolerated
			// so the tailer survives a flaky filesystem. Any other error bubbles.
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}

		// File didn't grow - or shrank, which shouldn't happen in normal use
		// but is treated as "no new bytes" rather than seeking backwards.
		if (stat.size <= this.lastOffset) return;

		const length = stat.size - this.lastOffset;
		const buffer = Buffer.allocUnsafe(length);
		const fd = fs.openSync(this.path, 'r');
		let bytesRead: number;
		try {
			bytesRead = fs.readSync(fd, buffer, 0, length, this.lastOffset);
		} finally {
			fs.closeSync(fd);
		}
		if (bytesRead <= 0) return;

		const chunk = buffer.subarray(0, bytesRead).toString('utf-8');
		this.lastOffset += bytesRead;
		this.lastByteAt = Date.now();
		this.pendingBuffer += chunk;
		this.flushLines();
	}

	private flushLines(): void {
		let nlIndex = this.pendingBuffer.indexOf('\n');
		while (nlIndex >= 0) {
			const line = this.pendingBuffer.slice(0, nlIndex);
			this.pendingBuffer = this.pendingBuffer.slice(nlIndex + 1);
			if (line.length > 0) {
				try {
					const parsed = JSON.parse(line);
					this.emit('entry', parsed);
				} catch (err) {
					const payload: ParseErrorPayload = { line, error: err as Error };
					this.emit('parse-error', payload);
				}
			}
			nlIndex = this.pendingBuffer.indexOf('\n');
		}
	}
}
