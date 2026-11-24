/**
 * What the installed model server will actually compute on: a GPU, or the CPU.
 *
 * A build's name is a promise, not a fact. The Vulkan build on a Windows machine
 * with no Vulkan driver, or on a Linux server whose only Vulkan device is the
 * llvmpipe software renderer, starts fine and runs every model on the CPU, 10x
 * slower than the user expects and with nothing on screen that says why. So after
 * an install the engine is asked (`llama-server --list-devices`) and the answer is
 * stored with the engine record, where the card reads "Metal (Apple M5 Max)",
 * "Vulkan (NVIDIA GeForce RTX 4090)" or "CPU".
 *
 * A build that cannot reach a GPU is REPORTED, and the CPU build is OFFERED when
 * the platform has one. Nothing here swaps a build: the user chose it.
 *
 * The output format is `common_print_available_devices()` in llama.cpp's
 * `common/arg.cpp` (pinned release `b11559`):
 *
 *     Available devices:
 *       MTL0: Apple M5 Max (110100 MiB, 110099 MiB free)
 *       BLAS: Accelerate (0 MiB, 0 MiB free)
 *
 * It lists every device that is not the CPU, and prints `  (none)` when there are
 * none. A backend library that fails to load is logged to stderr by
 * `ggml-backend-reg.cpp` as `load_backend: failed to load <path>: <reason>`, which
 * is how a missing Vulkan loader shows up on a build that loads backends at run time.
 *
 * Pure data and functions; the probe that runs the binary lives in
 * `src/main/local-models/server/accelerator.ts`.
 */

import { selectServerBuild, type ServerBuildKind } from './server-engine';

/** The flag that prints the device list and exits. Confirmed in `--help` of `b11559`. */
export const LIST_DEVICES_FLAG = '--list-devices';

/** The ggml backend a device belongs to, from the prefix of its name (`MTL0`, `Vulkan1`). */
export type ServerDeviceBackend = 'metal' | 'vulkan' | 'cuda' | 'rocm' | 'blas' | 'other';

export interface ServerDevice {
	/** ggml's device name: `MTL0`, `Vulkan0`, `CUDA0`, `ROCm0`, `BLAS`. */
	readonly id: string;
	readonly backend: ServerDeviceBackend;
	/** The device description: `Apple M5 Max`, `NVIDIA GeForce RTX 4090`. */
	readonly name: string;
	readonly totalMiB: number;
	readonly freeMiB: number;
	/**
	 * True when a model offloaded here runs on graphics hardware. False for BLAS
	 * (a CPU math library) and for a software Vulkan renderer such as llvmpipe,
	 * which is the CPU wearing a GPU's name.
	 */
	readonly gpu: boolean;
}

/**
 * - `gpu`: a GPU device is present and the server will offload to it.
 * - `cpu`: the server runs, on the CPU. Expected for a CPU build; a problem for a GPU build.
 * - `failed`: the binary could not list its devices. The server will not start either.
 */
export type ServerAcceleratorStatus = 'gpu' | 'cpu' | 'failed';

/**
 * - `no-gpu-device`: a GPU build that found no GPU (no driver, or only a software renderer).
 * - `vulkan-loader-missing`: the Vulkan build could not load the system's Vulkan loader.
 * - `failed-to-run`: the binary exited with an error, or could not be started at all.
 */
export type ServerAcceleratorProblem = 'no-gpu-device' | 'vulkan-loader-missing' | 'failed-to-run';

/** The outcome of one `--list-devices` run, stored with the engine record. */
export interface ServerAcceleratorReport {
	readonly checkedAt: number;
	readonly status: ServerAcceleratorStatus;
	/** What the card shows: `Metal (Apple M5 Max)`, `Vulkan (NVIDIA GeForce RTX 4090)`, `CPU`. */
	readonly label: string;
	readonly devices: readonly ServerDevice[];
	readonly problem: ServerAcceleratorProblem | null;
	/** The engine's own words when something went wrong (the last stderr lines). Never shown raw as the headline. */
	readonly detail: string | null;
	/** True when the platform has a CPU build the user could switch to. Only ever offered, never applied. */
	readonly offerCpuBuild: boolean;
}

