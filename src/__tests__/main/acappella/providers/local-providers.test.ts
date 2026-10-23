/**
 * @file local-providers.test.ts
 *
 * The local tier against mocked native runtimes. Nothing here loads a model or a
 * `.node` binary: the runtime loader is the seam, which is the whole reason it
 * exists.
 *
 * What is worth testing about a local provider is not the inference - that
 * belongs to whisper.cpp and llama.cpp - but everything around it, which is where
 * this codebase's bugs would be: chunked partials that stop when the session
 * does, a cancel that actually cuts a run, and a load failure that reports itself
 * as its own provider rather than reaching for another one.
 *
 * The local Conductor Brain is not here: it runs through the Local Models task
 * router and is covered by `assigned-brain.test.ts`; the llama engine itself
 * (one resident model, idle unload, the sequence handed back per turn) by
 * `local-models/text-gen.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dictation = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../../../main/local-models/dictation', () => ({
	resolveLocalClipTranscriber: dictation.resolve,
}));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	WhisperSttProvider,
	sanitizeTranscript,
} from '../../../../main/acappella/providers/local/whisper-stt';
import { DictationSttProvider } from '../../../../main/acappella/providers/local/dictation-stt';
import { ParakeetSttProvider } from '../../../../main/acappella/providers/local/parakeet-stt';
import {
	KokoroTtsProvider,
	styleVectorFor,
} from '../../../../main/acappella/providers/local/kokoro-tts';
import { LocalModelError } from '../../../../main/local-models/errors';
import { SpeechToTextPool } from '../../../../main/local-models/speech-to-text';
import type { InstalledSpeechToTextModel } from '../../../../main/local-models/stt/engines';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { SttCallbacks, TtsChunk } from '../../../../shared/acappella/providers';

/**
 * A speech-to-text pool over a fake engine, standing in for the app-wide one.
 * Production providers lease their model from the pool instead of building an
 * engine of their own, so this is the seam the shared path is tested through.
 */
function sharedPool(options: { loadRuntime?: () => Promise<unknown>; text?: string } = {}) {
	const transcribe = vi.fn(async () => options.text ?? 'open the auth tab');
	const engine = { load: vi.fn(async () => {}), unload: vi.fn(async () => {}), transcribe };
	const resolved: string[] = [];
	const pool = new SpeechToTextPool({
		idleUnloadMs: 0,
		loadRuntime: (options.loadRuntime ?? (async () => ({}))) as never,
		resolveModel: async (modelId) => {
			resolved.push(modelId);
			return {
				entry: { displayName: modelId, runtime: 'onnx' },
				maxSamples: 16000 * 30,
				createEngine: async () => engine,
			} as unknown as InstalledSpeechToTextModel;
		},
	});
	return { pool, engine, resolved };
}

/** A core runtime refusal, as an uninstalled ONNX Runtime produces. */
const runtimeDown = async (_id: string, consumerId: string) => {
	throw new LocalModelError('ONNX Runtime is not downloaded.', {
		code: 'runtime-unavailable',
		recovery: 'Download it in Settings.',
		consumerId,
	});
};

function recorder(): {
	callbacks: SttCallbacks;
	partials: string[];
	finals: string[];
	errors: Error[];
} {
	const partials: string[] = [];
	const finals: string[] = [];
	const errors: Error[] = [];
	return {
		partials,
		finals,
		errors,
		callbacks: {
			onPartial: (text) => partials.push(text),
			onFinal: (text) => finals.push(text),
			onError: (error) => errors.push(error),
		},
	};
}

/** 20 ms of 16 kHz audio. */
function frame(): Int16Array {
	return new Int16Array(320);
}

// ---------------------------------------------------------------------------
// Whisper
// ---------------------------------------------------------------------------

