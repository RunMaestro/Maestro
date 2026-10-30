/**
 * Runs one vault root's DQL queries off the main thread (D2, DV-9). The vendored engine is synchronous once
 * it has its source pages, so a query that takes long (a catastrophic `regexmatch` pattern, a `FLATTEN`
 * that multiplies rows, any heavy query over a large vault) would freeze every window, agent, and IPC call
 * while it runs. Here it runs on a worker thread with its own mirror of the index, under a watchdog.
 *
 * - The mirror. The worker starts on the first query and receives the whole index (`VaultIndex.mirrorState`)
 *   in batches that yield to the event loop between them, then every commit (`VaultIndex.onCommit`). It
 *   finishes pages from the same cached raw parse main keeps, so answers match main exactly.
 * - One job at a time. Updates and queries share one queue and the worker never holds two, so a query
 *   waits behind the commits that came before it (and so reads at least the revision it asked for), and
 *   its watchdog measures only the query.
 * - The watchdog. A query that runs past {@link DATAVIEW_QUERY_TIMEOUT_MS} terminates the worker; the
 *   query answers with an error result, the next query starts a new worker from the index, and the same
 *   query on the same note answers that error at once for {@link DATAVIEW_QUERY_RETRY_AFTER_MS}, so a live
 *   refresh after every save cannot restart the worker over and over. Reads a CSV source asks main for do
 *   not count against the budget. A worker that dies (out of its heap) answers the same way.
 * - Inline fallback. When the compiled worker script is absent (vitest runs the `.ts` sources) or a worker
 *   cannot be constructed, queries run on the calling thread as they did before, so every caller keeps one
 *   code path.
 */

import { Worker } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import {
	executeDql,
	executeInlineDql,
	type DataviewErrorResult,
	type DataviewInlineResult,
	type DataviewResult,
} from '../../shared/dataview';
import { yieldToEventLoop } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import type {
	QueryWorkerQuery,
	QueryWorkerRequest,
	QueryWorkerResponse,
} from './query-worker-protocol';
import type { VaultIndex, VaultIndexCommit } from './vault-index';

const LOG_CONTEXT = 'Dataview';

/** How long one query may run in the worker before the worker is terminated. */
export const DATAVIEW_QUERY_TIMEOUT_MS = 5000;

/** How long a query that timed out answers its error without running again. */
export const DATAVIEW_QUERY_RETRY_AFTER_MS = 60 * 1000;

/** Pages per update message. The runner yields to the event loop between messages. */
export const DATAVIEW_QUERY_SYNC_BATCH_PAGES = 256;

/**
 * The worker's old-generation heap cap. Past it Node stops the worker alone; without a cap, a query that
 * allocates without end would take the whole app down.
 */
export const DATAVIEW_QUERY_WORKER_HEAP_MB = 4096;

/** The error a query answers with when it ran past the budget, or when it timed out moments ago. */
export function dataviewQueryTimeoutMessage(timeoutMs: number, retryAfterMs: number): string {
	return `Dataview: the query ran longer than ${timeoutMs / 1000} seconds and was stopped. It runs again after ${retryAfterMs / 1000} seconds, or as soon as you edit it.`;
}

/** What the runner needs from a `worker_threads` Worker. Tests pass an in-process stand-in. */
export interface QueryWorkerLike {
	postMessage(message: QueryWorkerRequest): void;
	on(event: 'message', listener: (message: QueryWorkerResponse) => void): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
	on(event: 'exit', listener: (code: number) => void): unknown;
	terminate(): Promise<number>;
}

export interface DataviewQueryRunnerOptions {
	/** Start a worker, or return null to run queries inline. Defaults to the compiled worker script. */
	spawn?: () => QueryWorkerLike | null;
	timeoutMs?: number;
	retryAfterMs?: number;
}

const WORKER_SCRIPT = path.join(__dirname, 'dataview-query-worker.js');
let workerScriptExists: boolean | null = null;

function spawnDefaultWorker(): QueryWorkerLike | null {
	workerScriptExists ??= fs.existsSync(WORKER_SCRIPT);
	if (!workerScriptExists) return null;
	try {
		const worker = new Worker(WORKER_SCRIPT, {
			resourceLimits: { maxOldGenerationSizeMb: DATAVIEW_QUERY_WORKER_HEAP_MB },
		});
		worker.unref();
		return worker;
	} catch (error) {
		// Construction failing is a property of this build or platform, not of one query.
		workerScriptExists = false;
		logger.warn(
			`Dataview could not start a query worker; querying inline: ${String(error)}`,
			LOG_CONTEXT
		);
		return null;
	}
}

