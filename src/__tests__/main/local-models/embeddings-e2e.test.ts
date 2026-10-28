/**
 * @file embeddings-e2e.test.ts
 *
 * The embedding service end to end on real hardware: install ONNX Runtime and
 * bge-small-en-v1.5 through the core Local Models service, embed through the
 * real encoder pool and tokenizer, and check that the vectors mean something:
 * "how do I rename a tab" must sit closer to "tab naming" than to "SSH remote
 * hosts". Unit tests fake the graph, so they cannot tell whether the pinned
 * ONNX file loads, whether its inputs are the ones the service feeds, or
 * whether CLS pooling is the right reading of its output. This test can, and
 * its latencies go into `docs/architecture/local-models.md`.
 *
 * Opt-in only (a 34 MB model plus the ONNX Runtime download on the first run):
 * SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/embeddings-e2e.test.ts
 *
 * Installs land in a scratch data dir, never the live Maestro one, shared with
 * the llama E2E. Override it with MAESTRO_LOCAL_MODEL_E2E_DIR.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1';
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
}));

import {
	downloadLocalModel,
	installLocalRuntime,
	listLocalRuntimes,
	verifyLocalModel,
} from '../../../main/local-models/service';
import { __setNativeImporter } from '../../../main/local-models/runtime/native-loader';
import { embedTexts } from '../../../main/local-models/embeddings';
import { __setOnnxEncoderPool, OnnxEncoderPool } from '../../../main/local-models/onnx-encoder';
import { BGE_SMALL_EN_ID } from '../../../shared/local-models/model-catalog';

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const INFERENCE_TIMEOUT_MS = 2 * 60_000;

const BGE = { type: 'local', modelId: BGE_SMALL_EN_ID } as const;

function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

/** Measurements written at the end, for the architecture doc. */
const results: Record<string, string | number> = {};

describe.skipIf(!RUN)('embeddings end to end (MAESTRO_LOCAL_MODEL_E2E=1)', () => {
	let pool: OnnxEncoderPool;

	beforeAll(() => {
		// See llama-e2e.test.ts: pin the data dir away from the live one, and give
		// the loader an importer vitest's module VM accepts.
		process.env.MAESTRO_USER_DATA = DATA_DIR;
		__setNativeImporter(
			(specifier) =>
				import(
					/* @vite-ignore */ path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier
				)
		);
		pool = new OnnxEncoderPool({ idleUnloadMs: 0 });
		__setOnnxEncoderPool(pool);
		results.platform = `${process.platform}-${process.arch}`;
	});

	afterAll(async () => {
		await pool.unload();
		__setOnnxEncoderPool(null);
		__setNativeImporter(null);
		const report = JSON.stringify(results, null, 2);
		writeFileSync(path.join(DATA_DIR, 'embeddings-e2e-results.json'), `${report}\n`);
		console.log(`[embeddings-e2e] results\n${report}`);
	});

	it(
		'installs ONNX Runtime and bge-small-en-v1.5 through the core service',
		async () => {
			const runtime = (await listLocalRuntimes()).find((entry) => entry.id === 'onnx')!;
			if (!runtime.installed || runtime.stale) await installLocalRuntime('onnx');
			if (!(await verifyLocalModel(BGE_SMALL_EN_ID)).ok) {
				const download = await downloadLocalModel(BGE_SMALL_EN_ID);
				expect(download.error ?? null).toBeNull();
			}
			expect((await verifyLocalModel(BGE_SMALL_EN_ID)).ok).toBe(true);
		},
		DOWNLOAD_TIMEOUT_MS
	);

	it(
		'places a query nearer the related document than the unrelated one',
		async () => {
			let started = Date.now();
			const [query] = await embedTexts(BGE, ['how do I rename a tab'], { mode: 'query' });
			results.coldQueryMs = Date.now() - started;

			started = Date.now();
			const [related, unrelated] = await embedTexts(BGE, ['tab naming', 'SSH remote hosts'], {
				mode: 'document',
			});
			results.warmPairMs = Date.now() - started;

			expect(query).toHaveLength(384);
			expect(Math.hypot(...Array.from(query))).toBeCloseTo(1, 4);

			const near = dot(query, related);
			const far = dot(query, unrelated);
			results.similarityRelated = Number(near.toFixed(4));
			results.similarityUnrelated = Number(far.toFixed(4));
			expect(near).toBeGreaterThan(far);
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'measures a full batch',
		async () => {
			const texts = Array.from(
				{ length: 64 },
				(_, i) => `History entry ${i}: the agent refactored the settings modal and fixed a test.`
			);
			const started = Date.now();
			const vectors = await embedTexts(BGE, texts, { mode: 'document' });
			results.batch64Ms = Date.now() - started;
			results.perTextMs = Number(((Date.now() - started) / texts.length).toFixed(2));
			expect(vectors).toHaveLength(64);
		},
		INFERENCE_TIMEOUT_MS
	);
});
