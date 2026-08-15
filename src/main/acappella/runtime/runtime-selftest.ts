/**
 * "Run voice self-test" - the answer to a bug report that says voice does not
 * work.
 *
 * Without this, that report is a guess: the microphone, three native runtimes,
 * four model downloads, and a code-signing story all fail in ways that look
 * identical from the outside ("nothing happens when I press the button"). The
 * self-test loads each runtime the way the real providers will, runs a trivial
 * operation against it, and reports per-runtime pass/fail with timings, plus the
 * microphone permission, in one structure that goes straight into a support
 * report through the debug package.
 *
 * Three properties it must keep:
 *
 *   - **It proves the load path, not a stub.** Each probe goes through
 *     `native-loader.ts`, so a self-test that passes means the same dlopen the
 *     provider will do actually succeeded in this installation, on this
 *     platform, from this code-signed bundle.
 *   - **It loads no model.** A probe touches the module's own surface (its
 *     version, its constructor) and nothing on disk. A self-test that needed
 *     1.4 GB of models could not be run by the person who most needs to run it.
 *   - **It cannot hang.** Every probe races a timeout, because "the button did
 *     nothing" is precisely the bug being diagnosed, and a diagnostic that
 *     reproduces it is not a diagnostic.
 */

import {
	NATIVE_RUNTIMES,
	nativePlatformKey,
	type NativePlatformKey,
	type NativePrebuildAvailability,
	type NativeRuntimeDescriptor,
	type NativeRuntimeId,
} from '../../../shared/acappella/native-runtimes';
import type { MicPermission } from '../../../shared/acappella/protocol';
import { getMicPermission } from '../permissions/mic-permission';
import {
	tryLoadNativeRuntime,
	unloadNativeRuntime,
	type NativeRuntimeFailureKind,
	type NativeRuntimeResult,
} from './native-loader';

/**
 * `skipped` is not a soft failure: it means the runtime is not part of this
 * build yet, which is a true and useful thing for a support report to say. It is
 * reported separately from `fail` so a bug report cannot read as three broken
 * runtimes when nothing is broken.
 */
export type RuntimeSelfTestStatus = 'pass' | 'fail' | 'skipped';

export interface RuntimeSelfTestEntry {
	runtimeId: NativeRuntimeId;
	moduleId: string;
	label: string;
	status: RuntimeSelfTestStatus;
	/** Wall-clock for the load plus the probe. The number that shows a slow dlopen. */
	durationMs: number;
	/** What the probe found (a version string) or why it failed. */
	detail?: string;
	failure?: NativeRuntimeFailureKind | 'probe-failed' | 'timeout';
	/** How this runtime's binary is meant to arrive on this platform. */
	prebuild: NativePrebuildAvailability | 'unsupported-platform';
}

export interface RuntimeSelfTestReport {
	/** Epoch millis. Stamped by the caller's clock, so it matches the log around it. */
	ranAt: number;
	platform: string;
	arch: string;
	/** Null on a platform Maestro ships no installer for. */
	platformKey: NativePlatformKey | null;
	entries: RuntimeSelfTestEntry[];
	/** True when nothing FAILED. A skipped runtime does not fail the run. */
	passed: boolean;
	microphone: {
		permission: MicPermission;
		/** True when the OS prompt has not been shown yet, so the state is not a refusal. */
		canPrompt: boolean;
	};
}

/**
 * A minimal structural view of each runtime's surface.
 *
 * Structural rather than imported types on purpose: importing
 * `node-llama-cpp`'s types here would put the package back into the static
 * import graph, which is the exact thing `native-loader.ts` exists to prevent.
 */
interface LlamaModule {
	getLlama?: unknown;
}
interface WhisperModule {
	Whisper?: unknown;
}
interface OnnxModule {
	InferenceSession?: unknown;
	env?: { versions?: Record<string, string> };
}

/** How long one runtime gets before it is called hung. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * The trivial operation per runtime.
 *
 * Each returns a short detail string on success and THROWS on failure. They
 * deliberately check the export the provider will actually call, so a package
 * that loads but has moved its API (a version bump nobody meant to take) fails
 * here rather than mid-session.
 */
const PROBES: Record<NativeRuntimeId, (module: unknown) => Promise<string>> = {
	llama: async (module) => {
		const llama = module as LlamaModule;
		if (typeof llama.getLlama !== 'function') {
			throw new Error('node-llama-cpp loaded but exposes no getLlama()');
		}
		return 'getLlama() present';
	},
	whisper: async (module) => {
		const whisper = module as WhisperModule;
		if (typeof whisper.Whisper !== 'function') {
			throw new Error('smart-whisper loaded but exposes no Whisper constructor');
		}
		return 'Whisper constructor present';
	},
	onnx: async (module) => {
		const onnx = module as OnnxModule;
		if (!onnx.InferenceSession) {
			throw new Error('onnxruntime-node loaded but exposes no InferenceSession');
		}
		const version = onnx.env?.versions?.common;
		return version ? `ONNX Runtime ${version}` : 'InferenceSession present';
	},
};

