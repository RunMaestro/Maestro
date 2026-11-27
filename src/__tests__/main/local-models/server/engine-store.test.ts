/**
 * @file engine-store.test.ts
 *
 * Verifies atomic server engine manifest writes so a failed or interrupted
 * write never leaves a truncated manifest on disk.
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
				await actual.writeFile(args[0], '{"release":', 'utf8');
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
	readServerEngineManifest,
	serverEngineDir,
	writeServerEngineManifest,
	type ServerEngineManifest,
} from '../../../../main/local-models/server/engine-store';

let tempRoot: string;

function makeManifest(over: Partial<ServerEngineManifest> = {}): ServerEngineManifest {
	return {
		release: 'b11559',
		platform: 'linux-x64',
		choice: 'default',
		kind: 'vulkan',
		label: 'Vulkan',
		assets: [],
		binary: 'llama-server',
		installedAt: 1,
		bytes: 100,
		...over,
	};
}

beforeEach(async () => {
	writeState.failNextTempWrite = false;
	writeState.failNextRename = false;
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-store-userdata-'));
	process.env.MAESTRO_USER_DATA = tempRoot;
});

afterEach(async () => {
	delete process.env.MAESTRO_USER_DATA;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('writeServerEngineManifest', () => {
	it('writes and reads back a valid manifest', async () => {
		const manifest = makeManifest({ installedAt: 42 });
		await writeServerEngineManifest(manifest);

		expect(await readServerEngineManifest()).toEqual(manifest);
	});

	it('leaves no manifest when the first write fails mid-flight', async () => {
		writeState.failNextTempWrite = true;

		await expect(writeServerEngineManifest(makeManifest())).rejects.toThrow(/ENOSPC/);
		expect(await readServerEngineManifest()).toBeNull();
		const entries = await fs.readdir(serverEngineDir());
		expect(entries).toEqual([]);
	});

	it('preserves the previous manifest intact when a subsequent write fails mid-flight', async () => {
		const previous = makeManifest({ release: 'b11559', installedAt: 10 });
		await writeServerEngineManifest(previous);

		writeState.failNextTempWrite = true;
		await expect(
			writeServerEngineManifest(makeManifest({ release: 'b11600', installedAt: 20 }))
		).rejects.toThrow(/ENOSPC/);

		expect(await readServerEngineManifest()).toEqual(previous);
		const entries = await fs.readdir(serverEngineDir());
		expect(entries).toEqual(['manifest.json']);
	});

	it('preserves the previous manifest intact when rename fails', async () => {
		const previous = makeManifest({ release: 'b11559', installedAt: 10 });
		await writeServerEngineManifest(previous);

		writeState.failNextRename = true;
		await expect(
			writeServerEngineManifest(makeManifest({ release: 'b11600', installedAt: 20 }))
		).rejects.toThrow(/EIO/);

		expect(await readServerEngineManifest()).toEqual(previous);
		const entries = await fs.readdir(serverEngineDir());
		expect(entries).toEqual(['manifest.json']);
	});
});