type QueryAnswer = DataviewResult | DataviewInlineResult;

type Job =
	| { kind: 'commit'; commit: VaultIndexCommit }
	| { kind: 'query'; query: QueryWorkerQuery; resolve: (answer: QueryAnswer) => void };

/** What the runner waits on from the worker right now. */
type Awaiting =
	| { type: 'applied'; seq: number; resolve: (ok: boolean) => void }
	| { type: 'result'; id: number; resolve: (answer: QueryAnswer | null) => void };

export class DataviewQueryRunner {
	private readonly spawn: () => QueryWorkerLike | null;
	private readonly timeoutMs: number;
	private readonly retryAfterMs: number;
	private readonly unsubscribe: () => void;
	private readonly queue: Job[] = [];
	/** Query keys that timed out, with when. */
	private readonly timedOut = new Map<string, number>();
	private worker: QueryWorkerLike | null = null;
	/** Whether queries run on this thread: no worker script, or none could start. Decided once. */
	private inline = false;
	/** The commit the worker's mirror holds; -1 before a sync has finished. */
	private appliedSeq = -1;
	private awaiting: Awaiting | null = null;
	/** Why the worker went away, for the query that was waiting on it. */
	private lostReason: string | null = null;
	private pumping = false;
	private disposed = false;
	private nextQueryId = 1;
	private watchdog: ReturnType<typeof setTimeout> | null = null;
	private watchdogDeadline = 0;
	private watchdogRemaining = 0;
	private readsInFlight = 0;

	constructor(
		private readonly index: VaultIndex,
		options: DataviewQueryRunnerOptions = {}
	) {
		this.spawn = options.spawn ?? spawnDefaultWorker;
		this.timeoutMs = options.timeoutMs ?? DATAVIEW_QUERY_TIMEOUT_MS;
		this.retryAfterMs = options.retryAfterMs ?? DATAVIEW_QUERY_RETRY_AFTER_MS;
		this.unsubscribe = index.onCommit((commit) => {
			// Only a live mirror needs it; a new worker syncs from the index as it is then.
			if (this.worker) this.enqueue({ kind: 'commit', commit });
		});
	}

	/** Run one `dataview` block with `this` bound to `thisPath`. Never throws (DV-9). */
	dql(source: string, thisPath: string): Promise<DataviewResult> {
		return this.run({ kind: 'dql', source, thisPath }) as Promise<DataviewResult>;
	}

	/** Evaluate one inline `` `= expr` `` with `this` bound to `thisPath`. Never throws (DV-9). */
	inlineQuery(expression: string, thisPath: string): Promise<DataviewInlineResult> {
		return this.run({ kind: 'inline', expression, thisPath }) as Promise<DataviewInlineResult>;
	}

	/** Whether a worker is running now. For status and tests. */
	get workerRunning(): boolean {
		return this.worker !== null;
	}

