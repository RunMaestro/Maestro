/**
 * A Cappella model downloader - resumable, verified, and never optimistic.
 *
 * The invariant everything else in this subsystem rests on:
 *
 *   **A file only appears at its final path after its bytes have been hashed and
 *   the hash matched the catalog.**
 *
 * Until then the bytes live in `<file>.part`. That is not tidiness; it is the
 * difference between a killed app resuming a download and a killed app leaving a
 * truncated file that passes an existence check and detonates weeks later inside
 * a model runtime with no evidence of what happened.
 *
 * How each requirement is met:
 *
 *   - **Resume.** The `.part` file's length is the resume offset, sent as
 *     `Range: bytes=N-`. A server that ignores the range (200 instead of 206)
 *     restarts from zero, and the partial file is truncated to match, because a
 *     resumed hash over bytes that were not resumed is worse than a slow restart.
 *   - **Verification.** SHA-256 is computed as the bytes stream past. On resume
 *     the existing partial is re-hashed first, so the running digest covers the
 *     whole file rather than only the new tail.
 *   - **Mismatch.** The `.part` is deleted and BOTH hashes are reported. A
 *     mismatch means the bytes are not what the catalog promised; keeping them
 *     around to "resume" would resume a corrupt file forever.
 *   - **Pause / resume / cancel.** Pause aborts the request and keeps the
 *     partial. Cancel aborts and deletes it, along with anything else the job
 *     wrote, so a cancelled download leaves nothing behind. Both leave the
 *     manifest untouched, because there is no manifest until success.
 *   - **Retry.** Bounded, with exponential backoff, on transient network errors
 *     only. An HTTP 404 or a hash mismatch is not transient and fails at once.
 *   - **Progress.** Emitted on a throttled cadence with bytes, total, rate, and
 *     ETA. The throttle lives here because the flood originates here; the
 *     renderer uses `useThrottledCallback` for its own repaints and does not need
 *     a second throttle helper.
 *   - **Concurrency.** At most {@link MAX_ACTIVE_DOWNLOADS} models transfer at
 *     once. A 1.4 GB set downloaded four-wide saturates a domestic connection and
 *     makes every individual file slower, which reads to the user as a hang.
 */

import { createHash, type Hash } from 'crypto';
import * as fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import {
	getVoiceModel,
	type VoiceModelEntry,
	type VoiceModelFile,
} from '../../../shared/acappella/model-catalog';
import { logger } from '../../utils/logger';
import {
	ensureModelDir,
	markInstalled,
	modelFilePath,
	PARTIAL_SUFFIX,
	remove,
	type ModelManifest,
} from './model-store';

const LOG_CONTEXT = 'ACappella';

/**
 * Two at a time. One is too conservative for a set of four small files; three or
 * more starves each stream on a domestic uplink and makes the whole set slower.
 */
export const MAX_ACTIVE_DOWNLOADS = 2;

/** Progress push interval. ~4 Hz: fast enough to look live, slow enough to be free. */
export const PROGRESS_INTERVAL_MS = 250;

/** Attempts per file before a transient failure becomes a real one. */
export const MAX_RETRIES = 4;

const BASE_RETRY_DELAY_MS = 500;

export type DownloadPhase =
	| 'queued'
	| 'downloading'
	| 'verifying'
	| 'paused'
	| 'complete'
	| 'cancelled'
	| 'error';

export interface DownloadProgress {
	modelId: string;
	phase: DownloadPhase;
	/** Bytes of the whole model transferred so far, resumed bytes included. */
	bytesReceived: number;
	/** Total bytes of every file in the model. */
	bytesTotal: number;
	/** Bytes per second over the recent window. Zero before the first sample. */
	bytesPerSecond: number;
	/** Seconds remaining at the current rate, or null when it cannot be estimated. */
	etaSeconds: number | null;
	/** The file currently transferring, for a per-file line in the UI. */
	currentFile?: string;
	/** Set on `error`. */
	error?: string;
	/** Set when the failure was a hash mismatch, so the UI can show both sides. */
	mismatch?: { path: string; expected: string; actual: string };
}

export type DownloadProgressListener = (progress: DownloadProgress) => void;

