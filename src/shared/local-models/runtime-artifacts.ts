/**
 * The downloadable payloads that carry the Local Models native runtimes.
 *
 * **Why these are downloaded and not bundled.** Local inference is opt-in.
 * Bundling llama.cpp and ONNX Runtime would put roughly 300 MB of inference
 * binaries into every installer, on every platform, for every user - including
 * the large majority who never run a local model. The binaries are also the only
 * part of the feature whose size is not a rounding error, so they are the one
 * part worth fetching on demand.
 *
 * The precedent is already in the product: a local model ALREADY asks the user
 * to download hundreds of megabytes before it can run. A runtime payload rides
 * the same road, with the same rules - pinned source, recorded SHA-256, verified
 * before anything is promoted into place - so "where did this binary come from"
 * has exactly one answer for models and runtimes alike.
 *
 * **Why npm registry tarballs.** They are immutable per version, publicly
 * auditable, and already the provenance the pinned `versionPin` in
 * `native-runtimes.ts` refers to. Hosting our own would mean a second supply
 * chain to secure and a release step that can silently not run; pointing at the
 * exact tarball npm would have installed means the downloaded bytes and the
 * bytes a contributor gets from `npm install` are the same bytes.
 *
 * **Every hash below was computed from the real tarball, not copied from a
 * manifest.** A hash nobody has verified is a hash that fails on the user's
 * machine, and `bytes` is the COMPRESSED download size, because that is the
 * number a progress bar counts and a user waits through.
 *
 * **A tarball is not an install.** npm ships a package's own files and resolves
 * its dependency tree separately, so a payload that declares a runtime dependency
 * arrives incomplete. `onnxruntime-node` requires `onnxruntime-common` on the
 * first line of its entry point, and installing without it produces a runtime
 * that extracts cleanly, verifies cleanly, reports itself installed, and then
 * throws `MODULE_NOT_FOUND` the first time a model is opened - after the
 * user has waited through the whole download. {@link NativeRuntimeDependency} is
 * why that cannot happen: dependencies are pinned, hashed, and installed inside
 * the same transaction as the payload.
 *
 * The one wart, recorded rather than hidden: `onnxruntime-node` publishes a
 * single tarball containing all five platform payloads, so a user downloads
 * ~101 MB to keep ~37 MB. {@link NativeRuntimeArtifact.keep} is why disk does not
 * pay that tax as well - everything outside the running platform's subtree is
 * discarded at extraction. Splitting the download too would mean republishing
 * someone else's binaries under our own name, which is a supply chain we would
 * then own.
 */

import { NODE_LLAMA_CPP_DEPENDENCIES, NODE_LLAMA_CPP_VERSION } from './llama-dependencies';
import type { NativePlatformKey, NativeRuntimeId } from './native-runtimes';

/**
 * One downloadable payload: which runtime it carries, for which platform, and
 * everything needed to fetch it, prove it, and lay it out.
 */
