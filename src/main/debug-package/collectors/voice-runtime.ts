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
 * It is skipped entirely while the Encore Feature is off, and that is a rule
 * rather than an optimisation. "A Cappella off means no native module loads" has
 * to hold structurally: it is true today only because no runtime is a declared
 * dependency yet, so the loader declines before it imports anything. The moment
 * the real runtimes ship, an ungated self-test would `dlopen` three inference
 * engines every time anybody built a debug package for a feature they had never
 * switched on - and it would populate the loader's process-wide failure memo,
 * which the capability gate reads, on their behalf.
 *
 * The static runtime table is still reported either way. That is the half of the
 * answer worth having with the feature off: which binaries this build expects,
 * on this platform, and how they are meant to arrive.
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
import { isACappellaEnabled } from '../../../shared/acappella/feature-flag';
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
	/** Null when the self-test did not run. `selfTestSkipped` or `selfTestError` says why. */
	selfTest: RuntimeSelfTestReport | null;
	selfTestError?: string;
	/**
	 * Why the self-test was deliberately not run. Distinct from `selfTestError`,
	 * which means it ran and blew up: a reader of a support package has to be able
	 * to tell "we chose not to" from "it broke".
	 */
	selfTestSkipped?: string;
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

	const enabled = isACappellaEnabled(settingsStore);

	let selfTest: RuntimeSelfTestReport | null = null;
	let selfTestError: string | undefined;
	let selfTestSkipped: string | undefined;
	if (!enabled) {
		selfTestSkipped =
			'A Cappella is switched off in Encore Features, so no native runtime was loaded.';
	} else {
		try {
			selfTest = await runSelfTest();
		} catch (error) {
			// runSelfTest is written not to throw, so this is belt and braces: a
			// diagnostic that takes the whole debug package down with it would remove
			// the one artifact the user was trying to produce.
			selfTestError = error instanceof Error ? error.message : String(error);
		}
	}

	return {
		enabled,
		microphone: selfTest
			? selfTest.microphone
			: { permission: 'unknown' as MicPermission, canPrompt: false },
		runtimes,
		selfTest,
		selfTestError,
		selfTestSkipped,
	};
}