describe('WhisperSttProvider', () => {
	it('passes live vocabulary per decode through the shared lease', async () => {
		const { pool, engine } = sharedPool();
		const provider = new WhisperSttProvider({ pool, partialIntervalMs: 0 });
		await provider.start(recorder().callbacks);
		provider.setVocabulary(['🏢 Pedro Sidián']);
		provider.feed(new Int16Array(16000).fill(1000));
		await provider.flush();
		expect(engine.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), {
			vocabulary: ['Pedro Sidián'],
		});
		await provider.stop();
	});
	/**
	 * A stand-in for the ONNX engine.
	 *
	 * The provider owns STREAMING policy - cadence, stability, endpointing, and
	 * what is published when - while `whisper/engine.ts` owns inference. These
	 * tests are about the policy, so the engine is injected: a real one would open
	 * two ONNX graphs and a 200 MB model to prove something about timing.
	 */
	function whisperEngine(text = 'open the auth tab') {
		const transcribe = vi.fn(async () => text);
		const unload = vi.fn(async () => {});
		return {
			transcribe,
			unload,
			engine: { load: vi.fn(async () => {}), unload, transcribe },
		};
	}

	it('reports a runtime that will not load as its own failure, never another provider', async () => {
		const { pool } = sharedPool({ loadRuntime: runtimeDown as never });
		const provider = new WhisperSttProvider({ pool });

		await expect(provider.start(recorder().callbacks)).rejects.toMatchObject({
			name: 'VoiceProviderError',
			kind: 'unavailable',
			providerId: 'whisper-local',
			message: 'ONNX Runtime is not downloaded.',
		});
	});

	it('leases its catalog model from the shared pool and gives it back on stop', async () => {
		const { pool, engine, resolved } = sharedPool({ text: 'run the tests' });
		const provider = new WhisperSttProvider({ pool, partialIntervalMs: 0 });
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		expect(resolved).toEqual(['whisper-base-en']);
		expect(pool.leaseCount('whisper-base-en')).toBe(1);

		provider.feed(frame());
		await provider.flush();
		expect(finals).toEqual(['run the tests']);

		await provider.stop();
		expect(pool.leaseCount('whisper-base-en')).toBe(0);
		// Nobody else held it and this pool keeps nothing idle, so it is freed.
		expect(engine.unload).toHaveBeenCalledTimes(1);
	});

	it('shares one loaded model with another consumer rather than loading a second', async () => {
		const { pool, engine } = sharedPool();
		// The transcription wake word, say, already holding the same model.
		const other = await pool.acquire('whisper-base-en', 'transcription-wake');
		const provider = new WhisperSttProvider({ pool });

		await provider.start(recorder().callbacks);
		expect(engine.load).toHaveBeenCalledTimes(1);
		expect(pool.leaseCount('whisper-base-en')).toBe(2);

		// Ending the session must not unload the model underneath the other holder.
		await provider.stop();
		expect(engine.unload).not.toHaveBeenCalled();
		await expect(other.transcribe(new Float32Array(16000))).resolves.toBe('open the auth tab');
	});

	it('loads the ONNX runtime rather than a whisper-specific one', async () => {
		// The whole reason local speech-to-text can ship: it rides the runtime
		// text-to-speech and the wake word already download, instead of a
		// whisper.cpp binding that compiles from source and so has nothing to fetch.
		const seen: string[] = [];
		const harness = whisperEngine();
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: (async (id: string) => {
				seen.push(id);
				return {} as never;
			}) as never,
		});

		await provider.start(recorder().callbacks);
		expect(seen).toEqual(['onnx']);
	});

	it('emits a partial once enough audio has accumulated', async () => {
		const harness = whisperEngine('open the');
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 40,
		});
		const { callbacks, partials } = recorder();

		await provider.start(callbacks);
		// Two frames is 40 ms, which is the configured interval.
		provider.feed(frame());
		provider.feed(frame());
		await vi.waitFor(() => expect(partials).toEqual(['open the']));
	});

	it('publishes the final on endpointing and clears the buffer', async () => {
		const harness = whisperEngine('open the auth tab');
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			// No partials, so exactly one decode happens and it is the final.
			partialIntervalMs: 0,
		});
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		await provider.flush();

		expect(finals).toEqual(['open the auth tab']);
		expect(harness.transcribe).toHaveBeenCalledTimes(1);

		// A second flush with nothing buffered must not decode silence.
		await provider.flush();
		expect(harness.transcribe).toHaveBeenCalledTimes(1);
	});

	it('drops a decode that lands after the session ended', async () => {
		const harness = whisperEngine('too late');
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 0,
		});
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		const pending = provider.flush();
		await provider.stop();
		await pending;

		// The transcript belongs to a session that is over; publishing it would put
		// an old utterance on the next turn.
		expect(finals).toEqual([]);
	});

	it('frees the model on stop', async () => {
		const harness = whisperEngine();
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
		});

		await provider.start(recorder().callbacks);
		await provider.stop();

		expect(harness.unload).toHaveBeenCalled();
	});

	it('reports a decode failure through onError rather than throwing at the frame path', async () => {
		const provider = new WhisperSttProvider({
			engine: {
				load: vi.fn(async () => {}),
				unload: vi.fn(async () => {}),
				transcribe: async () => {
					throw new Error('ggml assert');
				},
			},
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 0,
		});
		const { callbacks, errors } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		await provider.flush();

		expect(errors[0].message).toContain('ggml assert');
	});

	it('takes typed text without decoding anything', async () => {
		const harness = whisperEngine();
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
		});
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.injectUtterance('typed instead of spoken');

		expect(finals).toEqual(['typed instead of spoken']);
		expect(harness.transcribe).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Parakeet
