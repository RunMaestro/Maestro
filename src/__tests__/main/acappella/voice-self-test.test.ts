/**
 * @file voice-self-test.test.ts
 *
 * The voice self-test is the core runtime self-test plus the microphone. The
 * runtime rows are the core's tests; what is asserted here is the half voice
 * adds, because a voice bug report that hides a refused microphone names the
 * wrong cause.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/acappella-voice-selftest-test' },
	shell: { openExternal: vi.fn() },
	systemPreferences: {
		getMediaAccessStatus: () => 'granted',
		askForMediaAccess: vi.fn(),
	},
}));

import {
	formatVoiceSelfTestReport,
	runVoiceSelfTest,
} from '../../../main/acappella/voice-self-test';
import type { NativeRuntimeResult } from '../../../main/local-models/runtime/native-loader';
import type { NativeRuntimeId } from '../../../shared/local-models/native-runtimes';

const WORKING_MODULES: Record<NativeRuntimeId, unknown> = {
	llama: { getLlama: async () => ({ gpu: 'metal', dispose: async () => undefined }) },
	onnx: { InferenceSession: {}, env: { versions: { common: '1.27.0' } } },
};

async function loadAll(id: NativeRuntimeId): Promise<NativeRuntimeResult<unknown>> {
	return { ok: true, module: WORKING_MODULES[id] };
}

describe('voice-self-test', () => {
	it('runs every runtime and carries the microphone permission', async () => {
		const report = await runVoiceSelfTest({
			loadRuntime: loadAll,
			readMicPermission: () => ({ state: 'denied', canPrompt: false }),
		});

		expect(report.entries.map((entry) => entry.runtimeId)).toEqual(['llama', 'onnx']);
		expect(report.passed).toBe(true);
		expect(report.microphone).toEqual({ permission: 'denied', canPrompt: false });
	});

	it('formats one artifact holding the runtimes and the microphone', async () => {
		const report = await runVoiceSelfTest({
			loadRuntime: loadAll,
			readMicPermission: () => ({ state: 'denied', canPrompt: false }),
		});

		const text = formatVoiceSelfTestReport(report);
		expect(text).toContain('A Cappella voice self-test on');
		expect(text).toContain('PASS');
		expect(text).toContain('node-llama-cpp');
		expect(text).toContain('Microphone: denied');
	});
});
