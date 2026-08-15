/**
 * The native runtimes A Cappella's local tier needs, and everything the build
 * has to know about them.
 *
 * This table is the single source of truth for four consumers that would
 * otherwise each keep their own copy and drift:
 *
 *   - `src/main/acappella/runtime/native-loader.ts` - the only module allowed to
 *     import these packages, and the only one that can turn a dlopen failure
 *     into a sentence a user can act on.
 *   - `src/main/acappella/runtime/runtime-selftest.ts` - "Run voice self-test".
 *   - `scripts/verify-native-packaging.mjs` - reads the compiled copy of this
 *     file out of `dist/` and fails the packaging step when a binary this table
 *     promises is missing from the built app or still trapped inside the asar.
 *   - The capability gate, which reports a runtime that will not load as its own
 *     unsatisfied reason rather than blaming a model that is sitting on disk
 *     perfectly intact.
 *
 * **Why `declared` exists.** A descriptor here is a decision, not an
 * installation. The packages below are large (onnxruntime-node ships a
 * per-platform ONNX Runtime, node-llama-cpp pulls a per-platform llama.cpp
 * build) and one of them compiles from source at install time, so adding them to
 * `dependencies` costs every contributor and both CI legs real minutes and real
 * disk on every `npm ci`. They are added in the phase that first executes them
 * (Phase 05, the real providers), and `declared` flips to true in that same
 * commit. Until then the loader reports `not-a-dependency`, which is a truthful
 * and distinct answer from "your install is broken". A test asserts this flag
 * against `package.json`, so the two cannot disagree.
 *
 * Everything in here is data. Platform branching belongs to `platformDetection`,
 * not to this file.
 */

import type { VoiceSlot } from './readiness';

/** A runtime is one npm package, however many slots it serves. */
export type NativeRuntimeId = 'llama' | 'whisper' | 'onnx';

/** The four platform/arch pairs Maestro ships installers for. */
export type NativePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64';

/**
 * How a runtime's binary arrives on a given platform.
 *
 * `source-build` is not a smaller version of `prebuilt`: it means the package
 * runs a compiler during `npm install`, so the toolchain becomes a build
 * requirement for contributors and for both CI legs. It is recorded per platform
 * because it is the kind of fact that decides whether a release can be cut at
 * all, and it must not live only in someone's memory.
 */
export type NativePrebuildAvailability = 'prebuilt' | 'source-build' | 'unavailable';

export interface NativeRuntimeDescriptor {
	readonly id: NativeRuntimeId;
	/** The npm package name. Also the specifier the loader dynamically imports. */
	readonly moduleId: string;
	/**
	 * The exact version to install, no range. Ranges are how a native dependency
	 * silently changes its ABI, its prebuild matrix, or its binary layout between
	 * two builds of the same tag.
	 */
	readonly versionPin: string;
	readonly label: string;
	/** Which voice slots stop working when this runtime cannot load. */
	readonly slots: readonly VoiceSlot[];
	/**
	 * Whether the package is in `package.json` dependencies yet. See the module
	 * comment: false is a deliberate state, not an oversight.
	 */
	readonly declared: boolean;
	/**
	 * Whether `electron-rebuild` has to rebuild it against Electron's ABI.
	 *
	 * False for every runtime here because all three are Node-API addons, and
	 * Node-API is ABI-stable across Node and Electron by design. That is a
	 * property worth stating out loud: adding a non-Node-API addon later means
	 * setting this true AND adding it to the `postinstall` rebuild list, and the
	 * symptom of forgetting is a signed release that dies on launch.
	 */
	readonly requiresElectronRebuild: boolean;
	readonly prebuilds: Readonly<Record<NativePlatformKey, NativePrebuildAvailability>>;
	/**
	 * Globs for `build.asarUnpack` in package.json. A `.node` file inside an asar
	 * archive cannot be dlopen'd: the loader needs a real path on disk.
	 */
	readonly asarUnpack: readonly string[];
	/**
	 * Paths, relative to `app.asar.unpacked/`, that MUST exist in a packaged app
	 * for this runtime to work on the given platform. The packaging assertion
	 * checks these; an empty list for a platform means "no platform-specific
	 * binary", not "unchecked".
	 */
	readonly packagedBinaries: Readonly<Record<NativePlatformKey, readonly string[]>>;
	/** One sentence of why this package and not another. */
	readonly rationale: string;
	/** Anything a person cutting a release has to know. */
	readonly notes: string;
}

/**
 * The registry.
 *
 * Versions and binary layouts below were read from the published packages, not
 * guessed: `@node-llama-cpp/<platform>` ships `bins/<platform>/llama-addon.node`
 * beside its ggml dylibs, and `onnxruntime-node` ships
 * `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node` beside the ONNX
 * Runtime shared library.
 */
