/**
 * Whether a model will run on this computer: Fits, Tight, or Too large.
 *
 * The Library must be honest for the 8, 16 and 32 GB machines most people have,
 * not only for the developer's 128 GB one. A model needs its weights, plus the KV
 * cache for the context the server runs it at, plus room for the system. The rule
 * depends on where the weights live:
 *
 * - **Unified memory (Apple Silicon):** macOS lets the GPU wire about 75% of RAM
 *   by default. Fits when weights + KV + 2 GB <= 75% of RAM; tight up to 90%.
 * - **Discrete GPU:** fits when weights + KV <= VRAM. A MoE model that spills can
 *   keep its experts in RAM (`--n-cpu-moe`), so it is tight when it fits in VRAM
 *   plus RAM less 4 GB for the system. A dense model that spills does not fit.
 * - **CPU only:** never better than tight: weights + KV + 4 GB <= RAM, and only
 *   for models under 10B active parameters. Anything bigger is too slow to offer.
 *
 * Every verdict carries its reason as one sentence for the Library row and the CLI.
 * Pure: the hardware is probed in `src/main/local-models/hardware.ts`.
 */

import { formatSize } from '../formatters';
import { kvBytesPer1kTokens } from './model-catalog';
import type { LocalModelEntry, LocalModelKvLayout } from './types';

const GiB = 1024 ** 3;

/** Share of RAM the GPU may wire on Apple Silicon by default (`iogpu.wired_limit_mb` unset). */
export const UNIFIED_GPU_SHARE = 0.75;
/** Past the default GPU share but still runnable, with the system squeezed. */
export const UNIFIED_TIGHT_SHARE = 0.9;
/** Room the system keeps on a unified-memory Mac. */
export const UNIFIED_SYSTEM_HEADROOM_BYTES = 2 * GiB;
/** Room the system keeps when model weights live in ordinary RAM. */
export const RAM_SYSTEM_HEADROOM_BYTES = 4 * GiB;
/** The largest active parameter count (billions) offered on a CPU-only machine. */
export const CPU_MAX_ACTIVE_PARAMETERS_B = 10;

/** One graphics device and the memory it reported. */
export interface HardwareGpu {
	readonly name: string;
	/** Dedicated video memory, or null when nothing reported it. */
	readonly vramBytes: number | null;
	/** Who reported the device: Electron's GPU info, or the model server's device list. */
	readonly source: 'electron' | 'model-server';
}

/** What the fit rule needs to know about a computer. */
export interface HardwareProfile {
	readonly platform: string;
	readonly arch: string;
	readonly totalMemoryBytes: number;
	/** True on Apple Silicon, where the GPU computes out of system RAM. */
	readonly unifiedMemory: boolean;
	readonly gpus: readonly HardwareGpu[];
}

export type ModelFitLevel = 'fits' | 'tight' | 'too-large';

export interface ModelFit {
	readonly fit: ModelFitLevel;
	/** One sentence that says why, with the numbers. */
	readonly reason: string;
}

/** What a model costs in memory at one context size. */
export interface ModelMemoryNeed {
	readonly weightsBytes: number;
	readonly kvBytes: number;
	readonly context: number;
	/** True when the KV cache came from the size table, not the model's own attention shape. */
	readonly kvEstimated: boolean;
}

/**
 * Typical attention shapes by size, for a text model that carries no GGUF
 * attention metadata (a model the user added by hand). Grouped-query attention
 * with 8 KV heads of 128 dimensions, which is what Qwen, Llama and Mistral ship
 * at these sizes; the layer counts are the common ones per size class. Errs
 * large, so an unknown model is never called a fit it is not.
 */
