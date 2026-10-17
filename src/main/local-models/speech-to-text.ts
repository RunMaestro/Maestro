/**
 * The Local Models speech-to-text service: audio in, text out.
 *
 * Two things live here.
 *
 * **The shared pool** ({@link SpeechToTextPool}): one loaded engine per catalog
 * speech-to-text model, for the whole app. Three consumers open these models
 * (a voice session's recogniser, the transcription wake word, a dictated clip)
 * and each used to build its own engine, so a wake word listening while a
 * session ran held the same 650 MB encoder in memory twice. A consumer now
 * takes a LEASE on the model:
 *
 *   - **One engine per model.** Every lease on a model shares its ONNX sessions.
 *   - **One decode at a time per model.** Two greedy loops on the same decoder
 *     session hand each other's recurrent state back, and ONNX Runtime reports
 *     that as a reshape failure deep inside the graph. Every `transcribe()` on a
 *     model runs through one queue, so the rule holds across consumers and not
 *     just inside one of them.
 *   - **Resident while leased, freed when idle.** A model stays loaded while any
 *     lease is held (a voice session, an armed wake word) and is freed
 *     {@link DEFAULT_STT_IDLE_UNLOAD_MS} after the last one is released, so a
 *     run of dictated clips does not reload it for each clip.
 *   - **A missing piece fails as itself.** A model that is not downloaded, a
 *     runtime that will not load, or a graph that will not open throws a
 *     classified {@link LocalModelError} naming it. Nothing here reaches for a
 *     different model.
 *
 * **One-shot transcription** ({@link transcribeSpeech}): a whole clip through a
 * source (a local model through the pool, or an endpoint that offers
 * `/v1/audio/transcriptions`). This is what a speech-to-text task runs; reach it
 * through `runSpeechToTextTask` in `task-router.ts`, not directly.
 */

import {
	encodeWav,
	float32ToInt16,
	resampleFloat32,
	SPEECH_SAMPLE_RATE,
} from '../../shared/audio/pcm';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { getLocalModel } from '../../shared/local-models/model-catalog';
import { modelsSettingsLocation } from '../../shared/local-models/settings-location';
import { logger } from '../utils/logger';
import { transcribeWithLocalModelEndpoint } from './endpoint-service';
import { isLocalModelError, LocalModelError, throwIfLocalModelCancelled } from './errors';
import { loadLocalRuntime } from './runtime/load-runtime';
import type { OnnxModule } from './runtime/onnx-types';
import type { LocalModelSource } from './sources';
import {
	resolveInstalledSpeechToTextModel,
	type InstalledSpeechToTextModel,
	type SpeechToTextEngine,
} from './stt/engines';
import { sanitizeTranscript } from './stt/transcript';

const LOG_CONTEXT = '[LocalModels]';

/** Who the core names when a one-shot transcription fails. */
const CONSUMER_ID = 'local-models:speech-to-text';

/** How long a model stays resident after its last lease is released. */
export const DEFAULT_STT_IDLE_UNLOAD_MS = 5 * 60_000;

/**
 * Below this a clip is a tap or a cough, not speech. It is answered with an
 * empty transcript and no model is loaded for it: a recogniser's answer to 100
 * ms of room noise is a confident word nobody said.
 */
export const MIN_CLIP_MS = 200;

/** The rates a clip may arrive at. Outside this it is not audio anyone recorded. */
export const MIN_CLIP_SAMPLE_RATE = 8000;
export const MAX_CLIP_SAMPLE_RATE = 192_000;

/**
 * How far back from a window's limit a cut may move to find a quiet spot. A
 * pause between sentences is normally well inside three seconds of any point.
 */
const CUT_SEARCH_MS = 3000;

/** The energy frame the cut search slides, in milliseconds. */
const CUT_FRAME_MS = 20;

// ---------------------------------------------------------------------------
// The shared pool
// ---------------------------------------------------------------------------

/** One consumer's hold on a loaded speech-to-text model. */
export interface SpeechToTextLease {
	readonly modelId: string;
	/** The longest buffer one `transcribe()` accepts, in samples at 16 kHz. */
	readonly maxSamples: number;
	/**
	 * Transcribe 16 kHz mono audio. Queued behind any decode already running on
	 * this model, whoever asked for it. Returns the engine's raw text.
	 */
	transcribe(audio: Float32Array): Promise<string>;
	/**
	 * Give the model back. Waits for a decode still in flight, so the graphs are
	 * never freed underneath one. Safe to call twice.
	 */
	release(): Promise<void>;
}

