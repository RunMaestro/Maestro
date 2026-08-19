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
 * does, a cancel that actually cuts a run, a model that unloads when idle and
 * loads again on the next turn, and a load failure that reports itself as its own
 * provider rather than reaching for another one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { WhisperSttProvider } from '../../../../main/acappella/providers/local/whisper-stt';
import {
	KokoroTtsProvider,
	styleVectorFor,
} from '../../../../main/acappella/providers/local/kokoro-tts';
import { LlamaBrainProvider } from '../../../../main/acappella/providers/local/llama-brain';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { SttCallbacks, TtsChunk } from '../../../../shared/acappella/providers';
import type { RosterAgent } from '../../../../shared/acappella/protocol';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
	},
];

/** A runtime loader that always fails, as an uninstalled runtime would. */
const failingRuntime = async (_id: string, providerId: string) => {
	throw new VoiceProviderError('llama.cpp is not part of this build yet.', {
		kind: 'unavailable',
		providerId,
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
	function whisperRuntime(segments: string[] = ['open the auth tab']) {
		const free = vi.fn();
		const transcribe = vi.fn(async () => ({
			result: Promise.resolve(segments.map((text) => ({ text }))),
		}));
		const module = {
			Whisper: class {
				transcribe = transcribe;
				free = free;
			},
		};
		return { module, transcribe, free, loadRuntime: async () => module as never };
	}

	it('reports a runtime that will not load as its own failure, never another provider', async () => {
		const provider = new WhisperSttProvider({ loadRuntime: failingRuntime as never });

		await expect(provider.start(recorder().callbacks)).rejects.toMatchObject({
			kind: 'unavailable',
			providerId: 'whisper-local',
		});
	});

	it('emits a partial once enough audio has accumulated', async () => {
		const runtime = whisperRuntime(['open the']);
		const provider = new WhisperSttProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/model.bin',
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
		const runtime = whisperRuntime(['open the auth tab']);
		const provider = new WhisperSttProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/model.bin',
			// No partials, so exactly one decode happens and it is the final.
			partialIntervalMs: 0,
		});
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		await provider.flush();

		expect(finals).toEqual(['open the auth tab']);
		expect(runtime.transcribe).toHaveBeenCalledTimes(1);

		// A second flush with nothing buffered must not decode silence.
		await provider.flush();
		expect(runtime.transcribe).toHaveBeenCalledTimes(1);
	});

	it('drops a decode that lands after the session ended', async () => {
		const runtime = whisperRuntime(['too late']);
		const provider = new WhisperSttProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/model.bin',
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
		const runtime = whisperRuntime();
		const provider = new WhisperSttProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/model.bin',
		});

		await provider.start(recorder().callbacks);
		await provider.stop();

		expect(runtime.free).toHaveBeenCalled();
	});

	it('reports a decode failure through onError rather than throwing at the frame path', async () => {
		const module = {
			Whisper: class {
				transcribe = async () => {
					throw new Error('ggml assert');
				};
				free = vi.fn();
			},
		};
		const provider = new WhisperSttProvider({
			loadRuntime: async () => module as never,
			modelPath: '/tmp/model.bin',
			partialIntervalMs: 0,
		});
		const { callbacks, errors } = recorder();

		await provider.start(callbacks);
		provider.feed(frame());
		await provider.flush();

		expect(errors[0].message).toContain('ggml assert');
	});

	it('takes typed text without decoding anything', async () => {
		const runtime = whisperRuntime();
		const provider = new WhisperSttProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/model.bin',
		});
		const { callbacks, finals } = recorder();

		await provider.start(callbacks);
		provider.injectUtterance('typed instead of spoken');

		expect(finals).toEqual(['typed instead of spoken']);
		expect(runtime.transcribe).not.toHaveBeenCalled();
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

	it('refuses, by name, when there is no phoneme front end', async () => {
		const runtime = onnxRuntime();
		const provider = new KokoroTtsProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/kokoro.onnx',
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

// ---------------------------------------------------------------------------
// Qwen3 via llama.cpp
// ---------------------------------------------------------------------------

describe('LlamaBrainProvider', () => {
	function llamaRuntime(reply: string) {
		const prompt = vi.fn(async () => reply);
		const contextDispose = vi.fn();
		const modelDispose = vi.fn();
		const module = {
			getLlama: async () => ({
				loadModel: async () => ({
					createContext: async () => ({
						getSequence: () => ({}),
						dispose: contextDispose,
					}),
					dispose: modelDispose,
				}),
				createGrammarForJsonSchema: async () => ({}),
			}),
			LlamaChatSession: class {
				prompt = prompt;
			},
		};
		return {
			module,
			prompt,
			contextDispose,
			modelDispose,
			loadRuntime: async () => module as never,
		};
	}

	const decision = JSON.stringify({
		target: { sessionId: 'agent-backend' },
		tabAction: 'new',
		tabName: 'Auth',
		prompt: 'refactor auth',
		confidence: 0.9,
	});

	it('reports a runtime that will not load as its own failure', async () => {
		const provider = new LlamaBrainProvider({ loadRuntime: failingRuntime as never });

		await expect(
			provider.route('anything', { roster: ROSTER, scope: { kind: 'conductor' } })
		).rejects.toMatchObject({ kind: 'unavailable', providerId: 'qwen3-local' });
	});

	it('routes through the shared parser', async () => {
		const runtime = llamaRuntime(decision);
		const provider = new LlamaBrainProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/qwen.gguf',
			idleUnloadMs: 0,
		});

		const result = await provider.route('ask backend to refactor auth', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		expect(result).toMatchObject({ target: { sessionId: 'agent-backend' }, tabAction: 'new' });
	});

	it('keeps the context loaded across turns', async () => {
		const runtime = llamaRuntime(decision);
		const provider = new LlamaBrainProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/qwen.gguf',
			// Never unload, so this test is about reuse rather than about the timer.
			idleUnloadMs: 0,
		});
		const context = { roster: ROSTER, scope: { kind: 'conductor' as const } };

		await provider.route('one', context);
		await provider.route('two', context);

		expect(provider.isLoaded).toBe(true);
		expect(runtime.prompt).toHaveBeenCalledTimes(2);
		// One load, two turns: per-turn latency is inference only.
		expect(runtime.modelDispose).not.toHaveBeenCalled();
	});

	it('unloads after the idle window and reloads on the next turn', async () => {
		vi.useFakeTimers();
		try {
			const runtime = llamaRuntime(decision);
			const provider = new LlamaBrainProvider({
				loadRuntime: runtime.loadRuntime,
				modelPath: '/tmp/qwen.gguf',
				idleUnloadMs: 1_000,
			});
			const context = { roster: ROSTER, scope: { kind: 'conductor' as const } };

			await provider.route('one', context);
			expect(provider.isLoaded).toBe(true);

			await vi.advanceTimersByTimeAsync(1_100);
			// A gigabyte of resident memory for a conversation that ended is not
			// acceptable, however warm it would have been.
			expect(provider.isLoaded).toBe(false);
			expect(runtime.contextDispose).toHaveBeenCalled();
			expect(runtime.modelDispose).toHaveBeenCalled();

			await provider.route('two', context);
			expect(provider.isLoaded).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('trims a spoken rewrite to the sentence budget', async () => {
		const runtime = llamaRuntime('One. Two. Three.');
		const provider = new LlamaBrainProvider({
			loadRuntime: runtime.loadRuntime,
			modelPath: '/tmp/qwen.gguf',
			idleUnloadMs: 0,
		});

		const spoken = await provider.converse('...', {
			agentSessionId: 'agent-backend',
			tabId: 'tab-auth',
			maxSentences: 2,
		});

		expect(spoken).toBe('One. Two.');
	});

	it('reports an inference failure as a classified provider error', async () => {
		const module = {
			getLlama: async () => ({
				loadModel: async () => ({
					createContext: async () => ({ getSequence: () => ({}), dispose: vi.fn() }),
					dispose: vi.fn(),
				}),
				createGrammarForJsonSchema: async () => ({}),
			}),
			LlamaChatSession: class {
				prompt = async () => {
					throw new Error('context is full');
				};
			},
		};
		const provider = new LlamaBrainProvider({
			loadRuntime: async () => module as never,
			modelPath: '/tmp/qwen.gguf',
			idleUnloadMs: 0,
		});

		await expect(
			provider.route('anything', { roster: ROSTER, scope: { kind: 'conductor' } })
		).rejects.toMatchObject({ kind: 'unavailable' });
	});
});

beforeEach(() => {
	vi.clearAllMocks();
});
