/**
 * @file engine-installer.test.ts
 *
 * The llama-server install transaction against real archives and no network: a
 * tar.gz for the POSIX layout, a zip for the Windows layout, and a two-asset build
 * for the CUDA case. The pinned table is replaced with synthetic builds so the
 * real streaming download, SHA-256 check, node-tar and zip extraction, and
 * promote-then-commit ordering all run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { zipSync } from 'fflate';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';

const { state, execFileNoThrow } = vi.hoisted(() => ({
	state: { build: null as unknown },
	// The "binary" in these archives is a text file. The device check runs it, so
	// the run is stubbed with what the real CPU build prints.
	execFileNoThrow: vi.fn(async () => ({
		stdout: 'Available devices:\n  (none)\n',
		stderr: '',
		exitCode: 0 as number | string,
	})),
}));

vi.mock('../../../../main/utils/execFile', () => ({ execFileNoThrow }));

vi.mock('../../../../shared/local-models/server-engine', async (importOriginal) => ({
	...(await importOriginal<object>()),
	selectServerBuild: () => state.build,
}));

import {
	installServerEngine,
	ServerBinaryMissingError,
	ServerBuildUnavailableError,
} from '../../../../main/local-models/server/engine-installer';
import {
	installedServerBinary,
	isServerEngineInstalled,
	readServerEngineManifest,
	removeServerEngine,
	serverEngineDir,
	serverEngineStagingDir,
} from '../../../../main/local-models/server/engine-store';
import { RuntimeHashMismatchError } from '../../../../main/local-models/runtime/runtime-installer';

let tempRoot: string;

function sha(bytes: Buffer | Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/** A tar.gz wrapped in one top-level directory, like the real macOS and Linux assets. */
async function tarAsset(
	wrapper: string,
	files: Record<string, string>,
	mode?: number
): Promise<Buffer> {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-tar-'));
	for (const [name, contents] of Object.entries(files)) {
		const target = path.join(source, wrapper, name);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, contents, { mode: mode ?? 0o644 });
	}
	const file = path.join(source, 'asset.tgz');
	await tar.c({ file, cwd: source, gzip: true }, [wrapper]);
	const bytes = await fs.readFile(file);
	await fs.rm(source, { recursive: true, force: true });
	return bytes;
}

/** A flat zip, like the real Windows assets. */
function zipAsset(files: Record<string, string>): Buffer {
	const entries: Record<string, Uint8Array> = {};
	for (const [name, contents] of Object.entries(files)) entries[name] = Buffer.from(contents);
	return Buffer.from(zipSync(entries));
}

/** A fetch that serves a different body per URL. */
function serve(bodies: Record<string, Buffer>): typeof globalThis.fetch {
	return (async (url: string) => {
		const body = bodies[url];
		return {
			ok: body !== undefined,
			status: body ? 200 : 404,
			body: body
				? new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(body));
							controller.close();
						},
					})
				: null,
		} as unknown as Response;
	}) as unknown as typeof globalThis.fetch;
}

function makeBuild(
	assets: Array<{ name: string; bytes: Buffer; format: 'tar.gz' | 'zip' }>,
	over: Record<string, unknown> = {}
) {
	return {
		platform: 'linux-x64',
		kind: 'cpu',
		variant: null,
		label: 'CPU',
		answers: ['default'],
		stripComponents: 1,
		binary: 'llama-server',
		assets: assets.map((entry) => ({
			name: entry.name,
			url: `https://example.test/${entry.name}`,
			sha256: sha(entry.bytes),
			bytes: entry.bytes.length,
			format: entry.format,
		})),
		...over,
	};
}

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-userdata-'));
	process.env.MAESTRO_USER_DATA = tempRoot;
});