export interface SpeechToTextPoolOptions {
	/** Idle time before a model with no lease is freed. 0 frees it at once. */
	idleUnloadMs?: number;
	/** Injected in tests; production goes through `native-loader.ts`. */
	loadRuntime?: typeof loadLocalRuntime;
	/** Injected in tests; production resolves an installed catalog model. */
	resolveModel?: (modelId: string, consumerId: string) => Promise<InstalledSpeechToTextModel>;
}

interface ResidentModel {
	engine: SpeechToTextEngine;
	maxSamples: number;
	leases: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Holds loaded speech-to-text engines, one per model, and hands out leases.
 *
 * Exported for tests; production code shares {@link getSpeechToTextPool}.
 */
export class SpeechToTextPool {
	private readonly idleUnloadMs: number;
	private readonly loadRuntime: typeof loadLocalRuntime;
	private readonly resolveModel: NonNullable<SpeechToTextPoolOptions['resolveModel']>;
	/** Per model: loads, decodes, releases, and unloads never interleave. */
	private readonly queue = createKeyedWriteQueue();
	private readonly resident = new Map<string, ResidentModel>();

	constructor(options: SpeechToTextPoolOptions = {}) {
		this.idleUnloadMs = Math.max(0, options.idleUnloadMs ?? DEFAULT_STT_IDLE_UNLOAD_MS);
		this.loadRuntime = options.loadRuntime ?? loadLocalRuntime;
		this.resolveModel = options.resolveModel ?? resolveInstalledSpeechToTextModel;
	}

	/** Ids of the models currently loaded. */
	get loadedModelIds(): string[] {
		return [...this.resident.keys()];
	}

	/** How many leases are held on a model. 0 when it is not loaded. */
	leaseCount(modelId: string): number {
		return this.resident.get(modelId)?.leases ?? 0;
	}

	/**
	 * Take a lease on `modelId`, loading it first if nobody holds it.
	 *
	 * `consumerId` names the caller in any refusal. Throws a classified
	 * `LocalModelError` when the model is not a speech-to-text model, is not
	 * installed, its runtime will not load, or its graphs will not open.
	 */
	acquire(modelId: string, consumerId: string): Promise<SpeechToTextLease> {
		return this.queue.enqueue(modelId, async () => {
			const resident = await this.ensureLoaded(modelId, consumerId);
			resident.leases++;
			this.clearIdleTimer(resident);

			let released = false;
			const gone = () =>
				new LocalModelError(
					`${modelName(modelId)} was asked to transcribe after it was released.`,
					{ code: 'generation-failed', recovery: 'Try again.', consumerId }
				);
			return {
				modelId,
				maxSamples: resident.maxSamples,
				transcribe: (audio) => {
					// Checked when the decode is ASKED for, not when it runs: a decode
					// requested just before `release()` is still owed its answer, and the
					// release queues behind it.
					if (released) return Promise.reject(gone());
					return this.queue.enqueue(modelId, () => {
						if (this.resident.get(modelId) !== resident) throw gone();
						return resident.engine.transcribe(audio);
					});
				},
				release: () => {
					if (released) return Promise.resolve();
					released = true;
					return this.queue.enqueue(modelId, async () => {
						// Unloaded underneath the lease: there is nothing left to give back.
						if (this.resident.get(modelId) !== resident) return;
						resident.leases--;
						if (resident.leases === 0) await this.scheduleIdleUnload(modelId, resident);
					});
				},
			};
		});
	}

	/**
	 * Free one model (or every model) now, leased or not. Waits for a decode in
	 * flight. A lease left holding a freed model rejects its next `transcribe()`
	 * by name rather than running on closed graphs.
	 */
	async unload(modelId?: string): Promise<void> {
		const ids = modelId === undefined ? [...this.resident.keys()] : [modelId];
		await Promise.all(ids.map((id) => this.queue.enqueue(id, () => this.dispose(id))));
	}

	// -- Internals -----------------------------------------------------------

