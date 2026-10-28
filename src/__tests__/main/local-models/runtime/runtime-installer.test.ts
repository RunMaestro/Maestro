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
		installPath: '',
		keep: ['dist', 'package.json', 'bin/napi-v6/darwin/arm64'],
		entry: 'dist/index.js',
		binary: 'bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
		// Overwritten per test by the dependency cases below.
		dependencies: [] as Array<{
			name: string;
			url: string;
			sha256: string;
			bytes: number;
			installPath?: string;
			keep?: string[];
		}>,
	},
}));

const ENTRY = artifact.entry;
const BINARY = artifact.binary;
const URL = artifact.url;

let tempRoot: string;
let tarballBytes: Buffer;
let tarballSha256: string;

vi.mock('../../../../shared/local-models/runtime-artifacts', async (importOriginal) => ({
	// The pure helpers (install paths, byte totals) are the real ones; only the
	// table is replaced.
	...(await importOriginal<object>()),
	nativeRuntimeArtifact: () => artifact,
	isNativeRuntimeDownloadable: () => true,
	nativeRuntimeDownloadBytes: () => artifact.bytes,
	NATIVE_RUNTIME_ARTIFACTS: [artifact],
}));

import {
	installNativeRuntime,
	RuntimeBinaryMissingError,
	RuntimeHashMismatchError,
} from '../../../../main/local-models/runtime/runtime-installer';
import {
	installedRuntimeEntry,
	isRuntimeInstalled,
	isRuntimeStale,
	readRuntimeManifest,
	removeRuntime,
	runtimeDir,
	runtimeStagingDir,
} from '../../../../main/local-models/runtime/runtime-store';

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
	artifact.dependencies = [];
	artifact.installPath = '';
	artifact.entry = ENTRY;
	artifact.binary = BINARY;
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

	it('extracts the payload into its install path when it names one', async () => {
		// llama's platform payload has to sit where `node-llama-cpp` imports it
		// from, `node_modules/@node-llama-cpp/<platform>`, not at the root.
		artifact.installPath = 'node_modules/@scope/fake-runtime';
		artifact.entry = `${artifact.installPath}/${ENTRY}`;
		artifact.binary = `${artifact.installPath}/${BINARY}`;

		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });
		const root = runtimeDir('onnx');

		expect(await exists(path.join(root, artifact.binary))).toBe(true);
		expect(await exists(path.join(root, ENTRY))).toBe(false);
		expect(await installedRuntimeEntry('onnx')).toBe(path.join(root, artifact.entry));
	});

	it('refuses an install path that climbs out of the install root', async () => {
		artifact.installPath = '../escaped';

		await expect(installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) })).rejects.toThrow(
			/escapes the install root/
		);
		expect(await isRuntimeInstalled('onnx')).toBe(false);
		expect(await exists(path.join(path.dirname(runtimeDir('onnx')), 'escaped'))).toBe(false);
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

	it('refuses to load a runtime installed from an older pin', async () => {
		// The pin moves when the old runtime is wrong, so a stale install must read
		// as not installed rather than load and quietly misbehave.
		const manifestPath = path.join(runtimeDir('onnx'), 'manifest.json');
		const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
		await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, sha256: 'f'.repeat(64) }));

		expect(await installedRuntimeEntry('onnx')).toBeNull();
	});

	it('treats an install whose layout moved as stale, even with the same payload hash', async () => {
		// llama kept its payload hash when its entry point moved into the
		// `node-llama-cpp` dependency. A hash-only check would keep loading the old
		// install's platform shim, which has no getLlama().
		const manifestPath = path.join(runtimeDir('onnx'), 'manifest.json');
		const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
		await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, entry: 'old/index.js' }));

		expect(await installedRuntimeEntry('onnx')).toBeNull();
		expect(await isRuntimeStale('onnx')).toBe(true);
	});

	it('is not stale when the manifest matches the artifact', async () => {
		expect(await isRuntimeStale('onnx')).toBe(false);
	});

	it('uninstalls cleanly', async () => {
		await removeRuntime('onnx');

		expect(await isRuntimeInstalled('onnx')).toBe(false);
		expect(await exists(runtimeDir('onnx'))).toBe(false);
	});

	it('refuses an unknown runtime id rather than turning it into a path', async () => {
		// `runtimeDir` feeds a recursive delete, and ids arrive from IPC.
		expect(() => runtimeDir('../../etc' as never)).toThrow(/UnknownLocalRuntime/);
	});
});

/**
 * A payload's own runtime dependencies.
 *
 * An npm tarball carries a package's files and NOT its dependency tree, so a
 * payload that declares one arrives incomplete. `onnxruntime-node` requires
 * `onnxruntime-common` on the first line of its entry point, and installing
 * without it produces a runtime that extracts cleanly, verifies cleanly, reports
 * itself installed, and then throws MODULE_NOT_FOUND the first time voice tries
 * to transcribe - after the user has waited through a 101 MB download. That is
 * the exact failure these tests exist to prevent.
 */
