/**
 * @file local-models-server-engine.test.ts
 *
 * The pinned llama-server table and `selectServerBuild`. The table is data a
 * person typed from a GitHub API listing, so these tests check it against itself:
 * a typo in a digest or a URL is a download that fails on the user's machine, not
 * in CI.
 */

import { describe, it, expect } from 'vitest';

import {
	availableServerBuildChoices,
	isServerBuildChoice,
	LLAMA_SERVER_RELEASE,
	SERVER_BUILD_CHOICES,
	SERVER_ENGINE_BUILDS,
	selectServerBuild,
	serverBuildDownloadBytes,
	serverPlatformKey,
	type ServerBuildChoice,
} from '../../shared/local-models/server-engine';

const PLATFORMS: ReadonlyArray<[string, string]> = [
	['darwin', 'arm64'],
	['darwin', 'x64'],
	['win32', 'x64'],
	['win32', 'arm64'],
	['linux', 'x64'],
	['linux', 'arm64'],
];

/** The asset name each (platform, choice) must resolve to, or null. Written out, not derived. */
const EXPECTED: Record<string, Record<ServerBuildChoice, string[] | null>> = {
	'darwin-arm64': {
		default: ['llama-b11559-bin-macos-arm64.tar.gz'],
		cpu: null,
		cuda: null,
		rocm: null,
	},
	'darwin-x64': {
		default: ['llama-b11559-bin-macos-x64.tar.gz'],
		cpu: ['llama-b11559-bin-macos-x64.tar.gz'],
		cuda: null,
		rocm: null,
	},
	'win32-x64': {
		default: ['llama-b11559-bin-win-vulkan-x64.zip'],
		cpu: ['llama-b11559-bin-win-cpu-x64.zip'],
		cuda: ['llama-b11559-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
		rocm: ['llama-b11559-bin-win-rocm-10.0-x64.zip'],
	},
	'win32-arm64': {
		default: ['llama-b11559-bin-win-vulkan-arm64.zip'],
		cpu: ['llama-b11559-bin-win-cpu-arm64.zip'],
		cuda: null,
		rocm: null,
	},
	'linux-x64': {
		default: ['llama-b11559-bin-ubuntu-vulkan-x64.tar.gz'],
		cpu: ['llama-b11559-bin-ubuntu-x64.tar.gz'],
		cuda: [
			'llama-b11559-bin-ubuntu-cuda-12.8-x64.tar.gz',
			'cudart-llama-b11559-bin-ubuntu-cuda-12.8-x64.tar.gz',
		],
		rocm: ['llama-b11559-bin-ubuntu-rocm-10.0-x64.tar.gz'],
	},
	'linux-arm64': {
		default: ['llama-b11559-bin-ubuntu-vulkan-arm64.tar.gz'],
		cpu: ['llama-b11559-bin-ubuntu-arm64.tar.gz'],
		cuda: null,
		rocm: null,
	},
};

describe('selectServerBuild', () => {
	for (const [platform, arch] of PLATFORMS) {
		for (const choice of SERVER_BUILD_CHOICES) {
			const expected = EXPECTED[`${platform}-${arch}`][choice];
			it(`${platform}-${arch} + ${choice} -> ${expected ? expected[0] : 'null'}`, () => {
				const selected = selectServerBuild(platform, arch, choice);
				expect(selected?.assets.map((entry) => entry.name) ?? null).toEqual(expected);
			});
		}
	}

	it('returns null for a platform llama.cpp publishes no build for', () => {
		expect(selectServerBuild('freebsd', 'x64', 'default')).toBeNull();
		expect(selectServerBuild('linux', 'ia32', 'default')).toBeNull();
	});

	it('never substitutes a different build for the one asked for', () => {
		// cpu on Apple silicon has no build: Metal-only. It must not come back as Metal.
		expect(selectServerBuild('darwin', 'arm64', 'cpu')).toBeNull();
		expect(selectServerBuild('darwin', 'x64', 'cuda')).toBeNull();
	});

	it('names the executable per platform and strips the tar wrapper only for tar.gz', () => {
		expect(selectServerBuild('win32', 'x64', 'default')).toMatchObject({
			binary: 'llama-server.exe',
			stripComponents: 0,
		});
		expect(selectServerBuild('linux', 'x64', 'default')).toMatchObject({
			binary: 'llama-server',
			stripComponents: 1,
		});
		expect(selectServerBuild('darwin', 'arm64', 'default')).toMatchObject({
			binary: 'llama-server',
			stripComponents: 1,
		});
	});

	it('labels the default build by its accelerator', () => {
		expect(selectServerBuild('darwin', 'arm64', 'default')?.label).toBe('Metal');
		expect(selectServerBuild('win32', 'x64', 'default')?.label).toBe('Vulkan');
		expect(selectServerBuild('darwin', 'x64', 'default')?.label).toBe('CPU');
		expect(selectServerBuild('win32', 'x64', 'cuda')?.label).toBe('CUDA 12.4');
	});
});

describe('availableServerBuildChoices', () => {
	it('lists default first and only the choices that resolve', () => {
		expect(availableServerBuildChoices('darwin', 'arm64')).toEqual(['default']);
		expect(availableServerBuildChoices('darwin', 'x64')).toEqual(['default', 'cpu']);
		expect(availableServerBuildChoices('win32', 'x64')).toEqual(['default', 'cpu', 'cuda', 'rocm']);
		expect(availableServerBuildChoices('linux', 'arm64')).toEqual(['default', 'cpu']);
		expect(availableServerBuildChoices('freebsd', 'x64')).toEqual([]);
	});
});

describe('the pinned table', () => {
	const assets = SERVER_ENGINE_BUILDS.flatMap((entry) => entry.assets);

	it('pins every asset to the release with a digest and a size', () => {
		for (const entry of assets) {
			expect(entry.url).toBe(
				`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_SERVER_RELEASE}/${entry.name}`
			);
			expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(entry.bytes).toBeGreaterThan(1_000_000);
			expect(entry.format).toBe(entry.name.endsWith('.zip') ? 'zip' : 'tar.gz');
		}
	});

	it('never uses one digest for two different files', () => {
		const byDigest = new Map<string, string>();
		for (const entry of assets) {
			const earlier = byDigest.get(entry.sha256);
			expect(earlier === undefined || earlier === entry.name).toBe(true);
			byDigest.set(entry.sha256, entry.name);
		}
	});

	it('pairs every vendor GPU build with its runtime companion where the release ships one', () => {
		for (const entry of SERVER_ENGINE_BUILDS.filter((candidate) => candidate.kind === 'cuda')) {
			expect(entry.assets).toHaveLength(2);
			expect(entry.assets[1].name.startsWith('cudart-')).toBe(true);
		}
	});

	it('gives every platform a default build and never lists a choice twice', () => {
		for (const [platform, arch] of PLATFORMS) {
			expect(selectServerBuild(platform, arch, 'default')).not.toBeNull();
			const rows = SERVER_ENGINE_BUILDS.filter((entry) => entry.platform === `${platform}-${arch}`);
			const answered = rows.flatMap((entry) => entry.answers);
			expect(new Set(answered).size).toBe(answered.length);
		}
	});

	it('raises the expansion cap on exactly the zips that need it', () => {
		for (const entry of assets) {
			if (entry.maxExpandedBytes !== undefined) expect(entry.format).toBe('zip');
		}
		const cuda = selectServerBuild('win32', 'x64', 'cuda')!;
		expect(cuda.assets.every((entry) => entry.maxExpandedBytes! > 256 * 1024 * 1024)).toBe(true);
	});

	it('sums the download across companions', () => {
		const cuda = selectServerBuild('win32', 'x64', 'cuda')!;
		expect(serverBuildDownloadBytes(cuda)).toBe(265_207_128 + 391_443_627);
	});
});

describe('guards', () => {
	it('recognises the four choices only', () => {
		expect(isServerBuildChoice('cuda')).toBe(true);
		expect(isServerBuildChoice('metal')).toBe(false);
		expect(isServerBuildChoice(undefined)).toBe(false);
	});

	it('maps process values to a platform key', () => {
		expect(serverPlatformKey('win32', 'arm64')).toBe('win32-arm64');
		expect(serverPlatformKey('darwin', 'ia32')).toBeNull();
	});
});