	private async ensureLoaded(modelId: string, consumerId: string): Promise<ResidentModel> {
		const existing = this.resident.get(modelId);
		if (existing) return existing;

		// Each throws a classified error of its own (model-unsupported,
		// model-not-installed, runtime-unavailable, generation-failed for a graph
		// that will not open); they pass through untouched.
		const installed = await this.resolveModel(modelId, consumerId);
		const module = await this.loadRuntime<OnnxModule>(installed.entry.runtime, consumerId);
		const engine = await installed.createEngine();
		await engine.load(module);

		const resident: ResidentModel = {
			engine,
			maxSamples: installed.maxSamples,
			leases: 0,
			idleTimer: null,
		};
		this.resident.set(modelId, resident);
		return resident;
	}

	/** Runs inside the model's queue slot, so no decode can be in flight. */
	private async scheduleIdleUnload(modelId: string, resident: ResidentModel): Promise<void> {
		this.clearIdleTimer(resident);
		if (this.idleUnloadMs <= 0) {
			await this.dispose(modelId);
			return;
		}
		resident.idleTimer = setTimeout(() => {
			resident.idleTimer = null;
			void this.queue.enqueue(modelId, async () => {
				// Leased again while the timer ran: it stays.
				if (this.resident.get(modelId) !== resident || resident.leases > 0) return;
				await this.dispose(modelId);
			});
		}, this.idleUnloadMs);
		// The timer must never be the reason the app stays alive.
		resident.idleTimer.unref?.();
	}

	private clearIdleTimer(resident: ResidentModel): void {
		if (!resident.idleTimer) return;
		clearTimeout(resident.idleTimer);
		resident.idleTimer = null;
	}

