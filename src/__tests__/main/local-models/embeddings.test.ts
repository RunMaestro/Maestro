/**
 * @file embeddings.test.ts
 *
 * The embedding service with ONNX Runtime faked and the real bge-small
 * tokenizer fixture in front of it. Properties worth protecting:
 *
 *   - **Pooling follows the run spec.** `cls` takes position 0, `mean` averages
 *     only the masked-in positions (padding must not drag the vector), and
 *     `graph` reads the already-pooled output as is.
 *   - **Every vector is unit length**, from a local model and an endpoint alike.
 *   - **Batching**: local runs go 16 texts at a time, endpoint requests 64, and
 *     the output keeps input order.
 *   - **Prefixes**: a model trained with query/document prefixes gets the right
 *     one; an endpoint model gets none.
 *   - **No fallback**: a failure is classified and names the model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-embeddings-test' } }));

const endpoint = vi.hoisted(() => ({ embedWithLocalModelEndpoint: vi.fn() }));
vi.mock('../../../main/local-models/endpoint-service', () => endpoint);

import {
	EMBED_BATCH_SIZE,
	ENDPOINT_EMBED_BATCH_SIZE,
	embedTexts,
	l2Normalize,
	poolEmbeddings,
} from '../../../main/local-models/embeddings';
import {
	__setOnnxEncoderPool,
	OnnxEncoderPool,
	type InstalledEncoder,
} from '../../../main/local-models/onnx-encoder';
import {
	clearTokenizerCache,
	loadTokenizer,
	type LocalTokenizer,
} from '../../../main/local-models/tokenizer';
import { LocalModelError } from '../../../main/local-models/errors';
import type { OnnxTensor, OnnxTensorData } from '../../../main/local-models/runtime/onnx-types';
import type { LocalEmbeddingSpec, LocalModelEntry } from '../../../shared/local-models/types';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/tokenizers/bge-small-en-v1.5');
const WIDTH = 3;

class FakeTensor implements OnnxTensor {
	constructor(
		readonly type: string,
		readonly data: OnnxTensorData,
		readonly dims: readonly number[]
	) {}
}

function tensor(data: number[], dims: number[]): OnnxTensor {
	return { data: Float32Array.from(data), dims };
}

const norm = (vector: Float32Array) => Math.hypot(...Array.from(vector));

/**
 * A fake graph. Token states are `[inputId, position + 1, 1]`, so CLS pooling
 * yields `[101, 1, 1]` and mean pooling is checkable by hand. In `graph` mode
 * it emits `[batch, WIDTH]` directly.
 */
function fakeSession(spec: LocalEmbeddingSpec, inputNames: string[]) {
	const runs: Record<string, FakeTensor>[] = [];
	const session = {
		inputNames,
		outputNames: [spec.outputName],
		release: vi.fn(async () => {}),
		run: vi.fn(async (feeds: Record<string, OnnxTensor>) => {
			runs.push(feeds as Record<string, FakeTensor>);
			const ids = feeds.input_ids;
			const [batch, sequence] = ids.dims;
			if (spec.pooling === 'graph') {
				const out: number[] = [];
				for (let row = 0; row < batch; row++) out.push(row + 1, 2, 2);
				return { [spec.outputName]: tensor(out, [batch, WIDTH]) };
			}
			const out: number[] = [];
			for (let row = 0; row < batch; row++) {
				for (let position = 0; position < sequence; position++) {
					out.push(Number((ids.data as BigInt64Array)[row * sequence + position]), position + 1, 1);
				}
			}
			return { [spec.outputName]: tensor(out, [batch, sequence, WIDTH]) };
		}),
	};
	return { session, runs };
}

function entryFor(spec: LocalEmbeddingSpec): LocalModelEntry {
	return {
		id: 'fake-embed',
		displayName: 'Fake Embed',
		kind: 'embedding',
		runtime: 'onnx',
		source: { repo: 'x/y', revision: 'a'.repeat(40) },
		license: { spdx: 'MIT', url: '' },
		description: '',
		goodAt: '',
		files: [],
		bytes: 0,
		embedding: spec,
	};
}

function baseSpec(overrides: Partial<LocalEmbeddingSpec> = {}): LocalEmbeddingSpec {
	return {
		modelFile: 'model.onnx',
		tokenizerDir: '',
		maxTokens: 512,
		outputName: 'last_hidden_state',
		dimensions: WIDTH,
		pooling: 'cls',
		normalize: true,
		...overrides,
	};
}

