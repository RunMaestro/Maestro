/**
 * @file model-catalog-load-e2e.test.ts
 *
 * Does the pinned `llama-server` build load a catalog model's architecture?
 * The catalog verifies a download by hash, which proves the bytes are the ones
 * we pinned and nothing about whether this build can run them: a new
 * architecture (`qwen35`, `gemma4`, `qwen3next`) that the build predates
 * downloads clean and fails at load. This test downloads each named model,
 * starts the Maestro model server against it, lists it on `/v1/models`, and
 * generates a few tokens (a model is only loaded by its first request). A model
 * that reads images is also sent one.
 *
 * Opt-in only. Gigabytes per model: SKIPPED unless BOTH
 *   MAESTRO_LOCAL_MODEL_E2E=1
 *   MAESTRO_LOCAL_MODEL_E2E_MODELS=<catalog id>,<catalog id>,...   (or "all")
 * Run with:
 *   MAESTRO_LOCAL_MODEL_E2E=1 MAESTRO_LOCAL_MODEL_E2E_MODELS=qwen3.5-4b-q4km \
 *     env -u MAESTRO_USER_DATA npx vitest run src/__tests__/main/local-models/model-catalog-load-e2e.test.ts
 *
 * Installs land in the scratch dir the other local-model e2e suites share
 * (`$TMPDIR/maestro-local-model-e2e`, or MAESTRO_LOCAL_MODEL_E2E_DIR), never the
 * live Maestro one. A model under 25 GB stays installed for the next suite; a
 * larger one is deleted once it has been checked. The outcome of every model,
 * loaded or not, is merged into `catalog-load-e2e-results.json` there.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const MODELS_ENV = process.env.MAESTRO_LOCAL_MODEL_E2E_MODELS ?? '';
const RUN = process.env.MAESTRO_LOCAL_MODEL_E2E === '1' && MODELS_ENV.trim() !== '';
const DATA_DIR =
	process.env.MAESTRO_LOCAL_MODEL_E2E_DIR ?? path.join(os.tmpdir(), 'maestro-local-model-e2e');

vi.mock('electron', () => ({
	app: { getPath: () => DATA_DIR },
	safeStorage: { isEncryptionAvailable: () => false },
}));

import {
	downloadLocalModel,
	removeLocalModel,
	verifyLocalModel,
} from '../../../main/local-models/service';
import {
	getModelServerReport,
	installModelServerEngine,
} from '../../../main/local-models/server/service';
import {
	configureModelServer,
	ensureModelServerFor,
	getModelServerKey,
	resetModelServerForTests,
	startModelServer,
	stopModelServer,
} from '../../../main/local-models/server/supervisor';
import {
	LOCAL_MODEL_CATALOG,
	getLocalModel,
	localModelProjectorFile,
} from '../../../shared/local-models/model-catalog';
import { MODEL_SERVER_AGENT_MIN_CONTEXT } from '../../../shared/local-models/model-server';
import { scratchKeySeal } from '../../helpers/scratchKeySeal';

const GB = 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 60_000;
const LOAD_TIMEOUT_MS = 15 * 60_000;
/** A model this size or larger is deleted after its check; smaller ones are kept. */
const KEEP_UNDER_BYTES = 25 * GB;
const RESULTS_FILE = path.join(DATA_DIR, 'catalog-load-e2e-results.json');

/** A 16x16 red PNG, the smallest image a vision model can be asked about. */
const RED_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=';

const seal = scratchKeySeal();

const ids =
	MODELS_ENV.trim() === 'all'
		? LOCAL_MODEL_CATALOG.filter((entry) => entry.kind === 'text-gen').map((entry) => entry.id)
		: MODELS_ENV.split(',')
				.map((id) => id.trim())
				.filter(Boolean);

interface LoadOutcome {
	checkedAt: string;
	loaded: boolean;
	error?: string;
	downloadedGb: number;
	loadMs?: number;
	generatedTokens?: number;
	tokensPerSecond?: number;
	promptTokensPerSecond?: number;
	contextSize: number;
	image?: 'answered' | 'refused';
	removedAfter: boolean;
}

function readResults(): Record<string, unknown> {
	if (!existsSync(RESULTS_FILE)) return {};
	return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as Record<string, unknown>;
}