afterEach(async () => {
	delete process.env.MAESTRO_USER_DATA;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('installServerEngine', () => {
	it('installs a verified tar.gz, strips the wrapper and makes the binary executable', async () => {
		const bytes = await tarAsset('llama-b0', {
			'llama-server': '#!/bin/sh\n',
			'libllama.so': 'LIB',
		});
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);

		const manifest = await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
		});

		expect(manifest).toMatchObject({ choice: 'default', kind: 'cpu', binary: 'llama-server' });
		expect(await isServerEngineInstalled()).toBe(true);
		const binary = await installedServerBinary();
		expect(binary).toBe(path.join(serverEngineDir(), 'llama-server'));
		expect(await exists(path.join(serverEngineDir(), 'libllama.so'))).toBe(true);
		expect(await exists(path.join(serverEngineDir(), 'llama-b0'))).toBe(false);
		if (process.platform !== 'win32') {
			expect((await fs.stat(binary!)).mode & 0o111).not.toBe(0);
		}
		expect(await exists(serverEngineStagingDir())).toBe(false);
	});

	it('runs the device check against the installed binary and stores its answer', async () => {
		const bytes = await tarAsset('llama-b0', { 'llama-server': '#!/bin/sh\n' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);

		const manifest = await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
		});

		expect(execFileNoThrow).toHaveBeenCalledWith(
			path.join(serverEngineDir(), 'llama-server'),
			['--list-devices'],
			serverEngineDir(),
			expect.objectContaining({ timeout: expect.any(Number) })
		);
		expect(manifest.accelerator).toMatchObject({ status: 'cpu', label: 'CPU', problem: null });
		expect((await readServerEngineManifest())?.accelerator?.label).toBe('CPU');
	});

	it('keeps the install when the device check cannot run the binary', async () => {
		execFileNoThrow.mockResolvedValueOnce({
			stdout: '',
			stderr: 'spawn EACCES',
			exitCode: 'EACCES',
		});
		const bytes = await tarAsset('llama-b0', { 'llama-server': '#!/bin/sh\n' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);

		const manifest = await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
		});

		expect(await isServerEngineInstalled()).toBe(true);
		expect(manifest.accelerator).toMatchObject({ status: 'failed', problem: 'failed-to-run' });
	});

	it('installs a flat zip for a Windows layout', async () => {
		const bytes = zipAsset({ 'llama-server.exe': 'MZ', 'ggml.dll': 'DLL' });
		state.build = makeBuild([{ name: 'w.zip', bytes, format: 'zip' }], {
			platform: 'win32-x64',
			binary: 'llama-server.exe',
			stripComponents: 0,
		});

		await installServerEngine('default', {
			platform: 'win32',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/w.zip': bytes }),
		});

		expect(await exists(path.join(serverEngineDir(), 'llama-server.exe'))).toBe(true);
		expect(await exists(path.join(serverEngineDir(), 'ggml.dll'))).toBe(true);
		expect(await exists(path.join(serverEngineDir(), 'asset-0.zip'))).toBe(false);
	});

	it('records the Windows executable by its .exe name and resolves it inside the install directory', async () => {
		const bytes = zipAsset({ 'llama-server.exe': 'MZ', 'ggml-vulkan.dll': 'DLL' });
		state.build = makeBuild([{ name: 'w.zip', bytes, format: 'zip' }], {
			platform: 'win32-x64',
			kind: 'vulkan',
			label: 'Vulkan',
			binary: 'llama-server.exe',
			stripComponents: 0,
		});

		const manifest = await installServerEngine('default', {
			platform: 'win32',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/w.zip': bytes }),
		});

		expect(manifest).toMatchObject({ platform: 'win32-x64', binary: 'llama-server.exe' });
		expect(await installedServerBinary()).toBe(path.join(serverEngineDir(), 'llama-server.exe'));
	});

	// A zip carries no mode bits and Windows has none to set: `chmod` is for the
	// POSIX layouts only. Checked on a POSIX host, where a wrong call would show.
	it.skipIf(process.platform === 'win32')(
		'leaves the mode of a Windows executable alone',
		async () => {
			const bytes = zipAsset({ 'llama-server.exe': 'MZ' });
			state.build = makeBuild([{ name: 'w.zip', bytes, format: 'zip' }], {
				platform: 'win32-x64',
				binary: 'llama-server.exe',
				stripComponents: 0,
			});

			await installServerEngine('default', {
				platform: 'win32',
				arch: 'arm64',
				fetchImpl: serve({ 'https://example.test/w.zip': bytes }),
			});

			const mode = (await fs.stat(path.join(serverEngineDir(), 'llama-server.exe'))).mode;
			expect(mode & 0o111).toBe(0);
		}
	);

	it.each([
		['a backslash path that climbs out', '..\\..\\evil.dll'],
		['a forward-slash path that climbs out', '../../evil.dll'],
		['a drive-letter path', 'C:\\Windows\\System32\\evil.dll'],
	])('refuses a Windows zip that holds %s, and installs nothing', async (_what, entryName) => {
		const bytes = zipAsset({ 'llama-server.exe': 'MZ', [entryName]: 'EVIL' });
		state.build = makeBuild([{ name: 'w.zip', bytes, format: 'zip' }], {
			platform: 'win32-x64',
			binary: 'llama-server.exe',
			stripComponents: 0,
		});

		await expect(
			installServerEngine('default', {
				platform: 'win32',
				arch: 'x64',
				fetchImpl: serve({ 'https://example.test/w.zip': bytes }),
			})
		).rejects.toThrow(/outside destination/);

		expect(await exists(serverEngineDir())).toBe(false);
		expect(await exists(serverEngineStagingDir())).toBe(false);
		// Two levels above the staging directory is the data folder itself.
		expect(await exists(path.join(tempRoot, 'evil.dll'))).toBe(false);
		expect(await isServerEngineInstalled()).toBe(false);
	});

	it('extracts the two flat zips of a Windows CUDA build into one directory', async () => {
		const main = zipAsset({ 'llama-server.exe': 'MZ', 'ggml-cuda.dll': 'CUDA' });
		const companion = zipAsset({ 'cudart64_12.dll': 'RT', 'cublas64_12.dll': 'BLAS' });
		const build = makeBuild(
			[
				{ name: 'cuda.zip', bytes: main, format: 'zip' },
				{ name: 'cudart.zip', bytes: companion, format: 'zip' },
			],
			{
				platform: 'win32-x64',
				kind: 'cuda',
				label: 'CUDA 12.4',
				binary: 'llama-server.exe',
				stripComponents: 0,
			}
		);
		// The real CUDA zips expand past the zip reader's default cap, so each carries its own.
		state.build = {
			...build,
			assets: build.assets.map((entry) => ({ ...entry, maxExpandedBytes: 3 * 1024 ** 3 })),
		};

		const manifest = await installServerEngine('cuda', {
			platform: 'win32',
			arch: 'x64',
			fetchImpl: serve({
				'https://example.test/cuda.zip': main,
				'https://example.test/cudart.zip': companion,
			}),
		});

		for (const name of [
			'llama-server.exe',
			'ggml-cuda.dll',
			'cudart64_12.dll',
			'cublas64_12.dll',
		]) {
			expect(await exists(path.join(serverEngineDir(), name)), name).toBe(true);
		}
		expect(manifest).toMatchObject({ choice: 'cuda', kind: 'cuda', label: 'CUDA 12.4' });
		expect(manifest.assets.map((entry) => entry.name)).toEqual(['cuda.zip', 'cudart.zip']);
	});

	it('hands an asset its own expansion cap to the zip reader', async () => {
		const bytes = zipAsset({ 'llama-server.exe': 'MZ'.repeat(64) });
		const build = makeBuild([{ name: 'w.zip', bytes, format: 'zip' }], {
			platform: 'win32-x64',
			binary: 'llama-server.exe',
			stripComponents: 0,
		});
		// A cap below the content: a refusal here proves the cap in the table is the one applied.
		state.build = {
			...build,
			assets: build.assets.map((entry) => ({ ...entry, maxExpandedBytes: 16 })),
		};

		await expect(
			installServerEngine('default', {
				platform: 'win32',
				arch: 'x64',
				fetchImpl: serve({ 'https://example.test/w.zip': bytes }),
			})
		).rejects.toThrow(/expanded size exceeds 16 bytes/);
		expect(await isServerEngineInstalled()).toBe(false);
	});

	it('extracts a companion asset into the same directory', async () => {
		const main = await tarAsset('llama-b0', { 'llama-server': 'BIN', 'libggml-cuda.so': 'CUDA' });
		const companion = await tarAsset('cudart-b0', { 'libcudart.so.12': 'RT' });
		state.build = makeBuild([
			{ name: 'main.tar.gz', bytes: main, format: 'tar.gz' },
			{ name: 'cudart.tar.gz', bytes: companion, format: 'tar.gz' },
		]);

		const manifest = await installServerEngine('cuda', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({
				'https://example.test/main.tar.gz': main,
				'https://example.test/cudart.tar.gz': companion,
			}),
		});

		expect(await exists(path.join(serverEngineDir(), 'libggml-cuda.so'))).toBe(true);
		expect(await exists(path.join(serverEngineDir(), 'libcudart.so.12'))).toBe(true);
		expect(manifest.assets.map((entry) => entry.name)).toEqual(['main.tar.gz', 'cudart.tar.gz']);
	});

	it('refuses a hash mismatch and leaves nothing behind', async () => {
		const bytes = await tarAsset('llama-b0', { 'llama-server': 'BIN' });
		const build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);
		build.assets[0].sha256 = 'f'.repeat(64);
		state.build = build;

		await expect(
			installServerEngine('default', {
				platform: 'linux',
				arch: 'x64',
				fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
			})
		).rejects.toBeInstanceOf(RuntimeHashMismatchError);

		expect(await exists(serverEngineDir())).toBe(false);
		expect(await exists(serverEngineStagingDir())).toBe(false);
		expect(await readServerEngineManifest()).toBeNull();
	});

	it('fails by name when the archive lacks the executable it promised', async () => {
		const bytes = await tarAsset('llama-b0', { 'other-tool': 'X' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);

		await expect(
			installServerEngine('default', {
				platform: 'linux',
				arch: 'x64',
				fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
			})
		).rejects.toBeInstanceOf(ServerBinaryMissingError);
		expect(await isServerEngineInstalled()).toBe(false);
	});

	it('refuses a choice with no build, naming the platform and choice', async () => {
		state.build = null;
		await expect(
			installServerEngine('cuda', { platform: 'darwin', arch: 'arm64' })
		).rejects.toThrow(/"cuda" model server build for darwin-arm64/);
		await expect(
			installServerEngine('cuda', { platform: 'darwin', arch: 'arm64' })
		).rejects.toBeInstanceOf(ServerBuildUnavailableError);
	});

	it('replaces an earlier install rather than merging with it', async () => {
		const first = await tarAsset('llama-b0', { 'llama-server': 'OLD', 'stale.so': 'S' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes: first, format: 'tar.gz' }]);
		await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': first }),
		});

		const second = await tarAsset('llama-b1', { 'llama-server': 'NEW' });
		state.build = makeBuild([{ name: 'b.tar.gz', bytes: second, format: 'tar.gz' }]);
		await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/b.tar.gz': second }),
		});

		expect(await exists(path.join(serverEngineDir(), 'stale.so'))).toBe(false);
		expect(await fs.readFile(path.join(serverEngineDir(), 'llama-server'), 'utf8')).toBe('NEW');
	});

	it('calls beforePromote after the new build is verified, while the old one is still in place', async () => {
		const first = await tarAsset('llama-b0', { 'llama-server': 'OLD' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes: first, format: 'tar.gz' }]);
		await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': first }),
		});

		const second = await tarAsset('llama-b1', { 'llama-server': 'NEW' });
		state.build = makeBuild([{ name: 'b.tar.gz', bytes: second, format: 'tar.gz' }]);
		let seenAtPromote: string | null = null;
		await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/b.tar.gz': second }),
			beforePromote: async () => {
				seenAtPromote = await fs.readFile(path.join(serverEngineDir(), 'llama-server'), 'utf8');
			},
		});

		expect(seenAtPromote).toBe('OLD');
		expect(await fs.readFile(path.join(serverEngineDir(), 'llama-server'), 'utf8')).toBe('NEW');
	});

	it('never calls beforePromote for a download that fails verification', async () => {
		const bytes = await tarAsset('llama-b0', { 'llama-server': 'BIN' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);
		const beforePromote = vi.fn(async () => {});

		await expect(
			installServerEngine('default', {
				platform: 'linux',
				arch: 'x64',
				fetchImpl: serve({ 'https://example.test/a.tar.gz': Buffer.from('tampered') }),
				beforePromote,
			})
		).rejects.toThrow();
		expect(beforePromote).not.toHaveBeenCalled();
	});

	it('reports progress ending on done at the full size', async () => {
		const bytes = await tarAsset('llama-b0', { 'llama-server': 'BIN' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);
		const phases: string[] = [];
		let last = { bytes: 0, totalBytes: 0 };

		await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
			onProgress: (progress) => {
				phases.push(progress.phase);
				last = progress;
			},
		});

		expect(phases).toContain('extracting');
		expect(phases.at(-1)).toBe('done');
		expect(last.bytes).toBe(last.totalBytes);
	});
});

