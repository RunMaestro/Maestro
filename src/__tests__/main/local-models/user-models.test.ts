/**
 * @file user-models.test.ts
 *
 * The store behind "Add from Hugging Face": reading the file into the catalog
 * at startup, and the one implementation of look up, add and remove that
 * Settings and `maestro-cli models add-hf` / `remove-hf` both call. Hugging
 * Face is one mocked request; nothing here downloads a model.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	dataDir: '',
	fetch: vi.fn(),
	cancel: vi.fn(async () => true),
	remove: vi.fn(async () => 1234),
	warn: vi.fn(),
	base: 'https://huggingface.co',
}));

vi.mock('../../../main/local-models/download-base', () => ({
	currentDownloadBase: () => mocks.base,
}));

vi.mock('../../../main/local-models/paths', () => ({
	LOCAL_MODELS_DIRNAME: 'models',
	LOCAL_RUNTIMES_DIRNAME: 'runtimes',
	localModelsDataDir: () => mocks.dataDir,
}));

vi.mock('../../../main/utils/fetchWithTimeout', () => ({
	fetchWithTimeout: mocks.fetch,
	isFetchTimeoutError: (error: unknown) => (error as { name?: string })?.name === 'TimeoutError',
}));

vi.mock('../../../main/local-models/model-downloader', () => ({
	getModelDownloader: () => ({ cancel: mocks.cancel }),
}));

vi.mock('../../../main/local-models/model-store', () => ({
	remove: mocks.remove,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	addHuggingFaceModel,
	hydrateUserLocalModels,
	listUserLocalModels,
	onUserLocalModelsChanged,
	previewHuggingFaceModel,
	removeUserLocalModel,
	resetUserLocalModelsForTests,
} from '../../../main/local-models/user-models';
import {
	QWEN3_1_7B_ID,
	allLocalModels,
	getLocalModel,
	LOCAL_MODEL_CATALOG,
} from '../../../shared/local-models/model-catalog';
import { USER_LOCAL_MODELS_FILE } from '../../../shared/local-models/user-models';

const REPO = 'unsloth/Qwen3.5-2B-GGUF';
const FILE = 'Qwen3.5-2B-Q4_K_M.gguf';
const ID = 'hf-unsloth-qwen3.5-2b-q4_k_m';
const COMMIT = 'f6d5376be1edb4d416d56da11e5397a961aca8ae';
const SHA = 'a'.repeat(64);

function repoInfo(over: Record<string, unknown> = {}) {
	return {
		sha: COMMIT,
		private: false,
		gated: false,
		cardData: { license: 'apache-2.0' },
		gguf: { total: 1_881_825_088, context_length: 262_144 },
		siblings: [{ rfilename: FILE, size: 1_280_835_840, lfs: { sha256: SHA, size: 1_280_835_840 } }],
		...over,
	};
}

function answer(status: number, body: unknown) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => {
			if (body instanceof Error) throw body;
			return body;
		},
	};
}

const storeFile = () => path.join(mocks.dataDir, USER_LOCAL_MODELS_FILE);
const stored = () => JSON.parse(fs.readFileSync(storeFile(), 'utf-8'));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-user-models-'));
	mocks.base = 'https://huggingface.co';
	mocks.fetch.mockResolvedValue(answer(200, repoInfo()));
	resetUserLocalModelsForTests();
});

afterEach(() => {
	resetUserLocalModelsForTests();
	fs.rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe('look up', () => {
	it('describes the model, license first, and saves nothing', async () => {
		const preview = await previewHuggingFaceModel(REPO, FILE);
		expect(preview.ok && preview.value.alreadyAdded).toBe(false);
		expect(preview.ok && preview.value.entry).toMatchObject({
			id: ID,
			userAdded: true,
			license: { spdx: 'apache-2.0' },
			source: { repo: REPO, revision: COMMIT },
			bytes: 1_280_835_840,
		});
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.fetch.mock.calls[0][0]).toBe(
			`https://huggingface.co/api/models/${REPO}?blobs=true`
		);
		expect(fs.existsSync(storeFile())).toBe(false);
		expect(getLocalModel(ID)).toBeUndefined();
	});

	it('asks the configured download base, and names it when it cannot be reached', async () => {
		mocks.base = 'https://hf-mirror.example';
		const preview = await previewHuggingFaceModel(REPO, FILE);
		expect(preview.ok).toBe(true);
		expect(mocks.fetch.mock.calls[0][0]).toBe(
			`https://hf-mirror.example/api/models/${REPO}?blobs=true`
		);

		mocks.fetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND hf-mirror.example'));
		const failed = await previewHuggingFaceModel(REPO, FILE);
		expect(failed.ok ? null : failed.message).toContain('Could not reach hf-mirror.example:');
	});

	it('refuses a bad repo id or file name before any request', async () => {
		expect((await previewHuggingFaceModel('nope', FILE)).ok).toBe(false);
		expect((await previewHuggingFaceModel(REPO, 'model.bin')).ok).toBe(false);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it('says what went wrong with the request, as a refusal and not a throw', async () => {
		const message = async () => {
			const preview = await previewHuggingFaceModel(REPO, FILE);
			return preview.ok ? null : preview.message;
		};
		// Hugging Face answers 401 for a repo that does not exist.
		mocks.fetch.mockResolvedValueOnce(answer(401, { error: 'Invalid username or password.' }));
		expect(await message()).toContain(`no public repo named ${REPO}`);
		mocks.fetch.mockResolvedValueOnce(answer(503, {}));
		expect(await message()).toContain('HTTP 503');
		mocks.fetch.mockResolvedValueOnce(answer(200, new Error('not json')));
		expect(await message()).toContain('not JSON');
		mocks.fetch.mockRejectedValueOnce(
			Object.assign(new Error('timed out'), { name: 'TimeoutError' })
		);
		expect(await message()).toContain('did not answer in time');
		mocks.fetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND huggingface.co'));
		expect(await message()).toContain('Could not reach Hugging Face: getaddrinfo ENOTFOUND');
		mocks.fetch.mockResolvedValueOnce(answer(200, repoInfo({ gated: 'auto' })));
		expect(await message()).toContain('gated');
	});
});

describe('add', () => {
	it('saves the record, joins the catalog, and tells the listeners', async () => {
		const heard: string[][] = [];
		const release = onUserLocalModelsChanged((entries) => heard.push(entries.map((e) => e.id)));

		const added = await addHuggingFaceModel(REPO, FILE);
		expect(added.ok && added.value.added).toBe(true);
		expect(added.ok && added.value.entry).toBe(getLocalModel(ID));

		expect(stored()).toMatchObject({
			version: 1,
			models: [{ id: ID, repo: REPO, revision: COMMIT, files: [{ path: FILE, sha256: SHA }] }],
		});
		expect(allLocalModels()).toHaveLength(LOCAL_MODEL_CATALOG.length + 1);
		expect(listUserLocalModels().map((entry) => entry.id)).toEqual([ID]);
		expect(heard).toEqual([[ID]]);
		// Adding lists the model. It does not download it.
		expect(mocks.cancel).not.toHaveBeenCalled();

		release();
		await removeUserLocalModel(ID);
		expect(heard).toHaveLength(1);
	});

	it('answers with the existing entry when the model is already there, keeping its pinned revision', async () => {
		await addHuggingFaceModel(REPO, FILE);
		// The repo moved on since.
		mocks.fetch.mockResolvedValue(answer(200, repoInfo({ sha: 'b'.repeat(40) })));

		const preview = await previewHuggingFaceModel(REPO, FILE);
		expect(preview.ok && preview.value.alreadyAdded).toBe(true);
		const again = await addHuggingFaceModel(REPO, FILE);
		expect(again.ok && again.value.added).toBe(false);
		expect(again.ok && again.value.entry.source.revision).toBe(COMMIT);
		expect(stored().models).toHaveLength(1);
	});

	it('refuses a file from another repo that would take the same id', async () => {
		await addHuggingFaceModel(REPO, FILE);
		const other = await addHuggingFaceModel('unsloth/Other-GGUF', FILE);
		expect(other).toEqual({
			ok: false,
			message: expect.stringContaining(`A model from ${REPO} already has the id ${ID}`),
		});
		expect(stored().models).toHaveLength(1);
	});

	it('saves nothing when Hugging Face refuses', async () => {
		mocks.fetch.mockResolvedValue(answer(401, {}));
		expect((await addHuggingFaceModel(REPO, FILE)).ok).toBe(false);
		expect(fs.existsSync(storeFile())).toBe(false);
	});
});

describe('remove', () => {
	it('cancels the download, deletes the files, and takes the entry out', async () => {
		await addHuggingFaceModel(REPO, FILE);
		const removed = await removeUserLocalModel(ID);
		expect(removed).toEqual({
			ok: true,
			value: { id: ID, displayName: 'Qwen3.5-2B-Q4_K_M', bytes: 1234 },
		});
		expect(mocks.cancel).toHaveBeenCalledWith(ID);
		expect(mocks.remove).toHaveBeenCalledWith(ID);
		// Cancel before delete: a live writer would recreate the file.
		expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.remove.mock.invocationCallOrder[0]
		);
		expect(getLocalModel(ID)).toBeUndefined();
		expect(stored().models).toEqual([]);
	});

	it('refuses a model Maestro ships, and an id nobody added', async () => {
		const curated = await removeUserLocalModel(QWEN3_1_7B_ID);
		expect(curated).toEqual({ ok: false, message: expect.stringContaining('Maestro ships') });
		const unknown = await removeUserLocalModel('hf-nope');
		expect(unknown).toEqual({ ok: false, message: expect.stringContaining('No model you added') });
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(getLocalModel(QWEN3_1_7B_ID)).toBeDefined();
	});
});

describe('startup', () => {
	it('starts empty with no file', () => {
		hydrateUserLocalModels();
		expect(listUserLocalModels()).toEqual([]);
	});

	it('reads what an earlier run saved', async () => {
		await addHuggingFaceModel(REPO, FILE);
		resetUserLocalModelsForTests();
		expect(getLocalModel(ID)).toBeUndefined();

		hydrateUserLocalModels();
		expect(getLocalModel(ID)).toMatchObject({ id: ID, userAdded: true });
	});

	it('reads the file on first use when startup has not run', async () => {
		await addHuggingFaceModel(REPO, FILE);
		resetUserLocalModelsForTests();
		expect(listUserLocalModels().map((entry) => entry.id)).toEqual([ID]);
	});

	it('moves a file that is not JSON aside instead of overwriting it', () => {
		fs.writeFileSync(storeFile(), '{ not json');
		hydrateUserLocalModels();
		expect(listUserLocalModels()).toEqual([]);
		expect(fs.existsSync(storeFile())).toBe(false);
		const kept = fs.readdirSync(mocks.dataDir).filter((name) => name.includes('.corrupt-'));
		expect(kept).toHaveLength(1);
		expect(fs.readFileSync(path.join(mocks.dataDir, kept[0]), 'utf-8')).toBe('{ not json');
		expect(mocks.warn).toHaveBeenCalled();
	});

	it('drops a record that was edited into something unusable, and says so', async () => {
		await addHuggingFaceModel(REPO, FILE);
		const file = stored();
		file.models.push({ ...file.models[0], id: '../../escape' });
		fs.writeFileSync(storeFile(), JSON.stringify(file));
		resetUserLocalModelsForTests();

		hydrateUserLocalModels();
		expect(listUserLocalModels().map((entry) => entry.id)).toEqual([ID]);
		expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('Ignored 1'), 'LocalModels');
	});
});
