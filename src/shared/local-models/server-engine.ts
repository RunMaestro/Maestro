/**
 * The Maestro model server's engine: llama.cpp's own `llama-server` binary.
 *
 * **Why this is not a `NativeRuntimeDescriptor`.** The runtimes in
 * `native-runtimes.ts` are npm packages that Node imports in-process. This one is a
 * standalone executable that Maestro supervises as a child process, and it ships
 * from llama.cpp's GitHub releases, not from the npm registry. It also has
 * choices the npm runtimes do not: six platform/arch pairs (Windows and Linux on
 * arm64 as well), and several GPU builds per platform. Forcing it into
 * `NativeRuntimeId` would have meant a fake npm version, a fake entry point and a
 * loader that never loads it.
 *
 * What it shares with them is the rule: pinned source, recorded SHA-256, verified
 * before anything is unpacked. Every digest below is the `digest` field GitHub
 * returns for the release asset (`gh api repos/ggml-org/llama.cpp/releases/tags/<tag>`),
 * pinned here and never fetched at runtime.
 *
 * Everything in here is data and pure functions. Platform branching belongs to the
 * caller, which passes `process.platform` and `process.arch` in, so every platform
 * can be tested from one machine.
 */

/** The llama.cpp release the table below was pinned from. */
export const LLAMA_SERVER_RELEASE = 'b11559';

/** The six platform/arch pairs llama.cpp publishes a server build for. */
export type ServerPlatformKey =
	| 'darwin-arm64'
	| 'darwin-x64'
	| 'win32-x64'
	| 'win32-arm64'
	| 'linux-x64'
	| 'linux-arm64';

/**
 * What the user (or `maestro-cli models server set --build`) asks for.
 *
 *   - `default`: the build that works on the widest range of hardware. Metal on
 *     Apple silicon, Vulkan on Windows and Linux (any GPU vendor, with a CPU
 *     fallback inside the same binary), CPU on Intel macOS.
 *   - `cpu`: the build with no GPU backend.
 *   - `cuda`, `rocm`: vendor builds. Large, and they need a matching driver, so
 *     they are an Advanced choice and never the default.
 */
export type ServerBuildChoice = 'default' | 'cpu' | 'cuda' | 'rocm';

export const SERVER_BUILD_CHOICES: readonly ServerBuildChoice[] = Object.freeze([
	'default',
	'cpu',
	'cuda',
	'rocm',
]);

/** What a build actually is, for the card: "Metal", "Vulkan", "CUDA 12.4" and so on. */
export type ServerBuildKind = 'metal' | 'vulkan' | 'cpu' | 'cuda' | 'rocm';

export type ServerArchiveFormat = 'tar.gz' | 'zip';

/** One downloadable file of a build. The first asset is the build; the rest are companions. */
export interface ServerEngineAsset {
	readonly name: string;
	readonly url: string;
	/** Lowercase hex SHA-256 of the file as downloaded. */
	readonly sha256: string;
	/** COMPRESSED size in bytes. What the user waits for. */
	readonly bytes: number;
	readonly format: ServerArchiveFormat;
	/**
	 * Cap on the EXPANDED size of a zip, in bytes. Absent means the zip reader's own
	 * default. The CUDA and ROCm zips expand past it, and the cap is the guard
	 * against a zip bomb, so it is raised per asset rather than removed.
	 */
	readonly maxExpandedBytes?: number;
}

export interface ServerEngineBuild {
	readonly platform: ServerPlatformKey;
	/** The choice this row answers. A row can answer more than one (see `answers`). */
	readonly kind: ServerBuildKind;
	/** CUDA toolkit or ROCm major the build was compiled against, when it matters. */
	readonly variant: string | null;
	/** Human label: "Metal", "Vulkan", "CPU", "CUDA 12.4", "ROCm 10.0". */
	readonly label: string;
	/** Choices this build satisfies. `default` and `cpu` coincide on Intel macOS. */
	readonly answers: readonly ServerBuildChoice[];
	/** Download order. Companions extract into the same directory as the build. */
	readonly assets: readonly ServerEngineAsset[];
	/** Leading path components to strip from a tar.gz. Zips are flat. */
	readonly stripComponents: number;
	/** The executable, relative to the install directory. */
	readonly binary: string;
}

const GIB = 1024 * 1024 * 1024;