describe('the store', () => {
	it('treats a manifest without its binary as not installed', async () => {
		const bytes = await tarAsset('llama-b0', { 'llama-server': 'BIN' });
		state.build = makeBuild([{ name: 'a.tar.gz', bytes, format: 'tar.gz' }]);
		await installServerEngine('default', {
			platform: 'linux',
			arch: 'x64',
			fetchImpl: serve({ 'https://example.test/a.tar.gz': bytes }),
		});
		await fs.rm(path.join(serverEngineDir(), 'llama-server'));

		expect(await readServerEngineManifest()).not.toBeNull();
		expect(await isServerEngineInstalled()).toBe(false);
	});

	it('refuses a manifest whose binary climbs out of the install directory', async () => {
		await fs.mkdir(serverEngineDir(), { recursive: true });
		await fs.writeFile(
			path.join(serverEngineDir(), 'manifest.json'),
			JSON.stringify({ release: 'b0', binary: '../../escape' })
		);
		expect(await installedServerBinary()).toBeNull();
	});

	// The manifest is a file on disk and its `binary` is handed to `spawn`. Each of
	// these names something outside the install directory on Windows, on POSIX, or
	// on both; none may come back as the engine on either.
	it.each(['/bin/sh', 'C:\\Windows\\System32\\cmd.exe', '..\\..\\escape.exe', '..'])(
		'never resolves the manifest binary %j to an executable',
		async (binary) => {
			await fs.mkdir(serverEngineDir(), { recursive: true });
			await fs.writeFile(
				path.join(serverEngineDir(), 'manifest.json'),
				JSON.stringify({ release: 'b11559', binary })
			);
			expect(await installedServerBinary()).toBeNull();
			expect(await isServerEngineInstalled()).toBe(false);
		}
	);

	it('removes the engine and is safe to call twice', async () => {
		await removeServerEngine();
		await removeServerEngine();
		expect(await isServerEngineInstalled()).toBe(false);
	});
});