	/** Stop following the index, and terminate the worker once the queries already asked have answered. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		if (!this.pumping) await this.stopWorker();
	}

	private run(query: QueryWorkerQuery): Promise<QueryAnswer> {
		return new Promise<QueryAnswer>((resolve) => this.enqueue({ kind: 'query', query, resolve }));
	}

	private enqueue(job: Job): void {
		this.queue.push(job);
		if (!this.pumping) void this.pump();
	}

	private async pump(): Promise<void> {
		this.pumping = true;
		try {
			while (this.queue.length > 0) {
				const job = this.queue.shift()!;
				if (job.kind === 'commit') await this.applyCommit(job.commit);
				else job.resolve(await this.answer(job.query));
			}
		} catch (error) {
			// A bug here would strand every queued query; answer them inline and report it.
			void captureException(error, { operation: 'dataview:queryRunner' });
			for (const job of this.queue.splice(0)) {
				if (job.kind === 'query') job.resolve(await this.runInline(job.query));
			}
		}
		if (this.disposed) await this.stopWorker();
		this.pumping = false;
		// A job queued while the worker stopped: a disposed runner answers it inline.
		if (this.queue.length > 0) void this.pump();
	}

	private async answer(query: QueryWorkerQuery): Promise<QueryAnswer> {
		const key = queryKey(query);
		const timedOutAt = this.timedOut.get(key);
		if (timedOutAt !== undefined) {
			if (Date.now() - timedOutAt < this.retryAfterMs) return this.timeoutResult(query);
			this.timedOut.delete(key);
		}
		if (!this.ensureWorker()) return this.runInline(query);
		if (this.appliedSeq < 0 && !(await this.sync())) return this.lostResult(query);

		const id = this.nextQueryId++;
		const answer = await new Promise<QueryAnswer | null>((resolve) => {
			this.awaiting = { type: 'result', id, resolve };
			this.post({ type: 'query', id, query });
			this.armWatchdog(this.timeoutMs);
		});
		this.clearWatchdog();
		if (answer) return answer;
		this.noteTimedOut(key);
		if (this.lostReason === 'timeout') {
			logger.warn(
				`Dataview stopped a query in ${this.index.root} after ${this.timeoutMs} ms (${query.thisPath})`,
				LOG_CONTEXT
			);
			return this.timeoutResult(query);
		}
		// The worker died under this query (out of heap): it waits out the retry window like a timeout.
		return this.lostResult(query);
	}

	/** Remember a query that stopped its worker, and forget the ones whose retry window has passed. */
	private noteTimedOut(key: string): void {
		const now = Date.now();
		for (const [other, at] of this.timedOut) {
			if (now - at >= this.retryAfterMs) this.timedOut.delete(other);
		}
		this.timedOut.set(key, now);
	}

	private runInline(query: QueryWorkerQuery): Promise<QueryAnswer> {
		return query.kind === 'dql'
			? executeDql(query.source, query.thisPath, this.index)
			: Promise.resolve(executeInlineDql(query.expression, query.thisPath, this.index));
	}

	/** A worker to send to, starting one if needed. False when queries run inline. */
	private ensureWorker(): boolean {
		if (this.worker) return true;
		// A disposed runner's index no longer changes; a query that still reaches it runs inline.
		if (this.inline || this.disposed) return false;
		const worker = this.spawn();
		if (!worker) {
			this.inline = true;
			return false;
		}
		this.worker = worker;
		this.appliedSeq = -1;
		this.lostReason = null;
		worker.on('message', (message) => this.onMessage(worker, message));
		worker.on('error', (error) => {
			void captureException(error, { operation: 'dataview:queryWorker' });
			this.onWorkerGone(worker, `the query worker failed: ${error.message}`);
		});
		worker.on('exit', (code) =>
			this.onWorkerGone(worker, `the query worker stopped (code ${code})`)
		);
		return true;
	}

	/** Send the whole index as one reset update. False when the worker went away first. */
	private sync(): Promise<boolean> {
		return this.sendUpdate(this.index.mirrorState(), true);
	}

	private async applyCommit(commit: VaultIndexCommit): Promise<void> {
		// No mirror (yet, or any more): the next sync reads the index as it is, this commit included.
		if (!this.worker || this.appliedSeq < 0 || commit.seq <= this.appliedSeq) return;
		await this.sendUpdate(commit, false);
	}

	private async sendUpdate(commit: VaultIndexCommit, reset: boolean): Promise<boolean> {
		const worker = this.worker;
		if (!worker) return false;
		this.post({
			type: 'begin',
			reset,
			seq: commit.seq,
			revision: commit.revision,
			...(commit.paths ? { paths: commit.paths } : {}),
			removed: commit.removed,
			stars: commit.stars,
		});
		for (let start = 0; start < commit.set.length; start += DATAVIEW_QUERY_SYNC_BATCH_PAGES) {
			if (this.worker !== worker) return false;
			this.post({
				type: 'pages',
				pages: commit.set.slice(start, start + DATAVIEW_QUERY_SYNC_BATCH_PAGES),
			});
			// Cloning a batch into the worker runs on this thread; let IPC through between batches.
			await yieldToEventLoop();
		}
		if (this.worker !== worker) return false;
		const ok = await new Promise<boolean>((resolve) => {
			this.awaiting = { type: 'applied', seq: commit.seq, resolve };
			this.post({ type: 'end' });
		});
		if (ok) this.appliedSeq = commit.seq;
		return ok;
	}