// ---------------------------------------------------------------------------

describe('ParakeetSttProvider', () => {
	/**
	 * The streaming policy is shared with Whisper (`chunked-stt.ts`) and covered
	 * above; these pin what is Parakeet's own: its identity, its runtime, and
	 * that a failure is reported as Parakeet rather than as the shared base.
	 */
	function parakeetEngine(text = 'Open the auth tab.') {
		const transcribe = vi.fn(async () => text);
		return {
			transcribe,
			engine: { load: vi.fn(async () => {}), unload: vi.fn(async () => {}), transcribe },
		};
	}

	it('is the local default recogniser, on the ONNX runtime', async () => {
		const seen: string[] = [];
		const provider = new ParakeetSttProvider({
			engine: parakeetEngine().engine,
			loadRuntime: (async (id: string) => {
				seen.push(id);
				return {} as never;
			}) as never,
		});

		expect(provider.id).toBe('parakeet-local');
		expect(provider.tier).toBe('local');
		expect(provider.acceptsAudio).toBe(true);
		await provider.start(recorder().callbacks);
		expect(seen).toEqual(['onnx']);
	});

	it('publishes the final, punctuation and all, on endpointing', async () => {
		const harness = parakeetEngine('Ask the Philosopher agent to summarize.');
		const provider = new ParakeetSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 0,
		});
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		await provider.flush();

		expect(finals).toEqual(['Ask the Philosopher agent to summarize.']);
	});

	it('names itself when a decode fails', async () => {
		const provider = new ParakeetSttProvider({
			engine: {
				load: vi.fn(async () => {}),
				unload: vi.fn(async () => {}),
				transcribe: async () => {
					throw new Error('reshape failed');
				},
			},
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 0,
		});
		const { callbacks, errors } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		await provider.flush();

		expect(errors[0]).toMatchObject({ kind: 'unavailable', providerId: 'parakeet-local' });
		expect(errors[0].message).toContain('Parakeet could not transcribe');
	});

	it('reports a runtime that will not load as its own failure', async () => {
		const { pool } = sharedPool({ loadRuntime: runtimeDown as never });
		const provider = new ParakeetSttProvider({ pool });

		await expect(provider.start(recorder().callbacks)).rejects.toMatchObject({
			kind: 'unavailable',
			providerId: 'parakeet-local',
		});
	});

	it('leases the Parakeet catalog model from the shared pool', async () => {
		const { pool, resolved } = sharedPool();
		const provider = new ParakeetSttProvider({ pool });

		await provider.start(recorder().callbacks);
		expect(resolved).toEqual(['parakeet-tdt-0.6b-v2']);
		await provider.stop();
		expect(pool.leaseCount('parakeet-tdt-0.6b-v2')).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Kokoro
// ---------------------------------------------------------------------------

describe('KokoroTtsProvider', () => {
	function onnxRuntime() {
		const run = vi.fn(async () => ({ waveform: { data: new Float32Array(240), dims: [1, 240] } }));
		const release = vi.fn();
		const module = {
			InferenceSession: { create: async () => ({ run, release }) },
			Tensor: class {
				constructor(
					readonly type: string,
					readonly data: unknown,
					readonly dims: readonly number[]
				) {}
			},
		};
		return { module, run, release, loadRuntime: async () => module as never };
	}

	const phonemize = (text: string) => text.split('').map((_char, index) => index + 1);
	const readVoicePack = async () => new Float32Array(256 * 64);

	async function collect(iterable: AsyncIterable<TtsChunk>): Promise<TtsChunk[]> {
		const chunks: TtsChunk[] = [];
		for await (const chunk of iterable) chunks.push(chunk);
		return chunks;
	}

	it('refuses, by name, when the phoneme front end cannot load', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			// No `phonemize` injected, so the real front end is built from the
			// model's tokenizer file, which is not there.
			tokenizerPath: '/tmp/no-such-kokoro-model/tokenizer.json',
			readVoicePack,
		});

		// It does NOT approximate. A character-level fallback would synthesise
		// confident nonsense, which is worse than silence with an explanation.
		await expect(collect(provider.speak('Hello.', { utteranceId: 'u1' }))).rejects.toMatchObject({
			kind: 'unavailable',
		});
	});

	it('synthesises one chunk per sentence at the model rate', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			phonemize,
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			voicePackPath: '/tmp/voice.bin',
			readVoicePack,
		});

		const chunks = await collect(provider.speak('First one. Second one.', { utteranceId: 'u1' }));

		expect(chunks.map((chunk) => chunk.text)).toEqual(['First one.', 'Second one.']);
		expect(chunks[0].sampleRate).toBe(24_000);
		expect(runtime.run).toHaveBeenCalledTimes(2);
	});

	it('speaks a sentence longer than the model takes in one run, as several', async () => {
		const runtime = onnxRuntime();
		// 1200 ids for one sentence, with a punctuation id (9) every 100.
		const long = Array.from({ length: 1200 }, (_, index) => (index % 100 === 99 ? 9 : 1));
		const provider = new KokoroTtsProvider({
			phonemize: () => long,
			boundaries: { punctuation: new Set([9]), space: undefined },
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			readVoicePack,
		});

		const chunks = await collect(provider.speak('One long sentence.', { utteranceId: 'u1' }));

		// Fed whole, 1200 ids fails the inference. Cut at punctuation it is three
		// runs of at most 510, joined into ONE chunk for the one sentence.
		expect(chunks).toHaveLength(1);
		expect(runtime.run).toHaveBeenCalledTimes(3);
		const lengths = runtime.run.mock.calls.map(
			([feeds]) => (feeds as { input_ids: { dims: number[] } }).input_ids.dims[1] - 2
		);
		expect(lengths).toEqual([500, 500, 200]);
		// 240 float samples per mocked run, as 16-bit PCM.
		expect(chunks[0].audio?.byteLength).toBe(3 * 240 * 2);
	});

	it('says nothing, and fails nothing, for a sentence with nothing speakable in it', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			phonemize: (text) => (text.startsWith('Real') ? [1, 2, 3] : []),
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			readVoicePack,
		});

		const chunks = await collect(provider.speak('(). Real words.', { utteranceId: 'u1' }));

		// Not a run of two pad tokens: the empty sentence is skipped.
		expect(chunks.map((chunk) => chunk.text)).toEqual(['Real words.']);
		expect(runtime.run).toHaveBeenCalledTimes(1);
	});

	it('cancels a run without delivering the sentence it interrupted', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			phonemize,
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			voicePackPath: '/tmp/voice.bin',
			readVoicePack,
		});

		const chunks: TtsChunk[] = [];
		for await (const chunk of provider.speak('First. Second. Third.', { utteranceId: 'u1' })) {
			chunks.push(chunk);
			provider.cancel();
		}

		expect(chunks).toHaveLength(1);
	});

	it('clamps the speed to the range the model can render', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			phonemize,
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			voicePackPath: '/tmp/voice.bin',
			readVoicePack,
		});

		await collect(provider.speak('Hello.', { utteranceId: 'u1', rate: 9 }));

		const feeds = (
			runtime.run.mock.calls[0] as unknown as [Record<string, { data: Float32Array }>]
		)[0];
		expect(feeds.speed.data[0]).toBe(2);
	});

	it('releases the session when disposed', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			phonemize,
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
			voicePackPath: '/tmp/voice.bin',
			readVoicePack,
		});

		await collect(provider.speak('Hello.', { utteranceId: 'u1' }));
		await provider.dispose();

		expect(runtime.release).toHaveBeenCalled();
	});

	it('clamps a style row rather than reading past the end of the pack', () => {
		const pack = new Float32Array(256 * 4).fill(1);
		// A sentence longer than the pack has rows for: reading past the end would
		// hand the model whatever followed it in memory, which comes out as a burst
		// of noise at full volume.
		expect(styleVectorFor(pack, 10_000)).toHaveLength(256);
		expect(styleVectorFor(pack, 0)).toHaveLength(256);
	});
});

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Whisper: silence, loops, and the endpoint race
// ---------------------------------------------------------------------------

