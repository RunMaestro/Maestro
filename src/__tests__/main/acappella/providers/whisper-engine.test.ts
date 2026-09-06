/**
 * @file whisper-engine.test.ts
 *
 * The greedy decode loop, driven against a fake ONNX Runtime.
 *
 * One test here matters more than the rest: **cross-attention KV must be kept
 * from the first pass and never overwritten**. The merged decoder computes it
 * once, on the pass where `use_cache_branch` is false, and returns a length-1
 * PLACEHOLDER for it on every pass after. Feeding that placeholder back throws
 * away the 1500-frame audio cache, and the decoder - now attending to nothing -
 * free-runs into a fluent repeating phrase.
 *
 * That is not a hypothetical. It is the bug this engine was written through:
 * "Ask the acapella agent to run the test suite" decoded as "Ask the students to
 * be able to be able to be able..." while the mel features were bit-exact and
 * every graph loaded cleanly. Nothing threw, nothing logged, and the output was
 * confident English. A fake runtime is the only way to assert the cache
 * discipline directly rather than inferring it from a transcript.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	WhisperEngine,
	WHISPER_BASE_GEOMETRY,
	type OnnxModule,
	type OnnxSession,
	type OnnxTensor,
} from '../../../../main/acappella/providers/local/whisper/engine';
import { WHISPER_EN_SPECIAL_TOKENS } from '../../../../main/acappella/providers/local/whisper/tokenizer';

const { layers, heads, headDim } = WHISPER_BASE_GEOMETRY;

/** Minimal stand-in for `onnxruntime-node`'s Tensor. */
class FakeTensor implements OnnxTensor {
	constructor(
		readonly type: string,
		readonly data: Float32Array | BigInt64Array | Uint8Array,
		readonly dims: readonly number[]
	) {}
}

/** The vocabulary the fake decoder emits from, mapped to plain ASCII pieces. */
function vocabFor(pieces: string[]): Record<string, number> {
	// Byte-level identity for ASCII in the printable range, which every piece
	// below stays inside.
	const vocab: Record<string, number> = {};
	pieces.forEach((piece, index) => {
		vocab[piece.replace(/ /g, 'Ġ')] = index;
	});
	return vocab;
}

interface DecodeCall {
	inputIds: number[];
	useCache: boolean;
	encoderCacheLength: number;
	decoderCacheLength: number;
}

/**
 * A fake ONNX module that plays the merged-decoder contract faithfully.
 *
 * The important half is the dishonest half: after the first pass it returns a
 * length-1 placeholder for `present.*.encoder.*`, exactly as the real graph does.
 * An engine that trusts it will be caught by the assertions below.
 */
function fakeOnnx(tokenSequence: number[]): {
	module: OnnxModule;
	calls: DecodeCall[];
	released: number;
} {
	const calls: DecodeCall[] = [];
	const state = { released: 0 };
	const ENCODER_FRAMES = 1500;

	const cache = (length: number) =>
		new FakeTensor('float32', new Float32Array(heads * length * headDim), [
			1,
			heads,
			length,
			headDim,
		]);

	const encoder: OnnxSession = {
		inputNames: ['input_features'],
		outputNames: ['last_hidden_state'],
		run: async () => ({
			last_hidden_state: new FakeTensor('float32', new Float32Array(ENCODER_FRAMES * 512), [
				1,
				ENCODER_FRAMES,
				512,
			]),
		}),
		release: async () => {
			state.released += 1;
		},
	};

	const decoder: OnnxSession = {
		inputNames: ['input_ids', 'encoder_hidden_states', 'use_cache_branch'],
		outputNames: ['logits'],
		run: async (feeds) => {
			const idTensor = feeds.input_ids.data as BigInt64Array;
			const inputIds = Array.from(idTensor, (value) => Number(value));
			const useCache = (feeds.use_cache_branch.data as Uint8Array)[0] === 1;
			calls.push({
				inputIds,
				useCache,
				encoderCacheLength: feeds['past_key_values.0.encoder.key'].dims[2],
				decoderCacheLength: feeds['past_key_values.0.decoder.key'].dims[2],
			});

			// One-hot the scripted token for this step so argmax is unambiguous.
			// Full-width on purpose: the end token is id 50256, so a narrow vocabulary
			// could not express "stop" and the loop would never terminate.
			const vocabSize = 51864;
			const step = calls.length - 1;
			const next = tokenSequence[step] ?? WHISPER_EN_SPECIAL_TOKENS.endOfText;
			// A real graph emits one row per input position; only the last is read.
			const positions = inputIds.length;
			const wide = new Float32Array(positions * vocabSize);
			wide[(positions - 1) * vocabSize + next] = 10;

			const outputs: Record<string, OnnxTensor> = {
				logits: new FakeTensor('float32', wide, [1, positions, vocabSize]),
			};
			for (let layer = 0; layer < layers; layer++) {
				outputs[`present.${layer}.decoder.key`] = cache(step + 2);
				outputs[`present.${layer}.decoder.value`] = cache(step + 2);
				// THE trap: real cross-attention KV on the first pass, a length-1
				// placeholder on every pass after it.
				const encoderLength = useCache ? 1 : ENCODER_FRAMES;
				outputs[`present.${layer}.encoder.key`] = cache(encoderLength);
				outputs[`present.${layer}.encoder.value`] = cache(encoderLength);
			}
			return outputs;
		},
		release: async () => {
			state.released += 1;
		},
	};

	const module: OnnxModule = {
		InferenceSession: {
			create: async (path: string) => (path.includes('encoder') ? encoder : decoder),
		},
		Tensor: FakeTensor as unknown as OnnxModule['Tensor'],
	};

	return {
		module,
		calls,
		get released() {
			return state.released;
		},
	};
}

