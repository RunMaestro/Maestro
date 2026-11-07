/**
 * @file kokoro-e2e.test.ts
 *
 * The Kokoro voice, end to end on real hardware: install the model and ONNX
 * Runtime through the core Local Models service, run the real phoneme front
 * end (espeak-ng through the `phonemizer` package, then the model's own
 * `tokenizer.json`), synthesise through the real provider, and compare what
 * comes out against the reference implementation.
 *
 * Unit tests inject a phonemizer and a fake ONNX session, so they cannot tell
 * whether real text becomes the ids the model was trained on, or whether the
 * audio is speech. This is the test that can. The reference values are from
 * kokoro-js 1.2.1 (the implementation the front end is ported from) for the
 * same sentence, voice and speed:
 *
 *   - the 30 token ids, exactly;
 *   - 56,400 samples at 24 kHz (2.35 s), exactly;
 *   - RMS 0.06735 on ONNX Runtime 1.30, within 2%.
 *
 * Samples are not compared one by one: they differ across ONNX Runtime
 * versions and platforms while sounding the same.
 *
 * Opt-in only (about 326 MB of model plus the ONNX runtime on the first run):
 * SKIPPED unless
 *   MAESTRO_LOCAL_MODEL_E2E=1
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/acappella/providers/kokoro-e2e.test.ts
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

import { installLocalModel, verifyLocalModel } from '../../../../main/local-models/service';
import { __setNativeImporter } from '../../../../main/local-models/runtime/native-loader';
import { modelFilePath } from '../../../../main/local-models/model-store';
import { KokoroTtsProvider } from '../../../../main/acappella/providers/local/kokoro-tts';
import { createKokoroFrontEnd } from '../../../../main/acappella/providers/local/kokoro/front-end';
import { KOKORO_MAX_TOKENS } from '../../../../main/acappella/providers/local/kokoro/tokens';
import { KOKORO_82M_ID } from '../../../../shared/local-models/model-catalog';

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const INFERENCE_TIMEOUT_MS = 5 * 60_000;

const SENTENCE = 'Hello world, this is a test.';
/** kokoro-js 1.2.1, `af_heart`, without the pad token at each end. */
const GOLDEN_IDS = [
	50, 83, 54, 156, 57, 135, 16, 65, 156, 87, 158, 54, 46, 3, 16, 81, 102, 61, 16, 102, 68, 16, 70,
	16, 62, 156, 86, 61, 62, 4,
];
const GOLDEN_SAMPLES = 56_400;
const GOLDEN_RMS = 0.06735;
const SAMPLE_RATE = 24_000;