export interface DownloadResult {
	modelId: string;
	status: 'complete' | 'cancelled' | 'paused' | 'error';
	manifest?: ModelManifest;
	error?: string;
	mismatch?: { path: string; expected: string; actual: string };
}

/** Injectable fetch, so tests drive the transport without a network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ModelDownloaderOptions {
	fetchImpl?: FetchLike;
	/** Overridable so tests do not wait real backoff. */
	retryDelayMs?: (attempt: number) => number;
	maxActiveDownloads?: number;
	progressIntervalMs?: number;
	/** Injectable clock, so rate and ETA are testable. */
	now?: () => number;
}

/** Errors we retry. Everything else is a real failure and fails immediately. */
function isTransient(error: unknown): boolean {
	if (error instanceof TransientHttpError) return true;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (
		code === 'ECONNRESET' ||
		code === 'ETIMEDOUT' ||
		code === 'ECONNREFUSED' ||
		code === 'EAI_AGAIN' ||
		code === 'ENOTFOUND' ||
		code === 'EPIPE'
	) {
		return true;
	}
	// Undici surfaces most network faults as a generic TypeError with a cause.
	return error instanceof TypeError && (error as { cause?: unknown }).cause !== undefined;
}

class TransientHttpError extends Error {}

/** A hash that did not match. Never retried: more attempts cannot change bytes. */
export class HashMismatchError extends Error {
	constructor(
		readonly filePath: string,
		readonly expected: string,
		readonly actual: string
	) {
		super(`Hash mismatch for ${filePath}: expected ${expected}, got ${actual}`);
		this.name = 'HashMismatchError';
	}
}

/** Raised when a job is paused or cancelled mid-transfer. */
class AbortedError extends Error {
	constructor(readonly kind: 'paused' | 'cancelled') {
		super(`Download ${kind}`);
		this.name = 'AbortedError';
	}
}

interface Job {
	entry: VoiceModelEntry;
	controller: AbortController;
	/** Set when the abort was deliberate, so a fetch abort is not read as a fault. */
	intent: 'paused' | 'cancelled' | null;
	phase: DownloadPhase;
	bytesReceived: number;
	currentFile?: string;
	/** Promise of the in-flight run, awaited by `cancel()` so teardown is ordered. */
	running: Promise<DownloadResult>;
	/**
	 * Releases this job from the concurrency queue. Called when a slot frees up
	 * AND when the job is cancelled while still waiting - without the second path
	 * a `cancel()` on a queued download would await a promise nothing will ever
	 * settle.
	 */
	releaseSlot: (() => void) | null;
	lastProgressAt: number;
	lastSampleBytes: number;
	lastSampleAt: number;
	bytesPerSecond: number;
}

export class ModelDownloader {
	private readonly fetchImpl: FetchLike;
	private readonly retryDelayMs: (attempt: number) => number;
	private readonly maxActive: number;
	private readonly progressIntervalMs: number;
	private readonly now: () => number;

	private readonly listeners = new Set<DownloadProgressListener>();
	private readonly jobs = new Map<string, Job>();
	/** Ids waiting for a slot, oldest first. */
	private readonly queue: string[] = [];
	private readonly slotWaiters: Array<{ modelId: string; resolve: () => void }> = [];
	private activeCount = 0;

	constructor(options: ModelDownloaderOptions = {}) {
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.retryDelayMs =
			options.retryDelayMs ?? ((attempt) => BASE_RETRY_DELAY_MS * Math.pow(2, attempt));
		this.maxActive = options.maxActiveDownloads ?? MAX_ACTIVE_DOWNLOADS;
		this.progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
		this.now = options.now ?? (() => Date.now());
	}