export interface RunSelfTestOptions {
	/** Injected in tests. Defaults to the real lazy loader. */
	loadRuntime?: (id: NativeRuntimeId) => Promise<NativeRuntimeResult<unknown>>;
	/** Injected in tests. Defaults to the real OS query, which never prompts. */
	readMicPermission?: () => { state: MicPermission; canPrompt: boolean };
	/** Per-runtime timeout. Lowered in tests. */
	timeoutMs?: number;
	/** Injected in tests so a fake clock can produce deterministic timings. */
	now?: () => number;
}

/**
 * Run the whole self-test. Never throws: every failure is a row in the report,
 * because a diagnostic that can itself blow up gives the user nothing.
 */
export async function runSelfTest(
	options: RunSelfTestOptions = {}
): Promise<RuntimeSelfTestReport> {
	const load = options.loadRuntime ?? tryLoadNativeRuntime;
	const readMic =
		options.readMicPermission ??
		(() => {
			const info = getMicPermission();
			return { state: info.state, canPrompt: info.canPrompt };
		});
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const platformKey = nativePlatformKey(process.platform, process.arch);

	const entries: RuntimeSelfTestEntry[] = [];
	for (const descriptor of NATIVE_RUNTIMES) {
		entries.push(await testRuntime(descriptor, { load, now, timeoutMs, platformKey }));
	}

	const mic = readMic();
	return {
		ranAt: now(),
		platform: process.platform,
		arch: process.arch,
		platformKey,
		entries,
		passed: entries.every((entry) => entry.status !== 'fail'),
		microphone: { permission: mic.state, canPrompt: mic.canPrompt },
	};
}

async function testRuntime(
	descriptor: NativeRuntimeDescriptor,
	deps: {
		load: (id: NativeRuntimeId) => Promise<NativeRuntimeResult<unknown>>;
		now: () => number;
		timeoutMs: number;
		platformKey: NativePlatformKey | null;
	}
): Promise<RuntimeSelfTestEntry> {
	const started = deps.now();
	const base = {
		runtimeId: descriptor.id,
		moduleId: descriptor.moduleId,
		label: descriptor.label,
		prebuild: deps.platformKey
			? descriptor.prebuilds[deps.platformKey]
			: ('unsupported-platform' as const),
	};

	const result = await withTimeout(deps.load(descriptor.id), deps.timeoutMs);

	if (result === TIMED_OUT) {
		return {
			...base,
			status: 'fail',
			failure: 'timeout',
			durationMs: deps.now() - started,
			detail: `Loading ${descriptor.moduleId} did not finish within ${deps.timeoutMs} ms.`,
		};
	}

	if (!result.ok) {
		// A runtime that is not a dependency yet is not a broken installation, and
		// a support report that says "fail" for it would send someone hunting a bug
		// that does not exist.
		const skipped = result.error.failure === 'not-a-dependency';
		return {
			...base,
			status: skipped ? 'skipped' : 'fail',
			failure: result.error.failure,
			durationMs: deps.now() - started,
			detail: result.error.detail
				? `${result.error.message} (${result.error.detail})`
				: result.error.message,
		};
	}

	try {
		const detail = await withTimeout(PROBES[descriptor.id](result.module), deps.timeoutMs);
		if (detail === TIMED_OUT) {
			return {
				...base,
				status: 'fail',
				failure: 'timeout',
				durationMs: deps.now() - started,
				detail: `${descriptor.moduleId} loaded but its probe did not finish within ${deps.timeoutMs} ms.`,
			};
		}
		// Dropped from the loader cache only on success. A FAILED runtime keeps its
		// remembered failure, which is what the capability gate reads to explain a
		// blocked slot after the self-test has been run.
		unloadNativeRuntime(descriptor.id);
		return { ...base, status: 'pass', durationMs: deps.now() - started, detail };
	} catch (error) {
		return {
			...base,
			status: 'fail',
			failure: 'probe-failed',
			durationMs: deps.now() - started,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Sentinel rather than a rejection, so a timeout is not confused with a load error. */
const TIMED_OUT = Symbol('timed-out');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<typeof TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(TIMED_OUT), ms);
				// Never hold the process open for a diagnostic.
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The report as lines, for a log or a pasted bug report. */
export function formatSelfTestReport(report: RuntimeSelfTestReport): string {
	const header = `A Cappella voice self-test on ${report.platform}-${report.arch}: ${
		report.passed ? 'PASS' : 'FAIL'
	}`;
	const rows = report.entries.map(
		(entry) =>
			`  ${entry.status.toUpperCase().padEnd(7)} ${entry.label} (${entry.moduleId}) ${entry.durationMs} ms${
				entry.detail ? ` - ${entry.detail}` : ''
			}`
	);
	return [header, ...rows, `  Microphone: ${report.microphone.permission}`].join('\n');
}
