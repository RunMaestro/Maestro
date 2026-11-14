/**
 * @file model-routing-corrections.test.ts
 *
 * The store behind a model routing correction: the file under the data dir,
 * read once, written atomically, and never overwritten when it cannot be read.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ dataDir: '', warn: vi.fn() }));

vi.mock('../../../main/local-models/paths', () => ({
	LOCAL_MODELS_DIRNAME: 'models',
	LOCAL_RUNTIMES_DIRNAME: 'runtimes',
	localModelsDataDir: () => mocks.dataDir,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	getModelRoutingCorrectionStore,
	ModelRoutingCorrectionStore,
} from '../../../main/local-models/model-routing-corrections';
import {
	MAX_MODEL_ROUTING_CORRECTIONS,
	MODEL_ROUTING_CORRECTIONS_FILE,
} from '../../../shared/local-models/model-routing';

let dir: string;
let file: string;

function readFile(): { version: number; corrections: Array<Record<string, unknown>> } {
	return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-routing-corrections-'));
	file = path.join(dir, 'nested', MODEL_ROUTING_CORRECTIONS_FILE);
	mocks.dataDir = dir;
	mocks.warn.mockReset();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('ModelRoutingCorrectionStore', () => {
	it('starts empty on a machine where nothing was corrected, and writes nothing', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		expect(await store.list()).toEqual([]);
		expect(fs.existsSync(file)).toBe(false);
	});

	it('records a correction and creates the folder it needs', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		const result = await store.record({ text: '  migrate the schema  ', tier: 'high' }, 42);
		expect(result).toEqual({
			ok: true,
			correction: { text: 'migrate the schema', tier: 'high', recordedAt: 42 },
			replaced: false,
			total: 1,
		});
		expect(readFile()).toEqual({
			version: 1,
			corrections: [{ text: 'migrate the schema', tier: 'high', recordedAt: 42 }],
		});
	});

	it('keeps the effort only when one was given', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		await store.record({ text: 'a', tier: 'low' }, 1);
		await store.record({ text: 'b', tier: 'high', effort: 'medium' }, 2);
		expect(await store.list()).toEqual([
			{ text: 'a', tier: 'low', recordedAt: 1 },
			{ text: 'b', tier: 'high', effort: 'medium', recordedAt: 2 },
		]);
	});

	it('replaces the earlier correction for the same prompt', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		await store.record({ text: 'rename it', tier: 'high' }, 1);
		const result = await store.record({ text: ' rename it ', tier: 'low' }, 2);
		expect(result).toMatchObject({ ok: true, replaced: true, total: 1 });
		expect(await store.list()).toEqual([{ text: 'rename it', tier: 'low', recordedAt: 2 }]);
	});

	it('refuses a correction with no prompt, and writes nothing', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		expect(await store.record({ text: '  \n ', tier: 'low' })).toEqual({
			ok: false,
			message: 'There is no prompt to record a correction for.',
		});
		expect(fs.existsSync(file)).toBe(false);
	});

	it('never writes a secret to the file', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		await store.record({ text: `deploy with sk-${'a'.repeat(40)}`, tier: 'medium' });
		expect(fs.readFileSync(file, 'utf-8')).not.toContain('sk-aaaa');
	});

	it('keeps every one of several corrections recorded at once', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.record({ text: `prompt ${index}`, tier: 'low' }, index)
			)
		);
		expect(readFile().corrections).toHaveLength(8);
		expect(await store.list()).toHaveLength(8);
	});

	it('is read back by a later start', async () => {
		await new ModelRoutingCorrectionStore(file).record({ text: 'a', tier: 'high' }, 7);
		expect(await new ModelRoutingCorrectionStore(file).list()).toEqual([
			{ text: 'a', tier: 'high', recordedAt: 7 },
		]);
	});

	it('holds the list to the cap, oldest first out', async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				corrections: Array.from({ length: MAX_MODEL_ROUTING_CORRECTIONS }, (_, index) => ({
					text: `prompt ${index}`,
					tier: 'low',
					recordedAt: index,
				})),
			})
		);
		const store = new ModelRoutingCorrectionStore(file);
		const result = await store.record({ text: 'newest', tier: 'high' });
		expect(result).toMatchObject({ ok: true, total: MAX_MODEL_ROUTING_CORRECTIONS });
		const list = await store.list();
		expect(list[0].text).toBe('prompt 1');
		expect(list.at(-1)?.text).toBe('newest');
	});

	it('clears every correction and says how many there were', async () => {
		const store = new ModelRoutingCorrectionStore(file);
		await store.record({ text: 'a', tier: 'low' });
		await store.record({ text: 'b', tier: 'low' });
		expect(await store.clear()).toBe(2);
		expect(await store.list()).toEqual([]);
		expect(readFile().corrections).toEqual([]);
		expect(await store.clear()).toBe(0);
	});

	it('moves a file that is not JSON aside instead of overwriting it', async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{ "corrections": [');
		const store = new ModelRoutingCorrectionStore(file);
		expect(await store.list()).toEqual([]);

		const siblings = fs.readdirSync(path.dirname(file));
		const sidecar = siblings.find((name) => name.includes('.corrupt-'));
		expect(sidecar).toBeDefined();
		expect(fs.readFileSync(path.join(path.dirname(file), sidecar as string), 'utf-8')).toBe(
			'{ "corrections": ['
		);
		expect(fs.existsSync(file)).toBe(false);
		expect(mocks.warn).toHaveBeenCalledTimes(1);

		await store.record({ text: 'a', tier: 'low' }, 1);
		expect(readFile().corrections).toHaveLength(1);
	});

	it('drops an unusable record, keeps the rest, and says so', async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				corrections: [
					{ text: 'kept', tier: 'low', recordedAt: 1 },
					{ text: 'bad', tier: 'enormous', recordedAt: 2 },
				],
			})
		);
		const store = new ModelRoutingCorrectionStore(file);
		expect(await store.list()).toEqual([{ text: 'kept', tier: 'low', recordedAt: 1 }]);
		expect(mocks.warn).toHaveBeenCalledTimes(1);
	});

	it('reads again after a read that failed', async () => {
		// A folder where the file should be: the read fails with something other
		// than "no such file".
		fs.mkdirSync(file, { recursive: true });
		const store = new ModelRoutingCorrectionStore(file);
		await expect(store.list()).rejects.toThrow();
		fs.rmdirSync(file);
		expect(await store.list()).toEqual([]);
	});
});

describe('getModelRoutingCorrectionStore', () => {
	it('is one store over the file in the data dir', async () => {
		const store = getModelRoutingCorrectionStore();
		expect(getModelRoutingCorrectionStore()).toBe(store);
		await store.record({ text: 'a', tier: 'low' }, 1);
		expect(fs.existsSync(path.join(dir, MODEL_ROUTING_CORRECTIONS_FILE))).toBe(true);
	});
});

// A correction that crossed a process boundary (`maestro-cli s1 route
// --correct`, the WS message `model_route_correct`). The store behind it is the
// app's one store, so each case loads the module again: a fresh store over this
// case's own data dir.
describe('recordModelRoutingCorrectionRequest', () => {
	let record: typeof import('../../../main/local-models/model-routing-corrections').recordModelRoutingCorrectionRequest;
	const dataFile = () => path.join(dir, MODEL_ROUTING_CORRECTIONS_FILE);

	beforeEach(async () => {
		vi.resetModules();
		({ recordModelRoutingCorrectionRequest: record } =
			await import('../../../main/local-models/model-routing-corrections'));
	});

	it.each([
		['nothing', undefined],
		['null', null],
		['a string', 'rename the helper'],
		['a number', 3],
		['a list', [{ prompt: 'rename the helper', tier: 'high' }]],
	])('rejects %s as a request, and writes nothing', async (_what, request) => {
		await expect(record(request)).rejects.toThrow(
			'A routing correction is an object with a prompt and a tier.'
		);
		expect(fs.existsSync(dataFile())).toBe(false);
	});

	it.each([
		['absent', {}],
		['a number', { prompt: 7 }],
		['null', { prompt: null }],
		['a list', { prompt: ['rename the helper'] }],
	])('rejects a prompt that is %s', async (_what, fields) => {
		await expect(record({ tier: 'high', ...fields })).rejects.toThrow(
			"A routing correction's prompt is text."
		);
		expect(fs.existsSync(dataFile())).toBe(false);
	});

	it.each([
		['absent', {}],
		['a word that is not a tier', { tier: 'enormous' }],
		['a tier in another case', { tier: 'High' }],
		['a number', { tier: 2 }],
		['null', { tier: null }],
	])('rejects a tier that is %s', async (_what, fields) => {
		await expect(record({ prompt: 'rename the helper', ...fields })).rejects.toThrow(
			"A routing correction's tier is one of low, medium, high."
		);
		expect(fs.existsSync(dataFile())).toBe(false);
	});

	it.each([
		['a word that is not a level', 'extreme'],
		['a number', 1],
		['null', null],
		['an empty string', ''],
	])('rejects an effort that is %s', async (_what, effort) => {
		await expect(record({ prompt: 'rename the helper', tier: 'high', effort })).rejects.toThrow(
			"A routing correction's effort is one of low, medium, high."
		);
		expect(fs.existsSync(dataFile())).toBe(false);
	});

	it("records a good one in the app's store, with no effort when none was given", async () => {
		const result = await record({ prompt: '  migrate the schema  ', tier: 'high' });

		expect(result).toEqual({
			ok: true,
			correction: { text: 'migrate the schema', tier: 'high', recordedAt: expect.any(Number) },
			replaced: false,
			total: 1,
		});
		const saved = JSON.parse(fs.readFileSync(dataFile(), 'utf-8'));
		expect(saved.corrections).toEqual([
			{ text: 'migrate the schema', tier: 'high', recordedAt: expect.any(Number) },
		]);
	});

	it('keeps the effort it is given, and ignores fields it does not know', async () => {
		const result = await record({
			prompt: 'migrate the schema',
			tier: 'high',
			effort: 'medium',
			agentId: 'agent-7',
		});

		expect(result).toMatchObject({
			ok: true,
			correction: { text: 'migrate the schema', tier: 'high', effort: 'medium' },
		});
		const saved = JSON.parse(fs.readFileSync(dataFile(), 'utf-8'));
		expect(saved.corrections).toEqual([
			{
				text: 'migrate the schema',
				tier: 'high',
				effort: 'medium',
				recordedAt: expect.any(Number),
			},
		]);
	});

	it('replaces the earlier correction for the same prompt', async () => {
		await record({ prompt: 'migrate the schema', tier: 'low' });
		const result = await record({ prompt: 'migrate the schema', tier: 'high' });

		expect(result).toMatchObject({ ok: true, replaced: true, total: 1 });
		expect(JSON.parse(fs.readFileSync(dataFile(), 'utf-8')).corrections).toEqual([
			expect.objectContaining({ text: 'migrate the schema', tier: 'high' }),
		]);
	});

	it('answers a blank prompt with the store refusal instead of rejecting', async () => {
		const result = await record({ prompt: '   ', tier: 'high' });

		expect(result).toEqual({
			ok: false,
			message: 'There is no prompt to record a correction for.',
		});
		expect(fs.existsSync(dataFile())).toBe(false);
	});
});