/** Install a pool whose model is `spec`, run by a fake session. */
async function installPool(
	spec: LocalEmbeddingSpec,
	inputNames = ['input_ids', 'attention_mask', 'token_type_ids']
) {
	const { session, runs } = fakeSession(spec, inputNames);
	const real = await loadTokenizer(FIXTURE_DIR);
	const encodedTexts: string[][] = [];
	const tokenizer: LocalTokenizer = {
		...real,
		encode: real.encode,
		encodeBatch: (texts, options) => {
			encodedTexts.push([...texts]);
			return real.encodeBatch(texts, options);
		},
	};
	const installed: InstalledEncoder = {
		entry: entryFor(spec),
		spec,
		modelPath: '/models/fake/model.onnx',
		tokenizerDir: FIXTURE_DIR,
	};
	const create = vi.fn(async () => session);
	const pool = new OnnxEncoderPool({
		idleUnloadMs: 0,
		resolveModel: async () => installed,
		loadRuntime: (async () => ({
			InferenceSession: { create },
			Tensor: FakeTensor,
		})) as never,
		loadTokenizer: async () => tokenizer,
	});
	__setOnnxEncoderPool(pool);
	return { session, runs, encodedTexts, create };
}

const LOCAL = { type: 'local', modelId: 'fake-embed' } as const;

beforeEach(() => {
	clearTokenizerCache();
	endpoint.embedWithLocalModelEndpoint.mockReset();
});

afterEach(() => __setOnnxEncoderPool(null));

