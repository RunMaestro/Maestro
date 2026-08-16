/**
 * The one place A Cappella's native runtimes are imported.
 *
 * Three rules, and the file exists because all three are easy to break by
 * accident anywhere else:
 *
 *   1. **Nothing native is imported at module load.** Every import in here is a
 *      dynamic `import()` inside a function. A user with the Encore Feature off
 *      never loads a single native symbol, and a user with it on pays for
 *      llama.cpp only when a session actually needs the Brain. A top-level
 *      `import 'node-llama-cpp'` anywhere else in the codebase would undo that
 *      silently, which is why concrete providers must come through here.
 *   2. **A failure is structured, never an opaque dlopen string.**
 *      "Error: Cannot open shared object file" tells a user nothing and tells a
 *      support report less. Every failure comes back as a
 *      {@link NativeRuntimeUnavailable} carrying the runtime, the module, the
 *      platform, the arch, a classified reason, and the underlying message.
 *   3. **A failed load never crashes the app.** {@link tryLoadNativeRuntime}
 *      returns a result object; {@link loadNativeRuntime} throws a typed error a
 *      caller can catch. Nothing here escapes as an unhandled rejection.
 *
 * The last failure per runtime is REMEMBERED, which is what lets the capability
 * gate say "the ONNX Runtime will not load on this machine" without loading
 * anything itself. The gate runs on every Settings render; making it dlopen a
 * few hundred megabytes of inference engine to draw a panel would be the exact
 * opposite of rule 1.
 */

import {
	getNativeRuntime,
	nativePlatformKey,
	type NativeRuntimeDescriptor,
	type NativeRuntimeId,
} from '../../../shared/acappella/native-runtimes';
import { isWindows } from '../../../shared/platformDetection';

/**
 * Why a runtime is not usable.
 *
 * Classified rather than collapsed into one "load failed" because the user's
 * next action differs for every one of them: wait for the feature to ship,
 * reinstall the app, use a different machine, or install a redistributable.
 */
export type NativeRuntimeFailureKind =
	| 'not-a-dependency'
	| 'unsupported-platform'
	| 'module-not-found'
	| 'load-failed';

/** A runtime that will not load, and everything needed to say why. */
export interface NativeRuntimeUnavailable {
	/** Discriminator, so this can travel inside a union without being mistaken for a module. */
	readonly kind: 'runtime-unavailable';
	readonly runtimeId: NativeRuntimeId;
	readonly moduleId: string;
	readonly platform: string;
	readonly arch: string;
	readonly failure: NativeRuntimeFailureKind;
	/** One sentence, written for a person. */
	readonly message: string;
	/** What the caller can do about it. */
	readonly suggestedAction: string;
	/** The underlying error text, kept verbatim for support reports. */
	readonly detail?: string;
}

/** The typed throw. Callers that prefer a result object use {@link tryLoadNativeRuntime}. */
export class NativeRuntimeUnavailableError extends Error {
	readonly info: NativeRuntimeUnavailable;

	constructor(info: NativeRuntimeUnavailable) {
		super(info.message);
		this.name = 'NativeRuntimeUnavailableError';
		this.info = info;
	}
}

export type NativeRuntimeResult<T> =
	| { ok: true; module: T }
	| { ok: false; error: NativeRuntimeUnavailable };

/**
 * A real dynamic import that survives transpilation.
 *
 * `tsconfig.main.json` emits CommonJS, and TypeScript rewrites `import()` into
 * `require()` there. That would be fine for a classic addon and fatal for
 * `node-llama-cpp`, which is ESM-only. Going through `new Function` keeps a
 * genuine dynamic import in the emitted output. It is also why the specifier is
 * always a variable: a literal would make TypeScript try to resolve a package
 * that is deliberately not installed yet.
 */
const dynamicImport: (specifier: string) => Promise<unknown> = new Function(
	'specifier',
	'return import(specifier);'
) as (specifier: string) => Promise<unknown>;

/** Injected in tests. Production always uses the real import. */
let importer: (specifier: string) => Promise<unknown> = dynamicImport;

/** In-flight and settled loads, so a second caller does not dlopen twice. */
const loaded = new Map<NativeRuntimeId, Promise<unknown>>();

/** The last failure per runtime, for the capability gate and the debug package. */
const failures = new Map<NativeRuntimeId, NativeRuntimeUnavailable>();

/**
 * Replace the module importer. Tests only.
 *
 * Exists because the alternative is a test suite that either installs a
 * gigabyte of inference engines or cannot test the failure paths at all, and the
 * failure paths are the entire point of this module.
 */
export function __setNativeImporter(fn: ((specifier: string) => Promise<unknown>) | null): void {
	importer = fn ?? dynamicImport;
}

/** Forget every cached module and failure. Tests, and the "retry" affordance. */
export function resetNativeRuntimes(): void {
	loaded.clear();
	failures.clear();
}