function pcm16(bytes: Uint8Array): Int16Array {
	return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

function rms(samples: Int16Array): number {
	let sum = 0;
	for (const sample of samples) sum += (sample / 32768) ** 2;
	return Math.sqrt(sum / samples.length);
}

async function speak(provider: KokoroTtsProvider, text: string): Promise<Int16Array[]> {
	const chunks: Int16Array[] = [];
	for await (const chunk of provider.speak(text, { utteranceId: 'e2e' })) {
		expect(chunk.sampleRate).toBe(SAMPLE_RATE);
		expect(chunk.format).toBe('pcm16');
		if (!chunk.audio) throw new Error('Kokoro yielded a chunk with no audio');
		chunks.push(pcm16(chunk.audio));
	}
	return chunks;
}

const results: Record<string, unknown> = {};

describe.skipIf(!RUN)('Kokoro voice end to end (MAESTRO_LOCAL_MODEL_E2E=1)', () => {
	let provider: KokoroTtsProvider;

	beforeAll(async () => {
		process.env.MAESTRO_USER_DATA = DATA_DIR;
		__setNativeImporter(
			(specifier) =>
				import(
					/* @vite-ignore */ path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier
				)
		);
		// The one call the Download button makes: the model and its engine.
		if (!(await verifyLocalModel(KOKORO_82M_ID)).ok) {
			const installed = await installLocalModel(KOKORO_82M_ID);
			expect(installed.error ?? null).toBeNull();
			expect(installed.status).toBe('complete');
			expect(['ready', 'installed']).toContain(installed.runtime.status);
		}
		provider = new KokoroTtsProvider();
		results.platform = `${process.platform}-${process.arch}`;
	}, DOWNLOAD_TIMEOUT_MS);

	afterAll(async () => {
		await provider?.dispose();
		__setNativeImporter(null);
		const report = JSON.stringify(results, null, 2);
		writeFileSync(path.join(DATA_DIR, 'kokoro-e2e-results.json'), `${report}\n`);
		console.log(`[kokoro-e2e] results\n${report}`);
	});

	it(
		'turns text into the ids the reference implementation produces',
		async () => {
			const listenersBefore = process.listenerCount('uncaughtException');
			const frontEnd = await createKokoroFrontEnd({
				tokenizerPath: modelFilePath(KOKORO_82M_ID, 'tokenizer.json'),
			});

			expect(await frontEnd.phonemize(SENTENCE)).toEqual(GOLDEN_IDS);
			// Loading espeak must not leave its process-wide error handlers behind.
			expect(process.listenerCount('uncaughtException')).toBe(listenersBefore);
			// Nothing speakable is an empty list, not a pair of pad tokens. Brackets
			// become guillemets, which the vocabulary does not have. (An emoji is NOT
			// such a case: espeak reads it by name, "party popper".)
			expect(await frontEnd.phonemize('()')).toEqual([]);
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'synthesises the audio the reference implementation produces',
		async () => {
			let started = Date.now();
			const cold = await speak(provider, SENTENCE);
			results.coldMs = Date.now() - started;

			started = Date.now();
			const warm = await speak(provider, SENTENCE);
			results.warmMs = Date.now() - started;

			expect(cold).toHaveLength(1);
			expect(cold[0].length).toBe(GOLDEN_SAMPLES);
			const level = rms(cold[0]);
			results.samples = cold[0].length;
			results.seconds = cold[0].length / SAMPLE_RATE;
			results.rms = Number(level.toFixed(5));
			expect(Math.abs(level - GOLDEN_RMS) / GOLDEN_RMS).toBeLessThan(0.02);
			// The same text gives the same audio: nothing in the graph is random.
			expect(warm[0].length).toBe(GOLDEN_SAMPLES);
			expect(Array.from(warm[0].subarray(0, 2000))).toEqual(Array.from(cold[0].subarray(0, 2000)));
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'speaks a sentence longer than the model takes in one run',
		async () => {
			// 240 characters of digits phonemize to well over the 510-id limit; fed
			// whole, ONNX Runtime fails the inference.
			const long = `${'1234567 '.repeat(29)}end.`;
			const frontEnd = await createKokoroFrontEnd({
				tokenizerPath: modelFilePath(KOKORO_82M_ID, 'tokenizer.json'),
			});
			const ids = await frontEnd.phonemize(long);
			expect(ids.length).toBeGreaterThan(KOKORO_MAX_TOKENS);

			const started = Date.now();
			const chunks = await speak(provider, long);
			const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
			results.longTokens = ids.length;
			results.longSeconds = Number((samples / SAMPLE_RATE).toFixed(1));
			results.longMs = Date.now() - started;

			expect(samples).toBeGreaterThan(SAMPLE_RATE * 10);
			for (const chunk of chunks) expect(rms(chunk)).toBeGreaterThan(0.01);
		},
		INFERENCE_TIMEOUT_MS
	);

	it(
		'reads years, money and clock times the way a person would',
		async () => {
			const chunks = await speak(provider, 'In 1999 it cost $9.99 at 3:05.');
			const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
			results.numbersSeconds = Number((samples / SAMPLE_RATE).toFixed(2));
			// Spelled out ("nineteen ninety nine ... nine dollars and ninety nine
			// cents ... three oh five"), this is several seconds of speech; read as
			// bare digits it would be under two.
			expect(samples).toBeGreaterThan(SAMPLE_RATE * 3);
		},
		INFERENCE_TIMEOUT_MS
	);
});