	private async dispose(modelId: string): Promise<void> {
		const resident = this.resident.get(modelId);
		if (!resident) return;
		this.resident.delete(modelId);
		this.clearIdleTimer(resident);
		// The engines release their own sessions and swallow a graph that will not
		// close, so teardown cannot throw from an idle timer.
		await resident.engine.unload();
	}
}

function modelName(modelId: string): string {
	return getLocalModel(modelId)?.displayName ?? modelId;
}

let sharedPool: SpeechToTextPool | null = null;

/** The app-wide pool every speech-to-text consumer shares. */
export function getSpeechToTextPool(): SpeechToTextPool {
	sharedPool ??= new SpeechToTextPool();
	return sharedPool;
}

/** Tests only: replace (or with null, forget) the shared pool. */
export function __setSpeechToTextPool(pool: SpeechToTextPool | null): void {
	sharedPool = pool;
}

// ---------------------------------------------------------------------------
// One-shot transcription
// ---------------------------------------------------------------------------

export interface TranscribeSpeechOptions {
	signal?: AbortSignal;
}

export interface SpeechTranscription {
	/** The transcript, with what a recogniser invents for silence removed. */
	text: string;
	/** Length of the clip that was transcribed, in milliseconds. */
	audioMs: number;
}

/**
 * Transcribe one whole clip of mono audio on a source.
 *
 * The clip may be at any rate between {@link MIN_CLIP_SAMPLE_RATE} and
 * {@link MAX_CLIP_SAMPLE_RATE}; it is resampled to 16 kHz once. A clip longer
 * than one pass of a local model accepts is cut into windows at quiet points
 * (see {@link splitSpeechWindows}) and every window is transcribed: unlike a
 * live session, which keeps the tail, dictation must not lose the start of what
 * was said.
 *
 * Throws a classified `LocalModelError` or `LocalModelEndpointError`. A sample
 * rate out of range is a caller bug and throws a plain `Error`.
 */
export async function transcribeSpeech(
	source: LocalModelSource,
	audio: Float32Array,
	sampleRate: number,
	options: TranscribeSpeechOptions = {}
): Promise<SpeechTranscription> {
	if (
		!Number.isFinite(sampleRate) ||
		sampleRate < MIN_CLIP_SAMPLE_RATE ||
		sampleRate > MAX_CLIP_SAMPLE_RATE
	) {
		throw new Error(
			`A clip's sample rate must be from ${MIN_CLIP_SAMPLE_RATE} to ${MAX_CLIP_SAMPLE_RATE} Hz.`
		);
	}
	throwIfLocalModelCancelled(options.signal, CONSUMER_ID);

	const samples = resampleFloat32(audio, sampleRate, SPEECH_SAMPLE_RATE);
	const audioMs = samplesToMs(samples.length);
	if (audioMs < MIN_CLIP_MS) return { text: '', audioMs };

	const startedAt = Date.now();
	const raw =
		source.type === 'endpoint'
			? await transcribeOnEndpoint(source, samples, options)
			: await transcribeOnLocalModel(source.modelId, samples, options);
	const text = sanitizeTranscript(raw);
	logger.info(
		`Speech-to-text: ${audioMs} ms of audio transcribed in ${Date.now() - startedAt} ms, ${text.length} chars${raw.trim() && !text ? ' (dropped as non-speech)' : ''}`,
		LOG_CONTEXT
	);
	return { text, audioMs };
}

async function transcribeOnEndpoint(
	source: Extract<LocalModelSource, { type: 'endpoint' }>,
	samples: Float32Array,
	options: TranscribeSpeechOptions
): Promise<string> {
	const reply = await transcribeWithLocalModelEndpoint(source.endpointId, {
		model: source.model,
		wav: encodeWav(float32ToInt16(samples), SPEECH_SAMPLE_RATE),
		...(options.signal ? { signal: options.signal } : {}),
	});
	return reply.text;
}

async function transcribeOnLocalModel(
	modelId: string,
	samples: Float32Array,
	options: TranscribeSpeechOptions
): Promise<string> {
	const lease = await getSpeechToTextPool().acquire(modelId, CONSUMER_ID);
	try {
		const parts: string[] = [];
		for (const window of splitSpeechWindows(samples, lease.maxSamples)) {
			throwIfLocalModelCancelled(options.signal, CONSUMER_ID);
			// The remainder after a cut can be a sliver of trailing silence.
			if (samplesToMs(window.length) < MIN_CLIP_MS) continue;
			const text = (await lease.transcribe(window)).trim();
			if (text) parts.push(text);
		}
		return parts.join(' ');
	} catch (error) {
		if (isLocalModelError(error)) throw error;
		throw new LocalModelError(
			`${modelName(modelId)} failed on this clip: ${(error as Error).message}`,
			{
				code: 'generation-failed',
				recovery: `Try again. If it keeps failing, verify the model in ${modelsSettingsLocation('library')}.`,
				consumerId: CONSUMER_ID,
				cause: error,
			}
		);
	} finally {
		await lease.release();
	}
}

function samplesToMs(samples: number): number {
	return Math.round((samples / SPEECH_SAMPLE_RATE) * 1000);
}

/**
 * Cut audio into windows of at most `maxSamples`, in order, losing nothing.
 *
 * A cut at exactly the limit lands mid-word as often as not, and each half of a
 * split word is transcribed as a different word. So each cut moves back from
 * the limit, by at most {@link CUT_SEARCH_MS} (and never more than a fifth of
 * the window), to the quietest 20 ms it can find, which in speech is a pause.
 * The windows are views over `samples`, not copies.
 */
export function splitSpeechWindows(
	samples: Float32Array,
	maxSamples: number,
	sampleRate: number = SPEECH_SAMPLE_RATE
): Float32Array[] {
	if (maxSamples <= 0 || samples.length <= maxSamples) return [samples];

	const frame = Math.max(1, Math.round((CUT_FRAME_MS / 1000) * sampleRate));
	const search = Math.min(
		Math.floor(maxSamples / 5),
		Math.round((CUT_SEARCH_MS / 1000) * sampleRate)
	);

	const windows: Float32Array[] = [];
	let start = 0;
	while (samples.length - start > maxSamples) {
		const limit = start + maxSamples;
		const cut = quietestPoint(samples, limit - search, limit, frame);
		windows.push(samples.subarray(start, cut));
		start = cut;
	}
	windows.push(samples.subarray(start));
	return windows;
}

/** The middle of the lowest-energy frame in `samples[from, to)`. */
function quietestPoint(samples: Float32Array, from: number, to: number, frame: number): number {
	if (to - from < frame) return to;
	let best = to;
	let bestEnergy = Infinity;
	for (let at = from; at + frame <= to; at += frame) {
		let energy = 0;
		for (let i = at; i < at + frame; i++) energy += samples[i] * samples[i];
		if (energy < bestEnergy) {
			bestEnergy = energy;
			best = at + Math.floor(frame / 2);
		}
	}
	return best;
}