	/** Subscribe to progress. Returns the unsubscribe function. */
	onProgress(listener: DownloadProgressListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Ids with a job in flight (running, queued, or paused-in-place). */
	activeIds(): string[] {
		return [...this.jobs.keys()];
	}

	/**
	 * Start (or resume) a model download.
	 *
	 * Idempotent while a job is live: calling it twice for the same model returns
	 * the same promise rather than opening a second set of requests at the same
	 * `.part` file, which is how two writers end up interleaving into one file.
	 */
	download(modelId: string): Promise<DownloadResult> {
		const existing = this.jobs.get(modelId);
		if (existing) return existing.running;

		const entry = getVoiceModel(modelId);
		if (!entry) return Promise.resolve({ modelId, status: 'error', error: 'Unknown model' });

		const job: Job = {
			entry,
			controller: new AbortController(),
			intent: null,
			phase: 'queued',
			bytesReceived: 0,
			running: Promise.resolve({ modelId, status: 'error' }),
			releaseSlot: null,
			lastProgressAt: 0,
			lastSampleBytes: 0,
			lastSampleAt: this.now(),
			bytesPerSecond: 0,
		};
		this.jobs.set(modelId, job);
		job.running = this.runWhenSlotFree(job);
		this.emit(job, true);
		return job.running;
	}

	/**
	 * Pause: abort the transfer and KEEP the `.part` file. The next `download()`
	 * resumes from where this stopped.
	 */
	pause(modelId: string): boolean {
		const job = this.jobs.get(modelId);
		if (!job || job.phase === 'complete') return false;
		job.intent = 'paused';
		job.controller.abort();
		job.releaseSlot?.();
		return true;
	}

	/** Resume a paused model. Same call as starting one; the `.part` does the rest. */
	resume(modelId: string): Promise<DownloadResult> {
		return this.download(modelId);
	}

	/**
	 * Cancel: abort, then delete everything the job wrote. Awaits the running job
	 * so the deletion cannot race the writer and leave the file it just recreated.
	 */
	async cancel(modelId: string): Promise<boolean> {
		const job = this.jobs.get(modelId);
		if (!job) {
			// Nothing running, but a partial from a previous boot may still be on
			// disk, and Cancel has to mean "leave nothing behind" either way.
			await this.cleanupPartials(modelId);
			return false;
		}
		job.intent = 'cancelled';
		job.controller.abort();
		job.releaseSlot?.();
		await job.running.catch(() => undefined);
		return true;
	}

	/** Cancel every in-flight job. Used on teardown. */
	async cancelAll(): Promise<void> {
		await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
	}

	// -- Internals -----------------------------------------------------------

	private async runWhenSlotFree(job: Job): Promise<DownloadResult> {
		this.queue.push(job.entry.id);
		await this.waitForSlot(job);
		this.activeCount++;
		try {
			// A job cancelled while it sat in the queue never opened a connection,
			// but Cancel still has to mean "leave nothing behind".
			if (job.intent) return await this.handleFailure(job, new AbortedError(job.intent));
			return await this.run(job);
		} finally {
			this.activeCount--;
			this.jobs.delete(job.entry.id);
			this.drainQueue();
		}
	}

	private waitForSlot(job: Job): Promise<void> {
		const modelId = job.entry.id;
		if (this.canStart(modelId)) {
			this.dequeue(modelId);
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const waiter = { modelId, resolve };
			this.slotWaiters.push(waiter);
			job.releaseSlot = () => {
				const index = this.slotWaiters.indexOf(waiter);
				if (index < 0) return;
				this.slotWaiters.splice(index, 1);
				this.dequeue(modelId);
				job.releaseSlot = null;
				resolve();
			};
		});
	}

	private canStart(modelId: string): boolean {
		return this.activeCount < this.maxActive && this.queue[0] === modelId;
	}

	private dequeue(modelId: string): void {
		const index = this.queue.indexOf(modelId);
		if (index >= 0) this.queue.splice(index, 1);
	}

	private drainQueue(): void {
		while (this.slotWaiters.length > 0 && this.activeCount < this.maxActive) {
			const next = this.slotWaiters.find((waiter) => this.queue[0] === waiter.modelId);
			if (!next) break;
			this.slotWaiters.splice(this.slotWaiters.indexOf(next), 1);
			this.dequeue(next.modelId);
			const waiting = this.jobs.get(next.modelId);
			if (waiting) waiting.releaseSlot = null;
			next.resolve();
		}
	}

	private async run(job: Job): Promise<DownloadResult> {
		const { entry } = job;
		job.phase = 'downloading';
		this.emit(job, true);

		try {
			await ensureModelDir(entry);

			for (const file of entry.files) {
				job.currentFile = file.path;
				await this.downloadFile(job, file);
			}

			job.phase = 'verifying';
			this.emit(job, true);
			const manifest = await markInstalled(entry);

			job.phase = 'complete';
			job.bytesReceived = entry.bytes;
			this.emit(job, true);
			return { modelId: entry.id, status: 'complete', manifest };
		} catch (error) {
			return await this.handleFailure(job, error);
		}
	}

