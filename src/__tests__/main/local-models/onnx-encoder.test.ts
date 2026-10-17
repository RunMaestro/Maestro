/**
 * @file onnx-encoder.test.ts
 *
 * The shared ONNX encoder pool. Properties worth protecting:
 *
 *   - **One session per model**, opened once and reused.
 *   - **Idle unload frees the session**, and a call that lands before the
 *     timer fires keeps it alive.
 *   - **Failures are classified and name the model**; a runtime refusal passes
 *     through untouched (no other engine is tried).
 *   - **Refusals for a model of the wrong kind** come from the catalog lookup.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-onnx-encoder-test' } }));

const store = vi.hoisted(() => ({ installed: true }));
vi.mock('../../../main/local-models/model-store', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/model-store')>()),
	isInstalled: vi.fn(async () => store.installed),
}));

import {
	encoderFeeds,
	OnnxEncoderPool,
	resolveInstalledEncoder,
	type InstalledEncoder,
} from '../../../main/local-models/onnx-encoder';
import { LocalModelError } from '../../../main/local-models/errors';
import type { LocalTokenizer } from '../../../main/local-models/tokenizer';
import {
	BGE_SMALL_EN_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
} from '../../../shared/local-models/model-catalog';

const installed = { entry: { displayName: 'Fake Encoder' } } as unknown as InstalledEncoder;
const tokenizer = {} as LocalTokenizer;

function makePool(overrides: { create?: () => Promise<unknown>; idleUnloadMs?: number } = {}) {
	const session = { inputNames: [], outputNames: [], run: vi.fn(), release: vi.fn(async () => {}) };
	const create = vi.fn(overrides.create ?? (async () => session));
	const pool = new OnnxEncoderPool({
		idleUnloadMs: overrides.idleUnloadMs ?? 0,
		resolveModel: async () => installed,
		loadRuntime: (async () => ({ InferenceSession: { create }, Tensor: class {} })) as never,
		loadTokenizer: async () => tokenizer,
	});
	return { pool, session, create };
}

afterEach(() => {
	vi.useRealTimers();
	store.installed = true;
});

describe('OnnxEncoderPool', () => {
	it('opens a model once and reuses the session', async () => {
		const { pool, create, session } = makePool();
		const seen: unknown[] = [];
		await pool.run('m', 'embedding', 'test', async (encoder) => seen.push(encoder.session));
		await pool.run('m', 'embedding', 'test', async (encoder) => seen.push(encoder.session));
		expect(create).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([session, session]);
		expect(pool.loadedModelIds).toEqual(['m']);
	});

	it('frees the session after the idle window, and a later call reopens it', async () => {
		vi.useFakeTimers();
		const { pool, create, session } = makePool({ idleUnloadMs: 1000 });
		await pool.run('m', 'embedding', 'test', async () => {});

		await vi.advanceTimersByTimeAsync(999);
		expect(session.release).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(session.release).toHaveBeenCalledTimes(1);
		expect(pool.loadedModelIds).toEqual([]);

		await pool.run('m', 'embedding', 'test', async () => {});
		expect(create).toHaveBeenCalledTimes(2);
	});

	it('restarts the idle clock on every call', async () => {
		vi.useFakeTimers();
		const { pool, session } = makePool({ idleUnloadMs: 1000 });
		await pool.run('m', 'embedding', 'test', async () => {});
		await vi.advanceTimersByTimeAsync(800);
		await pool.run('m', 'embedding', 'test', async () => {});
		await vi.advanceTimersByTimeAsync(800);
		expect(session.release).not.toHaveBeenCalled();
	});

	it('unloads on request', async () => {
		const { pool, session } = makePool();
		await pool.run('m', 'embedding', 'test', async () => {});
		await pool.unload();
		expect(session.release).toHaveBeenCalledTimes(1);
		expect(pool.loadedModelIds).toEqual([]);
	});

	it('classifies a graph that will not open, naming the model, and caches nothing', async () => {
		const { pool, create } = makePool({
			create: async () => {
				throw new Error('protobuf parse failed');
			},
		});

		const error = await pool.run('m', 'embedding', 'test', async () => {}).catch((e) => e);

		expect(error).toBeInstanceOf(LocalModelError);
		expect(error).toMatchObject({ code: 'generation-failed', consumerId: 'test' });
		expect(error.message).toBe('Fake Encoder could not be opened.');
		await pool.run('m', 'embedding', 'test', async () => {}).catch(() => {});
		expect(create).toHaveBeenCalledTimes(2);
	});

	it('passes a runtime refusal through untouched', async () => {
		const refusal = new LocalModelError('ONNX Runtime is not downloaded yet.', {
			code: 'runtime-unavailable',
			recovery: 'Download it.',
			consumerId: 'test',
		});
		const pool = new OnnxEncoderPool({
			resolveModel: async () => installed,
			loadRuntime: (async () => {
				throw refusal;
			}) as never,
		});
		await expect(pool.run('m', 'embedding', 'test', async () => {})).rejects.toBe(refusal);
	});
});

describe('resolveInstalledEncoder', () => {
	it('locates an installed embedding model from its run spec', async () => {
		const resolved = await resolveInstalledEncoder(BGE_SMALL_EN_ID, 'embedding', 'test');
		expect(resolved.modelPath.endsWith('onnx/model_quantized.onnx')).toBe(true);
		expect(resolved.spec.outputName).toBe('last_hidden_state');
	});

	it('refuses a model of another kind by name', async () => {
		await expect(resolveInstalledEncoder(QWEN3_1_7B_ID, 'embedding', 'test')).rejects.toMatchObject(
			{
				code: 'model-unsupported',
			}
		);
		await expect(
			resolveInstalledEncoder(PROMPT_GUARD_2_22M_ID, 'embedding', 'test')
		).rejects.toMatchObject({ code: 'model-unsupported' });
	});

	it('refuses a model that is not downloaded', async () => {
		store.installed = false;
		await expect(
			resolveInstalledEncoder(BGE_SMALL_EN_ID, 'embedding', 'test')
		).rejects.toMatchObject({
			code: 'model-not-installed',
			message: 'BGE Small (English) is not downloaded.',
		});
	});
});

describe('encoderFeeds', () => {
	it('refuses an input it cannot build, by name', () => {
		const encoder = {
			session: { inputNames: ['input_ids', 'pixel_values'] },
			ort: { Tensor: class {} },
			entry: { displayName: 'Odd Model' },
		} as never;
		const tokens = {
			batchSize: 1,
			sequenceLength: 1,
			inputIds: BigInt64Array.from([1n]),
			attentionMask: BigInt64Array.from([1n]),
		};
		expect(() => encoderFeeds(encoder, tokens, 'test')).toThrow(
			'Odd Model expects an input "pixel_values" Maestro cannot provide.'
		);
	});
});