const KV_LAYOUT_BY_SIZE: ReadonlyArray<{
	maxTotalB: number;
	layout: LocalModelKvLayout;
}> = [
	{ maxTotalB: 3, layout: { layers: 28, kvHeads: 8, headDim: 128 } },
	{ maxTotalB: 10, layout: { layers: 36, kvHeads: 8, headDim: 128 } },
	{ maxTotalB: 20, layout: { layers: 48, kvHeads: 8, headDim: 128 } },
	{ maxTotalB: 40, layout: { layers: 64, kvHeads: 8, headDim: 128 } },
	{ maxTotalB: Infinity, layout: { layers: 80, kvHeads: 8, headDim: 128 } },
];

/** Bits per weight of a Q4_K_M GGUF, to guess a size from a file when nothing else says it. */
const Q4_K_M_BITS_PER_WEIGHT = 4.85;

/** The typical attention shape for a model of `totalB` billion parameters, from the size table. */
export function estimateKvLayout(totalB: number): LocalModelKvLayout {
	const row = KV_LAYOUT_BY_SIZE.find((entry) => totalB <= entry.maxTotalB);
	return (row ?? KV_LAYOUT_BY_SIZE[KV_LAYOUT_BY_SIZE.length - 1]).layout;
}

/** KV cache bytes per 1,024 tokens for a model of `totalB` billion parameters, from the size table. */
export function estimateKvBytesPer1kTokens(totalB: number): number {
	return kvBytesPer1kTokens(estimateKvLayout(totalB));
}

/** A model's size in billions of parameters, guessed from a Q4_K_M file of `bytes`. */
export function estimateParametersB(bytes: number): number {
	return (bytes * 8) / Q4_K_M_BITS_PER_WEIGHT / 1e9;
}

function totalParametersB(entry: LocalModelEntry): number {
	return entry.parameters?.totalB ?? estimateParametersB(entry.bytes);
}

/**
 * What a model needs in memory at `context` tokens (default: the context the
 * server runs it at). Only a text model has a KV cache.
 */
export function modelMemoryNeed(entry: LocalModelEntry, context?: number): ModelMemoryNeed {
	const weightsBytes = entry.memoryHint?.fileBytes ?? entry.bytes;
	if (entry.kind !== 'text-gen') {
		return { weightsBytes, kvBytes: 0, context: 0, kvEstimated: false };
	}
	const tokens = context ?? entry.defaultContext ?? 0;
	const per1k =
		entry.memoryHint?.kvBytesPer1kTokens ?? estimateKvBytesPer1kTokens(totalParametersB(entry));
	return {
		weightsBytes,
		kvBytes: Math.ceil((per1k * tokens) / 1024),
		context: tokens,
		kvEstimated: entry.memoryHint === undefined || entry.memoryHint.estimated === true,
	};
}

/** A GPU whose memory is known. */
type VramGpu = HardwareGpu & { readonly vramBytes: number };

/** The GPU with the most reported memory, or null when no GPU reported any. */
export function largestVramGpu(profile: HardwareProfile): VramGpu | null {
	let best: VramGpu | null = null;
	for (const gpu of profile.gpus) {
		if (gpu.vramBytes === null || gpu.vramBytes <= 0) continue;
		if (!best || gpu.vramBytes > best.vramBytes) best = { ...gpu, vramBytes: gpu.vramBytes };
	}
	return best;
}

function isMoe(entry: LocalModelEntry): boolean {
	return entry.parameters !== undefined && entry.parameters.activeB < entry.parameters.totalB;
}

function activeParametersB(entry: LocalModelEntry): number {
	return entry.parameters?.activeB ?? totalParametersB(entry);
}

function needPhrase(need: ModelMemoryNeed): string {
	// A model the user added carries no attention shape of its own, so the
	// context share is the typical one for its size. The sentence says so.
	const kv = need.kvEstimated ? `about ${formatSize(need.kvBytes)}` : formatSize(need.kvBytes);
	return need.kvBytes > 0
		? `${formatSize(need.weightsBytes + need.kvBytes)} (${formatSize(need.weightsBytes)} model, ${kv} for ${need.context.toLocaleString('en-US')} tokens of context)`
		: formatSize(need.weightsBytes);
}

