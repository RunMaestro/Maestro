/**
 * A Cappella Voice Runtime Collector
 *
 * Answers "voice does not work" with facts instead of a guess. A voice failure
 * has at least four independent causes that look identical from the outside: the
 * Encore Feature is off, the microphone permission is denied, a native runtime
 * will not load in this build, or a model is missing. Every one of them is here,
 * in one file, so a support report does not need a round trip per hypothesis.
 *
 * The self-test loads each native runtime and runs a trivial operation against
 * it. It loads no model and touches no audio device, so generating a debug
 * package stays a read-only act.
 *
 * Privacy: no paths, no device names, no audio, no keys. Runtime ids, platform,
 * timings, and a permission string.
 */

import Store from 'electron-store';

import {
	NATIVE_RUNTIMES,
	nativePlatformKey,
	type NativePrebuildAvailability,
} from '../../../shared/acappella/native-runtimes';
import type { MicPermission } from '../../../shared/acappella/protocol';
import { runSelfTest, type RuntimeSelfTestReport } from '../../acappella/runtime/runtime-selftest';

export interface VoiceRuntimeInfo {
	/** The Encore Feature. When false, none of the rest is expected to work. */
	enabled: boolean;
	microphone: {
		permission: MicPermission;
		/** True when the OS prompt has not been shown yet: not a refusal. */
		canPrompt: boolean;
	};
	runtimes: Array<{
		id: string;
		moduleId: string;
		versionPin: string;
		/** Whether the package is a dependency of this build at all. */
		declared: boolean;
		/** How the binary is meant to arrive on THIS platform. */
		prebuild: NativePrebuildAvailability | 'unsupported-platform';
		requiresElectronRebuild: boolean;
	}>;
	/** Null when the self-test could not run at all. */
	selfTest: RuntimeSelfTestReport | null;
	selfTestError?: string;
}

/** Read the A Cappella Encore flag without importing the whole settings surface. */
function isEnabled(settingsStore: Store<any>): boolean {
	const flags = (settingsStore.get('encoreFeatures', {}) ?? {}) as Record<string, unknown>;
	return flags.aCappella === true;
}

export async function collectVoiceRuntime(settingsStore: Store<any>): Promise<VoiceRuntimeInfo> {
	const platformKey = nativePlatformKey(process.platform, process.arch);

	const runtimes = NATIVE_RUNTIMES.map((runtime) => ({
		id: runtime.id,
		moduleId: runtime.moduleId,
		versionPin: runtime.versionPin,
		declared: runtime.declared,
		prebuild: platformKey ? runtime.prebuilds[platformKey] : ('unsupported-platform' as const),
		requiresElectronRebuild: runtime.requiresElectronRebuild,
	}));

	let selfTest: RuntimeSelfTestReport | null = null;
	let selfTestError: string | undefined;
	try {
		selfTest = await runSelfTest();
	} catch (error) {
		// runSelfTest is written not to throw, so this is belt and braces: a
		// diagnostic that takes the whole debug package down with it would remove
		// the one artifact the user was trying to produce.
		selfTestError = error instanceof Error ? error.message : String(error);
	}

	return {
		enabled: isEnabled(settingsStore),
		microphone: selfTest
			? selfTest.microphone
			: { permission: 'unknown' as MicPermission, canPrompt: false },
		runtimes,
		selfTest,
		selfTestError,
	};
}
