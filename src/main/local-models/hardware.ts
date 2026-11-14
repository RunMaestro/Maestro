/**
 * What this computer has to run a model on: RAM, whether the GPU shares it, and
 * each GPU with its memory where something reports it.
 *
 * Two sources, in order:
 *   1. Electron's `app.getGPUInfo('complete')`. It always names the devices, but
 *      it reports dedicated memory only on Windows builds that still collect the
 *      DxDiag tree, so usually it gives names without VRAM.
 *   2. The model server's own device check (`llama-server --list-devices`, stored
 *      with the engine record in Phase 04). It reports each GPU's memory, but only
 *      once an engine is installed.
 *
 * On Apple Silicon the GPU computes out of system RAM, so the fit rule reads RAM
 * and the device list is informational. Nothing here runs a binary or touches
 * the network: the device check is read from the manifest, never re-run.
 *
 * The fit rule itself is `modelFit()` in `src/shared/local-models/model-fit.ts`.
 */

import { app } from 'electron';
import * as os from 'os';

import type { ServerAcceleratorReport } from '../../shared/local-models/server-accelerator';
import type { HardwareGpu, HardwareProfile } from '../../shared/local-models/model-fit';
import { logger } from '../utils/logger';
import { readServerEngineManifest } from './server/engine-store';

const LOG_CONTEXT = 'LocalModels';
const MiB = 1024 * 1024;

/** PCI vendor ids, to name a device Electron reports without a description. */
const GPU_VENDOR_NAMES: Record<number, string> = {
	0x10de: 'NVIDIA',
	0x1002: 'AMD',
	0x8086: 'Intel',
	0x106b: 'Apple',
	0x5143: 'Qualcomm',
};