function unifiedFit(need: ModelMemoryNeed, profile: HardwareProfile): ModelFit {
	const total = need.weightsBytes + need.kvBytes + UNIFIED_SYSTEM_HEADROOM_BYTES;
	const ram = profile.totalMemoryBytes;
	const gpuShare = ram * UNIFIED_GPU_SHARE;
	const needs = `Needs ${needPhrase(need)} plus ${formatSize(UNIFIED_SYSTEM_HEADROOM_BYTES)} for the system`;
	if (total <= gpuShare) {
		return {
			fit: 'fits',
			reason: `${needs}, within the ${formatSize(gpuShare)} the GPU can use on this Mac (75% of ${formatSize(ram)}).`,
		};
	}
	if (total <= ram * UNIFIED_TIGHT_SHARE) {
		return {
			fit: 'tight',
			reason: `${needs}, past the ${formatSize(gpuShare)} the GPU can use by default (75% of ${formatSize(ram)}), so it may run slowly or need the GPU memory limit raised.`,
		};
	}
	return {
		fit: 'too-large',
		reason: `${needs}, more than 90% of this Mac's ${formatSize(ram)}.`,
	};
}

function discreteGpuFit(
	entry: LocalModelEntry,
	need: ModelMemoryNeed,
	profile: HardwareProfile,
	gpu: VramGpu
): ModelFit {
	const total = need.weightsBytes + need.kvBytes;
	const vram = gpu.vramBytes;
	const needs = `Needs ${needPhrase(need)}`;
	if (total <= vram) {
		return {
			fit: 'fits',
			reason: `${needs}, within the ${formatSize(vram)} of ${gpu.name}.`,
		};
	}
	if (!isMoe(entry)) {
		return {
			fit: 'too-large',
			reason: `${needs}, more than the ${formatSize(vram)} of ${gpu.name}, and a dense model that spills out of the GPU is too slow.`,
		};
	}
	const ramShare = Math.max(0, profile.totalMemoryBytes - RAM_SYSTEM_HEADROOM_BYTES);
	if (total <= vram + ramShare) {
		return {
			fit: 'tight',
			reason: `${needs}, more than the ${formatSize(vram)} of ${gpu.name}, so its experts spill into RAM: slower, but workable.`,
		};
	}
	return {
		fit: 'too-large',
		reason: `${needs}, more than the ${formatSize(vram)} of ${gpu.name} and the ${formatSize(ramShare)} of RAM left beside it.`,
	};
}

function cpuOnlyFit(
	entry: LocalModelEntry,
	need: ModelMemoryNeed,
	profile: HardwareProfile
): ModelFit {
	const ram = profile.totalMemoryBytes;
	const total = need.weightsBytes + need.kvBytes + RAM_SYSTEM_HEADROOM_BYTES;
	const needs = `Needs ${needPhrase(need)} plus ${formatSize(RAM_SYSTEM_HEADROOM_BYTES)} for the system`;
	const active = activeParametersB(entry);
	if (active >= CPU_MAX_ACTIVE_PARAMETERS_B) {
		return {
			fit: 'too-large',
			reason: `With no GPU, a model of ${formatBillions(active)} active parameters is too slow; only models under ${CPU_MAX_ACTIVE_PARAMETERS_B}B run on the CPU.`,
		};
	}
	if (total <= ram) {
		return {
			fit: 'tight',
			reason: `${needs}, within this computer's ${formatSize(ram)}, but with no GPU it runs on the CPU and replies slowly.`,
		};
	}
	return {
		fit: 'too-large',
		reason: `${needs}, more than this computer's ${formatSize(ram)}.`,
	};
}

function formatBillions(value: number): string {
	return `${Number.isInteger(value) ? value : value.toFixed(1)}B`;
}

/**
 * Whether `entry` runs on `profile` at `context` tokens (default: the context
 * the model server runs it at).
 *
 * Only a text model is placed on a GPU. Every other kind (embedding, speech,
 * classifier, wake word) runs on the CPU inside Maestro, needs no KV cache, and
 * fits when its file and the system headroom fit in RAM.
 */