describe('embedTexts on a local model', () => {
	it('CLS-pools position 0 and normalizes', async () => {
		await installPool(baseSpec({ pooling: 'cls' }));

		const [vector] = await embedTexts(LOCAL, ['Hello, World!'], { mode: 'document' });

		const expected = l2Normalize(Float32Array.from([101, 1, 1]));
		expect(Array.from(vector)).toEqual(Array.from(expected));
		expect(norm(vector)).toBeCloseTo(1, 6);
	});

	it('mean-pools only the masked-in positions, so padding does not move the vector', async () => {
		await installPool(baseSpec({ pooling: 'mean' }));

		// "Hello, World!" is 6 tokens, padded to 10 beside the longer text.
		const [short] = await embedTexts(LOCAL, ['Hello, World!', 'How do I rename a tab?'], {
			mode: 'document',
		});
		const [alone] = await embedTexts(LOCAL, ['Hello, World!'], { mode: 'document' });

		// ids 101 7592 1010 2088 999 102, positions 1..6.
		const mean = [(101 + 7592 + 1010 + 2088 + 999 + 102) / 6, 3.5, 1];
		const expected = l2Normalize(Float32Array.from(mean));
		Array.from(short).forEach((value, i) => expect(value).toBeCloseTo(expected[i], 5));
		Array.from(alone).forEach((value, i) => expect(value).toBeCloseTo(short[i], 6));
	});

	it('reads a graph-pooled output as is, then normalizes it', async () => {
		await installPool(baseSpec({ pooling: 'graph', outputName: 'sentence_embedding' }), [
			'input_ids',
			'attention_mask',
		]);

		const vectors = await embedTexts(LOCAL, ['a', 'b'], { mode: 'document' });

		expect(Array.from(vectors[0])).toEqual(Array.from(l2Normalize(Float32Array.from([1, 2, 2]))));
		expect(Array.from(vectors[1])).toEqual(Array.from(l2Normalize(Float32Array.from([2, 2, 2]))));
	});

	it('feeds only the inputs the graph declares, zero-filling segment ids', async () => {
		const { runs } = await installPool(baseSpec(), ['input_ids', 'attention_mask']);
		await embedTexts(LOCAL, ['a'], { mode: 'query' });
		expect(Object.keys(runs[0]).sort()).toEqual(['attention_mask', 'input_ids']);

		const withTypes = await installPool(baseSpec());
		await embedTexts(LOCAL, ['a'], { mode: 'query' });
		const typeIds = withTypes.runs[0].token_type_ids;
		expect(typeIds.type).toBe('int64');
		expect(Array.from(typeIds.data as BigInt64Array, Number).every((v) => v === 0)).toBe(true);
	});

	it(`runs ${EMBED_BATCH_SIZE} texts per batch and keeps input order`, async () => {
		const { session, runs } = await installPool(baseSpec({ pooling: 'graph' }));
		const texts = Array.from({ length: 40 }, (_, i) => `text ${i}`);

		const vectors = await embedTexts(LOCAL, texts, { mode: 'document' });

		expect(vectors).toHaveLength(40);
		expect(session.run).toHaveBeenCalledTimes(3);
		expect(runs.map((feeds) => feeds.input_ids.dims[0])).toEqual([16, 16, 8]);
		// The fake encodes row index + 1 into the first component, per batch.
		expect(vectors[16][0]).toBeCloseTo(vectors[0][0], 6);
		expect(vectors[17][0]).toBeGreaterThan(vectors[16][0]);
	});

	it('loads the session once across calls', async () => {
		const { create } = await installPool(baseSpec());
		await embedTexts(LOCAL, ['a'], { mode: 'query' });
		await embedTexts(LOCAL, ['b'], { mode: 'query' });
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('applies the query or document prefix the model was trained with', async () => {
		const { encodedTexts } = await installPool(
			baseSpec({
				queryPrefix: 'task: search result | query: ',
				documentPrefix: 'title: none | text: ',
			})
		);

		await embedTexts(LOCAL, ['rename a tab'], { mode: 'query' });
		await embedTexts(LOCAL, ['Tab naming'], { mode: 'document' });

		expect(encodedTexts).toEqual([
			['task: search result | query: rename a tab'],
			['title: none | text: Tab naming'],
		]);
	});

	it('applies no prefix for a model trained without one', async () => {
		const { encodedTexts } = await installPool(baseSpec());
		await embedTexts(LOCAL, ['rename a tab'], { mode: 'query' });
		expect(encodedTexts).toEqual([['rename a tab']]);
	});

	it('returns nothing for no texts without loading the model', async () => {
		const { create } = await installPool(baseSpec());
		await expect(embedTexts(LOCAL, [], { mode: 'query' })).resolves.toEqual([]);
		expect(create).not.toHaveBeenCalled();
	});

	it('classifies a failed run, naming the model', async () => {
		const { session } = await installPool(baseSpec());
		session.run.mockRejectedValueOnce(new Error('bad shape'));

		const error = await embedTexts(LOCAL, ['a'], { mode: 'query' }).catch((e) => e);

		expect(error).toBeInstanceOf(LocalModelError);
		expect(error).toMatchObject({ code: 'generation-failed' });
		expect(error.message).toContain('Fake Embed');
	});

	it('refuses an output narrower than the catalog says', async () => {
		await installPool(baseSpec({ dimensions: 384 }));
		await expect(embedTexts(LOCAL, ['a'], { mode: 'query' })).rejects.toThrow(/3-wide vectors/);
	});

	it('stops between batches when cancelled', async () => {
		const { session } = await installPool(baseSpec());
		const controller = new AbortController();
		session.run.mockImplementationOnce(async (feeds: Record<string, OnnxTensor>) => {
			controller.abort();
			const [batch, sequence] = feeds.input_ids.dims;
			return {
				last_hidden_state: tensor(new Array(batch * sequence * WIDTH).fill(1), [
					batch,
					sequence,
					WIDTH,
				]),
			};
		});
		const texts = Array.from({ length: 20 }, () => 'x');

		await expect(
			embedTexts(LOCAL, texts, { mode: 'query', signal: controller.signal })
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(session.run).toHaveBeenCalledTimes(1);
	});
});

describe('embedTexts on an endpoint', () => {
	const NOMIC = { type: 'endpoint', endpointId: 'ep-1', model: 'nomic-embed-text' } as const;

	it(`sends ${ENDPOINT_EMBED_BATCH_SIZE} texts per request, unprefixed, and normalizes`, async () => {
		endpoint.embedWithLocalModelEndpoint.mockImplementation(
			async (_id: string, request: { input: string[] }) => ({
				embeddings: request.input.map(() => [3, 4]),
				model: 'nomic-embed-text',
			})
		);
		const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);

		const vectors = await embedTexts(NOMIC, texts, { mode: 'query' });

		expect(endpoint.embedWithLocalModelEndpoint).toHaveBeenCalledTimes(2);
		expect(endpoint.embedWithLocalModelEndpoint).toHaveBeenNthCalledWith(1, 'ep-1', {
			model: 'nomic-embed-text',
			input: texts.slice(0, 64),
		});
		expect(vectors).toHaveLength(70);
		expect(Array.from(vectors[0])).toEqual([0.6000000238418579, 0.800000011920929]);
	});

	it('lets an endpoint failure through as itself', async () => {
		endpoint.embedWithLocalModelEndpoint.mockRejectedValue(
			Object.assign(new Error('Ollama is not reachable.'), { kind: 'network' })
		);
		await expect(embedTexts(NOMIC, ['a'], { mode: 'query' })).rejects.toThrow(
			'Ollama is not reachable.'
		);
	});
});

describe('poolEmbeddings', () => {
	const tokens = {
		batchSize: 1,
		sequenceLength: 2,
		attentionMask: BigInt64Array.from([1n, 1n]),
	};

	it('refuses a batch-size mismatch', () => {
		expect(() =>
			poolEmbeddings(tensor([1, 2, 3, 4, 5, 6], [2, WIDTH]), tokens, {
				pooling: 'graph',
				dimensions: WIDTH,
			})
		).toThrow(/shape/);
	});

	it('leaves a zero vector at zero rather than dividing by nothing', () => {
		const [vector] = poolEmbeddings(tensor([0, 0, 0], [1, WIDTH]), tokens, {
			pooling: 'graph',
			dimensions: WIDTH,
		});
		expect(Array.from(vector)).toEqual([0, 0, 0]);
	});
});
