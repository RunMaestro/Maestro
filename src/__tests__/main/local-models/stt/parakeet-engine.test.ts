/**
 * @file parakeet-engine.test.ts
 *
 * The Token-and-Duration Transducer greedy loop, driven against a fake ONNX
 * Runtime that replays a scripted joint output per call.
 *
 * Three properties carry the whole decoder, and each is easy to get subtly
 * wrong while every graph loads cleanly and the output still looks like text:
 *
 *   - The prediction network's LSTM state advances ONLY on an emitted token. A
 *     blank must hand the old state back in, or the decoder forgets what it said.
 *   - The duration head moves the frame pointer; a zero duration stays on the
 *     frame and emits again, capped so one frame cannot loop forever.
 *   - The encoder output is channel-major (`[1, D, T]`), so frame `t` is every
 *     D-th value from offset `t`, not a contiguous slice.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	ParakeetEngine,
	detokenizeParakeet,
	parseParakeetVocab,
} from '../../../../main/local-models/stt/parakeet/engine';
import type {
	OnnxModule,
	OnnxSession,
	OnnxTensor,
	OnnxTensorData,
} from '../../../../main/local-models/runtime/onnx-types';

class FakeTensor implements OnnxTensor {
	constructor(
		readonly type: string,
		readonly data: OnnxTensorData,
		readonly dims: readonly number[]
	) {}
}

/** `<unk>`, three word pieces, and the blank, in `vocab.txt` order. */
const VOCAB_TEXT = ['<unk> 0', '▁open 1', '▁the 2', '▁tab 3', '<blk> 4'].join('\n');
const VOCAB_SIZE = 5;
const BLANK = 4;
/** This checkpoint's durations are 0..4. */
const DURATIONS = 5;
const WIDTH = 3;

/** One scripted joint step: which token wins and how far to move. */
interface Step {
	token: number;
	duration: number;
}

interface JointCall {
	frame: number[];
	previousToken: number;
	/** The first value of `input_states_1`, which the fake stamps with a step counter. */
	stateMarker: number;
}

function fakeOnnx(frames: number, steps: Step[]) {
	const calls: JointCall[] = [];
	let released = 0;
	let stepIndex = 0;

	const session = (run: OnnxSession['run']): OnnxSession => ({
		inputNames: [],
		outputNames: [],
		run,
		release: async () => {
			released += 1;
		},
	});

	const preprocessor = session(async (feeds) => {
		const samples = (feeds.waveforms.data as Float32Array).length;
		return {
			features: new FakeTensor('float32', new Float32Array(128 * 4), [1, 128, 4]),
			features_lens: new FakeTensor('int64', BigInt64Array.from([BigInt(samples)]), [1]),
		};
	});

	// Channel-major `[1, WIDTH, frames]`: value (d, t) = t * 10 + d, so a frame
	// gathered correctly reads [t*10, t*10+1, t*10+2].
	const encoder = session(async () => {
		const data = new Float32Array(WIDTH * frames);
		for (let d = 0; d < WIDTH; d++) {
			for (let t = 0; t < frames; t++) data[d * frames + t] = t * 10 + d;
		}
		return {
			outputs: new FakeTensor('float32', data, [1, WIDTH, frames]),
			encoded_lengths: new FakeTensor('int64', BigInt64Array.from([BigInt(frames)]), [1]),
		};
	});

	const decoderJoint = session(async (feeds) => {
		const step = steps[stepIndex] ?? { token: BLANK, duration: 1 };
		stepIndex += 1;
		calls.push({
			frame: Array.from(feeds.encoder_outputs.data as Float32Array),
			previousToken: (feeds.targets.data as Int32Array)[0],
			stateMarker: (feeds.input_states_1.data as Float32Array)[0],
		});
		const outputs = new Float32Array(VOCAB_SIZE + DURATIONS);
		outputs[step.token] = 10;
		outputs[VOCAB_SIZE + step.duration] = 10;
		// A fresh state stamped with this call's index, so the test can see which
		// state the NEXT call was handed.
		const nextState = new Float32Array(2 * 640);
		nextState[0] = stepIndex;
		return {
			outputs: new FakeTensor('float32', outputs, [1, 1, 1, VOCAB_SIZE + DURATIONS]),
			output_states_1: new FakeTensor('float32', nextState, [2, 1, 640]),
			output_states_2: new FakeTensor('float32', nextState, [2, 1, 640]),
		};
	});

	const byPath: Record<string, OnnxSession> = {
		pre: preprocessor,
		enc: encoder,
		dec: decoderJoint,
	};
	const module: OnnxModule = {
		InferenceSession: { create: async (path: string) => byPath[path] },
		Tensor: FakeTensor as unknown as OnnxModule['Tensor'],
	};
	return { module, calls, released: () => released };
}

function engine(options: { maxTokensPerStep?: number } = {}) {
	return new ParakeetEngine({
		preprocessorPath: 'pre',
		encoderPath: 'enc',
		decoderJointPath: 'dec',
		vocabText: VOCAB_TEXT,
		consumerId: 'parakeet-local',
		...options,
	});
}