function releaseUrl(name: string): string {
	return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_SERVER_RELEASE}/${name}`;
}

function asset(
	name: string,
	sha256: string,
	bytes: number,
	extra: Pick<ServerEngineAsset, 'maxExpandedBytes'> = {}
): ServerEngineAsset {
	return Object.freeze({
		name,
		url: releaseUrl(name),
		sha256,
		bytes,
		format: name.endsWith('.zip') ? ('zip' as const) : ('tar.gz' as const),
		...extra,
	});
}

function build(
	platform: ServerPlatformKey,
	kind: ServerBuildKind,
	label: string,
	answers: readonly ServerBuildChoice[],
	assets: readonly ServerEngineAsset[],
	variant: string | null = null
): ServerEngineBuild {
	const windows = platform.startsWith('win32');
	return Object.freeze({
		platform,
		kind,
		variant,
		label,
		answers: Object.freeze([...answers]),
		assets: Object.freeze([...assets]),
		// The tar.gz archives wrap everything in one `llama-<tag>/` directory.
		stripComponents: windows ? 0 : 1,
		binary: windows ? 'llama-server.exe' : 'llama-server',
	});
}

/**
 * Every pinned build, `b11559`. Sizes are the compressed download.
 *
 * The CUDA builds do not carry the CUDA runtime libraries: llama.cpp publishes
 * those as a separate `cudart-*` archive, so a CUDA build is two assets that
 * extract into one directory. Without the companion the binary starts on a machine
 * that has the CUDA toolkit and fails with a missing-library error on one that
 * does not, which is most of them.
 */
export const SERVER_ENGINE_BUILDS: readonly ServerEngineBuild[] = Object.freeze([
	build(
		'darwin-arm64',
		'metal',
		'Metal',
		['default'],
		[
			asset(
				'llama-b11559-bin-macos-arm64.tar.gz',
				'c6cfeaa709b8d2e47e8a50f6833d22071f7ee7079b0b1a6d704e482afe6ee2c6',
				12_105_699
			),
		]
	),

	build(
		'darwin-x64',
		'cpu',
		'CPU',
		['default', 'cpu'],
		[
			asset(
				'llama-b11559-bin-macos-x64.tar.gz',
				'630d5ab669876748b4f715def6b1cbbc2a8cf836ca8310cb9e4585d5f61fe8d4',
				11_597_115
			),
		]
	),

	build(
		'win32-x64',
		'vulkan',
		'Vulkan',
		['default'],
		[
			asset(
				'llama-b11559-bin-win-vulkan-x64.zip',
				'bf2fb2a7fc5d7669ccabbb6de3f6dd6b54058f213b32e731abc62b590f8566dc',
				32_084_119
			),
		]
	),
	build(
		'win32-x64',
		'cpu',
		'CPU',
		['cpu'],
		[
			asset(
				'llama-b11559-bin-win-cpu-x64.zip',
				'1228f133868c02a424bcf663a688e66d8c7d5499077649f305188f756f584377',
				19_501_338
			),
		]
	),
	build(
		'win32-x64',
		'cuda',
		'CUDA 12.4',
		['cuda'],
		[
			asset(
				'llama-b11559-bin-win-cuda-12.4-x64.zip',
				'4a885b80b26a213e86b774a580ac14fb210eba6220579051339c71b2bda1ecd7',
				265_207_128,
				{ maxExpandedBytes: 3 * GIB }
			),
			asset(
				'cudart-llama-bin-win-cuda-12.4-x64.zip',
				'8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
				391_443_627,
				{ maxExpandedBytes: 3 * GIB }
			),
		],
		'12.4'
	),
	build(
		'win32-x64',
		'rocm',
		'ROCm 10.0',
		['rocm'],
		[
			asset(
				'llama-b11559-bin-win-rocm-10.0-x64.zip',
				'5511af01bbcaa17ebdb21dd7ab8fc8841903f25a3a08c8441ee5a43ec5afb9ab',
				257_958_782,
				{ maxExpandedBytes: 3 * GIB }
			),
		],
		'10.0'
	),

	build(
		'win32-arm64',
		'vulkan',
		'Vulkan',
		['default'],
		[
			asset(
				'llama-b11559-bin-win-vulkan-arm64.zip',
				'de3ce7203732f070de58b4199021db0fd6196495b1c874595adcd4c0def66905',
				24_684_065
			),
		]
	),
	build(
		'win32-arm64',
		'cpu',
		'CPU',
		['cpu'],
		[
			asset(
				'llama-b11559-bin-win-cpu-arm64.zip',
				'37fc76d2e63bf97adb710c43ef0b985159282a830909f67009ab983d28ada487',
				12_371_743
			),
		]
	),

	build(
		'linux-x64',
		'vulkan',
		'Vulkan',
		['default'],
		[
			asset(
				'llama-b11559-bin-ubuntu-vulkan-x64.tar.gz',
				'3c864ef7eaac254b179a52cfc648ea5b31bcea67e3523710acc6828f44e12d9e',
				30_280_639
			),
		]
	),
	build(
		'linux-x64',
		'cpu',
		'CPU',
		['cpu'],
		[
			asset(
				'llama-b11559-bin-ubuntu-x64.tar.gz',
				'a454867b975dec288f731c6d3589f132b0e356f7dbad8d711f48d231ee67d7d9',
				17_717_780
			),
		]
	),
	build(
		'linux-x64',
		'cuda',
		'CUDA 12.8',
		['cuda'],
		[
			asset(
				'llama-b11559-bin-ubuntu-cuda-12.8-x64.tar.gz',
				'47e9eedc66aedc844d8a6c5dae6850705d687798abe7f42889473ca1ce4161c5',
				171_565_144
			),
			asset(
				'cudart-llama-b11559-bin-ubuntu-cuda-12.8-x64.tar.gz',
				'c9688702bc6f5bcc8e9bea509cb805558324a07dc7c49737633ae5a5f397ffd2',
				594_377_809
			),
		],
		'12.8'
	),
	build(
		'linux-x64',
		'rocm',
		'ROCm 10.0',
		['rocm'],
		[
			asset(
				'llama-b11559-bin-ubuntu-rocm-10.0-x64.tar.gz',
				'5905fd56884d221de2be5c31173632590ecb5cfc694f3e7c5db5b68ec85741df',
				244_497_598
			),
		],
		'10.0'
	),

	build(
		'linux-arm64',
		'vulkan',
		'Vulkan',
		['default'],
		[
			asset(
				'llama-b11559-bin-ubuntu-vulkan-arm64.tar.gz',
				'537c8587c896343acc7b2110bee39a106d777e6d226d21426da4f6e8074c5ed3',
				24_057_487
			),
		]
	),
	build(
		'linux-arm64',
		'cpu',
		'CPU',
		['cpu'],
		[
			asset(
				'llama-b11559-bin-ubuntu-arm64.tar.gz',
				'9a6d241056ae96ba72dda763b09a27eec38bbf005f25a5a9904ae2985bbc1f23',
				13_834_968
			),
		]
	),
]);

const PLATFORM_KEYS: readonly ServerPlatformKey[] = Object.freeze([
	'darwin-arm64',
	'darwin-x64',
	'win32-x64',
	'win32-arm64',
	'linux-x64',
	'linux-arm64',
]);

export function isServerBuildChoice(value: unknown): value is ServerBuildChoice {
	return typeof value === 'string' && (SERVER_BUILD_CHOICES as readonly string[]).includes(value);
}

/**
 * The server platform key for a `process.platform`/`process.arch` pair, or null on
 * a combination llama.cpp publishes no build for.
 */
export function serverPlatformKey(platform: string, arch: string): ServerPlatformKey | null {
	const key = `${platform}-${arch}`;
	return (PLATFORM_KEYS as readonly string[]).includes(key) ? (key as ServerPlatformKey) : null;
}

/**
 * The build that answers a choice on a platform, or null.
 *
 * Null is a real answer and the caller must report it by name: `cuda` on a Mac, or
 * `cpu` on Apple silicon (which has a Metal build only), has no build. Swapping in
 * a different build here would hand a user a GPU build they declined or a CPU
 * build they did not ask for, and an engine that is 12x slower than it should be
 * is a failure nobody can see.
 */
export function selectServerBuild(
	platform: string,
	arch: string,
	choice: ServerBuildChoice
): ServerEngineBuild | null {
	const key = serverPlatformKey(platform, arch);
	if (!key) return null;
	return (
		SERVER_ENGINE_BUILDS.find(
			(entry) => entry.platform === key && entry.answers.includes(choice)
		) ?? null
	);
}

/**
 * The choices that resolve to a build on a platform, in a stable order, for the
 * build picker. `default` is always first when the platform has any build.
 */
export function availableServerBuildChoices(platform: string, arch: string): ServerBuildChoice[] {
	return SERVER_BUILD_CHOICES.filter(
		(choice) => selectServerBuild(platform, arch, choice) !== null
	);
}

/** Total compressed download for a build, companions included. */
export function serverBuildDownloadBytes(serverBuild: ServerEngineBuild): number {
	return serverBuild.assets.reduce((sum, entry) => sum + entry.bytes, 0);
}