describe('dependency payloads', () => {
	/** A small pure-JS package, shaped like a real npm tarball. */
	async function buildDependency(
		name: string,
		files: Record<string, string>
	): Promise<{ bytes: Buffer; sha256: string }> {
		const source = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-dep-'));
		for (const [entryName, contents] of Object.entries(files)) {
			const target = path.join(source, entryName);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, contents, 'utf8');
		}
		const tarballPath = path.join(source, `${name}.tgz`);
		await tar.c({ file: tarballPath, cwd: source, gzip: true }, Object.keys(files));
		const bytes = await fs.readFile(tarballPath);
		await fs.rm(source, { recursive: true, force: true });
		return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
	}

	/** Serves the runtime archive first, then each dependency in order. */
	function serveSequence(bodies: Buffer[]): typeof globalThis.fetch {
		let index = 0;
		return (async () => {
			const body = bodies[Math.min(index, bodies.length - 1)];
			index += 1;
			return {
				ok: true,
				status: 200,
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(body));
						controller.close();
					},
				}),
			} as unknown as Response;
		}) as unknown as typeof globalThis.fetch;
	}

	it('installs a dependency where node resolution will find it', async () => {
		// `node_modules/<name>` under the install root, so the loader stays a plain
		// dynamic import with no path rewriting and the tree looks exactly like an
		// `npm install` would have produced.
		const dep = await buildDependency('onnxruntime-common', {
			'package/package.json': '{"name":"onnxruntime-common","main":"dist/index.js"}',
			'package/dist/index.js': 'module.exports = { marker: 1 };',
		});
		artifact.dependencies = [
			{
				name: 'onnxruntime-common',
				url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.27.0.tgz',
				sha256: dep.sha256,
				bytes: dep.bytes.length,
			},
		];

		await installNativeRuntime('onnx', { fetchImpl: serveSequence([tarballBytes, dep.bytes]) });

		const installed = path.join(runtimeDir('onnx'), 'node_modules', 'onnxruntime-common');
		expect(await exists(path.join(installed, 'package.json'))).toBe(true);
		expect(await exists(path.join(installed, 'dist', 'index.js'))).toBe(true);
	});

	it('refuses a dependency whose bytes are not what the catalog promised', async () => {
		// A dependency is code that will be imported into the main process, so it
		// gets exactly the same treatment as the payload itself.
		const dep = await buildDependency('onnxruntime-common', {
			'package/package.json': '{"name":"onnxruntime-common"}',
		});
		artifact.dependencies = [
			{
				name: 'onnxruntime-common',
				url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.27.0.tgz',
				sha256: 'f'.repeat(64),
				bytes: dep.bytes.length,
			},
		];

		await expect(
			installNativeRuntime('onnx', { fetchImpl: serveSequence([tarballBytes, dep.bytes]) })
		).rejects.toBeInstanceOf(RuntimeHashMismatchError);
	});

	it('promotes nothing when a dependency fails, rather than a runtime that cannot import', async () => {
		// The whole reason dependencies install INSIDE the transaction. A promoted
		// install missing its dependency is the worst of both worlds: it reports
		// itself ready and fails at the first utterance.
		artifact.dependencies = [
			{
				name: 'onnxruntime-common',
				url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.27.0.tgz',
				sha256: 'f'.repeat(64),
				bytes: 10,
			},
		];

		await expect(
			installNativeRuntime('onnx', {
				fetchImpl: serveSequence([tarballBytes, Buffer.from('nope')]),
			})
		).rejects.toBeInstanceOf(RuntimeHashMismatchError);

		expect(await isRuntimeInstalled('onnx')).toBe(false);
		expect(await exists(runtimeDir('onnx'))).toBe(false);
		expect(await exists(runtimeStagingDir('onnx'))).toBe(false);
	});

	it('leaves no dependency tarball behind', async () => {
		const dep = await buildDependency('onnxruntime-common', {
			'package/package.json': '{"name":"onnxruntime-common"}',
		});
		artifact.dependencies = [
			{
				name: 'onnxruntime-common',
				url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.27.0.tgz',
				sha256: dep.sha256,
				bytes: dep.bytes.length,
			},
		];

		await installNativeRuntime('onnx', { fetchImpl: serveSequence([tarballBytes, dep.bytes]) });

		const leftovers = (await fs.readdir(runtimeDir('onnx'))).filter((name) =>
			name.endsWith('.tgz')
		);
		expect(leftovers).toEqual([]);
	});

	it('installs a nested dependency where npm would have put it', async () => {
		// npm nests a package under its dependent when a sibling needs another
		// version (`node_modules/ora/node_modules/cli-spinners`); node resolution
		// only finds the right copy if it lands at that exact path.
		const parent = await buildDependency('parent-pkg', {
			'package/package.json': '{"name":"parent-pkg"}',
		});
		const nested = await buildDependency('nested-pkg', {
			'package/package.json': '{"name":"nested-pkg","version":"1.0.0"}',
		});
		artifact.dependencies = [
			{
				name: 'parent-pkg',
				url: 'https://registry.npmjs.org/parent-pkg/-/parent-pkg-2.0.0.tgz',
				sha256: parent.sha256,
				bytes: parent.bytes.length,
			},
			{
				name: 'nested-pkg',
				url: 'https://registry.npmjs.org/nested-pkg/-/nested-pkg-1.0.0.tgz',
				sha256: nested.sha256,
				bytes: nested.bytes.length,
				installPath: 'node_modules/parent-pkg/node_modules/nested-pkg',
			},
		];

		await installNativeRuntime('onnx', {
			fetchImpl: serveSequence([tarballBytes, parent.bytes, nested.bytes]),
		});

		const root = runtimeDir('onnx');
		expect(await exists(path.join(root, 'node_modules/parent-pkg/package.json'))).toBe(true);
		expect(
			await exists(path.join(root, 'node_modules/parent-pkg/node_modules/nested-pkg/package.json'))
		).toBe(true);
		expect(await exists(path.join(root, 'node_modules/nested-pkg'))).toBe(false);
	});

	it('downloads a tarball nested under several dependents once and extracts it everywhere', async () => {
		// npm nests the same version under each dependent that needs it
		// (`ansi-regex@5.0.1` three times for llama). Same URL, same bytes: one fetch.
		const shared = await buildDependency('shared-pkg', {
			'package/package.json': '{"name":"shared-pkg"}',
		});
		const url = 'https://registry.npmjs.org/shared-pkg/-/shared-pkg-5.0.1.tgz';
		artifact.dependencies = ['a', 'b'].map((parent) => ({
			name: 'shared-pkg',
			url,
			sha256: shared.sha256,
			bytes: shared.bytes.length,
			installPath: `node_modules/${parent}/node_modules/shared-pkg`,
		}));
		const requested: string[] = [];
		const inner = serveSequence([tarballBytes, shared.bytes]);
		const fetchImpl = (async (input: string, init?: RequestInit) => {
			requested.push(input);
			return inner(input, init);
		}) as unknown as typeof globalThis.fetch;

		await installNativeRuntime('onnx', { fetchImpl });

		expect(requested.filter((entry) => entry === url)).toHaveLength(1);
		const root = runtimeDir('onnx');
		for (const parent of ['a', 'b']) {
			expect(
				await exists(path.join(root, `node_modules/${parent}/node_modules/shared-pkg/package.json`))
			).toBe(true);
		}
	});

	it("honours a dependency's keep list and installs everything when it has none", async () => {
		// node-llama-cpp carries a 33 MB llama.cpp source bundle nothing on the load
		// path reads; `keep` is how it stays off disk.
		const big = await buildDependency('big-pkg', {
			'package/package.json': '{"name":"big-pkg"}',
			'package/dist/index.js': 'export {};',
			'package/llama/gitRelease.bundle': 'SOURCE',
			'package/llama/grammars/json.gbnf': 'GRAMMAR',
		});
		artifact.dependencies = [
			{
				name: 'big-pkg',
				url: 'https://registry.npmjs.org/big-pkg/-/big-pkg-1.0.0.tgz',
				sha256: big.sha256,
				bytes: big.bytes.length,
				keep: ['dist', 'package.json', 'llama/grammars'],
			},
		];

		await installNativeRuntime('onnx', { fetchImpl: serveSequence([tarballBytes, big.bytes]) });

		const installed = path.join(runtimeDir('onnx'), 'node_modules', 'big-pkg');
		expect(await exists(path.join(installed, 'dist/index.js'))).toBe(true);
		expect(await exists(path.join(installed, 'llama/grammars/json.gbnf'))).toBe(true);
		expect(await exists(path.join(installed, 'llama/gitRelease.bundle'))).toBe(false);
	});

	it('reports one running total across the payload and every dependency', async () => {
		// Per-tarball progress would refill the bar once per dependency, 117 times
		// for llama, whose payload is the smallest download of the set.
		const dep = await buildDependency('onnxruntime-common', {
			'package/package.json': '{"name":"onnxruntime-common"}',
		});
		artifact.dependencies = [
			{
				name: 'onnxruntime-common',
				url: 'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.27.0.tgz',
				sha256: dep.sha256,
				bytes: dep.bytes.length,
			},
		];
		const updates: Array<{ phase: string; bytes: number; totalBytes: number }> = [];

		await installNativeRuntime('onnx', {
			fetchImpl: serveSequence([tarballBytes, dep.bytes]),
			onProgress: (progress) => updates.push(progress),
		});

		const total = tarballBytes.length + dep.bytes.length;
		expect(updates.every((update) => update.totalBytes === total)).toBe(true);
		expect(updates.filter((update) => update.phase === 'verifying')).toHaveLength(1);
		expect(updates[updates.length - 1]).toMatchObject({ phase: 'done', bytes: total });
	});

	it('installs nothing extra when a payload declares no dependencies', async () => {
		artifact.dependencies = [];

		await installNativeRuntime('onnx', { fetchImpl: serve(tarballBytes) });

		expect(await exists(path.join(runtimeDir('onnx'), 'node_modules'))).toBe(false);
	});
});