describe('WhisperSttProvider with voice-activity hints', () => {
	function whisperEngine(text = 'open the auth tab') {
		const transcribe = vi.fn(async () => text);
		return {
			transcribe,
			engine: { load: vi.fn(async () => {}), unload: vi.fn(async () => {}), transcribe },
		};
	}

	function recorder() {
		const partials: string[] = [];
		const finals: string[] = [];
		const errors: Error[] = [];
		const callbacks: SttCallbacks = {
			onPartial: (text) => partials.push(text),
			onFinal: (text) => finals.push(text),
			onError: (error) => errors.push(error),
		};
		return { callbacks, partials, finals, errors };
	}

	const speech = { speech: true };
	const quiet = { speech: false };

	it('decodes nothing while the detector has heard no speech', async () => {
		const harness = whisperEngine('(keyboard clacking)');
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 40,
		});
		const { callbacks, partials, finals } = recorder();
		await provider.start(callbacks);

		// A quiet minute: not one pass, and nothing published on the endpoint.
		for (let i = 0; i < 3000; i++) provider.feed(new Int16Array(320), quiet);
		await provider.flush();

		expect(harness.transcribe).not.toHaveBeenCalled();
		expect(partials).toEqual([]);
		expect(finals).toEqual([]);
	});

	it('decodes once the detector has confirmed speech, with a second of context ahead of it', async () => {
		const harness = whisperEngine('open the auth tab');
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 0,
		});
		const { callbacks, finals } = recorder();
		await provider.start(callbacks);

		for (let i = 0; i < 500; i++) provider.feed(new Int16Array(320), quiet);
		for (let i = 0; i < 20; i++) provider.feed(new Int16Array(320), speech);
		await provider.flush();

		expect(finals).toEqual(['open the auth tab']);
		// 1 s of context (50 frames) plus the 20 speech frames, give or take a frame,
		// not the ten quiet seconds that came before.
		const decoded = harness.transcribe.mock.calls[0][0] as Float32Array;
		expect(decoded.length).toBeLessThanOrEqual(320 * 71);
		expect(decoded.length).toBeGreaterThanOrEqual(320 * 69);
	});

	it('drops what the model invents for a quiet room', async () => {
		const harness = whisperEngine('[ Silence ] (keyboard clacking)');
		const provider = new WhisperSttProvider({
			engine: harness.engine,
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 0,
		});
		const { callbacks, finals } = recorder();
		await provider.start(callbacks);

		for (let i = 0; i < 20; i++) provider.feed(new Int16Array(320), speech);
		await provider.flush();

		expect(harness.transcribe).toHaveBeenCalledTimes(1);
		expect(finals).toEqual([]);
	});

	it('lets a final wait for the partial in flight instead of racing it', async () => {
		let release: (() => void) | null = null;
		const transcribe = vi
			.fn<() => Promise<string>>()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						release = () => resolve('open the');
					})
			)
			.mockImplementation(async () => 'open the auth tab');
		const provider = new WhisperSttProvider({
			engine: { load: vi.fn(async () => {}), unload: vi.fn(async () => {}), transcribe },
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 40,
		});
		const { callbacks, partials, finals } = recorder();
		await provider.start(callbacks);

		// Two frames cross the partial interval: the first pass starts and stalls.
		provider.feed(new Int16Array(320));
		provider.feed(new Int16Array(320));
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));

		const flushed = provider.flush();
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The final has not started a second decode over the same session.
		expect(transcribe).toHaveBeenCalledTimes(1);

		release!();
		await flushed;
		expect(partials).toEqual(['open the']);
		expect(finals).toEqual(['open the auth tab']);
		expect(transcribe).toHaveBeenCalledTimes(2);
	});

	it('drops a failed partial quietly and reports only a failed final', async () => {
		const transcribe = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('Reshape node'))
			.mockRejectedValueOnce(new Error('Reshape node'));
		const provider = new WhisperSttProvider({
			engine: { load: vi.fn(async () => {}), unload: vi.fn(async () => {}), transcribe },
			loadRuntime: async () => ({}) as never,
			partialIntervalMs: 40,
		});
		const { callbacks, errors } = recorder();
		await provider.start(callbacks);

		provider.feed(new Int16Array(320));
		provider.feed(new Int16Array(320));
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(errors).toEqual([]);

		await provider.flush();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ kind: 'unavailable', providerId: 'whisper-local' });
	});
});

