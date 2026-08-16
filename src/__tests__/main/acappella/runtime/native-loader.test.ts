/**
 * @file native-loader.test.ts
 *
 * The loader has three promises, and every one of them is invisible in
 * development and expensive in production:
 *
 *   1. Nothing native is imported until someone asks for it. A user with the
 *      Encore Feature off must not pay a single dlopen, and the way that breaks
 *      is a static import added anywhere else in the codebase, so the first test
 *      here scans the source rather than the runtime.
 *   2. A failure comes back structured. A dlopen error string in front of a user
 *      is a bug report with no information in it.
 *   3. A failed load never takes the app down.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A stand-in registry.
 *
 * The real one has every runtime at `declared: false` (the packages land with
 * the providers in Phase 05), so testing the load paths against it would only
 * ever exercise the not-a-dependency branch. This mock keeps the same shape and
 * the same helper behaviour with one declared and one undeclared runtime.
 */
vi.mock('../../../../shared/acappella/native-runtimes', () => {
	const runtimes = [
		{
			id: 'llama',
			moduleId: 'fake-llama',
			versionPin: '1.0.0',
			label: 'Fake llama',
			slots: ['brain'],
			declared: true,
			requiresElectronRebuild: false,
			prebuilds: {
				'darwin-arm64': 'prebuilt',
				'darwin-x64': 'prebuilt',
				'win32-x64': 'prebuilt',
				'linux-x64': 'prebuilt',
			},
			asarUnpack: [],
			packagedBinaries: {
				'darwin-arm64': [],
				'darwin-x64': [],
				'win32-x64': [],
				'linux-x64': [],
			},
			rationale: '',
			notes: '',
		},
		{
			id: 'whisper',
			moduleId: 'fake-whisper',
			versionPin: '1.0.0',
			label: 'Fake whisper',
			slots: ['stt'],
			declared: false,
			requiresElectronRebuild: false,
			prebuilds: {
				'darwin-arm64': 'source-build',
				'darwin-x64': 'source-build',
				'win32-x64': 'source-build',
				'linux-x64': 'source-build',
			},
			asarUnpack: [],
			packagedBinaries: {
				'darwin-arm64': [],
				'darwin-x64': [],
				'win32-x64': [],
				'linux-x64': [],
			},
			rationale: '',
			notes: '',
		},
		{
			id: 'onnx',
			moduleId: 'fake-onnx',
			versionPin: '1.0.0',
			label: 'Fake onnx',
			slots: ['tts', 'wake-word'],
			declared: true,
			requiresElectronRebuild: false,
			// Deliberately shipped nowhere, to exercise the unsupported-platform path.
			prebuilds: {
				'darwin-arm64': 'unavailable',
				'darwin-x64': 'unavailable',
				'win32-x64': 'unavailable',
				'linux-x64': 'unavailable',
			},
			asarUnpack: [],
			packagedBinaries: {
				'darwin-arm64': [],
				'darwin-x64': [],
				'win32-x64': [],
				'linux-x64': [],
			},
			rationale: '',
			notes: '',
		},
	];

	return {
		NATIVE_RUNTIMES: runtimes,
		getNativeRuntime: (id: string) => runtimes.find((runtime) => runtime.id === id),
		nativePlatformKey: (platform: string, arch: string) => {
			const key = `${platform}-${arch}`;
			return ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].includes(key) ? key : null;
		},
	};
});

import {
	NativeRuntimeUnavailableError,
	__setNativeImporter,
	allNativeRuntimeFailures,
	describeRuntimeUnavailable,
	isNativeRuntimeLoaded,
	knownNativeRuntimeUnavailability,
	lastNativeRuntimeFailure,
	loadNativeRuntime,
	resetNativeRuntimes,
	tryLoadNativeRuntime,
	unloadNativeRuntime,
} from '../../../../main/acappella/runtime/native-loader';

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

function setPlatform(platform: string, arch: string): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	Object.defineProperty(process, 'arch', { value: arch, configurable: true });
}

function moduleNotFound(): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error("Cannot find module 'fake-llama'");
	error.code = 'MODULE_NOT_FOUND';
	return error;
}

