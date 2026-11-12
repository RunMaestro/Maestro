/**
 * Transcript parse pool: runs `transcript-parse-tasks.ts` on worker threads so
 * reading session history never blocks the Electron main thread.
 *
 * Why it exists: every stats cache re-reads EVERY live transcript when its
 * derivation version is bumped, and parsing is synchronous `JSON.parse` over
 * files that run to hundreds of MB. On the main thread that is seconds per
 * file during which no IPC call is answered and the window shows Not
 * Responding - with gigabytes of history, the app looks dead. On a worker the
 * main thread only ever sees a small result object.
 *
 * Shape of the pool:
 *  - Workers start lazily, up to `transcriptParsePoolSize()`, and each has at
 *    most ONE task in flight (the work is CPU-bound; a second would only queue
 *    inside the worker and hide the backlog from us).
 *  - A worker idle for `TRANSCRIPT_PARSE_IDLE_SHUTDOWN_MS` is terminated, so a
 *    long-running app does not hold four V8 heaps for a dashboard opened once.
 *  - Workers are `unref`'d: they never keep the process alive at quit.
 *  - A worker that dies fails ONLY its own task, with a plain error the caller
 *    reports; its replacement is spawned on demand. The task is not retried on
 *    the main thread, since a file that killed a worker (out of memory) would
 *    take the main process down with it.
 *
 * Inline fallback: when the compiled worker script is absent (vitest runs the
 * `.ts` sources, where `__dirname` holds no `.js`) or a worker cannot be
 * constructed, tasks run on the calling thread exactly as they did before this
 * pool existed. That keeps every caller on one code path.
 */

import { Worker } from 'worker_threads';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger';
import {
	runTranscriptParseTask,
	type TranscriptParseResult,
	type TranscriptParseTask,
} from './transcript-parse-tasks';
import {
	rehydrateParseError,
	type TranscriptParseRequest,
	type TranscriptParseResponse,
} from './transcript-parse-protocol';

const LOG_CONTEXT = '[TranscriptParsePool]';

/**
 * Workers kept at most: one core is left for the main thread, and never more
 * than four, since each holds whole transcripts in memory. Read lazily, on the
 * first spawn, so the inline path never touches `os`.
 */
export function transcriptParsePoolSize(): number {
	const cores = os.availableParallelism?.() ?? os.cpus().length;
	return Math.max(1, Math.min(4, cores - 1));
}

/** A worker with nothing to do for this long is terminated. */
export const TRANSCRIPT_PARSE_IDLE_SHUTDOWN_MS = 30_000;

const DEFAULT_WORKER_SCRIPT = path.join(__dirname, 'transcript-parse-worker.js');

interface PendingTask {
	id: number;
	task: TranscriptParseTask;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

interface PooledWorker {
	worker: Worker;
	inFlight: PendingTask | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

let workerScript = DEFAULT_WORKER_SCRIPT;
let mode: 'unresolved' | 'worker' | 'inline' = 'unresolved';
let nextId = 1;
const queue: PendingTask[] = [];
const workers: PooledWorker[] = [];

/** Parse one transcript off the main thread (or inline, see the module note). */
export function runTranscriptParse<T extends TranscriptParseTask>(
	task: T
): Promise<TranscriptParseResult<T>> {
	if (resolveMode() === 'inline') return runTranscriptParseTask(task);
	return new Promise<TranscriptParseResult<T>>((resolve, reject) => {
		queue.push({
			id: nextId++,
			task,
			resolve: resolve as (result: unknown) => void,
			reject,
		});
		pump();
	});
}

/** Whether tasks currently run on worker threads. For diagnostics and tests. */
export function transcriptParsePoolMode(): 'worker' | 'inline' {
	return resolveMode();
}

function resolveMode(): 'worker' | 'inline' {
	if (mode === 'unresolved') {
		mode = fs.existsSync(workerScript) ? 'worker' : 'inline';
		if (mode === 'inline') {
			logger.debug(`Worker script not found, parsing inline: ${workerScript}`, LOG_CONTEXT);
		}
	}
	return mode;
}

function pump(): void {
	while (queue.length > 0) {
		const target = workers.find((w) => w.inFlight === null) ?? spawnWorker();
		if (!target) return;
		dispatch(target, queue.shift()!);
	}
}

function dispatch(pooled: PooledWorker, pending: PendingTask): void {
	if (pooled.idleTimer) {
		clearTimeout(pooled.idleTimer);
		pooled.idleTimer = null;
	}
	pooled.inFlight = pending;
	const request: TranscriptParseRequest = { id: pending.id, task: pending.task };
	pooled.worker.postMessage(request);
}

function spawnWorker(): PooledWorker | null {
	if (mode !== 'worker' || workers.length >= transcriptParsePoolSize()) return null;

	let worker: Worker;
	try {
		worker = new Worker(workerScript);
	} catch (error) {
		// Construction failing is a property of this build or platform, not of
		// one file, so stop trying and run everything inline from here on.
		logger.warn('Could not start a transcript parse worker; parsing inline', LOG_CONTEXT, {
			error: String(error),
		});
		mode = 'inline';
		drainInline();
		return null;
	}
	worker.unref();

	const pooled: PooledWorker = { worker, inFlight: null, idleTimer: null };
	workers.push(pooled);

	worker.on('message', (response: TranscriptParseResponse) => {
		const pending = pooled.inFlight;
		if (!pending || pending.id !== response.id) return;
		pooled.inFlight = null;
		if (response.ok) pending.resolve(response.result);
		else pending.reject(rehydrateParseError(response.error));
		armIdleShutdown(pooled);
		pump();
	});

	const retire = (reason: Error) => {
		const index = workers.indexOf(pooled);
		if (index === -1) return;
		workers.splice(index, 1);
		if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
		const pending = pooled.inFlight;
		pooled.inFlight = null;
		pending?.reject(reason);
		pump();
	};
	worker.on('error', (error) => retire(error instanceof Error ? error : new Error(String(error))));
	worker.on('exit', (code) => {
		retire(new Error(`Transcript parse worker exited with code ${code}`));
	});

	return pooled;
}

function armIdleShutdown(pooled: PooledWorker): void {
	if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
	pooled.idleTimer = setTimeout(() => {
		pooled.idleTimer = null;
		if (pooled.inFlight === null) void pooled.worker.terminate();
	}, TRANSCRIPT_PARSE_IDLE_SHUTDOWN_MS);
	pooled.idleTimer.unref?.();
}

function drainInline(): void {
	while (queue.length > 0) {
		const pending = queue.shift()!;
		runTranscriptParseTask(pending.task).then(pending.resolve, pending.reject);
	}
}

/** Test seam: point the pool at another worker script and forget all state. */
export async function resetTranscriptParsePoolForTest(scriptPath?: string): Promise<void> {
	queue.length = 0;
	const live = workers.splice(0, workers.length);
	await Promise.all(
		live.map((pooled) => {
			if (pooled.idleTimer) clearTimeout(pooled.idleTimer);
			return pooled.worker.terminate();
		})
	);
	workerScript = scriptPath ?? DEFAULT_WORKER_SCRIPT;
	mode = 'unresolved';
	nextId = 1;
}
