/**
 * @file acappella-runtime-artifacts.test.ts
 *
 * The artifact table is a set of promises about bytes that will be downloaded
 * onto a user's machine and then dlopen'd. Every test here guards a failure that
 * only shows up on someone else's computer:
 *
 *   - A hash that is not a hash, or was pasted one character short, fails AFTER
 *     the user has waited through a 101 MB download.
 *   - A URL whose version has drifted from `versionPin` downloads a runtime the
 *     rest of the build was not written against.
 *   - A `keep` list that does not include the artifact's own `binary` extracts
 *     cleanly and produces an install with nothing in it.
 *
 * The last one is the reason `shouldKeepArchiveEntry` is exported and pure: it is
 * the only logic in the installer that can be wrong in two opposite directions,
 * and neither is visible without running an extraction.
 */

import { describe, it, expect } from 'vitest';

import {
	NATIVE_PLATFORM_KEYS,
	NATIVE_RUNTIMES,
	getNativeRuntime,
	type NativePlatformKey,
} from '../../shared/acappella/native-runtimes';
import {
	NATIVE_RUNTIME_ARTIFACTS,
	isNativeRuntimeDownloadable,
	nativeRuntimeArtifact,
	nativeRuntimeDownloadBytes,
} from '../../shared/acappella/runtime-artifacts';
import { shouldKeepArchiveEntry } from '../../main/acappella/runtime/runtime-installer';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

describe('native runtime artifacts', () => {
	it('records a real, full-length SHA-256 for every artifact', () => {
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			expect(
				SHA256_PATTERN.test(artifact.sha256),
				`${artifact.runtimeId}/${artifact.platform} has a malformed sha256: ${artifact.sha256}`
			).toBe(true);
		}
	});

	it('pins a version in every URL and never a tag or a range', () => {
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			expect(artifact.url).toMatch(/^https:\/\//);
			expect(
				/-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/.test(artifact.url),
				`${artifact.runtimeId}/${artifact.platform} is not pinned to a version: ${artifact.url}`
			).toBe(true);
		}
	});

	it('downloads the exact version the runtime registry pins', () => {
		// The registry's `versionPin` is what the rest of the build was written
		// against. A URL that has drifted from it is how a runtime gets upgraded
		// without anyone deciding to upgrade it.
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			const descriptor = getNativeRuntime(artifact.runtimeId);
			expect(descriptor).toBeTruthy();
			expect(
				artifact.url.includes(descriptor!.versionPin),
				`${artifact.runtimeId} pins ${descriptor!.versionPin} but downloads ${artifact.url}`
			).toBe(true);
		}
	});

	it('states a positive compressed size for every artifact', () => {
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			expect(artifact.bytes).toBeGreaterThan(0);
		}
	});

	it('strips exactly one component, because npm tarballs are rooted at package/', () => {
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			expect(artifact.stripComponents).toBe(1);
		}
	});

	it('keeps the subtree its own binary lives in', () => {
		// The failure this catches: an artifact that extracts successfully and is
		// then missing the one file the loader needs.
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			const kept = shouldKeepArchiveEntry(
				`package/${artifact.binary}`,
				artifact.stripComponents,
				artifact.keep
			);
			expect(
				kept,
				`${artifact.runtimeId}/${artifact.platform} discards its own binary: ${artifact.binary}`
			).toBe(artifact.binary);
		}
	});

	it('keeps the subtree its own entry point lives in', () => {
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			const kept = shouldKeepArchiveEntry(
				`package/${artifact.entry}`,
				artifact.stripComponents,
				artifact.keep
			);
			expect(
				kept,
				`${artifact.runtimeId}/${artifact.platform} discards its own entry: ${artifact.entry}`
			).toBe(artifact.entry);
		}
	});

	it('offers a payload for every supported platform of the runtimes it covers', () => {
		for (const runtimeId of ['llama', 'onnx'] as const) {
			for (const platform of NATIVE_PLATFORM_KEYS) {
				expect(
					isNativeRuntimeDownloadable(runtimeId, platform),
					`${runtimeId} has no payload for ${platform}`
				).toBe(true);
			}
		}
	});

	it('offers no payload for whisper, which publishes no prebuilt binary', () => {
		// Deliberate and load-bearing: `smart-whisper` runs node-gyp at install
		// time, so there is nothing to download. If this ever starts passing as
		// downloadable, someone has added a binary distribution we now maintain.
		for (const platform of NATIVE_PLATFORM_KEYS) {
			expect(isNativeRuntimeDownloadable('whisper', platform)).toBe(false);
			expect(nativeRuntimeArtifact('whisper', platform)).toBeNull();
		}
	});

	it('describes only runtimes that exist in the registry', () => {
		const known = new Set(NATIVE_RUNTIMES.map((runtime) => runtime.id));
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			expect(known.has(artifact.runtimeId)).toBe(true);
		}
	});

	it('gives one runtime and platform exactly one payload', () => {
		const seen = new Set<string>();
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			const key = `${artifact.runtimeId}/${artifact.platform}`;
			expect(seen.has(key), `duplicate artifact for ${key}`).toBe(false);
			seen.add(key);
		}
	});

	it('serves every ONNX platform from one tarball, with one hash', () => {
		// Not a coincidence to be preserved for its own sake: it is why `keep`
		// exists, and why the download total has to deduplicate.
		const onnx = NATIVE_RUNTIME_ARTIFACTS.filter((entry) => entry.runtimeId === 'onnx');
		expect(onnx.length).toBeGreaterThan(1);
		expect(new Set(onnx.map((entry) => entry.url)).size).toBe(1);
		expect(new Set(onnx.map((entry) => entry.sha256)).size).toBe(1);
	});

	it('gives each ONNX platform a different subtree to keep', () => {
		const onnx = NATIVE_RUNTIME_ARTIFACTS.filter((entry) => entry.runtimeId === 'onnx');
		const binaries = onnx.map((entry) => entry.binary);
		expect(new Set(binaries).size).toBe(binaries.length);
	});
});