/** True when this runtime has already been loaded in this process. */
export function isNativeRuntimeLoaded(id: NativeRuntimeId): boolean {
	return loaded.has(id);
}

/**
 * Drop a runtime from the cache.
 *
 * Node has no unload, so the native library stays resident for the life of the
 * process. What this buys is a fresh attempt: after a self-test, or after a user
 * installs the thing that was missing, the next load actually retries instead of
 * replaying a cached rejection.
 */
export function unloadNativeRuntime(id: NativeRuntimeId): void {
	loaded.delete(id);
	failures.delete(id);
}

/**
 * The last known failure for a runtime, or null when it has never failed here.
 *
 * Deliberately does NOT attempt a load: this is what the capability gate reads,
 * and the gate must stay a cheap disk-and-settings question.
 */
export function lastNativeRuntimeFailure(id: NativeRuntimeId): NativeRuntimeUnavailable | null {
	return failures.get(id) ?? null;
}

/** Every remembered failure, in registry order. For the debug package. */
export function allNativeRuntimeFailures(): NativeRuntimeUnavailable[] {
	return [...failures.values()];
}

/**
 * Why this runtime will not load, WITHOUT loading it. Null when it should.
 *
 * The difference from {@link lastNativeRuntimeFailure} is the difference between
 * "has this already gone wrong here" and "will this work here", and the second
 * is the only one a capability gate can act on. Two of the reasons a runtime
 * cannot load are knowable from the registry alone - the package is not a
 * dependency of this build, or there is no binary for this platform - and a gate
 * that only reads remembered failures reports those runtimes as FINE until
 * something attempts a load and fails.
 *
 * That gap is not theoretical. On a fresh boot nothing has attempted anything,
 * so readiness came back "everything satisfied, start a session" for slots whose
 * runtime is not in the build at all; the user got a green button, downloaded
 * gigabytes of models on its say-so, and the session then died mid-flight in a
 * provider's `start()`. The same call after any load attempt said the opposite,
 * which made readiness depend on the order the app happened to do things in.
 *
 * Side-effect free on purpose: it does NOT record into the remembered failures,
 * so asking the question cannot make the debug package report a failure nobody
 * ever hit.
 */
export function knownNativeRuntimeUnavailability(
	id: NativeRuntimeId
): NativeRuntimeUnavailable | null {
	const remembered = failures.get(id);
	if (remembered) return remembered;

	const descriptor = getNativeRuntime(id);
	if (!descriptor) return unknownRuntime(id);
	return declineBeforeLoading(descriptor);
}

/**
 * Load a native runtime, or throw {@link NativeRuntimeUnavailableError}.
 *
 * Resolves to the module's namespace object. Callers cast to their own minimal
 * structural type rather than importing the package's types, which is what keeps
 * the package out of every other file's import graph.
 */
export async function loadNativeRuntime<T = unknown>(id: NativeRuntimeId): Promise<T> {
	const result = await tryLoadNativeRuntime<T>(id);
	if (!result.ok) throw new NativeRuntimeUnavailableError(result.error);
	return result.module;
}

/**
 * Load a native runtime, reporting failure as a value.
 *
 * Never rejects. A runtime that cannot load is a capability the app does not
 * have, not an exception the app should die on.
 */
export async function tryLoadNativeRuntime<T = unknown>(
	id: NativeRuntimeId
): Promise<NativeRuntimeResult<T>> {
	const descriptor = getNativeRuntime(id);
	if (!descriptor) {
		return { ok: false, error: unknownRuntime(id) };
	}

	const cached = loaded.get(id);
	if (cached) {
		try {
			return { ok: true, module: (await cached) as T };
		} catch {
			// The rejection was already classified and remembered on the first
			// attempt; replay it rather than re-deriving it from a stale error.
			return {
				ok: false,
				error: failures.get(id) ?? classify(descriptor, new Error('load failed')),
			};
		}
	}

	const declined = declineBeforeLoading(descriptor);
	if (declined) {
		failures.set(id, declined);
		return { ok: false, error: declined };
	}

	const attempt = importer(descriptor.moduleId);
	loaded.set(id, attempt);

	try {
		const module = (await attempt) as T;
		failures.delete(id);
		return { ok: true, module };
	} catch (error) {
		// Drop the cache entry so a later attempt (after the user installs the
		// missing piece) is a real retry rather than a replayed rejection.
		loaded.delete(id);
		const classified = classify(descriptor, error);
		failures.set(id, classified);
		return { ok: false, error: classified };
	}
}

/**
 * The two failures that are knowable without touching the module at all.
 *
 * Checked first because attempting the import would produce a MODULE_NOT_FOUND
 * in both cases, and "the package is not installed yet" and "your platform has
 * no build" are completely different answers to give a user.
 */
