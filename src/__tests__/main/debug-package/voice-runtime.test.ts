/**
 * The A Cappella voice-runtime collector.
 *
 * Contracts defended:
 * - With the Encore Feature OFF, the self-test does not run and NO native
 *   runtime is loaded. This is the collector's half of "off means off": the
 *   self-test `dlopen`s every declared inference engine, and a debug package is
 *   built by users who are usually reporting something else entirely.
 * - "Skipped" and "errored" are different fields. A reader of a support package
 *   has to be able to tell "we chose not to run it" from "it ran and blew up".
 * - The static runtime table is reported either way: which binaries this build
 *   expects, on this platform, is the half of the answer worth having with the
 *   feature off.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Store from 'electron-store';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/acappella-voice-runtime-test' },
	systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: vi.fn() },
}));

const selfTest = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../../../main/acappella/runtime/runtime-selftest', () => ({
	runSelfTest: selfTest.run,
}));

import { collectVoiceRuntime } from '../../../main/debug-package/collectors/voice-runtime';

/** The one key this collector reads. */
function storeWith(aCappella: unknown): Store<Record<string, unknown>> {
	return {
		get: (key: string, defaultValue?: unknown) =>
			key === 'encoreFeatures' ? { aCappella } : defaultValue,
	} as unknown as Store<Record<string, unknown>>;
}

const REPORT = {
	ranAt: 1_700_000_000_000,
	platform: 'darwin',
	arch: 'arm64',
	platformKey: 'darwin-arm64',
	entries: [],
	passed: true,
	microphone: { permission: 'granted', canPrompt: false },
};

beforeEach(() => {
	vi.clearAllMocks();
	selfTest.run.mockResolvedValue(REPORT);
});

describe('collectVoiceRuntime', () => {
	it('runs the self-test when the feature is on', async () => {
		const info = await collectVoiceRuntime(storeWith(true));

		expect(selfTest.run).toHaveBeenCalledTimes(1);
		expect(info.enabled).toBe(true);
		expect(info.selfTest).toEqual(REPORT);
		expect(info.selfTestSkipped).toBeUndefined();
		expect(info.microphone.permission).toBe('granted');
	});

	it('loads no native runtime when the feature is off', async () => {
		const info = await collectVoiceRuntime(storeWith(false));

		// The whole point. `runSelfTest` is what dlopens whisper.cpp, llama.cpp, and
		// onnxruntime, and it also populates the loader's process-wide failure memo
		// that the capability gate reads.
		expect(selfTest.run).not.toHaveBeenCalled();
		expect(info.enabled).toBe(false);
		expect(info.selfTest).toBeNull();
		expect(info.selfTestSkipped).toMatch(/Encore Features/);
		expect(info.selfTestError).toBeUndefined();
	});

	it('reports the static runtime table with the feature off', async () => {
		const info = await collectVoiceRuntime(storeWith(false));

		expect(info.runtimes.length).toBeGreaterThan(0);
		for (const runtime of info.runtimes) {
			expect(runtime.id).toEqual(expect.any(String));
			expect(runtime.moduleId).toEqual(expect.any(String));
			expect(runtime.declared).toEqual(expect.any(Boolean));
		}
	});

	it('reports an unknown microphone rather than a guess when the self-test did not run', async () => {
		const info = await collectVoiceRuntime(storeWith(false));

		expect(info.microphone).toEqual({ permission: 'unknown', canPrompt: false });
	});

	it('separates a self-test that blew up from one that was skipped', async () => {
		selfTest.run.mockRejectedValue(new Error('probe exploded'));

		const info = await collectVoiceRuntime(storeWith(true));

		expect(info.selfTestError).toBe('probe exploded');
		expect(info.selfTestSkipped).toBeUndefined();
		expect(info.selfTest).toBeNull();
	});
});