describe('nativeRuntimeDownloadBytes', () => {
	const platform: NativePlatformKey = 'darwin-arm64';

	it('sums the payloads a set of runtimes needs', () => {
		const llama = nativeRuntimeArtifact('llama', platform)!;
		const onnx = nativeRuntimeArtifact('onnx', platform)!;
		expect(nativeRuntimeDownloadBytes(['llama', 'onnx'], platform)).toBe(llama.bytes + onnx.bytes);
	});

	it('counts a shared tarball once', () => {
		// Both ONNX slots come from the same 101 MB download. Counting it twice
		// would promise a wait that never happens, which reads as a stalled
		// progress bar when the second half completes instantly.
		const onnx = nativeRuntimeArtifact('onnx', platform)!;
		expect(nativeRuntimeDownloadBytes(['onnx', 'onnx'], platform)).toBe(onnx.bytes);
	});

	it('ignores runtimes with no payload rather than throwing', () => {
		expect(nativeRuntimeDownloadBytes(['whisper'], platform)).toBe(0);
	});

	it('is zero for an empty selection', () => {
		expect(nativeRuntimeDownloadBytes([], platform)).toBe(0);
	});
});

describe('shouldKeepArchiveEntry', () => {
	const keep = ['dist', 'package.json', 'bin/napi-v6/darwin/arm64'];

	it('strips the leading package/ that every npm tarball carries', () => {
		expect(shouldKeepArchiveEntry('package/dist/index.js', 1, keep)).toBe('dist/index.js');
	});

	it('keeps a file that is exactly a kept prefix', () => {
		expect(shouldKeepArchiveEntry('package/package.json', 1, keep)).toBe('package.json');
	});

	it('keeps everything under a kept directory, however deep', () => {
		expect(shouldKeepArchiveEntry('package/bin/napi-v6/darwin/arm64/lib.dylib', 1, keep)).toBe(
			'bin/napi-v6/darwin/arm64/lib.dylib'
		);
	});

	it('discards another platform, which is the whole point', () => {
		expect(shouldKeepArchiveEntry('package/bin/napi-v6/win32/x64/onnxruntime.dll', 1, keep)).toBe(
			null
		);
		expect(
			shouldKeepArchiveEntry('package/bin/napi-v6/linux/x64/libonnxruntime.so.1', 1, keep)
		).toBe(null);
	});

	it('matches on whole segments, not string prefixes', () => {
		// `arm64-extra` starts with `arm64`. A `startsWith` implementation would
		// admit it, and admitting a sibling directory is how the size argument
		// quietly stops being true.
		expect(shouldKeepArchiveEntry('package/bin/napi-v6/darwin/arm64-extra/x.node', 1, keep)).toBe(
			null
		);
		expect(shouldKeepArchiveEntry('package/distraction/x.js', 1, keep)).toBe(null);
	});

	it('refuses an entry that climbs out of the root', () => {
		expect(shouldKeepArchiveEntry('package/../evil.node', 1, keep)).toBe(null);
		expect(shouldKeepArchiveEntry('package/dist/../../evil.node', 1, keep)).toBe(null);
	});

	it('discards an entry with nothing left after stripping', () => {
		expect(shouldKeepArchiveEntry('package', 1, keep)).toBe(null);
		expect(shouldKeepArchiveEntry('package/', 1, keep)).toBe(null);
	});

	it('discards anything outside every kept prefix', () => {
		expect(shouldKeepArchiveEntry('package/README.md', 1, keep)).toBe(null);
		expect(shouldKeepArchiveEntry('package/LICENSE', 1, keep)).toBe(null);
	});

	it('keeps nothing when the keep list is empty', () => {
		expect(shouldKeepArchiveEntry('package/dist/index.js', 1, [])).toBe(null);
	});
});
