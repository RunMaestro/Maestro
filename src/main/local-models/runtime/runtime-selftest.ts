/**
 * The Local Models runtime self-test - the answer to a bug report that says a
 * local model does not work.
 *
 * Without this, that report is a guess: native runtimes, model downloads, and a
 * code-signing story all fail in ways that look identical from the outside
 * ("nothing happens when I press the button"). The self-test loads each runtime
 * the way the real consumers will, runs a trivial operation against it, and
 * reports per-runtime pass/fail with timings, in one structure that goes
 * straight into a support report through the debug package. A consumer adds its
 * own rows on top (A Cappella adds the microphone permission).
 *
 * Three properties it must keep:
 *
 *   - **It proves the load path, not a stub.** Each probe goes through
 *     `native-loader.ts`, so a self-test that passes means the same dlopen the
 *     consumer will do actually succeeded in this installation, on this
 *     platform, from this code-signed bundle.
 *   - **It loads no model.** A probe touches the module's own surface (its
 *     version, its constructor, llama.cpp's compute backend) and never a model
 *     file. A self-test that needed 1.4 GB of models could not be run by the
 *     person who most needs to run it.
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
} from '../../../shared/local-models/native-runtimes';
import { selfTestVerdict } from '../../../shared/local-models/native-runtimes';
import {
	tryLoadNativeRuntime,
	unloadNativeRuntime,
	type NativeRuntimeFailureKind,
	type NativeRuntimeResult,
} from './native-loader';
import { LLAMA_GET_OPTIONS, llamaBackendLabel, type LlamaBackendInfo } from './llama-options';

/**
 * `skipped` is not a soft failure: it means the runtime is not part of this
 * build yet, which is a true and useful thing for a support report to say. It is
 * reported separately from `fail` so a bug report cannot read as three broken
 * runtimes when nothing is broken.
 *
 * `missing` is the runtime this build CAN fetch but has not. Nothing is broken,
 * so it does not fail the run either, but it is not "skipped": every local model
 * that rides it is dead until it is downloaded, and the summary says so.
 */
export type RuntimeSelfTestStatus = 'pass' | 'fail' | 'skipped' | 'missing';

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
	/** True when nothing FAILED. A skipped or missing runtime does not fail the run. */
	passed: boolean;
}

/**
 * A minimal structural view of each runtime's surface.
 *
 * Structural rather than imported types on purpose: importing
 * `node-llama-cpp`'s types here would put the package back into the static
 * import graph, which is the exact thing `native-loader.ts` exists to prevent.
 */
interface LlamaInstance extends LlamaBackendInfo {
	dispose?(): Promise<void> | void;
}
interface LlamaModule {
	getLlama?: (options?: Record<string, unknown>) => Promise<LlamaInstance>;
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
		const { getLlama } = module as LlamaModule;
		if (typeof getLlama !== 'function') {
			throw new Error('node-llama-cpp loaded but exposes no getLlama()');
		}
		// The JavaScript half importing proves nothing about the native half:
		// `getLlama()` is what dlopens the platform binary and initializes the
		// compute backend, so it is the call a missing or unsigned binary fails.
		// Same options as the text-generation path, so this is that load path.
		const llama = await getLlama({ ...LLAMA_GET_OPTIONS });
		const backend = llamaBackendLabel(llama);
		const build = llama.buildType === 'localBuild' ? ', local build' : '';
		// The backend holds threads and, on a GPU, device memory. A diagnostic
		// must not leave either behind.
		try {
			await llama.dispose?.();
		} catch {
			/* best-effort: the load already succeeded, which is what was asked */
		}
		return `llama.cpp backend: ${backend}${build}`;
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

export interface RunRuntimeSelfTestOptions {
	/** Injected in tests. Defaults to the real lazy loader. */
	loadRuntime?: (id: NativeRuntimeId) => Promise<NativeRuntimeResult<unknown>>;
	/** Per-runtime timeout. Lowered in tests. */
	timeoutMs?: number;
	/** Injected in tests so a fake clock can produce deterministic timings. */
	now?: () => number;
}

/**
 * Run the whole self-test. Never throws: every failure is a row in the report,
 * because a diagnostic that can itself blow up gives the user nothing.
 */
export async function runRuntimeSelfTest(
	options: RunRuntimeSelfTestOptions = {}
): Promise<RuntimeSelfTestReport> {
	const load = options.loadRuntime ?? tryLoadNativeRuntime;
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const platformKey = nativePlatformKey(process.platform, process.arch);

	const entries: RuntimeSelfTestEntry[] = [];
	for (const descriptor of NATIVE_RUNTIMES) {
		entries.push(await testRuntime(descriptor, { load, now, timeoutMs, platformKey }));
	}

	return {
		ranAt: now(),
		platform: process.platform,
		arch: process.arch,
		platformKey,
		entries,
		passed: entries.every((entry) => entry.status !== 'fail'),
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
		const status: RuntimeSelfTestStatus =
			result.error.failure === 'not-a-dependency'
				? 'skipped'
				: result.error.failure === 'not-downloaded'
					? 'missing'
					: 'fail';
		return {
			...base,
			status,
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

/**
 * The report as lines, for a log or a pasted bug report. `title` names who ran
 * it (a consumer's diagnostic), and the verdict follows it on the header line.
 */
export function formatRuntimeSelfTestLines(report: RuntimeSelfTestReport, title: string): string[] {
	const header = `${title} on ${report.platform}-${report.arch}: ${selfTestVerdict(report)}`;
	const rows = report.entries.map(
		(entry) =>
			`  ${entry.status.toUpperCase().padEnd(7)} ${entry.label} (${entry.moduleId}) ${entry.durationMs} ms${
				entry.detail ? ` - ${entry.detail}` : ''
			}`
	);
	return [header, ...rows];
}
