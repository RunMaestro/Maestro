/**
 * @file runtime-installer.test.ts
 *
 * The install transaction, driven end to end against a real tarball with no
 * network. Everything here is offline and deterministic: the archive is built in
 * a temp directory, hashed, and handed back through an injected `fetch`, so the
 * test exercises the real streaming download, the real SHA-256 comparison, the
 * real node-tar extraction, and the real promote-and-commit ordering.
 *
 * The properties worth protecting, each of which was a design decision rather
 * than an accident:
 *
 *   - Nothing appears at the install path until the manifest is written, so a
 *     failure part-way through can never look like a finished install.
 *   - A hash mismatch is fatal and leaves no bytes behind, because the payload is
 *     code that will later be dlopen'd.
 *   - Only the running platform's subtree is written, which is the entire reason
 *     a 101 MB download costs 37 MB of disk.
 *   - A reinstall REPLACES rather than merges, so a stale binary cannot outlive
 *     the version that shipped it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';

/**
 * A synthetic payload shaped like the real ONNX Runtime tarball: an npm root, a
 * little JavaScript, the platform we want, a platform we do not, and a file
 * outside every kept prefix.
 */
const ARCHIVE_FILES: Record<string, string> = {
	'package/package.json': '{"name":"fake-runtime","main":"dist/index.js"}',
	'package/dist/index.js': 'module.exports = {};',
	'package/bin/napi-v6/darwin/arm64/onnxruntime_binding.node': 'ARM64 BINDING',
	'package/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib': 'ARM64 DYLIB',
	'package/bin/napi-v6/win32/x64/onnxruntime_binding.node': 'WINDOWS BINDING',
	'package/bin/napi-v6/win32/x64/onnxruntime.dll': 'WINDOWS DLL',
	'package/README.md': 'not kept',
};

/**
 * The artifact the store and installer see, mutated per test.
 *
 * Hoisted because `vi.mock` factories run before the module body, and a factory
 * that closed over an ordinary `const` would read it before initialisation.
 */
const { artifact } = vi.hoisted(() => ({
	artifact: {
		runtimeId: 'onnx' as const,
		platform: 'darwin-arm64' as const,
		url: 'https://registry.npmjs.org/fake-runtime/-/fake-runtime-1.27.0.tgz',
		sha256: '',
		bytes: 0,
		stripComponents: 1,
		keep: ['dist', 'package.json', 'bin/napi-v6/darwin/arm64'],
		entry: 'dist/index.js',
		binary: 'bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
	},
}));

const ENTRY = artifact.entry;
const BINARY = artifact.binary;
const URL = artifact.url;

let tempRoot: string;
let tarballBytes: Buffer;
let tarballSha256: string;

vi.mock('../../../../shared/acappella/runtime-artifacts', () => ({
	nativeRuntimeArtifact: () => artifact,
	isNativeRuntimeDownloadable: () => true,
	nativeRuntimeDownloadBytes: () => artifact.bytes,
	NATIVE_RUNTIME_ARTIFACTS: [artifact],
}));

import {
	installNativeRuntime,
	RuntimeBinaryMissingError,
	RuntimeHashMismatchError,
} from '../../../../main/acappella/runtime/runtime-installer';
import {
	installedRuntimeEntry,
	isRuntimeInstalled,
	readRuntimeManifest,
	removeRuntime,
	runtimeDir,
	runtimeStagingDir,
} from '../../../../main/acappella/runtime/runtime-store';

/** Build the archive once per test run; it is deterministic. */
async function buildTarball(): Promise<void> {
	const source = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-archive-'));
	for (const [name, contents] of Object.entries(ARCHIVE_FILES)) {
		const target = path.join(source, name);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, contents, 'utf8');
	}

	const tarballPath = path.join(source, 'payload.tgz');
	await tar.c(
		{ file: tarballPath, cwd: source, gzip: true },
		Object.keys(ARCHIVE_FILES).map((name) => name)
	);
	tarballBytes = await fs.readFile(tarballPath);
	tarballSha256 = createHash('sha256').update(tarballBytes).digest('hex');
	await fs.rm(source, { recursive: true, force: true });
}

/** An injected fetch that serves the archive, or whatever bytes it is given. */
function serve(body: Buffer, status = 200): typeof globalThis.fetch {
	return (async () =>
		({
			ok: status >= 200 && status < 300,
			status,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(body));
					controller.close();
				},
			}),
		}) as unknown as Response) as unknown as typeof globalThis.fetch;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-userdata-'));
	// The store reads this before it reaches for Electron, which is what lets the
	// whole transaction run in a test with no app instance.
	process.env.MAESTRO_USER_DATA = tempRoot;
	await buildTarball();
	artifact.sha256 = tarballSha256;
	artifact.bytes = tarballBytes.length;
});

