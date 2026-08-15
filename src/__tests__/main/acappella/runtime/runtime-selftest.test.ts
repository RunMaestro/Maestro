/**
 * @file runtime-selftest.test.ts
 *
 * The self-test is what a support report carries instead of "voice does not
 * work". So the things worth asserting are the ones that would make that report
 * misleading: a runtime that is not part of the build reading as broken, a
 * failure taking the whole diagnostic down with it, or a hung load turning the
 * diagnostic into a second copy of the bug being diagnosed.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/acappella-selftest-test' },
	shell: { openExternal: vi.fn() },
	systemPreferences: {
		getMediaAccessStatus: () => 'granted',
		askForMediaAccess: vi.fn(),
	},
}));

import {
	runSelfTest,
	formatSelfTestReport,
} from '../../../../main/acappella/runtime/runtime-selftest';
import type { NativeRuntimeResult } from '../../../../main/acappella/runtime/native-loader';
import type { NativeRuntimeId } from '../../../../shared/acappella/native-runtimes';

/** Module surfaces the real probes accept. */
const WORKING_MODULES: Record<NativeRuntimeId, unknown> = {
	llama: { getLlama: () => undefined },
	whisper: { Whisper: function Whisper() {} },
	onnx: { InferenceSession: {}, env: { versions: { common: '1.27.0' } } },
};

function loader(
	behaviour: Partial<Record<NativeRuntimeId, 'pass' | 'fail' | 'skip' | 'bad-surface' | 'hang'>>
) {
	return async (id: NativeRuntimeId): Promise<NativeRuntimeResult<unknown>> => {
		const mode = behaviour[id] ?? 'pass';
		if (mode === 'hang') return new Promise(() => undefined);
		if (mode === 'bad-surface') return { ok: true, module: {} };
		if (mode === 'pass') return { ok: true, module: WORKING_MODULES[id] };
		return {
			ok: false,
			error: {
				kind: 'runtime-unavailable',
				runtimeId: id,
				moduleId: `mock-${id}`,
				platform: 'darwin',
				arch: 'arm64',
				failure: mode === 'skip' ? 'not-a-dependency' : 'load-failed',
				message: mode === 'skip' ? 'not part of this build yet' : 'dlopen failed',
				suggestedAction: 'do the thing',
				detail: mode === 'skip' ? undefined : 'symbol not found',
			},
		};
	};
}

const mic = () => ({ state: 'granted' as const, canPrompt: false });

describe('runtime-selftest', () => {
	it('reports every registered runtime, in registry order', async () => {
		const report = await runSelfTest({ loadRuntime: loader({}), readMicPermission: mic });

		expect(report.entries.map((entry) => entry.runtimeId)).toEqual(['llama', 'whisper', 'onnx']);
		expect(report.entries.every((entry) => entry.status === 'pass')).toBe(true);
		expect(report.passed).toBe(true);
	});

	it('reports a per-runtime failure without failing the others', async () => {
		const report = await runSelfTest({
			loadRuntime: loader({ whisper: 'fail' }),
			readMicPermission: mic,
		});

		const whisper = report.entries.find((entry) => entry.runtimeId === 'whisper')!;
		expect(whisper.status).toBe('fail');
		expect(whisper.failure).toBe('load-failed');
		// The underlying cause travels: a support report with "it failed" in it is
		// the same as no support report.
		expect(whisper.detail).toContain('symbol not found');

		expect(report.entries.find((entry) => entry.runtimeId === 'llama')?.status).toBe('pass');
		expect(report.passed).toBe(false);
	});

	it('skips a runtime that is not part of the build rather than calling it broken', async () => {
		const report = await runSelfTest({
			loadRuntime: loader({ whisper: 'skip' }),
			readMicPermission: mic,
		});

		expect(report.entries.find((entry) => entry.runtimeId === 'whisper')?.status).toBe('skipped');
		// A skip is not a failure. Reporting it as one would send someone hunting a
		// bug that does not exist.
		expect(report.passed).toBe(true);
	});

	it('fails a runtime that loads but has lost the API the provider calls', async () => {
		const report = await runSelfTest({
			loadRuntime: loader({ onnx: 'bad-surface' }),
			readMicPermission: mic,
		});

		const onnx = report.entries.find((entry) => entry.runtimeId === 'onnx')!;
		expect(onnx.status).toBe('fail');
		expect(onnx.failure).toBe('probe-failed');
		expect(onnx.detail).toContain('InferenceSession');
	});

	it('reports the probe detail on success, so a version reaches the report', async () => {
		const report = await runSelfTest({ loadRuntime: loader({}), readMicPermission: mic });
		expect(report.entries.find((entry) => entry.runtimeId === 'onnx')?.detail).toContain('1.27.0');
	});

	it('times out instead of hanging, which is the bug it is diagnosing', async () => {
		const report = await runSelfTest({
			loadRuntime: loader({ llama: 'hang' }),
			readMicPermission: mic,
			timeoutMs: 20,
		});

		const llama = report.entries.find((entry) => entry.runtimeId === 'llama')!;
		expect(llama.status).toBe('fail');
		expect(llama.failure).toBe('timeout');
	});

	it('records timings from the injected clock', async () => {
		let clock = 1000;
		const report = await runSelfTest({
			loadRuntime: loader({}),
			readMicPermission: mic,
			now: () => (clock += 5),
		});

		expect(report.entries.every((entry) => entry.durationMs > 0)).toBe(true);
		expect(report.ranAt).toBeGreaterThan(1000);
	});

	it('carries the microphone permission, because it is the other half of the diagnosis', async () => {
		const report = await runSelfTest({
			loadRuntime: loader({}),
			readMicPermission: () => ({ state: 'denied', canPrompt: false }),
		});

		expect(report.microphone.permission).toBe('denied');
		// A microphone problem must be visible in the same artifact as a runtime
		// problem, or half the reports name the wrong cause.
		expect(formatSelfTestReport(report)).toContain('Microphone: denied');
	});

	it('formats a report that names each runtime and its verdict', async () => {
		const report = await runSelfTest({
			loadRuntime: loader({ whisper: 'fail' }),
			readMicPermission: mic,
		});

		const text = formatSelfTestReport(report);
		expect(text).toContain('FAIL');
		expect(text).toContain('PASS');
		expect(text).toContain('node-llama-cpp');
	});
});