function engineFor(pieces: string[]): WhisperEngine {
	return new WhisperEngine({
		encoderPath: '/models/onnx/encoder_model.onnx',
		decoderPath: '/models/onnx/decoder_model_merged_q4.onnx',
		tokenizerJson: JSON.stringify({ model: { vocab: vocabFor(pieces) } }),
		providerId: 'whisper-local',
	});
}

/** Non-silent audio, so nothing short-circuits on an empty buffer. */
const AUDIO = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10) * 0.2);

describe('WhisperEngine', () => {
	it('keeps the cross-attention cache from the first pass and never overwrites it', async () => {
		// The regression test. Every pass after the first must still see the full
		// 1500-frame encoder cache; seeing the length-1 placeholder means the audio
		// has been dropped and the decoder is inventing.
		const pieces = [' open', ' the', ' auth', ' tab'];
		const fake = fakeOnnx([0, 1, 2, 3]);
		const engine = engineFor(pieces);
		await engine.load(fake.module);
		await engine.transcribe(AUDIO);

		expect(fake.calls.length).toBeGreaterThan(2);
		expect(fake.calls[0].encoderCacheLength).toBe(0);
		for (const call of fake.calls.slice(1)) {
			expect(call.encoderCacheLength).toBe(1500);
		}
	});

	it('grows the decoder cache one token at a time', async () => {
		// The other half of the contract: cross-attention is frozen, self-attention
		// accumulates. Freezing both would stop the model seeing what it just said.
		const fake = fakeOnnx([0, 1, 2, 3]);
		const engine = engineFor([' open', ' the', ' auth', ' tab']);
		await engine.load(fake.module);
		await engine.transcribe(AUDIO);

		const lengths = fake.calls.map((call) => call.decoderCacheLength);
		for (let i = 1; i < lengths.length; i++) {
			expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
		}
	});

	it('primes with start-of-transcript and no-timestamps, then feeds one token a step', async () => {
		const fake = fakeOnnx([0, 1]);
		const engine = engineFor([' hello', ' there']);
		await engine.load(fake.module);
		await engine.transcribe(AUDIO);

		// `noTimestamps` is what makes the model emit words rather than interleaved
		// `<|0.00|>` segment markers.
		expect(fake.calls[0].inputIds).toEqual([
			WHISPER_EN_SPECIAL_TOKENS.startOfTranscript,
			WHISPER_EN_SPECIAL_TOKENS.noTimestamps,
		]);
		expect(fake.calls[0].useCache).toBe(false);
		for (const call of fake.calls.slice(1)) {
			expect(call.inputIds).toHaveLength(1);
			expect(call.useCache).toBe(true);
		}
	});

	it('decodes the generated ids to text and trims it', async () => {
		const fake = fakeOnnx([0, 1, 2, 3]);
		const engine = engineFor([' open', ' the', ' auth', ' tab']);
		await engine.load(fake.module);

		expect(await engine.transcribe(AUDIO)).toBe('open the auth tab');
	});

	it('stops at the end token without emitting it', async () => {
		const fake = fakeOnnx([0, 1, WHISPER_EN_SPECIAL_TOKENS.endOfText, 2]);
		const engine = engineFor([' open', ' the', ' NEVER']);
		await engine.load(fake.module);

		expect(await engine.transcribe(AUDIO)).toBe('open the');
	});

	it('stops at the token ceiling rather than looping forever', async () => {
		// Without a ceiling a model that never emits an end token spins until the
		// process dies. Whisper's positional embedding runs out at 448 anyway.
		// Every step returns token 0, which is a real piece, so nothing ends it.
		const neverEnding = fakeOnnx([0, 0, 0, 0, 0, 0, 0, 0]);
		const looping = new WhisperEngine({
			encoderPath: '/models/onnx/encoder_model.onnx',
			decoderPath: '/models/onnx/decoder_model_merged_q4.onnx',
			tokenizerJson: JSON.stringify({ model: { vocab: vocabFor([' loop']) } }),
			providerId: 'whisper-local',
			maxTokens: 5,
		});
		await looping.load(neverEnding.module);
		await looping.transcribe(AUDIO);
		expect(neverEnding.calls).toHaveLength(5);
	});

	it('returns empty for empty audio without touching the graphs', async () => {
		const fake = fakeOnnx([0]);
		const engine = engineFor([' hello']);
		await engine.load(fake.module);

		expect(await engine.transcribe(new Float32Array(0))).toBe('');
		expect(fake.calls).toHaveLength(0);
	});

	it('refuses to transcribe before it has loaded', async () => {
		const engine = engineFor([' hello']);
		await expect(engine.transcribe(AUDIO)).rejects.toMatchObject({
			kind: 'unavailable',
			providerId: 'whisper-local',
		});
	});

	it('reports a model that will not open as unavailable, pointing at the Models page', async () => {
		const engine = engineFor([' hello']);
		const module: OnnxModule = {
			InferenceSession: {
				create: async () => {
					throw new Error('protobuf parsing failed');
				},
			},
			Tensor: FakeTensor as unknown as OnnxModule['Tensor'],
		};

		await expect(engine.load(module)).rejects.toMatchObject({ kind: 'unavailable' });
		// A half-loaded engine must not look ready afterwards.
		expect(engine.ready).toBe(false);
	});

	it('releases both graphs on unload', async () => {
		const fake = fakeOnnx([0]);
		const engine = engineFor([' hello']);
		await engine.load(fake.module);
		expect(engine.ready).toBe(true);

		await engine.unload();
		expect(engine.ready).toBe(false);
		expect(fake.released).toBe(2);
	});

	it('survives a graph that throws on release', async () => {
		// Teardown must not wedge on a handle the process is about to drop anyway.
		const fake = fakeOnnx([0]);
		const engine = engineFor([' hello']);
		await engine.load(fake.module);
		const decoder = await fake.module.InferenceSession.create('decoder');
		vi.spyOn(decoder, 'release').mockRejectedValue(new Error('already freed'));

		await expect(engine.unload()).resolves.toBeUndefined();
	});
});