describe('parseParakeetVocab', () => {
	it('indexes tokens by their id and finds the blank', () => {
		const { tokens, blank } = parseParakeetVocab(VOCAB_TEXT);
		expect(tokens).toEqual(['<unk>', '▁open', '▁the', '▁tab', '<blk>']);
		expect(blank).toBe(BLANK);
	});

	it('refuses a vocabulary with no blank', () => {
		expect(() => parseParakeetVocab('<unk> 0\n▁a 1')).toThrow(/<blk>/);
	});
});

describe('detokenizeParakeet', () => {
	it('turns word-boundary markers into single spaces', () => {
		expect(detokenizeParakeet(['▁Open', '▁the', '▁Ac', 'ap', 'ella', '.'])).toBe(
			'Open the Acapella.'
		);
	});
});

describe('ParakeetEngine', () => {
	it('bounds all native sessions and rejects cancellation before inference', async () => {
		const fake = fakeOnnx(1, []);
		const create = vi.spyOn(fake.module.InferenceSession, 'create');
		const recogniser = engine();
		await recogniser.load(fake.module);
		expect(create).toHaveBeenCalledTimes(3);
		for (const call of create.mock.calls)
			expect(call[1]).toEqual({
				intraOpNumThreads: 2,
				interOpNumThreads: 1,
				executionMode: 'sequential',
			});
		const abort = new AbortController();
		abort.abort();
		await expect(
			recogniser.transcribe(new Float32Array(16000), { signal: abort.signal })
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(fake.calls).toHaveLength(0);
	});

	it('decodes tokens, follows the duration head, and gathers channel-major frames', async () => {
		const fake = fakeOnnx(4, [
			{ token: 1, duration: 0 }, // "open", stay on frame 0
			{ token: 2, duration: 2 }, // "the", jump to frame 2
			{ token: BLANK, duration: 1 }, // nothing on frame 2
			{ token: 3, duration: 1 }, // "tab" on frame 3, then past the end
		]);
		const parakeet = engine();
		await parakeet.load(fake.module);

		expect(await parakeet.transcribe(new Float32Array(1600))).toBe('open the tab');

		expect(fake.calls.map((call) => call.frame)).toEqual([
			[0, 1, 2],
			[0, 1, 2],
			[20, 21, 22],
			[30, 31, 32],
		]);
		// Each call is primed with the last EMITTED token, the blank before any.
		expect(fake.calls.map((call) => call.previousToken)).toEqual([BLANK, 1, 2, 2]);
	});

	it('advances the prediction state only on an emitted token', async () => {
		const fake = fakeOnnx(3, [
			{ token: 1, duration: 1 }, // emits: state from call 1 carries forward
			{ token: BLANK, duration: 1 }, // blank: state from call 2 is discarded
			{ token: 2, duration: 1 },
		]);
		const parakeet = engine();
		await parakeet.load(fake.module);
		await parakeet.transcribe(new Float32Array(1600));

		expect(fake.calls.map((call) => call.stateMarker)).toEqual([0, 1, 1]);
	});

	it('forces the pointer forward when one frame keeps emitting', async () => {
		// A degenerate frame that never asks to move: without the cap this loops.
		const fake = fakeOnnx(
			1,
			Array.from({ length: 50 }, () => ({ token: 1, duration: 0 }))
		);
		const parakeet = engine({ maxTokensPerStep: 3 });
		await parakeet.load(fake.module);

		expect(await parakeet.transcribe(new Float32Array(1600))).toBe('open open open');
		expect(fake.calls).toHaveLength(3);
	});

	it('returns nothing for empty audio without running a graph', async () => {
		const fake = fakeOnnx(4, []);
		const parakeet = engine();
		await parakeet.load(fake.module);

		expect(await parakeet.transcribe(new Float32Array(0))).toBe('');
		expect(fake.calls).toHaveLength(0);
	});

	it('refuses to transcribe before it loads, as itself', async () => {
		await expect(engine().transcribe(new Float32Array(16))).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'generation-failed',
			consumerId: 'parakeet-local',
		});
	});

	it('classifies a graph that will not open as a failed model, and releases the rest', async () => {
		const fake = fakeOnnx(1, []);
		const module: OnnxModule = {
			...fake.module,
			InferenceSession: {
				create: async (path: string) => {
					if (path === 'dec') throw new Error('bad graph');
					return fake.module.InferenceSession.create(path);
				},
			},
		};
		const parakeet = engine();

		await expect(parakeet.load(module)).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'generation-failed',
			consumerId: 'parakeet-local',
			recovery: expect.stringContaining('Verify or re-download'),
		});
		expect(parakeet.ready).toBe(false);
		// The preprocessor and encoder that DID open are not leaked.
		expect(fake.released()).toBe(2);
	});

	it('releases every graph on unload', async () => {
		const fake = fakeOnnx(1, []);
		const parakeet = engine();
		await parakeet.load(fake.module);
		await parakeet.unload();

		expect(fake.released()).toBe(3);
		expect(parakeet.ready).toBe(false);
	});
});
