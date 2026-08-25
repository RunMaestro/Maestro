/**
 * @file acappella-native-runtimes.test.ts
 *
 * The registry is read by four consumers that cannot see each other: the lazy
 * loader, the self-test, the capability gate, and a packaging script that runs
 * after electron-builder on a machine nobody is watching. Every test here exists
 * because a mismatch between the table and reality shows up as a signed release
 * that dies on launch, which is the most expensive failure mode this codebase
 * has.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
	NATIVE_PLATFORM_KEYS,
	NATIVE_RUNTIMES,
	getNativeRuntime,
	nativeAsarUnpackGlobs,
	nativePlatformKey,
	runtimesForSlot,
} from '../../shared/acappella/native-runtimes';

function readPackageJson(): {
	dependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	build?: { asarUnpack?: string[]; mac?: { extendInfo?: Record<string, string> } };
} {
	return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
}

describe('native runtime registry', () => {
	it('pins an exact version for every runtime', () => {
		// A range is how a native dependency silently changes its ABI, its prebuild
		// matrix, or its binary layout between two builds of the same tag.
		for (const runtime of NATIVE_RUNTIMES) {
			expect(runtime.versionPin).toMatch(/^\d+\.\d+\.\d+/);
			expect(runtime.versionPin).not.toMatch(/[\^~*x]/);
		}
	});

	it('covers every shipped platform for every runtime', () => {
		for (const runtime of NATIVE_RUNTIMES) {
			for (const key of NATIVE_PLATFORM_KEYS) {
				expect(runtime.prebuilds[key]).toBeDefined();
				expect(runtime.packagedBinaries[key]).toBeDefined();
			}
		}
	});

	it('keeps `declared` in step with package.json dependencies', () => {
		// The one fact this table gets wrong most easily. A runtime marked declared
		// that is not installed makes the loader report a broken install; an
		// installed runtime marked undeclared makes the loader refuse to load
		// something that is sitting right there.
		const deps = readPackageJson().dependencies ?? {};
		for (const runtime of NATIVE_RUNTIMES) {
			expect(
				runtime.declared,
				`${runtime.moduleId}: registry says declared=${runtime.declared}, package.json says ${
					runtime.moduleId in deps ? 'present' : 'absent'
				}`
			).toBe(runtime.moduleId in deps);
		}
	});

	it('pins the version package.json actually installs, when it installs one', () => {
		const deps = readPackageJson().dependencies ?? {};
		for (const runtime of NATIVE_RUNTIMES) {
			const installed = deps[runtime.moduleId];
			if (!installed) continue;
			expect(installed).toBe(runtime.versionPin);
		}
	});

	it('has every asarUnpack glob present in the electron-builder config', () => {
		// A .node file inside app.asar cannot be dlopen'd. This is the check that
		// catches a runtime added to the registry but never added to the build.
		const configured = readPackageJson().build?.asarUnpack ?? [];
		for (const glob of nativeAsarUnpackGlobs()) {
			expect(configured, `missing asarUnpack entry: ${glob}`).toContain(glob);
		}
	});

	it('marks a runtime as needing electron-rebuild only if the postinstall rebuilds it', () => {
		const postinstall = readPackageJson().scripts?.postinstall ?? '';
		for (const runtime of NATIVE_RUNTIMES) {
			if (!runtime.requiresElectronRebuild) continue;
			expect(
				postinstall,
				`${runtime.moduleId} needs an Electron ABI rebuild but is not in the postinstall list`
			).toContain(runtime.moduleId);
		}
	});

	it('records a microphone usage description that names the feature and the local path', () => {
		// Apple requires the string; a user deciding whether to grant the microphone
		// requires it to say something true. "Maestro would like to access the
		// microphone" answers neither question.
		const description =
			readPackageJson().build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? '';
		expect(description).toContain('A Cappella');
		expect(description.toLowerCase()).toContain('local');
	});

	it('resolves platform keys, and rejects platforms with no installer', () => {
		expect(nativePlatformKey('darwin', 'arm64')).toBe('darwin-arm64');
		expect(nativePlatformKey('win32', 'x64')).toBe('win32-x64');
		expect(nativePlatformKey('linux', 'arm64')).toBeNull();
		expect(nativePlatformKey('sunos', 'sparc')).toBeNull();
	});

	it('maps every voice slot that has a local tier to a runtime', () => {
		expect(runtimesForSlot('brain').map((runtime) => runtime.id)).toEqual(['llama']);
		expect(runtimesForSlot('stt').map((runtime) => runtime.id)).toEqual(['whisper']);
		// One ONNX Runtime serves both, which is the point of picking it.
		expect(runtimesForSlot('tts').map((runtime) => runtime.id)).toEqual(['onnx']);
		expect(runtimesForSlot('wake-word').map((runtime) => runtime.id)).toEqual(['onnx']);
		expect(runtimesForSlot('microphone')).toEqual([]);
	});

	it('is addressable by id and frozen against mutation', () => {
		expect(getNativeRuntime('llama')?.moduleId).toBe('node-llama-cpp');
		expect(getNativeRuntime('nope' as 'llama')).toBeUndefined();
		expect(Object.isFrozen(NATIVE_RUNTIMES)).toBe(true);
		expect(Object.isFrozen(NATIVE_RUNTIMES[0])).toBe(true);
	});
});