function declineBeforeLoading(
	descriptor: NativeRuntimeDescriptor
): NativeRuntimeUnavailable | null {
	if (!descriptor.declared) {
		return {
			kind: 'runtime-unavailable',
			runtimeId: descriptor.id,
			moduleId: descriptor.moduleId,
			platform: process.platform,
			arch: process.arch,
			failure: 'not-a-dependency',
			message: `${descriptor.label} is not part of this build yet.`,
			suggestedAction:
				'Use a hosted provider or the mock tier for this slot until the local runtime ships.',
		};
	}

	const key = nativePlatformKey(process.platform, process.arch);
	if (!key) {
		return {
			kind: 'runtime-unavailable',
			runtimeId: descriptor.id,
			moduleId: descriptor.moduleId,
			platform: process.platform,
			arch: process.arch,
			failure: 'unsupported-platform',
			message: `${descriptor.label} has no build for ${process.platform}-${process.arch}.`,
			suggestedAction: `Switch this slot to a hosted provider: there is no local ${descriptor.label} binary for this platform.`,
		};
	}

	if (descriptor.prebuilds[key] === 'unavailable') {
		return {
			kind: 'runtime-unavailable',
			runtimeId: descriptor.id,
			moduleId: descriptor.moduleId,
			platform: process.platform,
			arch: process.arch,
			failure: 'unsupported-platform',
			message: `${descriptor.label} is not shipped for ${key}.`,
			suggestedAction: `Switch this slot to a hosted provider: there is no local ${descriptor.label} binary for this platform.`,
		};
	}

	return null;
}

/** Turn whatever the module system threw into something a person can act on. */
function classify(descriptor: NativeRuntimeDescriptor, error: unknown): NativeRuntimeUnavailable {
	const detail = error instanceof Error ? error.message : String(error);
	const code = (error as NodeJS.ErrnoException | null)?.code;
	const missing = code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';

	if (missing) {
		return {
			kind: 'runtime-unavailable',
			runtimeId: descriptor.id,
			moduleId: descriptor.moduleId,
			platform: process.platform,
			arch: process.arch,
			failure: 'module-not-found',
			message: `${descriptor.label} is missing from this installation (${descriptor.moduleId}).`,
			// A missing module in a packaged app means the binary never made it into
			// the bundle, which a user cannot repair from inside the app.
			suggestedAction: 'Reinstall Maestro, then run the voice self-test again.',
			detail,
		};
	}

	if (isMissingSystemLibrary(detail)) {
		return {
			kind: 'runtime-unavailable',
			runtimeId: descriptor.id,
			moduleId: descriptor.moduleId,
			platform: process.platform,
			arch: process.arch,
			failure: 'load-failed',
			message: `${descriptor.label} loaded but a system library it needs is missing.`,
			// Windows reports this as a bare "The specified module could not be
			// found", naming the addon rather than the DLL it actually wanted, which
			// reads like a corrupt install. It is almost always the Visual C++
			// runtime, and naming it is the difference between a fix and a reinstall
			// that changes nothing.
			suggestedAction: isWindows()
				? 'Install the Microsoft Visual C++ Redistributable (x64), then run the voice self-test again.'
				: 'A shared library this runtime depends on is missing from the system. Run the voice self-test and include the result in a bug report.',
			detail,
		};
	}

	return {
		kind: 'runtime-unavailable',
		runtimeId: descriptor.id,
		moduleId: descriptor.moduleId,
		platform: process.platform,
		arch: process.arch,
		failure: 'load-failed',
		message: `${descriptor.label} failed to load on ${process.platform}-${process.arch}.`,
		suggestedAction:
			'Run the voice self-test in Settings > Plugins > A Cappella > Models and include the result in a bug report.',
		detail,
	};
}

/**
 * Whether a load error is the OS saying a dependent shared library is absent.
 *
 * Matched by message because that is all the platforms give: Windows returns
 * error 126 as text, and the Unix loaders name the missing object. This is the
 * one load failure with a specific user-facing fix, so it is worth telling apart
 * from the generic case.
 */
function isMissingSystemLibrary(detail: string): boolean {
	return (
		/The specified module could not be found/i.test(detail) ||
		/error (?:code )?126\b/i.test(detail) ||
		/0xc000007b/i.test(detail) ||
		/cannot open shared object file/i.test(detail) ||
		/(?:Library|image) not loaded/i.test(detail)
	);
}

function unknownRuntime(id: NativeRuntimeId): NativeRuntimeUnavailable {
	return {
		kind: 'runtime-unavailable',
		runtimeId: id,
		moduleId: String(id),
		platform: process.platform,
		arch: process.arch,
		failure: 'module-not-found',
		message: `Unknown native runtime "${id}".`,
		suggestedAction: 'This is a bug: the runtime registry has no descriptor for that id.',
	};
}

/** One line for a log or a support report. */
export function describeRuntimeUnavailable(info: NativeRuntimeUnavailable): string {
	const detail = info.detail ? ` (${info.detail})` : '';
	return `${info.moduleId} [${info.failure}] on ${info.platform}-${info.arch}: ${info.message}${detail}`;
}
