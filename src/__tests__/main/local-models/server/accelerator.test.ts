/**
 * @file accelerator.test.ts
 *
 * The device check that runs `llama-server --list-devices`: it never throws, it
 * hands the run to the shared classifier, and the recheck stores the new answer
 * in the engine manifest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
	checkServerAccelerator,
	recheckServerAccelerator,
} from '../../../../main/local-models/server/accelerator';
import {
	readServerEngineManifest,
	serverEngineDir,
	writeServerEngineManifest,
	type ServerEngineManifest,
} from '../../../../main/local-models/server/engine-store';
import { needsWindowsShell } from '../../../../main/utils/execFile';

const METAL = 'Available devices:\n  MTL0: Apple M5 Max (110100 MiB, 110099 MiB free)\n';
const NONE = 'Available devices:\n  (none)\n';

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'accelerator-userdata-'));
	process.env.MAESTRO_USER_DATA = tempRoot;
});

afterEach(async () => {
	delete process.env.MAESTRO_USER_DATA;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

async function installFakeEngine(over: Partial<ServerEngineManifest> = {}): Promise<string> {
	const binary = path.join(serverEngineDir(), 'llama-server');
	await fs.mkdir(serverEngineDir(), { recursive: true });
	await fs.writeFile(binary, '#!/bin/sh\n');
	await writeServerEngineManifest({
		release: 'b11559',
		platform: 'linux-x64',
		choice: 'default',
		kind: 'vulkan',
		label: 'Vulkan',
		assets: [],
		binary: 'llama-server',
		installedAt: 1,
		bytes: 1,
		...over,
	});
	return binary;
}

describe('checkServerAccelerator', () => {
	it('runs the binary it was given and classifies the output', async () => {
		const runListDevices = vi.fn(async () => ({ stdout: METAL, stderr: '', exitCode: 0 }));
		const report = await checkServerAccelerator('/opt/My Apps/llama-server', 'metal', {
			runListDevices,
			platform: 'darwin',
			arch: 'arm64',
		});
		expect(runListDevices).toHaveBeenCalledWith('/opt/My Apps/llama-server');
		expect(report).toMatchObject({ status: 'gpu', label: 'Metal (Apple M5 Max)' });
	});

	it('turns a runner that throws into a failed report instead of throwing', async () => {
		const report = await checkServerAccelerator('/missing', 'vulkan', {
			runListDevices: async () => {
				throw new Error('spawn ENOENT');
			},
			platform: 'win32',
			arch: 'x64',
		});
		expect(report).toMatchObject({
			status: 'failed',
			problem: 'failed-to-run',
			detail: 'spawn ENOENT',
			offerCpuBuild: true,
		});
	});
});

describe('the device check on Windows', () => {
	// The check runs the binary through the shared exec helper, which decides
	// from the path alone whether Windows needs a shell. An `.exe` never does, so
	// a path with spaces is one argument to `CreateProcess` and nothing in it is
	// read by a shell.
	it('needs no shell for the installed .exe, whatever its path holds', () => {
		for (const binary of [
			'C:\\Users\\Pat Doe\\AppData\\Roaming\\Maestro\\runtimes\\llama-server\\llama-server.exe',
			'D:\\Maestro Data (2)\\runtimes\\llama-server\\LLAMA-SERVER.EXE',
			'\\\\fileserver\\profiles\\pat\\Maestro\\runtimes\\llama-server\\llama-server.exe',
		]) {
			expect(needsWindowsShell(binary), binary).toBe(false);
		}
	});
});

describe('the Vulkan build on a Linux machine with no Vulkan loader', () => {
	const NOT_FOUND = 'cannot open shared object file: No such file or directory';

	it('reports a binary that cannot start for want of libvulkan, and offers the CPU build', async () => {
		const report = await checkServerAccelerator('/opt/maestro/llama-server', 'vulkan', {
			runListDevices: async () => ({
				stdout: '',
				stderr: `llama-server: error while loading shared libraries: libvulkan.so.1: ${NOT_FOUND}\n`,
				// What a shell and Node both report for a dynamic loader failure.
				exitCode: 127,
			}),
			platform: 'linux',
			arch: 'x64',
		});
		expect(report).toMatchObject({
			status: 'failed',
			label: 'Unavailable',
			problem: 'vulkan-loader-missing',
			offerCpuBuild: true,
		});
		expect(report.detail).toContain('libvulkan.so.1');
	});

	it('reports a server that runs on the CPU because its Vulkan backend did not load', async () => {
		const report = await checkServerAccelerator('/opt/maestro/llama-server', 'vulkan', {
			runListDevices: async () => ({
				stdout: NONE,
				stderr: `load_backend: failed to load /opt/maestro/libggml-vulkan.so: libvulkan.so.1: ${NOT_FOUND}\n`,
				exitCode: 0,
			}),
			platform: 'linux',
			arch: 'arm64',
		});
		expect(report).toMatchObject({
			status: 'cpu',
			label: 'CPU',
			problem: 'vulkan-loader-missing',
			offerCpuBuild: true,
		});
	});

	it('records the finding with the engine and swaps nothing', async () => {
		await installFakeEngine();

		const report = await recheckServerAccelerator({
			runListDevices: async () => ({
				stdout: '',
				stderr: `llama-server: error while loading shared libraries: libvulkan.so.1: ${NOT_FOUND}\n`,
				exitCode: 127,
			}),
			platform: 'linux',
			arch: 'x64',
		});

		expect(report?.problem).toBe('vulkan-loader-missing');
		// The user chose this build. It is reported and the CPU build is offered;
		// the installed build and the choice stay what they were.
		expect(await readServerEngineManifest()).toMatchObject({
			choice: 'default',
			kind: 'vulkan',
			label: 'Vulkan',
			binary: 'llama-server',
			accelerator: { problem: 'vulkan-loader-missing', offerCpuBuild: true },
		});
	});
});

describe('recheckServerAccelerator', () => {
	it('returns null when no engine is installed', async () => {
		expect(await recheckServerAccelerator({ runListDevices: vi.fn() })).toBeNull();
	});

	it('stores the new answer in the manifest and keeps the rest of it', async () => {
		const binary = await installFakeEngine();
		const runListDevices = vi.fn(async () => ({ stdout: NONE, stderr: '', exitCode: 0 }));

		const report = await recheckServerAccelerator({
			runListDevices,
			platform: 'linux',
			arch: 'x64',
		});

		expect(runListDevices).toHaveBeenCalledWith(binary);
		expect(report).toMatchObject({ status: 'cpu', problem: 'no-gpu-device', offerCpuBuild: true });
		const manifest = await readServerEngineManifest();
		expect(manifest).toMatchObject({ kind: 'vulkan', installedAt: 1 });
		expect(manifest?.accelerator).toEqual(report);
	});
});