/** Everything the profile reads, injectable for tests. */
export interface HardwareProbe {
	platform?: string;
	arch?: string;
	totalMemoryBytes?: number;
	/** True for an x64 build running on Apple Silicon under Rosetta: still unified memory. */
	runningUnderArm64Translation?: boolean;
	getGpuInfo?: () => Promise<unknown>;
	readAccelerator?: () => Promise<ServerAcceleratorReport | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** `8031 MB` (DxDiag's English memory strings) to bytes. Null for anything else. */
function parseDxDiagMemory(value: unknown): number | null {
	const match = typeof value === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*MB\s*$/i.exec(value) : null;
	return match ? Math.round(Number(match[1]) * MiB) : null;
}

/** How deep the DxDiag walk goes. The display devices sit three levels down. */
const DXDIAG_MAX_DEPTH = 6;

/**
 * Display devices in Chromium's DxDiag tree (`values.szDescription` beside
 * `values.szDedicatedMemoryEnglish`), wherever in the GPU info they sit.
 */
function dxDiagDisplayMemory(node: unknown, depth = 0, found = new Map<string, number>()) {
	if (!isRecord(node) || depth > DXDIAG_MAX_DEPTH) return found;
	const values = node.values;
	if (isRecord(values)) {
		const name = nonEmptyString(values.szDescription);
		const bytes = parseDxDiagMemory(values.szDedicatedMemoryEnglish);
		if (name && bytes !== null && bytes > 0) found.set(name, bytes);
	}
	for (const child of Object.values(node)) {
		if (Array.isArray(child)) {
			for (const item of child) dxDiagDisplayMemory(item, depth + 1, found);
		} else {
			dxDiagDisplayMemory(child, depth + 1, found);
		}
	}
	return found;
}

function electronDeviceName(device: Record<string, unknown>): string | null {
	const described = nonEmptyString(device.deviceString);
	if (described) return described;
	const vendorId = typeof device.vendorId === 'number' ? device.vendorId : null;
	if (vendorId === null || vendorId === 0) return null;
	const vendor =
		GPU_VENDOR_NAMES[vendorId] ??
		nonEmptyString(device.vendorString) ??
		`Vendor 0x${vendorId.toString(16)}`;
	const deviceId = typeof device.deviceId === 'number' ? device.deviceId : 0;
	return deviceId > 0 ? `${vendor} GPU 0x${deviceId.toString(16)}` : `${vendor} GPU`;
}

/**
 * The GPUs in Electron's GPU info, with dedicated memory where the DxDiag tree
 * gives it. Tolerates any shape: an unknown field is skipped, never thrown on.
 */
export function parseElectronGpuInfo(info: unknown): HardwareGpu[] {
	if (!isRecord(info)) return [];
	const memory = dxDiagDisplayMemory(info);
	const gpus: HardwareGpu[] = [];
	const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
	for (const device of devices) {
		if (!isRecord(device)) continue;
		const name = electronDeviceName(device);
		if (!name || gpus.some((gpu) => gpu.name === name)) continue;
		gpus.push({ name, vramBytes: memory.get(name) ?? null, source: 'electron' });
	}
	for (const [name, bytes] of memory) {
		if (!gpus.some((gpu) => gpu.name === name)) {
			gpus.push({ name, vramBytes: bytes, source: 'electron' });
		}
	}
	return gpus;
}

/** The GPUs the model server found, with their memory. A software renderer is not a GPU. */
export function acceleratorGpus(report: ServerAcceleratorReport | null): HardwareGpu[] {
	if (!report) return [];
	return report.devices
		.filter((device) => device.gpu)
		.map((device) => ({
			name: device.name,
			vramBytes: device.totalMiB > 0 ? device.totalMiB * MiB : null,
			source: 'model-server' as const,
		}));
}

/**
 * What each vendor's cards are called in a driver's description, keyed by the
 * name `GPU_VENDOR_NAMES` gives the vendor.
 */
const GPU_VENDOR_PRODUCT_NAMES: ReadonlyMap<string, RegExp> = new Map([
	['NVIDIA', /nvidia|geforce|quadro|\b[rg]tx\b/i],
	['AMD', /\bamd\b|radeon|\bati\b/i],
	['Intel', /\bintel\b|\barc\b|\biris\b/i],
	['Apple', /\bapple\b/i],
	['Qualcomm', /qualcomm|adreno|snapdragon/i],
]);

/** The name `electronDeviceName()` makes for a device with no description: `NVIDIA GPU 0x2684`. */
const VENDOR_ONLY_NAME = /^(\S+) GPU(?: 0x[0-9a-f]+)?$/;

function sameDevice(serverName: string, electronName: string): boolean {
	const left = serverName.toLowerCase();
	const right = electronName.toLowerCase();
	if (left.includes(right) || right.includes(left)) return true;
	// Linux gives Electron a device's PCI ids and no description, so its name
	// there is the vendor alone and never matches the model server's description
	// of the same card by text. It is the same card when the vendor is.
	const vendor = VENDOR_ONLY_NAME.exec(electronName)?.[1];
	const products = vendor === undefined ? undefined : GPU_VENDOR_PRODUCT_NAMES.get(vendor);
	return products !== undefined && products.test(serverName);
}

async function readElectronGpuInfo(): Promise<unknown> {
	try {
		return await app.getGPUInfo('complete');
	} catch (error) {
		// Electron rejects only when the GPU is disabled outright (no hardware and
		// no software implementation). That machine has no GPU to offer: expected.
		logger.warn('GPU info unavailable; treating this computer as having no GPU', LOG_CONTEXT, {
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

async function readStoredAccelerator(): Promise<ServerAcceleratorReport | null> {
	return (await readServerEngineManifest())?.accelerator ?? null;
}

/**
 * Probe this computer for the fit rule. Never runs a binary: the model server's
 * device list is read from the engine record.
 *
 * When Electron reports no VRAM on a machine without unified memory, the model
 * server's devices fill in, and Electron's devices it did not see are kept
 * beside them (without memory), so the list still names every GPU, and names
 * each one once.
 */
export async function resolveHardwareProfile(probe: HardwareProbe = {}): Promise<HardwareProfile> {
	const platform = probe.platform ?? process.platform;
	const arch = probe.arch ?? process.arch;
	const translated = probe.runningUnderArm64Translation ?? app.runningUnderARM64Translation;
	const unifiedMemory = platform === 'darwin' && (arch === 'arm64' || translated === true);
	const electronGpus = parseElectronGpuInfo(await (probe.getGpuInfo ?? readElectronGpuInfo)());

	let gpus = electronGpus;
	if (!unifiedMemory && !electronGpus.some((gpu) => gpu.vramBytes !== null)) {
		const serverGpus = acceleratorGpus(await (probe.readAccelerator ?? readStoredAccelerator)());
		if (serverGpus.length > 0) {
			gpus = [
				...serverGpus,
				...electronGpus.filter(
					(gpu) => !serverGpus.some((server) => sameDevice(server.name, gpu.name))
				),
			];
		}
	}

	return {
		platform,
		arch,
		totalMemoryBytes: probe.totalMemoryBytes ?? os.totalmem(),
		unifiedMemory,
		gpus,
	};
}