	private async handleFailure(job: Job, error: unknown): Promise<DownloadResult> {
		const { entry } = job;

		if (error instanceof AbortedError || job.intent) {
			const kind = error instanceof AbortedError ? error.kind : job.intent;
			if (kind === 'cancelled') {
				// Cancel means nothing left behind: partials AND any file that already
				// completed and was renamed into place during this run.
				await remove(entry.id).catch(() => undefined);
				job.phase = 'cancelled';
				this.emit(job, true);
				return { modelId: entry.id, status: 'cancelled' };
			}
			job.phase = 'paused';
			this.emit(job, true);
			return { modelId: entry.id, status: 'paused' };
		}

		if (error instanceof HashMismatchError) {
			job.phase = 'error';
			this.emit(job, true, {
				error: error.message,
				mismatch: { path: error.filePath, expected: error.expected, actual: error.actual },
			});
			logger.warn(`Model ${entry.id} failed verification: ${error.message}`, LOG_CONTEXT);
			return {
				modelId: entry.id,
				status: 'error',
				error: error.message,
				mismatch: { path: error.filePath, expected: error.expected, actual: error.actual },
			};
		}

		const message = error instanceof Error ? error.message : String(error);
		job.phase = 'error';
		this.emit(job, true, { error: message });
		logger.warn(`Model ${entry.id} download failed: ${message}`, LOG_CONTEXT);
		return { modelId: entry.id, status: 'error', error: message };
	}