describe('native-loader', () => {
	beforeEach(() => {
		resetNativeRuntimes();
		setPlatform('darwin', 'arm64');
	});

	afterEach(() => {
		__setNativeImporter(null);
		resetNativeRuntimes();
		setPlatform(REAL_PLATFORM, REAL_ARCH);
	});

	describe('lazy loading', () => {
		it('imports nothing until a runtime is asked for', async () => {
			const importer = vi.fn().mockResolvedValue({});
			__setNativeImporter(importer);

			// Importing this module, and reading the registry through it, must not
			// have reached the module system.
			expect(importer).not.toHaveBeenCalled();
			expect(isNativeRuntimeLoaded('llama')).toBe(false);

			await tryLoadNativeRuntime('llama');
			expect(importer).toHaveBeenCalledWith('fake-llama');
		});

		it('loads a runtime once, however many callers ask', async () => {
			const importer = vi.fn().mockResolvedValue({ marker: 1 });
			__setNativeImporter(importer);

			const [first, second] = await Promise.all([
				loadNativeRuntime<{ marker: number }>('llama'),
				loadNativeRuntime<{ marker: number }>('llama'),
			]);

			expect(first).toBe(second);
			expect(importer).toHaveBeenCalledTimes(1);
		});

		it('is the only module in the codebase that imports a native runtime', () => {
			// The runtime invariant cannot be observed at runtime: a stray top-level
			// `import 'node-llama-cpp'` in some provider would break the "Encore off
			// costs nothing" property silently and permanently. So the source itself
			// is the assertion.
			const roots = ['src/main', 'src/renderer', 'src/shared', 'src/cli'];
			const nativeModules = ['node-llama-cpp', 'smart-whisper', 'onnxruntime-node'];
			const offenders: string[] = [];

			for (const root of roots) {
				for (const file of walkTypeScript(path.resolve(process.cwd(), root))) {
					const source = fs.readFileSync(file, 'utf8');
					for (const moduleId of nativeModules) {
						// A static import or require of the package by name. The loader
						// reaches these through a variable specifier, so it never matches.
						const staticImport = new RegExp(
							`(from\\s+['"]${moduleId}['"])|(require\\(['"]${moduleId}['"]\\))|(import\\(['"]${moduleId}['"]\\))`
						);
						if (staticImport.test(source)) offenders.push(`${file} -> ${moduleId}`);
					}
				}
			}

			expect(offenders).toEqual([]);
		});
	});

	describe('structured failures', () => {
		it('reports a missing module with the runtime, module, platform, and cause', async () => {
			__setNativeImporter(vi.fn().mockRejectedValue(moduleNotFound()));

			const result = await tryLoadNativeRuntime('llama');

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe('runtime-unavailable');
			expect(result.error.failure).toBe('module-not-found');
			expect(result.error.runtimeId).toBe('llama');
			expect(result.error.moduleId).toBe('fake-llama');
			expect(result.error.platform).toBe('darwin');
			expect(result.error.arch).toBe('arm64');
			expect(result.error.detail).toContain('Cannot find module');
			// Never a bare dlopen string: there is always a sentence and a next step.
			expect(result.error.message).not.toBe('');
			expect(result.error.suggestedAction).not.toBe('');
		});

		it('classifies an arbitrary load error as load-failed, keeping the cause', async () => {
			__setNativeImporter(
				vi.fn().mockRejectedValue(new Error('dlopen(libggml.dylib): symbol not found'))
			);

			const result = await tryLoadNativeRuntime('llama');

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.failure).toBe('load-failed');
			expect(result.error.detail).toContain('symbol not found');
		});

		it('names the Visual C++ redistributable when Windows cannot find a dependent DLL', async () => {
			setPlatform('win32', 'x64');
			__setNativeImporter(
				vi
					.fn()
					.mockRejectedValue(
						new Error('\\\\?\\C:\\app\\llama-addon.node: The specified module could not be found.')
					)
			);

			const result = await tryLoadNativeRuntime('llama');

			expect(result.ok).toBe(false);
			if (result.ok) return;
			// Windows names the addon rather than the DLL it actually wanted, so the
			// raw message reads like a corrupt install and sends the user to reinstall
			// the app, which changes nothing.
			expect(result.error.suggestedAction).toContain('Visual C++ Redistributable');
		});

		it('says "not a dependency" without touching the module system', async () => {
			const importer = vi.fn();
			__setNativeImporter(importer);

			const result = await tryLoadNativeRuntime('whisper');

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.failure).toBe('not-a-dependency');
			// The distinction that matters: this is not a broken install, so nothing
			// was attempted and nothing should be reinstalled.
			expect(importer).not.toHaveBeenCalled();
		});

		it('says "unsupported platform" for a runtime with no build here', async () => {
			const importer = vi.fn();
			__setNativeImporter(importer);

			const result = await tryLoadNativeRuntime('onnx');

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.failure).toBe('unsupported-platform');
			expect(importer).not.toHaveBeenCalled();
		});

		it('reports an unknown platform/arch pair as unsupported rather than crashing', async () => {
			setPlatform('sunos', 'sparc');
			__setNativeImporter(vi.fn());

			const result = await tryLoadNativeRuntime('llama');

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.failure).toBe('unsupported-platform');
			expect(result.error.message).toContain('sunos-sparc');
		});

		it('formats a failure as one line for a log or support report', () => {
			const line = describeRuntimeUnavailable({
				kind: 'runtime-unavailable',
				runtimeId: 'llama',
				moduleId: 'fake-llama',
				platform: 'darwin',
				arch: 'arm64',
				failure: 'load-failed',
				message: 'Fake llama failed to load.',
				suggestedAction: 'Run the self-test.',
				detail: 'symbol not found',
			});

			expect(line).toContain('fake-llama');
			expect(line).toContain('load-failed');
			expect(line).toContain('symbol not found');
		});
	});

	describe('a failed load does not crash the app', () => {
		it('never rejects from tryLoadNativeRuntime', async () => {
			__setNativeImporter(vi.fn().mockRejectedValue(new Error('boom')));
			await expect(tryLoadNativeRuntime('llama')).resolves.toMatchObject({ ok: false });
		});

		it('throws a typed error from loadNativeRuntime, carrying the same structure', async () => {
			__setNativeImporter(vi.fn().mockRejectedValue(moduleNotFound()));

			await expect(loadNativeRuntime('llama')).rejects.toBeInstanceOf(
				NativeRuntimeUnavailableError
			);
			await expect(loadNativeRuntime('llama')).rejects.toMatchObject({
				info: { failure: 'module-not-found', moduleId: 'fake-llama' },
			});
		});

		it('reports an unknown runtime id instead of throwing', async () => {
			const result = await tryLoadNativeRuntime('nope' as 'llama');
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.message).toContain('Unknown native runtime');
		});
	});

	describe('remembered failures', () => {
		it('remembers the last failure so the capability gate can explain it without loading', async () => {
			__setNativeImporter(vi.fn().mockRejectedValue(new Error('boom')));
			await tryLoadNativeRuntime('llama');

			expect(lastNativeRuntimeFailure('llama')?.failure).toBe('load-failed');
			expect(allNativeRuntimeFailures()).toHaveLength(1);
		});

		it('retries after a failure rather than replaying it forever', async () => {
			const importer = vi
				.fn()
				.mockRejectedValueOnce(new Error('boom'))
				.mockResolvedValueOnce({ ok: true });
			__setNativeImporter(importer);

			expect((await tryLoadNativeRuntime('llama')).ok).toBe(false);
			// The user installed the missing piece; the next attempt must be real.
			expect((await tryLoadNativeRuntime('llama')).ok).toBe(true);
			expect(importer).toHaveBeenCalledTimes(2);
			expect(lastNativeRuntimeFailure('llama')).toBeNull();
		});

		it('forgets a runtime on unload so a later load is a fresh attempt', async () => {
			const importer = vi.fn().mockResolvedValue({});
			__setNativeImporter(importer);

			await tryLoadNativeRuntime('llama');
			expect(isNativeRuntimeLoaded('llama')).toBe(true);

			unloadNativeRuntime('llama');
			expect(isNativeRuntimeLoaded('llama')).toBe(false);

			await tryLoadNativeRuntime('llama');
			expect(importer).toHaveBeenCalledTimes(2);
		});
	});

	/**
	 * The question a capability gate actually has is "will this work here", not
	 * "has this already gone wrong here". Answering the second one in place of the
	 * first is how readiness came back "everything satisfied" on a fresh boot for
	 * runtimes that are not in the build at all, and the opposite answer once
	 * anything had attempted a load.
	 */
	describe('known unavailability, without loading', () => {
		it('reports a runtime that is not a dependency before anything tries it', () => {
			const importer = vi.fn();
			__setNativeImporter(importer);

			const verdict = knownNativeRuntimeUnavailability('whisper');

			expect(verdict?.failure).toBe('not-a-dependency');
			expect(importer).not.toHaveBeenCalled();
		});

		it('reports a platform with no build before anything tries it', () => {
			setPlatform('darwin', 'arm64');

			// `onnx` is declared but shipped nowhere in the stand-in registry.
			expect(knownNativeRuntimeUnavailability('onnx')?.failure).toBe('unsupported-platform');
		});

		it('is null for a runtime that should load', () => {
			setPlatform('darwin', 'arm64');

			expect(knownNativeRuntimeUnavailability('llama')).toBeNull();
		});

		it('prefers what actually happened over what the registry predicts', async () => {
			setPlatform('darwin', 'arm64');
			__setNativeImporter(vi.fn().mockRejectedValue(new Error('boom')));
			await tryLoadNativeRuntime('llama');

			expect(knownNativeRuntimeUnavailability('llama')?.failure).toBe('load-failed');
		});

		it('does not record a failure nobody hit', () => {
			knownNativeRuntimeUnavailability('whisper');

			// Asking must not put anything in the support report: the debug package
			// lists failures that HAPPENED, not answers to hypothetical questions.
			expect(allNativeRuntimeFailures()).toHaveLength(0);
			expect(lastNativeRuntimeFailure('whisper')).toBeNull();
		});
	});
});

/** Every .ts/.tsx file under a directory, skipping the test tree itself. */
function walkTypeScript(dir: string, out: string[] = []): string[] {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkTypeScript(full, out);
		else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
	}
	return out;
}