describe('WhisperEngine loop guards', () => {
	it('stops a tail that repeats itself and keeps one copy of the phrase', async () => {
		// A six-token phrase, over and over: what the decoder does with a cough.
		const phrase = [1, 2, 3, 4, 5, 6];
		const looping = fakeOnnx([...phrase, ...phrase, ...phrase, ...phrase, ...phrase]);
		const engine = new WhisperEngine({
			encoderPath: '/models/onnx/encoder_model.onnx',
			decoderPath: '/models/onnx/decoder_model_merged_q4.onnx',
			tokenizerJson: JSON.stringify({
				model: { vocab: vocabFor([' zero', ' a', ' b', ' c', ' d', ' e', ' f']) },
			}),
			providerId: 'whisper-local',
		});
		await engine.load(looping.module);

		const text = await engine.transcribe(AUDIO);

		// Three copies is the loop threshold, so it stops at 18 tokens rather than
		// running to the ceiling, and the two extra copies are trimmed off.
		expect(looping.calls.length).toBe(18);
		expect(text).toBe('a b c d e f');
	});

	it('budgets tokens by audio length so noise cannot run to the ceiling', async () => {
		const neverEnding = fakeOnnx(Array.from({ length: 448 }, (_, i) => (i % 40) + 1));
		const engine = new WhisperEngine({
			encoderPath: '/models/onnx/encoder_model.onnx',
			decoderPath: '/models/onnx/decoder_model_merged_q4.onnx',
			tokenizerJson: JSON.stringify({
				model: { vocab: vocabFor(Array.from({ length: 41 }, (_, i) => ` t${i}`)) },
			}),
			providerId: 'whisper-local',
		});
		await engine.load(neverEnding.module);

		// One second of audio: 24 + 12 tokens, not 448.
		await engine.transcribe(AUDIO);
		expect(neverEnding.calls.length).toBe(36);
	});
});
