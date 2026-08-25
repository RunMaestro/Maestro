/**
 * The downloadable payloads that carry A Cappella's native runtimes.
 *
 * **Why these are downloaded and not bundled.** A Cappella is an Encore Feature
 * that ships off. Bundling llama.cpp and ONNX Runtime would put roughly 300 MB of
 * inference binaries into every installer, on every platform, for every user -
 * including the large majority who never switch voice on. The binaries are also
 * the only part of the feature whose size is not a rounding error, so they are the
 * one part worth fetching on demand.
 *
 * The precedent is already in the product: local voice ALREADY asks the user to
 * download 454 MB to 1.5 GB of models before it can run. A runtime payload rides
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
 * The one wart, recorded rather than hidden: `onnxruntime-node` publishes a
 * single tarball containing all five platform payloads, so a user downloads
 * ~101 MB to keep ~37 MB. {@link NativeRuntimeArtifact.keep} is why disk does not
 * pay that tax as well - everything outside the running platform's subtree is
 * discarded at extraction. Splitting the download too would mean republishing
 * someone else's binaries under our own name, which is a supply chain we would
 * then own.
 */

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
	 * Path prefixes to keep, relative to the stripped root. Anything else in the
	 * archive is discarded during extraction.
	 *
	 * This is what stops the ONNX Runtime tarball from leaving four platforms'
	 * worth of binaries on a machine that can run exactly one of them.
	 */
	readonly keep: readonly string[];
	/**
	 * The module the loader imports, relative to the install root.
	 *
	 * Always a JS entry point rather than the `.node` file itself: the addon is
	 * reached through its package's own resolution, and pointing a loader at raw
	 * `.node` would skip whatever setup that package does around it.
	 */
	readonly entry: string;
	/**
	 * The native binary that must exist once extraction finishes, relative to the
	 * install root.
	 *
	 * Checked on install and by the self-test. A payload whose archive extracted
	 * cleanly but whose binary is absent is a payload that will fail later inside
	 * a dlopen, where the error names nothing a user can act on.
	 */
	readonly binary: string;
}

/** `3.20.0`, matching `versionPin` for the `llama` runtime. */
const LLAMA_VERSION = '3.20.0';
/** `1.27.0`, matching `versionPin` for the `onnx` runtime. */
const ONNX_VERSION = '1.27.0';

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
	return Object.freeze({
		runtimeId: 'llama' as const,
		platform,
		url: `https://registry.npmjs.org/@node-llama-cpp/${pkg}/-/${pkg}-${LLAMA_VERSION}.tgz`,
		sha256,
		bytes,
		stripComponents: 1,
		// The whole package. It is 4.5 MB to 10.4 MB compressed and carries no
		// dependencies, so there is nothing to prune and nothing to resolve.
		keep: Object.freeze(['dist', 'bins', 'package.json']),
		entry: 'dist/index.js',
		binary: `bins/${pkg}/llama-addon.node`,
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
const ONNX_TARBALL_SHA256 = 'c3779c01c59832f8c03e2c392ac3af10bf08579f1822e8b1c63cc451edb302a2';
const ONNX_TARBALL_BYTES = 100_893_124;

function onnxArtifact(platform: NativePlatformKey, binary: string): NativeRuntimeArtifact {
	const binDir = ONNX_BIN_DIR[platform];
	return Object.freeze({
		runtimeId: 'onnx' as const,
		platform,
		url: ONNX_TARBALL_URL,
		sha256: ONNX_TARBALL_SHA256,
		bytes: ONNX_TARBALL_BYTES,
		stripComponents: 1,
		// `dist` is 132 KB of JavaScript; the other four platforms' binaries are
		// the ~220 MB this list exists to throw away.
		keep: Object.freeze(['dist', 'package.json', binDir]),
		entry: 'dist/index.js',
		binary: `${binDir}/${binary}`,
	});
}

/**
 * Every downloadable runtime payload.
 *
 * `whisper` is deliberately absent, and its absence is the honest state rather
 * than an oversight: `smart-whisper` publishes no prebuilt binary for any
 * platform and runs `node-gyp rebuild` at install time, so there is nothing to
 * download. Giving it a row here would mean either shipping a compiler to users
 * or inventing a binary distribution we would then have to build, sign, and host.
 * Until speech-to-text moves to a runtime that publishes prebuilds, the local STT
 * slot stays unavailable and says so.
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
 * Total download for a set of runtimes on a platform, in bytes.
 *
 * Deduplicated by URL, because ONNX Runtime serves several rows from one tarball
 * and a total that counted it twice would promise a wait that never happens. The
 * same property matters more once a second runtime shares a payload.
 */
export function nativeRuntimeDownloadBytes(
	runtimeIds: readonly NativeRuntimeId[],
	platform: NativePlatformKey
): number {
	const seen = new Set<string>();
	let total = 0;
	for (const runtimeId of runtimeIds) {
		const artifact = nativeRuntimeArtifact(runtimeId, platform);
		if (!artifact || seen.has(artifact.url)) continue;
		seen.add(artifact.url);
		total += artifact.bytes;
	}
	return total;
}
