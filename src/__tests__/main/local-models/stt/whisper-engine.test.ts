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
import generation from '../../../fixtures/whisper-base-generation-config.json';
import { readFile } from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
	readFile: vi.fn(),
}));
vi.mock('../../../../main/local-models/model-store', () => ({
	isInstalled: vi.fn(async () => true),
	modelFilePath: (id: string, relative: string) => `/models/${id}/${relative}`,
}));

import { resolveInstalledSpeechToTextModel } from '../../../../main/local-models/stt/engines';

import {
	WhisperEngine,
	WHISPER_BASE_GEOMETRY,
	type OnnxModule,
	type WhisperEngineOptions,
	type OnnxSession,
	type OnnxTensor,
} from '../../../../main/local-models/stt/whisper/engine';
import {
	WHISPER_EN_SPECIAL_TOKENS,
	WhisperTokenizer,
	WHISPER_MULTILINGUAL_SPECIAL_TOKENS,
} from '../../../../main/local-models/stt/whisper/tokenizer';

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
function fakeOnnx(
	tokenSequence: number[],
	alternatives: readonly (readonly [number, number])[][] = [],
	geometry = WHISPER_BASE_GEOMETRY
): {
	module: OnnxModule;
	calls: DecodeCall[];
	released: number;
} {
	const { layers, heads, headDim } = geometry;
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
			// The actual factory must supply every layer with the checkpoint shape.
			expect(Object.keys(feeds).filter((key) => key.startsWith('past_key_values.'))).toHaveLength(
				layers * 4
			);
			for (let layer = 0; layer < layers; layer++) {
				for (const attention of ['encoder', 'decoder']) {
					for (const part of ['key', 'value']) {
						const tensor = feeds[`past_key_values.${layer}.${attention}.${part}`];
						expect(tensor.dims).toEqual([1, heads, expect.any(Number), headDim]);
						if (attention === 'encoder') expect(tensor.dims[2]).toBe(useCache ? ENCODER_FRAMES : 0);
					}
				}
			}
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
			for (const [id, score] of alternatives[step] ?? [])
				wide[(positions - 1) * vocabSize + id] = score;

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

function tokenizerFor(pieces: string[], options: Partial<WhisperEngineOptions> = {}): string {
	return JSON.stringify({
		model: { vocab: vocabFor(pieces) },
		...(options.specialTokens?.languages
			? {
					added_tokens: [
						{ content: '<|startoftranscript|>', id: 50258 },
						{ content: '<|endoftext|>', id: 50257 },
						{ content: '<|notimestamps|>', id: 50363 },
						{ content: '<|startofprev|>', id: 50361 },
						{ content: '<|transcribe|>', id: 50359 },
						{ content: '<|de|>', id: 50261 },
						{ content: '<|en|>', id: 50259 },
					],
				}
			: {}),
	});
}

function engineFor(pieces: string[], options: Partial<WhisperEngineOptions> = {}): WhisperEngine {
	return new WhisperEngine({
		encoderPath: '/models/onnx/encoder_model.onnx',
		decoderPath: '/models/onnx/decoder_model_merged_q4.onnx',
		tokenizerJson: tokenizerFor(pieces, options),
		consumerId: 'whisper-local',
		...options,
	});
}

/** Non-silent audio, so nothing short-circuits on an empty buffer. */
const AUDIO = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10) * 0.2);