	private onMessage(worker: QueryWorkerLike, message: QueryWorkerResponse): void {
		if (worker !== this.worker) return;
		switch (message.type) {
			case 'applied': {
				const awaiting = this.awaiting;
				if (awaiting?.type !== 'applied' || awaiting.seq !== message.seq) return;
				this.awaiting = null;
				awaiting.resolve(true);
				return;
			}
			case 'result': {
				const awaiting = this.awaiting;
				if (awaiting?.type !== 'result' || awaiting.id !== message.id) return;
				this.awaiting = null;
				awaiting.resolve(message.result);
				return;
			}
			case 'read':
				void this.serveRead(worker, message.id, message.path);
				return;
		}
	}

	/** Read a vault file for a CSV source. The watchdog pauses while main reads (SSH can be slow). */
	private async serveRead(worker: QueryWorkerLike, id: number, relPath: string): Promise<void> {
		if (this.readsInFlight++ === 0) this.pauseWatchdog();
		let reply: QueryWorkerRequest;
		try {
			reply = { type: 'readResult', id, text: await this.index.fs.readText(relPath) };
		} catch (error) {
			reply = { type: 'readResult', id, error: String(error) };
		}
		if (--this.readsInFlight === 0) this.resumeWatchdog();
		if (worker === this.worker) this.post(reply);
	}

	private onWorkerGone(worker: QueryWorkerLike, reason: string): void {
		if (worker !== this.worker) return;
		this.dropWorker(reason);
	}

	/** Forget the worker and fail whatever waited on it. The next query starts a new one. */
	private dropWorker(reason: string): void {
		const worker = this.worker;
		this.worker = null;
		this.appliedSeq = -1;
		this.lostReason = reason;
		this.readsInFlight = 0;
		this.clearWatchdog();
		const awaiting = this.awaiting;
		this.awaiting = null;
		if (awaiting?.type === 'applied') awaiting.resolve(false);
		else if (awaiting?.type === 'result') awaiting.resolve(null);
		void worker?.terminate().catch(() => undefined);
	}

	private async stopWorker(): Promise<void> {
		const worker = this.worker;
		if (!worker) return;
		this.dropWorker('the index closed');
		await worker.terminate().catch(() => undefined);
	}

	private post(message: QueryWorkerRequest): void {
		this.worker?.postMessage(message);
	}

	private armWatchdog(ms: number): void {
		this.clearWatchdog();
		this.watchdogRemaining = ms;
		this.watchdogDeadline = Date.now() + ms;
		this.watchdog = setTimeout(() => {
			this.watchdog = null;
			this.dropWorker('timeout');
		}, ms);
		this.watchdog.unref?.();
	}

	private pauseWatchdog(): void {
		if (!this.watchdog) return;
		this.watchdogRemaining = Math.max(0, this.watchdogDeadline - Date.now());
		clearTimeout(this.watchdog);
		this.watchdog = null;
	}

	private resumeWatchdog(): void {
		if (this.awaiting?.type === 'result' && !this.watchdog)
			this.armWatchdog(this.watchdogRemaining);
	}

	private clearWatchdog(): void {
		if (this.watchdog) clearTimeout(this.watchdog);
		this.watchdog = null;
	}

	private timeoutResult(query: QueryWorkerQuery): DataviewErrorResult {
		return errorFor(query, dataviewQueryTimeoutMessage(this.timeoutMs, this.retryAfterMs));
	}

	private lostResult(query: QueryWorkerQuery): DataviewErrorResult {
		return errorFor(query, `Dataview: ${this.lostReason ?? 'the query worker stopped'}.`);
	}
}

/** The same query on the same note. A new source (an edit) is a new key. */
function queryKey(query: QueryWorkerQuery): string {
	return `${query.kind}\0${query.thisPath}\0${query.kind === 'dql' ? query.source : query.expression}`;
}

/** An error result in the shape the query's own failures take (upstream's inline prefix for inline). */
function errorFor(query: QueryWorkerQuery, message: string): DataviewErrorResult {
	if (query.kind === 'dql') return { kind: 'error', message };
	const expr = query.expression.trim().replace(/^=/, '').trim();
	return {
		kind: 'error',
		message: `Dataview (for inline query '${expr}'): ${message.replace(/^Dataview: /, '')}`,
	};
}