describe('sanitizeTranscript', () => {
	it('strips sound-effect tags and keeps the words around them', () => {
		expect(sanitizeTranscript('(sighs) run the tests')).toBe('run the tests');
		expect(sanitizeTranscript('[ Silence ]')).toBe('');
		expect(sanitizeTranscript('(keyboard clacking) (muffled speaking)')).toBe('');
		expect(sanitizeTranscript('[BLANK_AUDIO]')).toBe('');
	});

	it("drops the model's stock words for silence", () => {
		expect(sanitizeTranscript('you')).toBe('');
		expect(sanitizeTranscript('Thank you.')).toBe('');
		expect(sanitizeTranscript('...')).toBe('');
		expect(sanitizeTranscript('♪')).toBe('');
	});

	it('leaves real speech alone', () => {
		expect(sanitizeTranscript('  Ask the backend agent to run the test suite.  ')).toBe(
			'Ask the backend agent to run the test suite.'
		);
		expect(sanitizeTranscript('thank you for the update, now deploy it')).toBe(
			'thank you for the update, now deploy it'
		);
	});
});

describe('DictationSttProvider shared source', () => {
	it('leases the same multilingual model with the configured language and preserves other leases', async () => {
		dictation.resolve.mockResolvedValue({
			modelId: 'whisper-base',
			language: 'de',
			languages: ['de', 'en'],
			reason: null,
		});
		const { pool, engine, resolved } = sharedPool({ text: 'synthetic fixture' });
		const other = await pool.acquire('whisper-base', 'file-clip');
		const provider = new DictationSttProvider({ pool });
		await provider.start(recorder().callbacks);
		provider.setVocabulary(['🏢 Pedro Sidián']);
		for (let i = 0; i < 20; i++) provider.feed(frame());
		await provider.flush();
		expect(engine.transcribe).toHaveBeenCalledWith(expect.any(Float32Array), {
			language: 'de',
			vocabulary: ['Pedro Sidián'],
		});
		expect(resolved).toEqual(['whisper-base']);
		await provider.stop();
		expect(engine.unload).not.toHaveBeenCalled();
		await other.release();
		expect(engine.unload).toHaveBeenCalledTimes(1);
	});
	it('refuses unavailable Dictation without opening a second engine or choosing English', async () => {
		dictation.resolve.mockResolvedValue({ modelId: null, languages: [], reason: 'off' });
		const { pool, engine, resolved } = sharedPool();
		await expect(
			new DictationSttProvider({ pool }).start(recorder().callbacks)
		).rejects.toMatchObject({ name: 'VoiceProviderError', providerId: 'dictation-local' });
		expect(resolved).toEqual([]);
		expect(engine.load).not.toHaveBeenCalled();
	});
});