afterEach(async () => {
	delete process.env.MAESTRO_USER_DATA;
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('installNativeRuntime', () => {
	it('installs a verified payload and reports it as installed', async () => {
		expect(await isRuntimeInstalled('onnx')).toBe(false);

		const manifest = await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });

		expect(manifest.runtimeId).toBe('onnx');
		expect(manifest.sha256).toBe(tarballSha256);
		expect(manifest.version).toBe('1.27.0');
		expect(await isRuntimeInstalled('onnx')).toBe(true);
	});

	it('writes only the running platform, discarding the rest of the archive', async () => {
		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		const root = runtimeDir('onnx');

		expect(await exists(path.join(root, BINARY))).toBe(true);
		expect(await exists(path.join(root, 'bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib'))).toBe(
			true
		);
		expect(await exists(path.join(root, ENTRY))).toBe(true);

		// The point of the whole exercise.
		expect(await exists(path.join(root, 'bin/napi-v6/win32'))).toBe(false);
		expect(await exists(path.join(root, 'README.md'))).toBe(false);
	});

	it('removes the tarball once it has been unpacked', async () => {
		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		expect(await exists(path.join(runtimeDir('onnx'), 'payload.tgz'))).toBe(false);
	});

	it('leaves no staging directory behind on success', async () => {
		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		expect(await exists(runtimeStagingDir('onnx'))).toBe(false);
	});

	it('resolves the entry point to an absolute path that exists', async () => {
		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		const entry = await installedRuntimeEntry('onnx');

		expect(entry).toBeTruthy();
		expect(path.isAbsolute(entry!)).toBe(true);
		expect(await exists(entry!)).toBe(true);
	});

	it('records a footprint that is the extracted size, not the download size', async () => {
		const manifest = await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		// Every kept file is tiny here, but the property under test is that the
		// number is measured from disk rather than copied from the catalog.
		expect(manifest.bytes).toBeGreaterThan(0);
		expect(manifest.bytes).not.toBe(artifact.bytes);
	});

	it('refuses a payload whose hash does not match, and keeps nothing', async () => {
		const tampered = Buffer.concat([tarballBytes, Buffer.from('extra')]);

		await expect(
			installNativeRuntime('onnx', { fetchImpl: serve(tampered) })
		).rejects.toBeInstanceOf(RuntimeHashMismatchError);

		expect(await isRuntimeInstalled('onnx')).toBe(false);
		expect(await exists(runtimeStagingDir('onnx'))).toBe(false);
		expect(await exists(runtimeDir('onnx'))).toBe(false);
	});

	it('reports both hashes on a mismatch, so a support report can be acted on', async () => {
		const tampered = Buffer.concat([tarballBytes, Buffer.from('extra')]);
		const actualHash = createHash('sha256').update(tampered).digest('hex');

		await expect(
			installNativeRuntime('onnx', { fetchImpl: serve(tampered) })
		).rejects.toMatchObject({ expected: tarballSha256, actual: actualHash });
	});

	it('fails when the archive verifies but does not contain the promised binary', async () => {
		// The archive is genuine and its hash is right; the artifact simply points
		// at a file that is not in it. Without this check the install would
		// "succeed" and die later inside a dlopen.
		artifact.binary = 'bin/napi-v6/darwin/arm64/not-in-the-archive.node';

		await expect(
			installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) })
		).rejects.toBeInstanceOf(RuntimeBinaryMissingError);

		expect(await isRuntimeInstalled('onnx')).toBe(false);
		artifact.binary = BINARY;
	});

	it('fails on a non-OK response without leaving a staging directory', async () => {
		await expect(
			installNativeRuntime('onnx', { fetchImpl: serve(Buffer.from(''), 404) })
		).rejects.toThrow(/404/);

		expect(await exists(runtimeStagingDir('onnx'))).toBe(false);
	});

	it('replaces a previous install rather than merging into it', async () => {
		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });

		// A file from an imaginary older version, sitting where the new payload
		// does not put one. A merge would leave it; a replace removes it.
		const stale = path.join(runtimeDir('onnx'), 'bin/napi-v6/darwin/arm64/old-engine.dylib');
		await fs.writeFile(stale, 'previous version', 'utf8');
		expect(await exists(stale)).toBe(true);

		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		expect(await exists(stale)).toBe(false);
		expect(await isRuntimeInstalled('onnx')).toBe(true);
	});

	it('clears the wreckage of a killed install before starting a new one', async () => {
		const staging = runtimeStagingDir('onnx');
		await fs.mkdir(staging, { recursive: true });
		await fs.writeFile(path.join(staging, 'half-written.tgz'), 'junk', 'utf8');

		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });

		expect(await isRuntimeInstalled('onnx')).toBe(true);
		expect(await exists(path.join(runtimeDir('onnx'), 'half-written.tgz'))).toBe(false);
	});

	it('emits progress that ends in the done phase', async () => {
		const phases: string[] = [];
		await installNativeRuntime('onnx', {
			fetchImpl: serve(tarballBytes),
			onProgress: (progress) => phases.push(progress.phase),
		});

		expect(phases).toContain('verifying');
		expect(phases[phases.length - 1]).toBe('done');
	});
});

describe('runtime store, after an install', () => {
	beforeEach(async () => {
		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
	});

	it('round-trips the manifest', async () => {
		const manifest = await readRuntimeManifest('onnx');
		expect(manifest).toMatchObject({
			runtimeId: 'onnx',
			platform: 'darwin-arm64',
			sourceUrl: URL,
			entry: ENTRY,
			binary: BINARY,
		});
	});

	it('reports not-installed once the binary is gone, manifest notwithstanding', async () => {
		// The manifest is a claim about the past; the binary is what a dlopen
		// needs. A store that trusted the manifest alone would send the loader at
		// a file that is not there.
		await fs.rm(path.join(runtimeDir('onnx'), BINARY));

		expect(await isRuntimeInstalled('onnx')).toBe(false);
		expect(await installedRuntimeEntry('onnx')).toBeNull();
	});

	it('uninstalls cleanly', async () => {
		await removeRuntime('onnx');

		expect(await isRuntimeInstalled('onnx')).toBe(false);
		expect(await exists(runtimeDir('onnx'))).toBe(false);
	});

	it('refuses an unknown runtime id rather than turning it into a path', async () => {
		// `runtimeDir` feeds a recursive delete, and ids arrive from IPC.
		expect(() => runtimeDir('../../etc' as never)).toThrow(/UnknownVoiceRuntime/);
	});
});
