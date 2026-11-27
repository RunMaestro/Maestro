/**
 * @file runtime-store.test.ts
 *
 * Verifies atomic runtime manifest writes so a failed or interrupted write
 * never leaves a truncated manifest on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const writeState = vi.hoisted(() => ({
	failNextTempWrite: false,
	failNextRename: false,
}));

vi.mock('fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs/promises')>();
	return {
		...actual,
		writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
			if (writeState.failNextTempWrite && String(args[0]).endsWith('.tmp')) {
				writeState.failNextTempWrite = false;
				// Simulate a partial write followed by ENOSPC before failing.
				await actual.writeFile(args[0], '{"runtimeId":', 'utf8');
				const err = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
				throw err;
			}
			return actual.writeFile(...args);
		}),
		rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
			if (writeState.failNextRename) {
				writeState.failNextRename = false;
				const err = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
				throw err;
			}
			return actual.rename(...args);
		}),
	};
});

import {
	readRuntimeManifest,
	runtimeDir,
	writeRuntimeManifest,
	type RuntimeManifest,
} from '../../../../main/local-models/runtime/runtime-store';

let tempRoot: string;
let previousUserData: string | undefined;

function makeManifest(over: Partial<RuntimeManifest> = {}): RuntimeManifest {
	return {
		runtimeId: 'onnx',
		version: '1.21.0',
		platform: 'linux-x64',
		sourceUrl: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.21.0.tgz',
		sha256: 'a'.repeat(64),
		entry: 'dist/index.js',
		binary: 'bin/napi-v6/linux/x64/onnxruntime_binding.node',
		installedAt: 1,
		bytes: 100,
		...over,
	};
}

beforeEach(async () => {
	writeState.failNextTempWrite = false;
	writeState.failNextRename = false;
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-store-userdata-'));
	previousUserData = process.env.MAESTRO_USER_DATA;
	process.env.MAESTRO_USER_DATA = tempRoot;
});

afterEach(async () => {
	if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = previousUserData;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('writeRuntimeManifest', () => {
	it('writes and reads back a valid manifest', async () => {
		const manifest = makeManifest({ installedAt: 42 });
		await writeRuntimeManifest('onnx', manifest);

		expect(await readRuntimeManifest('onnx')).toEqual(manifest);
	});

	it('leaves no manifest when the first write fails mid-flight', async () => {
		writeState.failNextTempWrite = true;

		await expect(writeRuntimeManifest('onnx', makeManifest())).rejects.toThrow(/ENOSPC/);
		expect(await readRuntimeManifest('onnx')).toBeNull();
		const entries = await fs.readdir(runtimeDir('onnx'));
		expect(entries).toEqual([]);
	});

	it('preserves the previous manifest intact when a subsequent write fails mid-flight', async () => {
		const previous = makeManifest({ version: '1.20.0', installedAt: 10 });
		await writeRuntimeManifest('onnx', previous);

		writeState.failNextTempWrite = true;
		await expect(
			writeRuntimeManifest('onnx', makeManifest({ version: '1.21.0', installedAt: 20 }))
		).rejects.toThrow(/ENOSPC/);

		expect(await readRuntimeManifest('onnx')).toEqual(previous);
		const entries = await fs.readdir(runtimeDir('onnx'));
		expect(entries).toEqual(['manifest.json']);
	});

	it('preserves the previous manifest intact when rename fails', async () => {
		const previous = makeManifest({ version: '1.20.0', installedAt: 10 });
		await writeRuntimeManifest('onnx', previous);

		writeState.failNextRename = true;
		await expect(
			writeRuntimeManifest('onnx', makeManifest({ version: '1.21.0', installedAt: 20 }))
		).rejects.toThrow(/EIO/);

		expect(await readRuntimeManifest('onnx')).toEqual(previous);
		const entries = await fs.readdir(runtimeDir('onnx'));
		expect(entries).toEqual(['manifest.json']);
	});

	it('serializes concurrent writes without leaving a partial manifest or temp files', async () => {
		const writes = Array.from({ length: 20 }, (_, index) =>
			writeRuntimeManifest('onnx', makeManifest({ installedAt: 1_000 + index }))
		);
		await Promise.all(writes);

		const read = await readRuntimeManifest('onnx');
		expect(read).not.toBeNull();
		expect(read?.runtimeId).toBe('onnx');
		const entries = await fs.readdir(runtimeDir('onnx'));
		expect(entries).toEqual(['manifest.json']);
	});
});