export function modelFit(
	entry: LocalModelEntry,
	profile: HardwareProfile,
	context?: number
): ModelFit {
	const need = modelMemoryNeed(entry, context);
	if (entry.kind !== 'text-gen') {
		const total = need.weightsBytes + RAM_SYSTEM_HEADROOM_BYTES;
		return total <= profile.totalMemoryBytes
			? {
					fit: 'fits',
					reason: `Needs ${formatSize(need.weightsBytes)} and runs on the CPU, within this computer's ${formatSize(profile.totalMemoryBytes)}.`,
				}
			: {
					fit: 'too-large',
					reason: `Needs ${formatSize(need.weightsBytes)} plus ${formatSize(RAM_SYSTEM_HEADROOM_BYTES)} for the system, more than this computer's ${formatSize(profile.totalMemoryBytes)}.`,
				};
	}
	if (profile.unifiedMemory) return unifiedFit(need, profile);
	const gpu = largestVramGpu(profile);
	if (gpu) return discreteGpuFit(entry, need, profile, gpu);
	return cpuOnlyFit(entry, need, profile);
}

/** What each verdict is called on a Library row and in the CLI. */
export const MODEL_FIT_LABELS: Readonly<Record<ModelFitLevel, string>> = Object.freeze({
	fits: 'Fits',
	tight: 'Tight',
	'too-large': 'Too large',
});

/**
 * One line naming what the fit rule judged against: "128 GB of unified memory
 * (Apple Silicon)", "32 GB of RAM, NVIDIA RTX 4060 (8 GB)", "16 GB of RAM, no GPU".
 */
export function describeHardwareProfile(profile: HardwareProfile): string {
	const ram = formatSize(profile.totalMemoryBytes);
	if (profile.unifiedMemory) return `${ram} of unified memory (Apple Silicon)`;
	if (profile.gpus.length === 0) return `${ram} of RAM, no GPU`;
	const gpus = profile.gpus.map((gpu) =>
		gpu.vramBytes !== null && gpu.vramBytes > 0
			? `${gpu.name} (${formatSize(gpu.vramBytes)})`
			: `${gpu.name} (memory not reported)`
	);
	return `${ram} of RAM, ${gpus.join(', ')}`;
}

/**
 * The memory a model is judged against, in two short parts for a stat card:
 * the headline (system memory) and a caption naming what kind it is. The same
 * facts as {@link describeHardwareProfile}, cut to fit a tile.
 */
export function hardwareProfileStat(profile: HardwareProfile): { value: string; caption: string } {
	const value = formatSize(profile.totalMemoryBytes);
	if (profile.unifiedMemory) return { value, caption: 'Unified memory, Apple Silicon' };
	const gpu = largestVramGpu(profile) ?? profile.gpus[0];
	if (!gpu) return { value, caption: 'RAM, no GPU' };
	return {
		value,
		caption:
			gpu.vramBytes !== null && gpu.vramBytes > 0
				? `RAM, ${gpu.name} (${formatSize(gpu.vramBytes)})`
				: `RAM, ${gpu.name}`,
	};
}

/**
 * Why the verdicts on this computer are harsher than the hardware deserves, or
 * null when they are not.
 *
 * A PC's GPU memory is read from the model server engine's device check, so
 * before that engine is installed a discrete GPU has a name and no size, and
 * every model is judged as if it ran on the CPU. A surface that shows fit
 * labels shows this beside them, so "Too large" is not read as final.
 */
export function hardwareFitCaveat(profile: HardwareProfile): string | null {
	if (profile.unifiedMemory || profile.gpus.length === 0 || largestVramGpu(profile)) return null;
	return `Maestro cannot read how much memory ${profile.gpus[0].name} has until the model server engine is installed, so each model is judged as if it ran on the CPU. Install the engine to judge against the GPU.`;
}