	/**
	 * Fetch one file with retry, verify it, and rename it into place.
	 *
	 * A retry re-enters `transferFile`, which re-reads the partial's length, so a
	 * connection dropped at 80% resumes at 80% rather than starting over.
	 */
	private async downloadFile(job: Job, file: VoiceModelFile): Promise<void> {
		const finalPath = modelFilePath(job.entry.id, file.path);
		const partPath = `${finalPath}${PARTIAL_SUFFIX}`;

		// A file already at its final path with the right length is already
		// verified: it only got there by passing verification.
		const existing = await statSize(finalPath);
		if (existing === file.bytes) {
			job.bytesReceived += file.bytes;
			this.emit(job, true);
			return;
		}
		if (existing !== null) await fs.rm(finalPath, { force: true });

		let lastError: unknown;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const digest = await this.transferFile(job, file, partPath);
				if (digest !== file.sha256) {
					// Delete the partial. Keeping it would mean every future resume
					// continues a file whose bytes are already known to be wrong.
					await fs.rm(partPath, { force: true });
					throw new HashMismatchError(file.path, file.sha256, digest);
				}
				await fs.rename(partPath, finalPath);
				return;
			} catch (error) {
				if (error instanceof AbortedError || error instanceof HashMismatchError) throw error;
				if (job.intent) throw new AbortedError(job.intent);
				if (!isTransient(error) || attempt === MAX_RETRIES) throw error;
				lastError = error;
				await delay(this.retryDelayMs(attempt));
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	/**
	 * Stream one file into `<file>.part`, resuming if bytes are already there.
	 *
	 * @returns the SHA-256 of the complete file.
	 */
	private async transferFile(job: Job, file: VoiceModelFile, partPath: string): Promise<string> {
		let resumeFrom = (await statSize(partPath)) ?? 0;
		if (resumeFrom > file.bytes) {
			// Longer than the catalog says the file is. Something else wrote here;
			// resuming past the end would produce a file that can never hash right.
			await fs.rm(partPath, { force: true });
			resumeFrom = 0;
		}

		const headers: Record<string, string> = {};
		if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

		const response = await this.fetchImpl(file.sourceUrl, {
			headers,
			signal: job.controller.signal,
		}).catch((error) => {
			if (job.intent) throw new AbortedError(job.intent);
			throw error;
		});

		if (response.status === 416) {
			// The server says our offset is past the end. The partial is not what we
			// think it is; drop it and let the retry start clean.
			await fs.rm(partPath, { force: true });
			throw new TransientHttpError('Partial file rejected by server (416)');
		}
		if (!response.ok) {
			const message = `HTTP ${response.status} for ${file.sourceUrl}`;
			if (response.status >= 500 || response.status === 429) throw new TransientHttpError(message);
			throw new Error(message);
		}

		// A 200 to a ranged request means the server ignored the range and is
		// sending the whole file. Appending would splice the file into itself.
		const serverResumed = response.status === 206;
		if (resumeFrom > 0 && !serverResumed) {
			await fs.rm(partPath, { force: true });
			resumeFrom = 0;
		}

		const hash = createHash('sha256');
		// The digest has to cover the whole file, not just this leg, so the bytes
		// already on disk are folded in before the new ones arrive.
		if (resumeFrom > 0) await hashInto(hash, partPath);

		job.bytesReceived = this.completedBytesBefore(job, file) + resumeFrom;
		job.lastSampleBytes = job.bytesReceived;
		job.lastSampleAt = this.now();
		this.emit(job, true);

		if (!response.body) throw new TransientHttpError(`Empty body for ${file.sourceUrl}`);

		const sink = createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' });
		const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

		source.on('data', (chunk: Buffer) => {
			hash.update(chunk);
			job.bytesReceived += chunk.length;
			this.emit(job, false);
		});

		try {
			await pipeline(source, sink);
		} catch (error) {
			if (job.intent) throw new AbortedError(job.intent);
			throw error;
		}

		if (job.intent) throw new AbortedError(job.intent);

		return hash.digest('hex');
	}

	/** Bytes of the model's earlier files, so per-model progress stays monotonic. */
	private completedBytesBefore(job: Job, file: VoiceModelFile): number {
		let total = 0;
		for (const candidate of job.entry.files) {
			if (candidate.path === file.path) break;
			total += candidate.bytes;
		}
		return total;
	}

	private async cleanupPartials(modelId: string): Promise<void> {
		const entry = getVoiceModel(modelId);
		if (!entry) return;
		for (const file of entry.files) {
			await fs
				.rm(`${modelFilePath(modelId, file.path)}${PARTIAL_SUFFIX}`, { force: true })
				.catch(() => undefined);
		}
	}

	/**
	 * Push a progress event, throttled unless `force`.
	 *
	 * Throttling here rather than in the renderer is deliberate: a 1 GB file at
	 * 20 MB/s produces hundreds of chunk events a second, and every one of them
	 * would otherwise cross the IPC boundary and wake React. Phase transitions and
	 * terminal states always go through.
	 */
	private emit(job: Job, force: boolean, extra?: Partial<DownloadProgress>): void {
		const now = this.now();
		if (!force && now - job.lastProgressAt < this.progressIntervalMs) return;
		job.lastProgressAt = now;

		const elapsed = (now - job.lastSampleAt) / 1000;
		if (elapsed >= 0.2) {
			const delta = job.bytesReceived - job.lastSampleBytes;
			job.bytesPerSecond = delta > 0 ? delta / elapsed : 0;
			job.lastSampleBytes = job.bytesReceived;
			job.lastSampleAt = now;
		}

		const remaining = Math.max(0, job.entry.bytes - job.bytesReceived);
		const progress: DownloadProgress = {
			modelId: job.entry.id,
			phase: job.phase,
			bytesReceived: job.bytesReceived,
			bytesTotal: job.entry.bytes,
			bytesPerSecond: job.bytesPerSecond,
			etaSeconds:
				job.bytesPerSecond > 0 && job.phase === 'downloading'
					? Math.round(remaining / job.bytesPerSecond)
					: null,
			currentFile: job.currentFile,
			...extra,
		};

		for (const listener of this.listeners) listener(progress);
	}
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ModelDownloader | null = null;

/** The app-wide downloader. Built on first use; nothing runs until then. */
export function getModelDownloader(): ModelDownloader {
	if (!instance) instance = new ModelDownloader();
	return instance;
}

/** Test seam: replace or drop the singleton. */
export function setModelDownloader(next: ModelDownloader | null): void {
	instance = next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function statSize(filePath: string): Promise<number | null> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile() ? stat.size : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function hashInto(hash: Hash, filePath: string): Promise<void> {
	const stream = createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk as Buffer);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
