/**
 * @file storage-migration.test.ts
 *
 * The legacy-root migration moves gigabytes the user already paid bandwidth for.
 * These tests pin that it never loses or overwrites a byte across the four states
 * a data dir can be in: fresh install, untouched legacy tree, a tree a crash left
 * half-moved, and a target that already exists.
 *
 * Runs against a real temp directory: rename and rmdir semantics are the thing
 * under test, so mocking `fs` would test the mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tempRoot = { dir: '' };

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger }));

import {
	migrateLegacyLocalModelStorage,
	migrateLegacyRoot,
} from '../../../main/local-models/storage-migration';
import { modelsRoot } from '../../../main/local-models/model-store';
import { runtimesRoot } from '../../../main/local-models/runtime/runtime-store';

async function writeFile(target: string, contents: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, contents);
}

async function readText(target: string): Promise<string> {
	return fs.readFile(target, 'utf-8');
}

async function exists(target: string): Promise<boolean> {
	return fs
		.stat(target)
		.then(() => true)
		.catch(() => false);
}

describe('local model storage migration', () => {
	const originalUserData = process.env.MAESTRO_USER_DATA;
	let models: string;
	let runtimes: string;

	beforeEach(async () => {
		tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-local-models-migration-'));
		delete process.env.MAESTRO_USER_DATA;
		models = path.join(tempRoot.dir, 'models');
		runtimes = path.join(tempRoot.dir, 'runtimes');
		vi.clearAllMocks();
	});

	afterEach(async () => {
		if (originalUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = originalUserData;
		await fs.rm(tempRoot.dir, { recursive: true, force: true });
	});

	it('the stores read from the new roots', () => {
		expect(modelsRoot()).toBe(models);
		expect(runtimesRoot()).toBe(runtimes);
	});

	it('is a no-op on a fresh install', async () => {
		const results = await migrateLegacyLocalModelStorage(tempRoot.dir);

		expect(results.map((r) => r.moved)).toEqual([[], []]);
		expect(results.map((r) => r.skipped)).toEqual([[], []]);
		expect(await exists(models)).toBe(false);
		expect(await exists(runtimes)).toBe(false);
		expect(logger.info).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('moves every model and runtime up and removes the empty legacy roots', async () => {
		await writeFile(path.join(models, 'acappella', 'whisper', 'model.onnx'), 'whisper bytes');
		await writeFile(path.join(models, 'acappella', 'whisper', 'manifest.json'), '{"id":"whisper"}');
		await writeFile(path.join(models, 'acappella', 'kokoro', 'voice.bin.part'), 'partial');
		await writeFile(
			path.join(runtimes, 'acappella', 'onnx', 'manifest.json'),
			'{"runtimeId":"onnx"}'
		);

		const [modelResult, runtimeResult] = await migrateLegacyLocalModelStorage(tempRoot.dir);

		expect(modelResult.moved.sort()).toEqual(['kokoro', 'whisper']);
		expect(modelResult.removedLegacyRoot).toBe(true);
		expect(runtimeResult.moved).toEqual(['onnx']);
		expect(runtimeResult.removedLegacyRoot).toBe(true);

		expect(await readText(path.join(models, 'whisper', 'model.onnx'))).toBe('whisper bytes');
		expect(await readText(path.join(models, 'whisper', 'manifest.json'))).toBe('{"id":"whisper"}');
		// An interrupted download moves too, so Resume still finds its bytes.
		expect(await readText(path.join(models, 'kokoro', 'voice.bin.part'))).toBe('partial');
		expect(await readText(path.join(runtimes, 'onnx', 'manifest.json'))).toBe(
			'{"runtimeId":"onnx"}'
		);
		expect(await exists(path.join(models, 'acappella'))).toBe(false);
		expect(await exists(path.join(runtimes, 'acappella'))).toBe(false);
		expect(logger.info).toHaveBeenCalledTimes(3);
	});

	it('finishes a tree a crash left half-moved', async () => {
		// A previous run moved whisper, then the app died before kokoro.
		await writeFile(path.join(models, 'whisper', 'model.onnx'), 'whisper bytes');
		await writeFile(path.join(models, 'acappella', 'kokoro', 'voice.bin'), 'kokoro bytes');

		const result = await migrateLegacyRoot(models);

		expect(result.moved).toEqual(['kokoro']);
		expect(result.skipped).toEqual([]);
		expect(result.removedLegacyRoot).toBe(true);
		expect(await readText(path.join(models, 'whisper', 'model.onnx'))).toBe('whisper bytes');
		expect(await readText(path.join(models, 'kokoro', 'voice.bin'))).toBe('kokoro bytes');
	});

	it('leaves the legacy copy alone and logs it when the target already exists', async () => {
		await writeFile(path.join(models, 'whisper', 'model.onnx'), 'new install');
		await writeFile(path.join(models, 'acappella', 'whisper', 'model.onnx'), 'legacy install');
		await writeFile(path.join(models, 'acappella', 'kokoro', 'voice.bin'), 'kokoro bytes');

		const result = await migrateLegacyRoot(models);

		expect(result.moved).toEqual(['kokoro']);
		expect(result.skipped).toEqual(['whisper']);
		// Neither install is overwritten or deleted.
		expect(await readText(path.join(models, 'whisper', 'model.onnx'))).toBe('new install');
		expect(await readText(path.join(models, 'acappella', 'whisper', 'model.onnx'))).toBe(
			'legacy install'
		);
		// The legacy root still holds bytes, so it stays.
		expect(result.removedLegacyRoot).toBe(false);
		expect(await exists(path.join(models, 'acappella'))).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('already exists'),
			'LocalModels'
		);
	});

	it('is idempotent across repeated runs', async () => {
		await writeFile(path.join(runtimes, 'acappella', 'llama', 'manifest.json'), '{}');

		await migrateLegacyLocalModelStorage(tempRoot.dir);
		const second = await migrateLegacyLocalModelStorage(tempRoot.dir);

		expect(second.map((r) => r.moved)).toEqual([[], []]);
		expect(await readText(path.join(runtimes, 'llama', 'manifest.json'))).toBe('{}');
	});

	it('defaults to the Maestro data dir', async () => {
		await writeFile(path.join(models, 'acappella', 'whisper', 'model.onnx'), 'bytes');

		await migrateLegacyLocalModelStorage();

		expect(await readText(path.join(models, 'whisper', 'model.onnx'))).toBe('bytes');
	});
});
