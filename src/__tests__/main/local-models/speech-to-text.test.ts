/**
 * @file speech-to-text.test.ts
 *
 * The Local Models speech-to-text service, with a mocked engine. Properties
 * worth protecting:
 *
 *   - **One engine per model, however many consumers lease it.** A voice
 *     session, the transcription wake word, and a dictated clip share one copy.
 *   - **One decode at a time per model**, across leases: two greedy loops on
 *     one decoder session corrupt each other.
 *   - **Resident while leased, freed when idle**, and a lease taken before the
 *     idle timer fires keeps the model loaded.
 *   - **Failures are classified and pass through untouched**; nothing else is
 *     tried, and a failed load leaves nothing resident.
 *   - **A whole clip is transcribed**, cut at quiet points when it is longer
 *     than one pass, and what a recogniser invents for silence is dropped.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-stt-test' } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const endpoints = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../../../main/local-models/endpoint-service', () => ({
	transcribeWithLocalModelEndpoint: endpoints.transcribe,
}));

import {
	__setSpeechToTextPool,
	MIN_CLIP_MS,
	SpeechToTextPool,
	splitSpeechWindows,
	transcribeSpeech,
} from '../../../main/local-models/speech-to-text';
import { LocalModelError, localModelCancelledError } from '../../../main/local-models/errors';
import type {
	InstalledSpeechToTextModel,
	SpeechToTextEngine,
} from '../../../main/local-models/stt/engines';
import { decodeWavPcm16 } from '../../../shared/audio/pcm';
import {
	PARAKEET_TDT_V2_ID,
	WHISPER_BASE_ID,
	WHISPER_SMALL_ID,
} from '../../../shared/local-models/model-catalog';

const RATE = 16000;
const LOCAL = { type: 'local', modelId: PARAKEET_TDT_V2_ID } as const;
const ENDPOINT = { type: 'endpoint', endpointId: 'ep-1', model: 'whisper-1' } as const;

function fakeEngine(transcribe: SpeechToTextEngine['transcribe'] = async () => 'hello world') {
	return {
		load: vi.fn(async () => {}),
		unload: vi.fn(async () => {}),
		transcribe: vi.fn(transcribe),
	};
}

function makePool(
	options: {
		engine?: ReturnType<typeof fakeEngine>;
		idleUnloadMs?: number;
		maxSamples?: number;
		resolveModel?: () => Promise<InstalledSpeechToTextModel>;
		loadRuntime?: () => Promise<unknown>;
	} = {}
) {
	const engine = options.engine ?? fakeEngine();
	const createEngine = vi.fn(async () => engine);
	const resolveModel = vi.fn(
		options.resolveModel ??
			(async () =>
				({
					entry: { displayName: 'Fake Recogniser', runtime: 'onnx' },
					maxSamples: options.maxSamples ?? 60 * RATE,
					createEngine,
				}) as unknown as InstalledSpeechToTextModel)
	);
	const loadRuntime = vi.fn(options.loadRuntime ?? (async () => ({})));
	const pool = new SpeechToTextPool({
		idleUnloadMs: options.idleUnloadMs ?? 0,
		resolveModel,
		loadRuntime: loadRuntime as never,
	});
	return { pool, engine, createEngine, resolveModel, loadRuntime };
}

/** A promise a test settles by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** Let every queued microtask run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function seconds(n: number, value = 0.25): Float32Array {
	return new Float32Array(Math.round(n * RATE)).fill(value);
}

afterEach(() => {
	vi.useRealTimers();
	__setSpeechToTextPool(null);
});

describe('SpeechToTextPool', () => {
	it('refuses an unsupported language before a Parakeet decode', async () => {
		const { pool, engine } = makePool();
		const lease = await pool.acquire(LOCAL.modelId, 'clip');
		await expect(lease.transcribe(seconds(1), { language: 'de' })).rejects.toMatchObject({
			code: 'model-unsupported',
		});
		expect(engine.transcribe).not.toHaveBeenCalled();
		await lease.release();
	});

	it.each([WHISPER_BASE_ID, WHISPER_SMALL_ID])(
		'keeps each caller language on its queued %s decode without loading a second engine',
		async (modelId) => {
			const { pool, engine, createEngine } = makePool();
			const first = await pool.acquire(modelId, 'live');
			const second = await pool.acquire(modelId, 'clip');
			await Promise.all([
				first.transcribe(seconds(1), { language: 'en' }),
				second.transcribe(seconds(1), { language: 'de' }),
			]);
			expect(createEngine).toHaveBeenCalledTimes(1);
			expect(engine.transcribe.mock.calls.map((call) => call[1]?.language)).toEqual(['en', 'de']);
			await first.release();
			await second.release();
		}
	);

	it('loads a model once and shares the engine across leases', async () => {
		const { pool, engine, createEngine, loadRuntime } = makePool({ idleUnloadMs: 1000 });

		const session = await pool.acquire('m', 'voice-session');
		const wake = await pool.acquire('m', 'wake-word');

		expect(createEngine).toHaveBeenCalledTimes(1);
		expect(engine.load).toHaveBeenCalledTimes(1);
		expect(loadRuntime).toHaveBeenCalledWith('onnx', 'voice-session');
		expect(pool.leaseCount('m')).toBe(2);
		expect(pool.loadedModelIds).toEqual(['m']);

		await expect(session.transcribe(seconds(1))).resolves.toBe('hello world');
		await expect(wake.transcribe(seconds(1))).resolves.toBe('hello world');
		expect(engine.transcribe).toHaveBeenCalledTimes(2);
	});

	it('runs one decode at a time on a model, whoever asked', async () => {
		const first = deferred<string>();
		const running: string[] = [];
		const engine = fakeEngine(async (audio) => {
			running.push(`start:${audio.length}`);
			const text = audio.length === 1 ? await first.promise : 'second';
			running.push(`end:${audio.length}`);
			return text;
		});
		const { pool } = makePool({ engine });
		const a = await pool.acquire('m', 'a');
		const b = await pool.acquire('m', 'b');

		const one = a.transcribe(new Float32Array(1));
		const two = b.transcribe(new Float32Array(2));
		await tick();
		// The second decode has not started: the first still holds the session.
		expect(running).toEqual(['start:1']);

		first.resolve('first');
		await expect(one).resolves.toBe('first');
		await expect(two).resolves.toBe('second');
		expect(running).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
	});

	it('keeps the model loaded while any lease is held', async () => {
		const { pool, engine } = makePool();
		const a = await pool.acquire('m', 'a');
		const b = await pool.acquire('m', 'b');

		await a.release();
		expect(engine.unload).not.toHaveBeenCalled();
		expect(pool.leaseCount('m')).toBe(1);

		await b.release();
		expect(engine.unload).toHaveBeenCalledTimes(1);
		expect(pool.loadedModelIds).toEqual([]);
	});

	it('frees an unleased model after the idle window', async () => {
		vi.useFakeTimers();
		const { pool, engine } = makePool({ idleUnloadMs: 1000 });
		const lease = await pool.acquire('m', 'a');
		await lease.release();

		await vi.advanceTimersByTimeAsync(999);
		expect(engine.unload).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(engine.unload).toHaveBeenCalledTimes(1);
		expect(pool.loadedModelIds).toEqual([]);
	});

	it('a lease taken inside the idle window reuses the loaded model', async () => {
		vi.useFakeTimers();
		const { pool, engine, createEngine } = makePool({ idleUnloadMs: 1000 });
		await (await pool.acquire('m', 'a')).release();
		await vi.advanceTimersByTimeAsync(500);

		const again = await pool.acquire('m', 'b');
		await vi.advanceTimersByTimeAsync(5000);

		expect(createEngine).toHaveBeenCalledTimes(1);
		expect(engine.unload).not.toHaveBeenCalled();
		await expect(again.transcribe(seconds(1))).resolves.toBe('hello world');
	});

	it('waits for a decode in flight before a release frees the model', async () => {
		const gate = deferred<string>();
		const engine = fakeEngine(() => gate.promise);
		const { pool } = makePool({ engine });
		const lease = await pool.acquire('m', 'a');

		const decode = lease.transcribe(seconds(1));
		const released = lease.release();
		await tick();
		expect(engine.unload).not.toHaveBeenCalled();

		gate.resolve('done');
		await expect(decode).resolves.toBe('done');
		await released;
		expect(engine.unload).toHaveBeenCalledTimes(1);
	});

	it('releasing twice gives the model back once', async () => {
		const { pool } = makePool({ idleUnloadMs: 1000 });
		const a = await pool.acquire('m', 'a');
		await pool.acquire('m', 'b');
		await a.release();
		await a.release();
		expect(pool.leaseCount('m')).toBe(1);
	});

	it('refuses to transcribe on a released lease, by name', async () => {
		const { pool } = makePool({ idleUnloadMs: 1000 });
		const lease = await pool.acquire(PARAKEET_TDT_V2_ID, 'a');
		await lease.release();
		await expect(lease.transcribe(seconds(1))).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'generation-failed',
			message: expect.stringContaining('Parakeet'),
		});
	});

	it('a model unloaded underneath a lease rejects its next decode instead of running', async () => {
		const { pool, engine } = makePool({ idleUnloadMs: 1000 });
		const lease = await pool.acquire('m', 'a');
		await pool.unload('m');

		expect(engine.unload).toHaveBeenCalledTimes(1);
		await expect(lease.transcribe(seconds(1))).rejects.toBeInstanceOf(LocalModelError);
		expect(engine.transcribe).not.toHaveBeenCalled();
		// Giving back a lease on a model that is gone must not throw.
		await expect(lease.release()).resolves.toBeUndefined();
	});

	it('passes a model refusal through untouched and loads nothing', async () => {
		const refusal = new LocalModelError('Parakeet is not downloaded.', {
			code: 'model-not-installed',
			recovery: 'Download it in Settings.',
			consumerId: 'a',
		});
		const { pool, loadRuntime } = makePool({
			resolveModel: async () => {
				throw refusal;
			},
		});
		await expect(pool.acquire('m', 'a')).rejects.toBe(refusal);
		expect(loadRuntime).not.toHaveBeenCalled();
		expect(pool.loadedModelIds).toEqual([]);
	});

	it('passes a runtime refusal through untouched and builds no engine', async () => {
		const refusal = new LocalModelError('ONNX Runtime is not downloaded.', {
			code: 'runtime-unavailable',
			recovery: 'Download it in Settings.',
			consumerId: 'a',
		});
		const { pool, createEngine } = makePool({
			loadRuntime: async () => {
				throw refusal;
			},
		});
		await expect(pool.acquire('m', 'a')).rejects.toBe(refusal);
		expect(createEngine).not.toHaveBeenCalled();
	});

	it('a model that will not open leaves nothing resident, and the next lease retries', async () => {
		const engine = fakeEngine();
		engine.load.mockRejectedValueOnce(new Error('protobuf parsing failed'));
		const { pool } = makePool({ engine });

		await expect(pool.acquire('m', 'a')).rejects.toThrow('protobuf parsing failed');
		expect(pool.loadedModelIds).toEqual([]);

		await expect(pool.acquire('m', 'a')).resolves.toMatchObject({ modelId: 'm' });
		expect(engine.load).toHaveBeenCalledTimes(2);
	});
});

describe('splitSpeechWindows', () => {
	it('returns the clip itself when it fits one pass', () => {
		const clip = seconds(5);
		expect(splitSpeechWindows(clip, 60 * RATE)).toEqual([clip]);
	});

	it('cuts a long clip into windows that lose nothing and never exceed the limit', () => {
		const clip = seconds(25);
		const windows = splitSpeechWindows(clip, 10 * RATE);
		expect(windows.length).toBeGreaterThanOrEqual(3);
		for (const window of windows) expect(window.length).toBeLessThanOrEqual(10 * RATE);
		expect(windows.reduce((sum, window) => sum + window.length, 0)).toBe(clip.length);
	});

	it('moves each cut back to the quietest spot before the limit', () => {
		// Loud everywhere except a 100 ms pause ending 1 s before the 10 s limit.
		const clip = seconds(15, 0.5);
		const pauseStart = Math.round(8.9 * RATE);
		const pauseEnd = Math.round(9.0 * RATE);
		clip.fill(0, pauseStart, pauseEnd);

		const [first] = splitSpeechWindows(clip, 10 * RATE);
		expect(first.length).toBeGreaterThanOrEqual(pauseStart);
		expect(first.length).toBeLessThanOrEqual(pauseEnd);
	});
});

describe('transcribeSpeech', () => {
	it("passes vocabulary per lease call without storing another consumer's hints on the engine", async () => {
		const { pool, engine } = makePool();
		__setSpeechToTextPool(pool);
		const vocabulary = ['Pedro Sidián'];
		await transcribeSpeech(LOCAL, seconds(2), RATE, { vocabulary });
		expect(engine.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), { vocabulary });
	});
	beforeEach(() => {
		endpoints.transcribe.mockReset();
	});

	it('transcribes a clip on the assigned local model and gives the lease back', async () => {
		const { pool, engine } = makePool();
		__setSpeechToTextPool(pool);

		await expect(transcribeSpeech(LOCAL, seconds(2), RATE)).resolves.toEqual({
			text: 'hello world',
			audioMs: 2000,
		});
		expect(engine.transcribe).toHaveBeenCalledTimes(1);
		expect(pool.leaseCount(PARAKEET_TDT_V2_ID)).toBe(0);
	});

	it('answers a tap with an empty transcript and loads no model', async () => {
		const { pool, resolveModel } = makePool();
		__setSpeechToTextPool(pool);

		const tap = new Float32Array(Math.round(((MIN_CLIP_MS - 50) / 1000) * RATE));
		await expect(transcribeSpeech(LOCAL, tap, RATE)).resolves.toMatchObject({ text: '' });
		expect(resolveModel).not.toHaveBeenCalled();
	});

	it('resamples a clip that did not arrive at 16 kHz', async () => {
		const { pool, engine } = makePool();
		__setSpeechToTextPool(pool);

		const result = await transcribeSpeech(LOCAL, new Float32Array(48000 * 2).fill(0.2), 48000);
		expect(result.audioMs).toBe(2000);
		expect((engine.transcribe.mock.calls[0][0] as Float32Array).length).toBe(2 * RATE);
	});

	it('drops what a recogniser invents for a quiet room', async () => {
		const { pool } = makePool({ engine: fakeEngine(async () => '[BLANK_AUDIO]') });
		__setSpeechToTextPool(pool);
		await expect(transcribeSpeech(LOCAL, seconds(2), RATE)).resolves.toMatchObject({ text: '' });
	});

	it('transcribes every window of a clip longer than one pass, in order', async () => {
		let pass = 0;
		const { pool, engine } = makePool({
			engine: fakeEngine(async () => ['one', 'two', 'three'][pass++] ?? ''),
			maxSamples: 10 * RATE,
		});
		__setSpeechToTextPool(pool);

		const result = await transcribeSpeech(LOCAL, seconds(25), RATE);
		expect(engine.transcribe).toHaveBeenCalledTimes(3);
		expect(result.text).toBe('one two three');
	});

	it('names the model when a decode fails, and still gives the lease back', async () => {
		const { pool } = makePool({
			engine: fakeEngine(async () => {
				throw new Error('reshape failed');
			}),
		});
		__setSpeechToTextPool(pool);

		await expect(transcribeSpeech(LOCAL, seconds(2), RATE)).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'generation-failed',
			message: expect.stringMatching(/Parakeet.*reshape failed/),
		});
		expect(pool.leaseCount(PARAKEET_TDT_V2_ID)).toBe(0);
	});

	it('uploads the clip as a 16 kHz WAV when the source is an endpoint', async () => {
		endpoints.transcribe.mockResolvedValue({ text: ' Ship it. ' });

		await expect(transcribeSpeech(ENDPOINT, seconds(1, 0.5), RATE)).resolves.toEqual({
			text: 'Ship it.',
			audioMs: 1000,
		});
		const [endpointId, request] = endpoints.transcribe.mock.calls[0];
		expect(endpointId).toBe('ep-1');
		expect(request.model).toBe('whisper-1');
		const decoded = decodeWavPcm16(request.wav as Uint8Array);
		expect(decoded.sampleRate).toBe(RATE);
		expect(decoded.pcm).toHaveLength(RATE);
	});

	it.each([LOCAL.modelId, WHISPER_SMALL_ID])(
		'discards the final %s window after cancellation and drains the lease',
		async (modelId) => {
			const assignment = { type: 'local', modelId } as const;
			const decoding = deferred<string>();
			const { pool, engine } = makePool({ engine: fakeEngine(() => decoding.promise) });
			__setSpeechToTextPool(pool);
			const abort = new AbortController();
			const result = transcribeSpeech(assignment, seconds(1), RATE, { signal: abort.signal });
			const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' });
			await tick();
			abort.abort();
			expect(pool.leaseCount(modelId)).toBe(1);
			decoding.resolve('late result');
			await rejection;
			expect(engine.unload).toHaveBeenCalledTimes(1);
			expect(pool.leaseCount(modelId)).toBe(0);
		}
	);

	it('stops before loading anything when the caller already cancelled', async () => {
		const { pool, resolveModel } = makePool();
		__setSpeechToTextPool(pool);
		const abort = new AbortController();
		abort.abort();

		await expect(
			transcribeSpeech(LOCAL, seconds(2), RATE, { signal: abort.signal })
		).rejects.toMatchObject({ code: localModelCancelledError('x').code });
		expect(resolveModel).not.toHaveBeenCalled();
	});

	it('refuses a sample rate that is not one (a caller bug)', async () => {
		await expect(transcribeSpeech(LOCAL, seconds(1), 0)).rejects.toThrow(/sample rate/);
		await expect(transcribeSpeech(LOCAL, seconds(1), Number.NaN)).rejects.toThrow(/sample rate/);
	});
});