export interface NativeRuntimeArtifact {
	readonly runtimeId: NativeRuntimeId;
	readonly platform: NativePlatformKey;
	/** Fully pinned tarball URL. A version, never a tag or a range. */
	readonly url: string;
	/** Lowercase hex SHA-256 of the tarball as downloaded, before extraction. */
	readonly sha256: string;
	/** COMPRESSED size in bytes. What the user actually waits for. */
	readonly bytes: number;
	/**
	 * Leading path components to strip. Always 1 for an npm tarball, whose
	 * entries are all prefixed `package/`. Named rather than assumed so a payload
	 * from somewhere else cannot be laid out one directory too deep.
	 */
	readonly stripComponents: number;
	/**
	 * Directory the payload is extracted into, relative to the install root. Empty
	 * for the root itself.
	 *
	 * Not empty for llama: `node-llama-cpp` finds its platform binary with
	 * `import('@node-llama-cpp/<platform>')`, so that payload has to sit at
	 * `node_modules/@node-llama-cpp/<platform>` for ordinary node resolution to
	 * reach it from the package that imports it.
	 */
	readonly installPath: string;
	/**
	 * Path prefixes to keep, relative to the stripped root. Anything else in the
	 * archive is discarded during extraction.
	 *
	 * This is what stops the ONNX Runtime tarball from leaving four platforms'
	 * worth of binaries on a machine that can run exactly one of them.
	 */
	readonly keep: readonly string[];
	/**
	 * The module the loader imports, relative to the install ROOT (not to
	 * {@link installPath}): it may live in a dependency rather than the payload.
	 *
	 * Always a JS entry point rather than the `.node` file itself: the addon is
	 * reached through its package's own resolution, and pointing a loader at raw
	 * `.node` would skip whatever setup that package does around it.
	 */
	readonly entry: string;
	/**
	 * The native binary that must exist once extraction finishes, relative to the
	 * install root (payload and dependencies both in place).
	 *
	 * Checked on install and by the self-test. A payload whose archive extracted
	 * cleanly but whose binary is absent is a payload that will fail later inside
	 * a dlopen, where the error names nothing a user can act on.
	 */
	readonly binary: string;
	/**
	 * Runtime dependencies the payload `require()`s but does not contain.
	 *
	 * An npm tarball ships a package's own files and NOT its dependency tree, so a
	 * payload that declares a runtime dependency arrives incomplete. Installing it
	 * anyway produces a runtime that extracts cleanly, verifies cleanly, reports
	 * itself installed, and then throws `MODULE_NOT_FOUND` the first time anything
	 * imports it - after the user has waited through the whole download.
	 *
	 * `onnxruntime-node` requires `onnxruntime-common` (its shared type and backend
	 * registry) at import time. llama is the extreme case: the platform payload is
	 * the binary alone, and everything that calls it (`node-llama-cpp` and its 115
	 * packages) arrives as dependencies. See `llama-dependencies.ts`.
	 */
	readonly dependencies: readonly NativeRuntimeDependency[];
}

/**
 * A second tarball that has to land inside the runtime for it to import.
 *
 * Extracted to `node_modules/<name>` under the install root (or a nested
 * `installPath`), so ordinary node resolution finds it from the entry point with
 * no loader involvement and no path rewriting.
 */
export interface NativeRuntimeDependency {
	/** Package name. */
	readonly name: string;
	/** Fully pinned tarball URL. A version, never a tag or a range. */
	readonly url: string;
	/** Lowercase hex SHA-256 of the tarball as downloaded. */
	readonly sha256: string;
	/** COMPRESSED size in bytes. */
	readonly bytes: number;
	/**
	 * Directory to extract into, relative to the install root. Defaults to
	 * `node_modules/<name>`. Set for a package npm nests under its dependent
	 * (`node_modules/ora/node_modules/cli-spinners`) because a sibling needs a
	 * different version of it.
	 */
	readonly installPath?: string;
	/**
	 * Path prefixes to keep, relative to the package root, as for a payload.
	 * Absent means everything: pruning a small package is how a lazily imported
	 * file goes missing. Set only where a package carries something large that
	 * nothing on the load path reads.
	 */
	readonly keep?: readonly string[];
}

/** Where a dependency is extracted, relative to the install root. */
export function dependencyInstallPath(dependency: NativeRuntimeDependency): string {
	return dependency.installPath ?? `node_modules/${dependency.name}`;
}

/**
 * `3.20.0`, matching `versionPin` for the `llama` runtime. One constant for the
 * platform payload and `node-llama-cpp` itself: the package refuses a binary
 * built for another release.
 */
const LLAMA_VERSION = NODE_LLAMA_CPP_VERSION;
/**
 * `1.30.0`, matching `versionPin` for the `onnx` runtime.
 *
 * Not 1.27.0, which was pinned first and is WRONG for openWakeWord: it computes
 * the embedding graph differently (same mel frames in, different embeddings
 * out), so the classifier scored a clear "hey jarvis" at 0.0001 where 1.29 and
 * 1.30 score 0.999. Neither version publishes a darwin-x64 binary.
 */
const ONNX_VERSION = '1.30.0';

/**
 * The `@node-llama-cpp/*` package serving each platform.
 *
 * macOS arm64 takes the Metal build: it is the only one of the four that is a
 * choice rather than the sole option, and Metal is why local inference on Apple
 * silicon is usable at all.
 */
