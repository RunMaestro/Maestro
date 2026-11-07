/**
 * "Run voice self-test" - the core runtime self-test plus the microphone.
 *
 * The runtimes are the core's to probe (`local-models/runtime/runtime-selftest.ts`).
 * What voice adds is the other half of the diagnosis: a voice bug report that
 * says "nothing happens" is as often a refused microphone as a runtime that will
 * not load, and both have to be visible in the same artifact or half the reports
 * name the wrong cause.
 */

import type { MicPermission } from '../../shared/acappella/protocol';
import {
	formatRuntimeSelfTestLines,
	runRuntimeSelfTest,
	type RunRuntimeSelfTestOptions,
	type RuntimeSelfTestReport,
} from '../local-models/runtime/runtime-selftest';
import { getMicPermission } from './permissions/mic-permission';

export interface VoiceSelfTestReport extends RuntimeSelfTestReport {
	microphone: {
		permission: MicPermission;
		/** True when the OS prompt has not been shown yet, so the state is not a refusal. */
		canPrompt: boolean;
	};
}

export interface RunVoiceSelfTestOptions extends RunRuntimeSelfTestOptions {
	/** Injected in tests. Defaults to the real OS query, which never prompts. */
	readMicPermission?: () => { state: MicPermission; canPrompt: boolean };
}

/** Run the voice self-test. Never throws, like the runtime self-test it wraps. */
export async function runVoiceSelfTest(
	options: RunVoiceSelfTestOptions = {}
): Promise<VoiceSelfTestReport> {
	const { readMicPermission, ...runtimeOptions } = options;
	const report = await runRuntimeSelfTest(runtimeOptions);
	const mic =
		readMicPermission?.() ??
		(() => {
			const info = getMicPermission();
			return { state: info.state, canPrompt: info.canPrompt };
		})();
	return { ...report, microphone: { permission: mic.state, canPrompt: mic.canPrompt } };
}

/** The report as lines, for a log or a pasted bug report. */
export function formatVoiceSelfTestReport(report: VoiceSelfTestReport): string {
	return [
		...formatRuntimeSelfTestLines(report, 'A Cappella voice self-test'),
		`  Microphone: ${report.microphone.permission}`,
	].join('\n');
}