export const NATIVE_RUNTIMES: readonly NativeRuntimeDescriptor[] = Object.freeze([
	Object.freeze({
		id: 'llama',
		moduleId: 'node-llama-cpp',
		versionPin: '3.20.0',
		label: 'llama.cpp (Conductor Brain)',
		slots: Object.freeze(['brain'] as VoiceSlot[]),
		declared: false,
		requiresElectronRebuild: false,
		prebuilds: Object.freeze({
			'darwin-arm64': 'prebuilt',
			'darwin-x64': 'prebuilt',
			'win32-x64': 'prebuilt',
			'linux-x64': 'prebuilt',
		} as Record<NativePlatformKey, NativePrebuildAvailability>),
		asarUnpack: Object.freeze([
			'node_modules/node-llama-cpp/**/*',
			'node_modules/@node-llama-cpp/**/*',
		]),
		packagedBinaries: Object.freeze({
			'darwin-arm64': Object.freeze([
				'node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node',
			]),
			'darwin-x64': Object.freeze([
				'node_modules/@node-llama-cpp/mac-x64/bins/mac-x64/llama-addon.node',
			]),
			'win32-x64': Object.freeze([
				'node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node',
			]),
			'linux-x64': Object.freeze([
				'node_modules/@node-llama-cpp/linux-x64/bins/linux-x64/llama-addon.node',
			]),
		}),
		rationale:
			'Ships per-platform prebuilt llama.cpp binaries as optional dependencies, so a user needs no compiler and the Qwen3 GGUF in the catalog runs as downloaded.',
		notes:
			'ESM-only. The loader must reach it through a real dynamic import, not a transpiled require(). The prebuilt binary sits beside several ggml dylibs that macOS signing has to cover.',
	}),
	Object.freeze({
		id: 'whisper',
		moduleId: 'smart-whisper',
		versionPin: '0.8.1',
		label: 'whisper.cpp (Speech-to-Text)',
		slots: Object.freeze(['stt'] as VoiceSlot[]),
		declared: false,
		requiresElectronRebuild: false,
		prebuilds: Object.freeze({
			'darwin-arm64': 'source-build',
			'darwin-x64': 'source-build',
			'win32-x64': 'source-build',
			'linux-x64': 'source-build',
		} as Record<NativePlatformKey, NativePrebuildAvailability>),
		asarUnpack: Object.freeze(['node_modules/smart-whisper/build/**/*']),
		packagedBinaries: Object.freeze({
			'darwin-arm64': Object.freeze(['node_modules/smart-whisper/build/Release/whisper.node']),
			'darwin-x64': Object.freeze(['node_modules/smart-whisper/build/Release/whisper.node']),
			'win32-x64': Object.freeze(['node_modules/smart-whisper/build/Release/whisper.node']),
			'linux-x64': Object.freeze(['node_modules/smart-whisper/build/Release/whisper.node']),
		}),
		rationale:
			'Node-API binding to whisper.cpp, which is the runtime the pinned ggml-base.en.bin in the model catalog is built for.',
		notes:
			'The one runtime with NO prebuilds on any platform: its install script runs node-gyp, so every build machine needs a C++ toolchain and CMake. That is a release-engineering cost, and it is the open question this phase deliberately leaves for Phase 05 rather than hiding.',
	}),
	Object.freeze({
		id: 'onnx',
		moduleId: 'onnxruntime-node',
		versionPin: '1.27.0',
		label: 'ONNX Runtime (Text-to-Speech and wake word)',
		slots: Object.freeze(['tts', 'wake-word'] as VoiceSlot[]),
		declared: false,
		requiresElectronRebuild: false,
		prebuilds: Object.freeze({
			'darwin-arm64': 'prebuilt',
			'darwin-x64': 'prebuilt',
			'win32-x64': 'prebuilt',
			'linux-x64': 'prebuilt',
		} as Record<NativePlatformKey, NativePrebuildAvailability>),
		asarUnpack: Object.freeze(['node_modules/onnxruntime-node/bin/**/*']),
		packagedBinaries: Object.freeze({
			'darwin-arm64': Object.freeze([
				'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
			]),
			'darwin-x64': Object.freeze([
				'node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node',
			]),
			'win32-x64': Object.freeze([
				'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
				'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
			]),
			'linux-x64': Object.freeze([
				'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node',
				'node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1',
			]),
		}),
		rationale:
			'One runtime for two slots: the Kokoro TTS model and the openWakeWord front end in the catalog are both ONNX, so shipping a second inference engine would be pure weight.',
		notes:
			'Node-API v6, so no Electron rebuild. Its own install script fetches optional CUDA extras; those are not required and must not become a packaging dependency.',
	}),
]);

const RUNTIMES_BY_ID = new Map<NativeRuntimeId, NativeRuntimeDescriptor>(
	NATIVE_RUNTIMES.map((runtime) => [runtime.id, runtime])
);

export function getNativeRuntime(id: NativeRuntimeId): NativeRuntimeDescriptor | undefined {
	return RUNTIMES_BY_ID.get(id);
}

/** Every runtime a slot depends on. Empty for slots with no native tier. */
export function runtimesForSlot(slot: VoiceSlot): NativeRuntimeDescriptor[] {
	return NATIVE_RUNTIMES.filter((runtime) => runtime.slots.includes(slot));
}

/** Every asarUnpack glob the build config needs, deduped and in registry order. */
export function nativeAsarUnpackGlobs(): string[] {
	return [...new Set(NATIVE_RUNTIMES.flatMap((runtime) => [...runtime.asarUnpack]))];
}

/**
 * The platform key for a `process.platform`/`process.arch` pair, or null on a
 * combination Maestro does not ship an installer for.
 *
 * Null is a real answer, not a failure: a user on linux-arm64 gets "this runtime
 * has no build for your platform" instead of a dlopen error that reads like a
 * corrupt install.
 */
export function nativePlatformKey(platform: string, arch: string): NativePlatformKey | null {
	const key = `${platform}-${arch}`;
	return isNativePlatformKey(key) ? key : null;
}

const PLATFORM_KEYS: readonly string[] = [
	'darwin-arm64',
	'darwin-x64',
	'win32-x64',
	'linux-x64',
] as const;

export function isNativePlatformKey(value: string): value is NativePlatformKey {
	return PLATFORM_KEYS.includes(value);
}

/** Every platform key, for the packaging matrix and its report. */
export const NATIVE_PLATFORM_KEYS = PLATFORM_KEYS as readonly NativePlatformKey[];