const LLAMA_PACKAGE_BY_PLATFORM: Readonly<Record<NativePlatformKey, string>> = Object.freeze({
	'darwin-arm64': 'mac-arm64-metal',
	'darwin-x64': 'mac-x64',
	'win32-x64': 'win-x64',
	'linux-x64': 'linux-x64',
});

function llamaArtifact(
	platform: NativePlatformKey,
	sha256: string,
	bytes: number
): NativeRuntimeArtifact {
	const pkg = LLAMA_PACKAGE_BY_PLATFORM[platform];
	const installPath = `node_modules/@node-llama-cpp/${pkg}`;
	return Object.freeze({
		runtimeId: 'llama' as const,
		platform,
		url: `https://registry.npmjs.org/@node-llama-cpp/${pkg}/-/${pkg}-${LLAMA_VERSION}.tgz`,
		sha256,
		bytes,
		stripComponents: 1,
		// Where `node-llama-cpp` imports it from, so the tree is the one `npm
		// install` would have produced and nothing in the loader rewrites a path.
		installPath,
		// The whole package. It is 4.5 MB to 10.4 MB compressed and is the binary
		// plus a `getBinsDir()` shim, so there is nothing to prune.
		keep: Object.freeze(['dist', 'bins', 'package.json']),
		// The JavaScript half, not the platform package: `getLlama()` lives there.
		entry: 'node_modules/node-llama-cpp/dist/index.js',
		binary: `${installPath}/bins/${pkg}/llama-addon.node`,
		dependencies: NODE_LLAMA_CPP_DEPENDENCIES,
	});
}

/** The ONNX Runtime binary directory for a platform, inside the npm tarball. */
const ONNX_BIN_DIR: Readonly<Record<NativePlatformKey, string>> = Object.freeze({
	'darwin-arm64': 'bin/napi-v6/darwin/arm64',
	'darwin-x64': 'bin/napi-v6/darwin/x64',
	'win32-x64': 'bin/napi-v6/win32/x64',
	'linux-x64': 'bin/napi-v6/linux/x64',
});

/**
 * The single ONNX Runtime tarball, verified once and described per platform.
 *
 * Same bytes and same hash for every row: it is one download whose `keep` differs.
 * Repeating the hash per platform is deliberate, so a reader never has to hold
 * "which of these share a file" in their head to check one.
 */
const ONNX_TARBALL_URL = `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNX_VERSION}.tgz`;
const ONNX_TARBALL_SHA256 = '6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75';
const ONNX_TARBALL_BYTES = 113_507_888;

/**
 * `onnxruntime-node`'s own runtime dependency.
 *
 * `dist/index.js` requires it on the first line, so without it the runtime
 * installs perfectly and then fails to import. 66 KB of JavaScript, pinned to the
 * same version as the runtime it serves - a mismatched pair would resolve, load,
 * and then disagree about the backend registry.
 *
 * `adm-zip` and `global-agent` are also in its `dependencies` and are deliberately
 * NOT here: both are used only by the package's install script, which never runs
 * on this path because the binary arrives pre-extracted.
 */
