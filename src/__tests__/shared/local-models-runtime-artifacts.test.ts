/**
 * @file local-models-runtime-artifacts.test.ts
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
} from '../../shared/local-models/native-runtimes';
import {
	NATIVE_RUNTIME_ARTIFACTS,
	dependencyInstallPath,
	isNativeRuntimeDownloadable,
	nativeRuntimeArtifact,
	nativeRuntimeDownloadBytes,
	type NativeRuntimeArtifact,
} from '../../shared/local-models/runtime-artifacts';
import {
	NODE_LLAMA_CPP_DEPENDENCIES,
	npmTarballUrl,
} from '../../shared/local-models/llama-dependencies';
import { shouldKeepArchiveEntry } from '../../main/local-models/runtime/runtime-installer';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Would a path relative to the install root survive extraction?
 *
 * The path may live in the payload (under its `installPath`) or in any
 * dependency (under its own), so this finds the tarball that owns it and asks
 * that tarball's `keep` list. Null when no tarball lands there at all.
 */
function keptAt(artifact: NativeRuntimeArtifact, rootRelative: string): string | null {
	const sources = [
		{ dir: artifact.installPath, strip: artifact.stripComponents, keep: artifact.keep },
		...artifact.dependencies.map((dependency) => ({
			dir: dependencyInstallPath(dependency),
			strip: 1,
			keep: dependency.keep ?? [''],
		})),
	];
	// Longest directory first, so a nested package wins over its parent.
	sources.sort((a, b) => b.dir.length - a.dir.length);
	for (const source of sources) {
		const prefix = source.dir ? `${source.dir}/` : '';
		if (!rootRelative.startsWith(prefix)) continue;
		const inner = rootRelative.slice(prefix.length);
		// An absent `keep` keeps everything; `['']` expresses that to the matcher.
		const kept = source.keep.includes('')
			? inner
			: shouldKeepArchiveEntry(`package/${inner}`, source.strip, source.keep);
		return kept === null ? null : `${prefix}${kept}`;
	}
	return null;
}

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
			const kept = keptAt(artifact, artifact.binary);
			expect(
				kept,
				`${artifact.runtimeId}/${artifact.platform} discards its own binary: ${artifact.binary}`
			).toBe(artifact.binary);
		}
	});

	it('keeps the subtree its own entry point lives in', () => {
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			const kept = keptAt(artifact, artifact.entry);
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

	it('offers a payload for every runtime in the registry, on every supported platform', () => {
		// There used to be a runtime with no payload at all - `smart-whisper`, which
		// ran node-gyp at install time and so had nothing to download, which made
		// speech-to-text the one slot that could never ship. Speech-to-text now runs
		// on ONNX Runtime and that runtime is gone. If this ever fails again, some
		// slot has quietly become uninstallable.
		for (const runtime of NATIVE_RUNTIMES) {
			for (const platform of NATIVE_PLATFORM_KEYS) {
				expect(
					isNativeRuntimeDownloadable(runtime.id, platform),
					`${runtime.id} has no payload for ${platform}`
				).toBe(true);
			}
		}
	});

	it('carries every dependency a payload needs to import', () => {
		// An npm tarball ships a package's own files and NOT its dependency tree, so
		// a payload that declares a runtime dependency arrives incomplete. Without
		// this, `onnxruntime-node` installed perfectly and then threw
		// MODULE_NOT_FOUND on the first transcription - after a 101 MB download.
		const onnx = nativeRuntimeArtifact('onnx', 'darwin-arm64');
		expect(onnx?.dependencies.map((dependency) => dependency.name)).toEqual(['onnxruntime-common']);

		// The llama platform package is the binary alone; `getLlama()` lives in
		// node-llama-cpp, which arrives with its whole production closure.
		const llama = nativeRuntimeArtifact('llama', 'darwin-arm64');
		const names = llama?.dependencies.map((dependency) => dependency.name) ?? [];
		expect(names[0]).toBe('node-llama-cpp');
		expect(names).toContain('@huggingface/jinja');
		expect(names).toContain('lifecycle-utils');
		expect(llama?.dependencies).toBe(NODE_LLAMA_CPP_DEPENDENCIES);
	});

	it('lays llama out so node-llama-cpp can import its platform package', () => {
		// node-llama-cpp finds its binary with `import('@node-llama-cpp/<pkg>')`.
		// Anywhere but `node_modules/@node-llama-cpp/<pkg>` that import fails, and
		// the runtime installs cleanly and then cannot open a model.
		for (const platform of NATIVE_PLATFORM_KEYS) {
			const llama = nativeRuntimeArtifact('llama', platform)!;
			const pkg = llama.url.match(/@node-llama-cpp\/([^/]+)\//)![1];
			expect(llama.installPath).toBe(`node_modules/@node-llama-cpp/${pkg}`);
			expect(llama.binary.startsWith(`${llama.installPath}/bins/${pkg}/`)).toBe(true);
			expect(llama.entry).toBe('node_modules/node-llama-cpp/dist/index.js');
		}
	});

	it('installs every llama dependency at a distinct path under node_modules', () => {
		const paths = NODE_LLAMA_CPP_DEPENDENCIES.map(dependencyInstallPath);
		expect(new Set(paths).size).toBe(paths.length);
		for (const installPath of paths) {
			expect(installPath).toMatch(/^node_modules\//);
			expect(installPath.split('/')).not.toContain('..');
		}
	});

	it('nests a llama dependency only under a package that is itself installed', () => {
		const paths = new Set(NODE_LLAMA_CPP_DEPENDENCIES.map(dependencyInstallPath));
		for (const installPath of paths) {
			const parent = installPath.replace(/\/node_modules\/(?:@[^/]+\/)?[^/]+$/, '');
			if (parent === installPath || parent === 'node_modules') continue;
			expect(paths.has(parent), `${installPath} is nested under a missing ${parent}`).toBe(true);
		}
	});

	it('pins node-llama-cpp to the same version as the platform binary', () => {
		// node-llama-cpp refuses a binary from another release.
		const llama = NATIVE_RUNTIMES.find((runtime) => runtime.id === 'llama')!;
		const pkg = NODE_LLAMA_CPP_DEPENDENCIES.find(
			(dependency) => dependency.name === 'node-llama-cpp'
		);
		expect(pkg?.url).toBe(npmTarballUrl('node-llama-cpp', llama.versionPin));
	});

	it("drops node-llama-cpp's llama.cpp source bundle and keeps what loads", () => {
		const pkg = NODE_LLAMA_CPP_DEPENDENCIES.find(
			(dependency) => dependency.name === 'node-llama-cpp'
		)!;
		const keep = pkg.keep!;
		expect(shouldKeepArchiveEntry('package/llama/gitRelease.bundle', 1, keep)).toBeNull();
		expect(shouldKeepArchiveEntry('package/dist/index.js', 1, keep)).toBe('dist/index.js');
		expect(shouldKeepArchiveEntry('package/llama/binariesGithubRelease.json', 1, keep)).toBe(
			'llama/binariesGithubRelease.json'
		);
		expect(shouldKeepArchiveEntry('package/llama/grammars/json.gbnf', 1, keep)).toBe(
			'llama/grammars/json.gbnf'
		);
	});

	it('pins and hashes every dependency exactly as it does a payload', () => {
		// A dependency is code that gets imported into the main process. It earns
		// the same treatment as the payload: a pinned version, a real hash, a real
		// size, and no tags or ranges anywhere.
		for (const artifact of NATIVE_RUNTIME_ARTIFACTS) {
			for (const dependency of artifact.dependencies) {
				expect(dependency.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(dependency.bytes).toBeGreaterThan(0);
				expect(dependency.url).toMatch(/^https:\/\/registry\.npmjs\.org\//);
				expect(dependency.url).toMatch(/-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/);
			}
		}
	});

	it('pins a dependency to the same version as the runtime it serves', () => {
		// `onnxruntime-common` carries the backend registry the addon registers
		// into. A mismatched pair resolves, loads, and then disagrees about what
		// backends exist - which surfaces as a session that refuses for no
		// visible reason.
		const onnx = NATIVE_RUNTIMES.find((runtime) => runtime.id === 'onnx');
		const artifact = nativeRuntimeArtifact('onnx', 'darwin-arm64');
		for (const dependency of artifact?.dependencies ?? []) {
			expect(dependency.url).toContain(`-${onnx?.versionPin}.tgz`);
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

	it('sums the payloads a set of runtimes needs, dependencies included', () => {
		// Each distinct tarball once: npm nests some versions under several
		// dependents, and the installer fetches each URL a single time.
		const sum = (artifact: NativeRuntimeArtifact) => {
			const sizes = new Map([[artifact.url, artifact.bytes]]);
			for (const dep of artifact.dependencies) sizes.set(dep.url, dep.bytes);
			return [...sizes.values()].reduce((total, bytes) => total + bytes, 0);
		};
		const llama = nativeRuntimeArtifact('llama', platform)!;
		const onnx = nativeRuntimeArtifact('onnx', platform)!;
		expect(nativeRuntimeDownloadBytes(['llama', 'onnx'], platform)).toBe(sum(llama) + sum(onnx));
		// node-llama-cpp alone dwarfs the 4.5 MB platform binary.
		expect(nativeRuntimeDownloadBytes(['llama'], platform)).toBeGreaterThan(30_000_000);
	});

	it('counts a shared tarball once', () => {
		// Both ONNX slots come from the same 101 MB download. Counting it twice
		// would promise a wait that never happens, which reads as a stalled
		// progress bar when the second half completes instantly.
		expect(nativeRuntimeDownloadBytes(['onnx', 'onnx'], platform)).toBe(
			nativeRuntimeDownloadBytes(['onnx'], platform)
		);
	});

	it('ignores runtimes with no payload rather than throwing', () => {
		expect(nativeRuntimeDownloadBytes(['whisper'], platform)).toBe(0);
	});

	it('is zero for an empty selection', () => {
		expect(nativeRuntimeDownloadBytes([], platform)).toBe(0);
	});
});

describe('npmTarballUrl', () => {
	it('builds the registry tarball URL for plain and scoped packages', () => {
		expect(npmTarballUrl('chalk', '5.6.2')).toBe(
			'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz'
		);
		expect(npmTarballUrl('@huggingface/jinja', '0.5.10')).toBe(
			'https://registry.npmjs.org/@huggingface/jinja/-/jinja-0.5.10.tgz'
		);
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