/** What the probe saw. `exitCode` is a string when the process could not be spawned (`ENOENT`, `EACCES`). */
export interface ListDevicesRun {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | string;
}

export interface ClassifyAcceleratorInput {
	/** The kind of the INSTALLED build, from its manifest. */
	readonly kind: ServerBuildKind;
	readonly platform: string;
	readonly arch: string;
	readonly run: ListDevicesRun;
	readonly now?: number;
}

const BACKEND_LABELS: Record<ServerDeviceBackend, string> = {
	metal: 'Metal',
	vulkan: 'Vulkan',
	cuda: 'CUDA',
	rocm: 'ROCm',
	blas: 'BLAS',
	other: 'GPU',
};

const GPU_BACKENDS: ReadonlySet<ServerDeviceBackend> = new Set(['metal', 'vulkan', 'cuda', 'rocm']);

/** Vulkan implementations that run on the CPU. Mesa's llvmpipe/lavapipe, Google's SwiftShader, Windows' WARP adapter. */
const SOFTWARE_RENDERER = /\b(llvmpipe|lavapipe|swiftshader|microsoft basic render)/i;

/** `  Vulkan0: NVIDIA GeForce RTX 4090 (24564 MiB, 23400 MiB free)`. The description may itself hold parentheses. */
const DEVICE_LINE = /^\s+([^\s:]+):\s+(.*?)\s+\((\d+) MiB, (\d+) MiB free\)\s*$/;

/** A Vulkan backend library that would not load: a missing `vulkan-1.dll` or `libvulkan.so.1`. */
const VULKAN_LOAD_FAILURE =
	/(failed to load\b.*vulkan|vulkan-1\.dll|libvulkan\.so|ggml[-_]vulkan.*(not found|cannot open|could not be found))/i;

/**
 * Windows reports a missing DLL at process start as STATUS_DLL_NOT_FOUND
 * (0xC0000135). Node surfaces it as the unsigned or the signed 32-bit value.
 */
const WINDOWS_DLL_NOT_FOUND = new Set([0xc0000135, 0xc0000135 - 0x1_0000_0000]);

/** How many trailing stderr lines a report keeps as `detail`. */
const DETAIL_LINES = 6;

function backendOf(id: string): ServerDeviceBackend {
	if (/^MTL\d*$/i.test(id) || /^Metal/i.test(id)) return 'metal';
	if (/^Vulkan\d*$/i.test(id)) return 'vulkan';
	if (/^CUDA\d*$/i.test(id)) return 'cuda';
	if (/^(ROCm|HIP)\d*$/i.test(id)) return 'rocm';
	if (/^BLAS$/i.test(id)) return 'blas';
	return 'other';
}

/**
 * Parse `llama-server --list-devices` stdout into devices. Lines that are not
 * device lines (the header, `(none)`, log noise) are skipped, so an empty array
 * means "no device besides the CPU".
 */
export function parseListDevices(stdout: string): ServerDevice[] {
	const devices: ServerDevice[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = DEVICE_LINE.exec(line);
		if (!match) continue;
		const [, id, name, total, free] = match;
		const backend = backendOf(id);
		devices.push({
			id,
			backend,
			name,
			totalMiB: Number(total),
			freeMiB: Number(free),
			gpu: GPU_BACKENDS.has(backend) && !SOFTWARE_RENDERER.test(name),
		});
	}
	return devices;
}

/** `Vulkan (NVIDIA GeForce RTX 4090)`. The first GPU device names the accelerator. */
export function acceleratorLabel(device: ServerDevice): string {
	return `${BACKEND_LABELS[device.backend]} (${device.name})`;
}