const ONNX_DEPENDENCIES: readonly NativeRuntimeDependency[] = Object.freeze([
	Object.freeze({
		name: 'onnxruntime-common',
		url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ONNX_VERSION}.tgz`,
		sha256: '7906c439e0d3e0f4048caa23b64cdfadc0f455c377f579ce1ab2a4b778f07d5f',
		bytes: 66_795,
	}),
]);

function onnxArtifact(platform: NativePlatformKey, binary: string): NativeRuntimeArtifact {
	const binDir = ONNX_BIN_DIR[platform];
	return Object.freeze({
		runtimeId: 'onnx' as const,
		platform,
		url: ONNX_TARBALL_URL,
		sha256: ONNX_TARBALL_SHA256,
		bytes: ONNX_TARBALL_BYTES,
		stripComponents: 1,
		installPath: '',
		// `dist` is 132 KB of JavaScript; the other four platforms' binaries are
		// the ~220 MB this list exists to throw away.
		keep: Object.freeze(['dist', 'package.json', binDir]),
		entry: 'dist/index.js',
		binary: `${binDir}/${binary}`,
		dependencies: ONNX_DEPENDENCIES,
	});
}

/**
 * Every downloadable runtime payload.
 *
 * There are exactly two, and there used to be a third that could not exist.
 * Speech-to-text was bound to `smart-whisper`, which publishes no prebuilt binary
 * for any platform and runs `node-gyp rebuild` at install time - so there was
 * nothing to download, and shipping it meant either putting a compiler in front
 * of every user or inventing a binary distribution we would then have to build,
 * sign, and host. Since Whisper has official ONNX exports, speech-to-text now
 * runs on the ONNX Runtime payload below, which text-to-speech and the wake word
 * already required. The slot that was impossible to ship became free.
 */
export const NATIVE_RUNTIME_ARTIFACTS: readonly NativeRuntimeArtifact[] = Object.freeze([
	llamaArtifact(
		'darwin-arm64',
		'c9162af601337ce96d407b9ca7f927b4f26540dbca9d1ca6b11f55a1055deb86',
		4_496_061
	),
	llamaArtifact(
		'darwin-x64',
		'ce8381be4a35709af22b0a71c6d5b7ba340d0f5d3ba84dd9ee09d280d7181265',
		10_432_970
	),
	llamaArtifact(
		'win32-x64',
		'b6aeb2066e4256631757b46d9ad179ee8a2cb6ac629888f7a477d5134c533531',
		9_311_462
	),
	llamaArtifact(
		'linux-x64',
		'76dbb03706ff469dee148e835e22c536b76c7c2865ac8c26f90739dda58b2dd0',
		10_164_694
	),

	onnxArtifact('darwin-arm64', 'onnxruntime_binding.node'),
	onnxArtifact('darwin-x64', 'onnxruntime_binding.node'),
	onnxArtifact('win32-x64', 'onnxruntime_binding.node'),
	onnxArtifact('linux-x64', 'onnxruntime_binding.node'),
]);

/** The payload for a runtime on a platform, or null when there is none. */
export function nativeRuntimeArtifact(
	runtimeId: NativeRuntimeId,
	platform: NativePlatformKey
): NativeRuntimeArtifact | null {
	return (
		NATIVE_RUNTIME_ARTIFACTS.find(
			(entry) => entry.runtimeId === runtimeId && entry.platform === platform
		) ?? null
	);
}

/** True when this runtime can be downloaded for this platform at all. */
export function isNativeRuntimeDownloadable(
	runtimeId: NativeRuntimeId,
	platform: NativePlatformKey
): boolean {
	return nativeRuntimeArtifact(runtimeId, platform) !== null;
}

/**
 * Total download for a set of runtimes on a platform, in bytes: each payload
 * plus the dependencies it installs alongside it.
 *
 * Deduplicated by URL, because ONNX Runtime serves several rows from one tarball
 * and a total that counted it twice would promise a wait that never happens. The
 * same property matters more once a second runtime shares a payload. Dependencies
 * count because they are most of the wait for llama: the platform binary is
 * 4.5 MB, `node-llama-cpp` alone is 34.8 MB.
 */
export function nativeRuntimeDownloadBytes(
	runtimeIds: readonly NativeRuntimeId[],
	platform: NativePlatformKey
): number {
	const sizes = new Map<string, number>();
	for (const runtimeId of runtimeIds) {
		const artifact = nativeRuntimeArtifact(runtimeId, platform);
		if (artifact) addArtifactSizes(artifact, sizes);
	}
	return sumSizes(sizes);
}

/**
 * One artifact's download in bytes: its payload plus every distinct dependency
 * tarball.
 *
 * Distinct by URL because npm nests the same version under several dependents
 * (`ansi-regex@5.0.1` three times for llama) and the installer fetches each URL
 * once. This is the number the install's progress counts to.
 */
export function nativeRuntimeArtifactBytes(artifact: NativeRuntimeArtifact): number {
	return sumSizes(addArtifactSizes(artifact, new Map()));
}

function addArtifactSizes(
	artifact: NativeRuntimeArtifact,
	sizes: Map<string, number>
): Map<string, number> {
	sizes.set(artifact.url, artifact.bytes);
	for (const dependency of artifact.dependencies) sizes.set(dependency.url, dependency.bytes);
	return sizes;
}

function sumSizes(sizes: Map<string, number>): number {
	let total = 0;
	for (const bytes of sizes.values()) total += bytes;
	return total;
}