function record(id: string, outcome: LoadOutcome): void {
	const merged = readResults();
	const models = (merged.models ?? {}) as Record<string, LoadOutcome>;
	models[id] = outcome;
	merged.host = {
		platform: `${process.platform}-${process.arch}`,
		cpu: os.cpus()[0]?.model ?? 'unknown',
		totalRamGb: Math.round(os.totalmem() / GB),
	};
	merged.models = models;
	writeFileSync(RESULTS_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

describe.skipIf(!RUN)('catalog models load in the pinned llama-server (opt-in)', () => {
	beforeAll(async () => {
		process.env.MAESTRO_USER_DATA = DATA_DIR;
		mkdirSync(DATA_DIR, { recursive: true });
		configureModelServer({ dataDir: () => DATA_DIR, osSeal: () => seal, safeSend: () => {} });
		const { engine } = await getModelServerReport();
		if (!engine.installed || engine.stale || engine.choice !== 'default') {
			await installModelServerEngine('default');
		}
	}, DOWNLOAD_TIMEOUT_MS);

	afterAll(async () => {
		await resetModelServerForTests();
	});

	it('names only models the catalog has', () => {
		for (const id of ids) expect(getLocalModel(id), id).toBeDefined();
	});

	it.each(ids)(
		'loads %s, lists it on /v1/models and generates',
		async (id) => {
			const entry = getLocalModel(id)!;
			const outcome: LoadOutcome = {
				checkedAt: new Date().toISOString(),
				loaded: false,
				downloadedGb: Math.round((entry.bytes / GB) * 10) / 10,
				contextSize: entry.defaultContext ?? MODEL_SERVER_AGENT_MIN_CONTEXT,
				removedAfter: false,
			};
			try {
				if (!(await verifyLocalModel(id)).ok) {
					const download = await downloadLocalModel(id);
					expect(download.error ?? null).toBeNull();
					expect((await verifyLocalModel(id)).ok).toBe(true);
				}

				// A fresh server per model: the presets file is written at start.
				await stopModelServer();
				const started = Date.now();
				await startModelServer();
				const ensured = await ensureModelServerFor(id);
				outcome.loadMs = Date.now() - started;
				expect(ensured).toMatchObject({ ok: true, model: id });
				if (!ensured.ok) return;

				const key = await getModelServerKey();
				const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
				const listed = (await (
					await fetch(`${ensured.baseUrl}/v1/models`, { headers })
				).json()) as { data?: Array<{ id: string }> };
				expect(listed.data?.map((model) => model.id)).toContain(id);

				const generate = async (content: unknown) => {
					const response = await fetch(`${ensured.baseUrl}/v1/chat/completions`, {
						method: 'POST',
						headers,
						body: JSON.stringify({
							model: id,
							messages: [{ role: 'user', content }],
							max_tokens: 48,
							temperature: 0,
							chat_template_kwargs: { enable_thinking: false },
						}),
					});
					const text = await response.text();
					return { status: response.status, text };
				};

				const answered = await generate('Reply with the single word: pong');
				expect(answered.status, answered.text.slice(0, 600)).toBe(200);
				const timings = (JSON.parse(answered.text) as { timings?: Record<string, number> }).timings;
				outcome.generatedTokens = timings?.predicted_n;
				outcome.tokensPerSecond = Math.round((timings?.predicted_per_second ?? 0) * 10) / 10;
				outcome.promptTokensPerSecond = Math.round((timings?.prompt_per_second ?? 0) * 10) / 10;
				expect(outcome.generatedTokens ?? 0).toBeGreaterThan(0);

				if (localModelProjectorFile(entry)) {
					const image = await generate([
						{ type: 'text', text: 'Name the color of this image in one word.' },
						{ type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } },
					]);
					outcome.image = image.status === 200 ? 'answered' : 'refused';
					expect(image.status, image.text.slice(0, 600)).toBe(200);
				}
				outcome.loaded = true;
			} catch (error) {
				outcome.error = error instanceof Error ? error.message.slice(0, 600) : String(error);
				throw error;
			} finally {
				await stopModelServer();
				if (entry.bytes >= KEEP_UNDER_BYTES) {
					await removeLocalModel(id);
					outcome.removedAfter = true;
				}
				record(id, outcome);
			}
		},
		DOWNLOAD_TIMEOUT_MS + LOAD_TIMEOUT_MS
	);
});