function stderrDetail(stderr: string): string | null {
	const lines = stderr
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	return lines.length > 0 ? lines.slice(-DETAIL_LINES).join('\n') : null;
}

function cpuBuildOffered(platform: string, arch: string, kind: ServerBuildKind): boolean {
	if (kind === 'cpu') return false;
	return selectServerBuild(platform, arch, 'cpu')?.kind === 'cpu';
}

/**
 * Turn one `--list-devices` run into the report stored with the engine.
 *
 * The rules, in order:
 *   1. A run that did not exit 0 is `failed`. On a Vulkan build, a missing Vulkan
 *      library in stderr or Windows' "DLL not found" exit code names the loader.
 *   2. A GPU device in the list is `gpu`, labelled by the first one.
 *   3. Otherwise the server runs on the CPU. That is the answer for a CPU build,
 *      and a problem for any other build.
 */
export function classifyAcceleratorProbe(input: ClassifyAcceleratorInput): ServerAcceleratorReport {
	const { kind, platform, arch, run } = input;
	const checkedAt = input.now ?? Date.now();
	const detail = stderrDetail(run.stderr);
	const vulkanLoaderMissing = kind === 'vulkan' && VULKAN_LOAD_FAILURE.test(run.stderr);

	if (run.exitCode !== 0) {
		const dllNotFound =
			kind === 'vulkan' &&
			typeof run.exitCode === 'number' &&
			WINDOWS_DLL_NOT_FOUND.has(run.exitCode);
		return {
			checkedAt,
			status: 'failed',
			label: 'Unavailable',
			devices: [],
			problem: vulkanLoaderMissing || dllNotFound ? 'vulkan-loader-missing' : 'failed-to-run',
			detail: detail ?? `Exit code ${String(run.exitCode)}`,
			offerCpuBuild: cpuBuildOffered(platform, arch, kind),
		};
	}

	const devices = parseListDevices(run.stdout);
	const gpu = devices.find((device) => device.gpu);
	if (gpu) {
		return {
			checkedAt,
			status: 'gpu',
			label: acceleratorLabel(gpu),
			devices,
			problem: null,
			detail: null,
			offerCpuBuild: false,
		};
	}

	if (kind === 'cpu') {
		return {
			checkedAt,
			status: 'cpu',
			label: 'CPU',
			devices,
			problem: null,
			detail: null,
			offerCpuBuild: false,
		};
	}

	return {
		checkedAt,
		status: 'cpu',
		label: 'CPU',
		devices,
		problem: vulkanLoaderMissing ? 'vulkan-loader-missing' : 'no-gpu-device',
		detail,
		offerCpuBuild: cpuBuildOffered(platform, arch, kind),
	};
}

/**
 * One sentence for the card and the CLI that says what is wrong and what the user
 * can do. Null when there is nothing wrong.
 */
export function serverAcceleratorProblemMessage(report: ServerAcceleratorReport): string | null {
	if (!report.problem) return null;
	const cpuHint = report.offerCpuBuild ? ' You can install the CPU build instead.' : '';
	switch (report.problem) {
		case 'vulkan-loader-missing':
			return report.status === 'failed'
				? `The model server could not start because the Vulkan loader is missing. Install or update your graphics driver.${cpuHint}`
				: `The Vulkan loader is missing, so the model server will run on the CPU. Install or update your graphics driver.${cpuHint}`;
		case 'no-gpu-device': {
			const software = report.devices.find(
				(device) => GPU_BACKENDS.has(device.backend) && !device.gpu
			);
			return software
				? `The only graphics device found is a software renderer (${software.name}), so the model server will run on the CPU.${cpuHint}`
				: `This build found no GPU, so the model server will run on the CPU.${cpuHint}`;
		}
		case 'failed-to-run':
			return `The model server engine did not run on this computer.${cpuHint}`;
	}
}