describe('WhisperEngine', () => {
	it('prefixes vocabulary before start-of-transcript and never returns it as recognized speech', async () => {
		const encode = vi.spyOn(WhisperTokenizer.prototype, 'encode').mockReturnValue([33, 34]);
		try {
			const fake = fakeOnnx([0, 1]);
			const engine = engineFor([' actual', ' speech']);
			await engine.load(fake.module);
			expect(await engine.transcribe(AUDIO, { vocabulary: ['🏢 Pedro Sidián'] })).toBe(
				'actual speech'
			);
			expect(encode).toHaveBeenCalledWith(' Pedro Sidián');
			expect(fake.calls[0].inputIds).toEqual([
				WHISPER_EN_SPECIAL_TOKENS.startOfPrevious,
				33,
				34,
				WHISPER_EN_SPECIAL_TOKENS.startOfTranscript,
				WHISPER_EN_SPECIAL_TOKENS.noTimestamps,
			]);
			await engine.unload();
		} finally {
			encode.mockRestore();
		}
	});
	it.each([
		['whisper-base', WHISPER_BASE_GEOMETRY],
		['whisper-small', { layers: 12, heads: 12, headDim: 64 }],
	] as const)(
		'preserves name hints with both languages through the %s factory',
		async (modelId, geometry) => {
			const encode = vi.spyOn(WhisperTokenizer.prototype, 'encode').mockReturnValue([33, 34]);
			try {
				for (const [language, languageToken] of [
					['de', 50261],
					['en', 50259],
				] as const) {
					vi.mocked(readFile).mockResolvedValue(
						tokenizerFor([' hello', ' unused', ' other', ' there'], {
							specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS,
						})
					);
					const model = await resolveInstalledSpeechToTextModel(modelId, 'dictation');
					const engine = await model.createEngine();
					const fake = fakeOnnx([0, 3, 50257], [], geometry);
					await engine.load(fake.module);
					try {
						await expect(
							engine.transcribe(AUDIO, { language, vocabulary: ['🏢 Pedro Sidián'] })
						).resolves.toBe('hello there');
						expect(fake.calls[0].inputIds).toEqual([
							generation.prev_sot_token_id,
							33,
							34,
							50258,
							languageToken,
							50359,
							50363,
						]);
						expect(encode).toHaveBeenLastCalledWith(' Pedro Sidián');
					} finally {
						await engine.unload();
					}
				}
			} finally {
				encode.mockRestore();
			}
		}
	);
	it.each([
		['whisper-base-en', WHISPER_BASE_GEOMETRY, 'en', [50257, 50362], 50256],
		['whisper-base', WHISPER_BASE_GEOMETRY, 'de', [50258, 50261, 50359, 50363], 50257],
		[
			'whisper-small',
			{ layers: 12, heads: 12, headDim: 64 },
			'de',
			[50258, 50261, 50359, 50363],
			50257,
		],
	] as const)(
		'loads %s through the factory with its geometry and language rules',
		async (modelId, geometry, language, prompt, eos) => {
			const multilingual = modelId !== 'whisper-base-en';
			vi.mocked(readFile).mockResolvedValue(
				tokenizerFor(
					[' hello', ' unused', ' other', ' there'],
					multilingual ? { specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS } : {}
				)
			);
			const model = await resolveInstalledSpeechToTextModel(modelId, 'dictation');
			const engine = await model.createEngine();
			const fake = fakeOnnx(
				[0, 3, eos],
				multilingual
					? [
							[
								[220, 30],
								[50257, 29],
								[50358, 28],
							],
							[[50358, 29]],
						]
					: [],
				geometry
			);
			const create = vi.spyOn(fake.module.InferenceSession, 'create');
			await engine.load(fake.module);
			try {
				await expect(engine.transcribe(AUDIO, { language })).resolves.toBe('hello there');
				expect(fake.calls[0].inputIds).toEqual(prompt);
				expect(fake.calls.map((call) => call.useCache)).toEqual([false, true, true]);
				expect(create.mock.calls.map((call) => call[0])).toEqual([
					`/models/${modelId}/onnx/encoder_model.onnx`,
					`/models/${modelId}/onnx/decoder_model_merged_q4.onnx`,
				]);
			} finally {
				await engine.unload();
			}
			expect(fake.released).toBe(2);
		}
	);

	it.each(['repeat', 'budget', 'cancel'] as const)(
		'enforces %s through the Small factory and permits reuse',
		async (boundary) => {
			const pieces = Array.from({ length: 5060 }, (_, i) => ` word${i}`);
			vi.mocked(readFile).mockResolvedValue(
				tokenizerFor(pieces, { specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS })
			);
			const model = await resolveInstalledSpeechToTextModel('whisper-small', 'dictation');
			const engine = await model.createEngine();
			const sequence =
				boundary === 'budget'
					? Array.from({ length: 60 }, (_, i) => 5000 + i)
					: boundary === 'cancel'
						? [5000, 5000, 5000, 50257]
						: Array(12).fill(5000);
			const fake = fakeOnnx(sequence, [], { layers: 12, heads: 12, headDim: 64 });
			const controller = new AbortController();
			let finish!: () => void;
			let cancelBoundaryHeld = false;
			let entered!: () => void;
			const inFlight = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const create = fake.module.InferenceSession.create;
			fake.module.InferenceSession.create = async (file, options) => {
				const session = await create(file, options);
				if (boundary === 'cancel' && file.includes('decoder')) {
					const run = session.run.bind(session);
					session.run = async (feeds) => {
						const output = await run(feeds);
						if ((feeds.use_cache_branch.data as Uint8Array)[0] === 1 && !cancelBoundaryHeld) {
							cancelBoundaryHeld = true;
							entered();
							await new Promise<void>((resolve) => {
								finish = resolve;
							});
						}
						return output;
					};
				}
				return session;
			};
			await engine.load(fake.module);
			try {
				const decoding = engine.transcribe(AUDIO, { language: 'de', signal: controller.signal });
				if (boundary === 'cancel') {
					const rejection = expect(decoding).rejects.toMatchObject({ code: 'cancelled' });
					await inFlight;
					controller.abort();
					let settled = false;
					void decoding.then(
						() => {
							settled = true;
						},
						() => {
							settled = true;
						}
					);
					await Promise.resolve();
					expect(settled).toBe(false);
					finish();
					await rejection;
					expect(fake.calls).toHaveLength(2);
					// A new invocation resets caches and does not inherit the cancelled signal.
					await expect(engine.transcribe(AUDIO, { language: 'en' })).resolves.toBe('word5000');
					expect(fake.calls[2].inputIds).toEqual([50258, 50259, 50359, 50363]);
					expect(fake.calls[2].useCache).toBe(false);
				} else {
					await expect(decoding).resolves.toContain('word5000');
					expect(fake.calls).toHaveLength(boundary === 'repeat' ? 8 : 36);
				}
			} finally {
				await engine.unload();
			}
			expect(fake.released).toBe(2);
		}
	);

	it('lets cancellation run during mel preparation before opening native inference', async () => {
		const fake = fakeOnnx([0, WHISPER_EN_SPECIAL_TOKENS.endOfText]);
		const create = fake.module.InferenceSession.create;
		const encoderRun = vi.fn();
		fake.module.InferenceSession.create = async (file, options) => {
			const session = await create(file, options);
			if (file.includes('encoder')) {
				const run = session.run.bind(session);
				session.run = async (feeds) => {
					encoderRun();
					return run(feeds);
				};
			}
			return session;
		};
		const engine = engineFor([' test']);
		await engine.load(fake.module);
		const controller = new AbortController();
		const cancellation = setImmediate(() => controller.abort());
		try {
			await expect(engine.transcribe(AUDIO, { signal: controller.signal })).rejects.toMatchObject({
				code: 'cancelled',
			});
			expect(encoderRun).not.toHaveBeenCalled();
		} finally {
			clearImmediate(cancellation);
			await engine.unload();
		}
	});

	it('primes multilingual German transcription with the checkpoint tokens, never translation', async () => {
		// Independently pinned generation_config.json: onnx-community/whisper-base
		// 1846881b6b3a3024392c1eea3ad983695bc23925 (not the .en checkpoint).
		const fake = fakeOnnx([0, 50257]);
		const engine = engineFor([' GrÃ¼ÃŁe'], {
			specialTokens: {
				startOfTranscript: 50258,
				endOfText: 50257,
				noTimestamps: 50363,
				transcribe: 50359,
				languages: { de: 50261, en: 50259 },
			},
		});
		await engine.load(fake.module);
		await expect(engine.transcribe(AUDIO, { language: 'de' })).resolves.toBe('Grüße');
		expect(fake.calls[0].inputIds).toEqual([50258, 50261, 50359, 50363]);
		expect(fake.calls[0].inputIds).not.toContain(50358);
	});

	it('uses the exact pinned multilingual generation exclusions', () => {
		// Exporter fixture@1846881b; original bytes SHA25661070cf8de25b1e9… (formatted).
		expect(WHISPER_MULTILINGUAL_SPECIAL_TOKENS.suppressTokens).toEqual(generation.suppress_tokens);
		expect(WHISPER_MULTILINGUAL_SPECIAL_TOKENS.beginSuppressTokens).toEqual(
			generation.begin_suppress_tokens
		);
		expect(WHISPER_MULTILINGUAL_SPECIAL_TOKENS.startOfPrevious).toBe(generation.prev_sot_token_id);
	});

	it('rejects mismatched multilingual vocabulary-context tokens before opening graphs', async () => {
		const definition = JSON.parse(
			tokenizerFor([' hello'], { specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS })
		);
		definition.added_tokens.find(
			(token: { content: string }) => token.content === '<|startofprev|>'
		).id = 50360;
		const fake = fakeOnnx([0]);
		const create = vi.spyOn(fake.module.InferenceSession, 'create');
		const engine = engineFor([' hello'], {
			specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS,
			tokenizerJson: JSON.stringify(definition),
		});
		await expect(engine.load(fake.module)).rejects.toMatchObject({ code: 'generation-failed' });
		expect(create).not.toHaveBeenCalled();
	});

	it('honors the pinned multilingual suppression rules at the transcription boundary', async () => {
		// generation_config.json@1846881b: blank220 and EOS50257 only at begin;
		// punctuation1 and translate50358 are forbidden on every generated step.
		// Blank and EOS must become legal after the first generated token.
		const fake = fakeOnnx(
			[220, 1, 50257],
			[
				[
					[220, 30],
					[50257, 29],
					[1, 28],
					[0, 20],
				],
				[
					[1, 30],
					[50358, 29],
					[220, 20],
				],
			]
		);
		const engine = engineFor([' hello', ' unwanted'], {
			specialTokens: WHISPER_MULTILINGUAL_SPECIAL_TOKENS,
		});
		await engine.load(fake.module);
		try {
			await expect(engine.transcribe(AUDIO, { language: 'de' })).resolves.toBe('hello');
			expect(fake.calls.map((call) => call.inputIds)).toEqual([
				[50258, 50261, 50359, 50363],
				[0],
				[220],
			]);
		} finally {
			await engine.unload();
		}
	});

	it('refuses German on an English checkpoint before inference', async () => {
		const fake = fakeOnnx([0]);
		const engine = engineFor([' hello']);
		await engine.load(fake.module);
		await expect(engine.transcribe(AUDIO, { language: 'de' })).rejects.toMatchObject({
			code: 'model-unsupported',
		});
		expect(fake.calls).toHaveLength(0);
	});

	it('bounds native Whisper sessions to two CPU threads', async () => {
		const fake = fakeOnnx([0]);
		const create = vi.spyOn(fake.module.InferenceSession, 'create');
		await engineFor([' hello']).load(fake.module);
		for (const call of create.mock.calls)
			expect(call[1]).toEqual({
				intraOpNumThreads: 2,
				interOpNumThreads: 1,
				executionMode: 'sequential',
			});
	});

	it('rejects a multilingual checkpoint with English special-token numbering before opening graphs', async () => {
		const fake = fakeOnnx([0]);
		const create = vi.spyOn(fake.module.InferenceSession, 'create');
		const engine = engineFor([' hello'], {
			tokenizerJson: JSON.stringify({ model: { vocab: { '<|startoftranscript|>': 50257 } } }),
			specialTokens: {
				startOfTranscript: 50258,
				endOfText: 50257,
				noTimestamps: 50363,
				transcribe: 50359,
				languages: { de: 50261, en: 50259 },
			},
		});
		await expect(engine.load(fake.module)).rejects.toMatchObject({ code: 'generation-failed' });
		expect(create).not.toHaveBeenCalled();
	});

	it('does not decode when already cancelled', async () => {
		const fake = fakeOnnx([0]);
		const engine = engineFor([' hello']);
		await engine.load(fake.module);
		const abort = new AbortController();
		abort.abort();
		await expect(engine.transcribe(AUDIO, { signal: abort.signal })).rejects.toMatchObject({
			code: 'cancelled',
		});
		expect(fake.calls).toHaveLength(0);
	});

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
			consumerId: 'whisper-local',
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
			name: 'LocalModelError',
			code: 'generation-failed',
			consumerId: 'whisper-local',
		});
	});

	it('reports a model that will not open as a failed model, pointing at where to verify it', async () => {
		const engine = engineFor([' hello']);
		const module: OnnxModule = {
			InferenceSession: {
				create: async () => {
					throw new Error('protobuf parsing failed');
				},
			},
			Tensor: FakeTensor as unknown as OnnxModule['Tensor'],
		};

		await expect(engine.load(module)).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'generation-failed',
			recovery: expect.stringContaining('Verify or re-download'),
		});
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
			consumerId: 'whisper-local',
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
			consumerId: 'whisper-local',
		});
		await engine.load(neverEnding.module);

		// One second of audio: 24 + 12 tokens, not 448.
		await engine.transcribe(AUDIO);
		expect(neverEnding.calls.length).toBe(36);
	});
});
