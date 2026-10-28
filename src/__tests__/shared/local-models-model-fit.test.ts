/**
 * @file local-models-model-fit.test.ts
 *
 * The hardware fit rule, against the machines people actually have: an 8 GB
 * Intel MacBook, a 16 GB M-series Mac, a 32 GB Windows PC with an 8 GB RTX, a
 * 64 GB Linux box with a 24 GB GPU, a 128 GB Mac, and a 16 GB laptop with no GPU.
 */

import { describe, it, expect } from 'vitest';

import {
	BGE_SMALL_EN_ID,
	defineModel,
	getLocalModel,
	kvBytesPer1kTokens,
	QWEN3_1_7B_ID,
	type LocalModelDraft,
} from '../../shared/local-models/model-catalog';
import {
	describeHardwareProfile,
	estimateKvBytesPer1kTokens,
	hardwareProfileStat,
	estimateKvLayout,
	hardwareFitCaveat,
	largestVramGpu,
	MODEL_FIT_LABELS,
	modelFit,
	modelMemoryNeed,
	type HardwareProfile,
} from '../../shared/local-models/model-fit';
import type { LocalModelEntry } from '../../shared/local-models/types';

const GiB = 1024 ** 3;
const SHA = 'a'.repeat(64);

/**
 * A text model whose memory is easy to read: `weightsGiB` of GGUF and a KV
 * layout of 32 MiB per 1,024 tokens per `kvLayers` / 16, so a 32,768-token
 * default context costs `kvLayers / 16` GiB.
 */
function textModel(
	id: string,
	weightsGiB: number,
	parameters: { totalB: number; activeB: number },
	kvGiBAtDefault: number
): LocalModelEntry {
	const draft: LocalModelDraft = {
		id,
		displayName: id,
		kind: 'text-gen',
		runtime: 'llama',
		source: { repo: 'maestro/test', revision: '0'.repeat(40) },
		license: { spdx: 'Apache-2.0', url: 'https://example.invalid/license' },
		description: 'A test model.',
		goodAt: 'Tests.',
		roles: ['housekeeping'],
		parameters,
		contextLength: 262_144,
		defaultContext: 32_768,
		// 2 (K and V) x layers x 8 heads x 128 dims x 2 bytes x 1,024 = 4 MiB per layer per 1K;
		// at 32K tokens that is 128 MiB per layer, so 8 layers per GiB.
		kvLayout: { layers: kvGiBAtDefault * 8, kvHeads: 8, headDim: 128 },
		files: [{ path: `${id}-Q4_K_M.gguf`, sha256: SHA, bytes: weightsGiB * GiB }],
	};
	return defineModel(draft);
}

/** 4.5 GiB at its default context: 2.5 GiB weights + 2 GiB KV. */
const DENSE_4B = textModel('dense-4b', 2.5, { totalB: 4, activeB: 4 }, 2);
/** 13 GiB with headroom on a Mac: 10 + 1 + 2. */
const MOE_20B = textModel('moe-20b', 10, { totalB: 21, activeB: 3.6 }, 1);
/** 24 GiB: 18 + 6. */
const MOE_30B = textModel('moe-30b', 18, { totalB: 30.5, activeB: 3 }, 6);
/** 22 GiB: 18 + 4. */
const DENSE_31B = textModel('dense-31b', 18, { totalB: 30.7, activeB: 30.7 }, 4);
/** 65 GiB: 63 + 2. */
const MOE_120B = textModel('moe-120b', 63, { totalB: 116.8, activeB: 5.1 }, 2);
/** 160 GiB: nothing on a desktop holds it. */
const MOE_HUGE = textModel('moe-huge', 155, { totalB: 284, activeB: 13 }, 5);

const INTEL_MACBOOK_8GB: HardwareProfile = {
	platform: 'darwin',
	arch: 'x64',
	totalMemoryBytes: 8 * GiB,
	unifiedMemory: false,
	gpus: [{ name: 'Intel(R) Iris(TM) Plus Graphics', vramBytes: null, source: 'electron' }],
};

const M_SERIES_16GB: HardwareProfile = {
	platform: 'darwin',
	arch: 'arm64',
	totalMemoryBytes: 16 * GiB,
	unifiedMemory: true,
	gpus: [{ name: 'Apple M3', vramBytes: null, source: 'electron' }],
};

const WINDOWS_32GB_RTX_8GB: HardwareProfile = {
	platform: 'win32',
	arch: 'x64',
	totalMemoryBytes: 32 * GiB,
	unifiedMemory: false,
	gpus: [
		{ name: 'NVIDIA GeForce RTX 4060', vramBytes: 8 * GiB, source: 'model-server' },
		{ name: 'Intel(R) UHD Graphics 770', vramBytes: null, source: 'electron' },
	],
};

const LINUX_64GB_GPU_24GB: HardwareProfile = {
	platform: 'linux',
	arch: 'x64',
	totalMemoryBytes: 64 * GiB,
	unifiedMemory: false,
	gpus: [{ name: 'NVIDIA GeForce RTX 4090', vramBytes: 24 * GiB, source: 'model-server' }],
};

const MAC_128GB: HardwareProfile = {
	platform: 'darwin',
	arch: 'arm64',
	totalMemoryBytes: 128 * GiB,
	unifiedMemory: true,
	gpus: [{ name: 'Apple M5 Max', vramBytes: null, source: 'electron' }],
};

const CPU_ONLY_16GB: HardwareProfile = {
	platform: 'linux',
	arch: 'x64',
	totalMemoryBytes: 16 * GiB,
	unifiedMemory: false,
	gpus: [],
};

describe('modelMemoryNeed', () => {
	it('reads the weights and the KV cache at the default context', () => {
		expect(modelMemoryNeed(DENSE_4B)).toEqual({
			weightsBytes: 2.5 * GiB,
			kvBytes: 2 * GiB,
			context: 32_768,
			kvEstimated: false,
		});
	});

	it('scales the KV cache with the context asked for', () => {
		expect(modelMemoryNeed(DENSE_4B, 8_192).kvBytes).toBe(0.5 * GiB);
	});

	it('sizes the real catalog Qwen3 1.7B from its GGUF attention shape', () => {
		const qwen = getLocalModel(QWEN3_1_7B_ID)!;
		const need = modelMemoryNeed(qwen);
		// 28 layers x 8 KV heads x 128 dims, f16: 112 MiB per 1K tokens, 40,960 tokens.
		expect(need.kvBytes).toBe(112 * 1024 * 1024 * 40);
		expect(need.weightsBytes).toBe(qwen.bytes);
	});

	it('falls back to the size table for a text model with no attention shape', () => {
		const { memoryHint: _dropped, ...rest } = DENSE_31B;
		const handAdded: LocalModelEntry = rest;
		const need = modelMemoryNeed(handAdded);
		expect(need.kvEstimated).toBe(true);
		expect(need.kvBytes).toBe((estimateKvBytesPer1kTokens(30.7) * 32_768) / 1024);
	});

	it('gives a model that is not a text model no KV cache', () => {
		const embedding = getLocalModel(BGE_SMALL_EN_ID)!;
		expect(modelMemoryNeed(embedding)).toMatchObject({ kvBytes: 0, context: 0 });
	});
});

describe('estimateKvBytesPer1kTokens', () => {
	it('grows with the size class and never shrinks', () => {
		const sizes = [1, 4, 9, 14, 32, 70, 400];
		const estimates = sizes.map(estimateKvBytesPer1kTokens);
		for (let i = 1; i < estimates.length; i++) {
			expect(estimates[i]).toBeGreaterThanOrEqual(estimates[i - 1]);
		}
		expect(estimateKvBytesPer1kTokens(1.7)).toBe(
			kvBytesPer1kTokens({ layers: 28, kvHeads: 8, headDim: 128 })
		);
	});
});

describe('largestVramGpu', () => {
	it('picks the GPU with the most reported memory and skips unknown memory', () => {
		expect(largestVramGpu(WINDOWS_32GB_RTX_8GB)?.name).toBe('NVIDIA GeForce RTX 4060');
		expect(largestVramGpu(INTEL_MACBOOK_8GB)).toBeNull();
		expect(largestVramGpu(CPU_ONLY_16GB)).toBeNull();
	});
});

describe('modelFit', () => {
	describe('8 GB Intel MacBook (no unified memory, no GPU memory reported)', () => {
		it('runs a small model on the CPU at most, and only at a short context', () => {
			const atDefault = modelFit(DENSE_4B, INTEL_MACBOOK_8GB);
			expect(atDefault.fit).toBe('too-large');
			expect(atDefault.reason).toContain('8.0 GB');

			const short = modelFit(DENSE_4B, INTEL_MACBOOK_8GB, 8_192);
			expect(short.fit).toBe('tight');
			expect(short.reason).toMatch(/CPU/);
		});

		it('refuses a MoE that does not fit in RAM', () => {
			expect(modelFit(MOE_30B, INTEL_MACBOOK_8GB).fit).toBe('too-large');
		});
	});

	describe('16 GB M-series Mac (unified memory)', () => {
		it('fits a small model within 75% of RAM', () => {
			const fit = modelFit(DENSE_4B, M_SERIES_16GB);
			expect(fit.fit).toBe('fits');
			expect(fit.reason).toContain('12.0 GB');
			expect(fit.reason).toContain('75% of 16.0 GB');
		});

		it('calls a model between 75% and 90% of RAM tight', () => {
			const fit = modelFit(MOE_20B, M_SERIES_16GB);
			expect(fit.fit).toBe('tight');
			expect(fit.reason).toMatch(/GPU memory limit/);
		});

		it('refuses a model past 90% of RAM', () => {
			expect(modelFit(MOE_30B, M_SERIES_16GB).fit).toBe('too-large');
		});
	});

	describe('32 GB Windows PC with an 8 GB RTX', () => {
		it('fits a model that fits in VRAM', () => {
			const fit = modelFit(DENSE_4B, WINDOWS_32GB_RTX_8GB);
			expect(fit.fit).toBe('fits');
			expect(fit.reason).toContain('NVIDIA GeForce RTX 4060');
		});

		it('calls a MoE that spills its experts into RAM tight', () => {
			const fit = modelFit(MOE_30B, WINDOWS_32GB_RTX_8GB);
			expect(fit.fit).toBe('tight');
			expect(fit.reason).toMatch(/experts spill into RAM/);
		});

		it('refuses a dense model that does not fit in VRAM', () => {
			const fit = modelFit(DENSE_31B, WINDOWS_32GB_RTX_8GB);
			expect(fit.fit).toBe('too-large');
			expect(fit.reason).toMatch(/dense model/);
		});

		it('refuses a MoE larger than VRAM plus the RAM beside it', () => {
			expect(modelFit(MOE_120B, WINDOWS_32GB_RTX_8GB).fit).toBe('too-large');
		});
	});

	describe('64 GB Linux box with a 24 GB GPU', () => {
		it('fits models up to the GPU memory, dense or MoE', () => {
			expect(modelFit(MOE_30B, LINUX_64GB_GPU_24GB).fit).toBe('fits');
			expect(modelFit(DENSE_31B, LINUX_64GB_GPU_24GB).fit).toBe('fits');
		});

		it('calls a large MoE tight with expert offload', () => {
			expect(modelFit(MOE_120B, LINUX_64GB_GPU_24GB).fit).toBe('tight');
		});
	});

	describe('128 GB Mac', () => {
		it('fits the largest curated model', () => {
			expect(modelFit(MOE_120B, MAC_128GB).fit).toBe('fits');
		});

		it('refuses a model no desktop holds', () => {
			const fit = modelFit(MOE_HUGE, MAC_128GB);
			expect(fit.fit).toBe('too-large');
			expect(fit.reason).toContain('90%');
		});
	});

	describe('16 GB laptop with no GPU', () => {
		it('never calls a model better than tight', () => {
			const fit = modelFit(DENSE_4B, CPU_ONLY_16GB);
			expect(fit.fit).toBe('tight');
			expect(fit.reason).toMatch(/no GPU/);
		});

		it('refuses a model at or past 10B active parameters, even when RAM would hold it', () => {
			const fit = modelFit(DENSE_31B, { ...CPU_ONLY_16GB, totalMemoryBytes: 64 * GiB });
			expect(fit.fit).toBe('too-large');
			expect(fit.reason).toMatch(/under 10B/);
		});

		it('refuses a small-active MoE that does not fit in RAM', () => {
			expect(modelFit(MOE_30B, CPU_ONLY_16GB).fit).toBe('too-large');
		});
	});

	it('places a model that is not a text model in RAM, never on a GPU', () => {
		const embedding = getLocalModel(BGE_SMALL_EN_ID)!;
		expect(modelFit(embedding, CPU_ONLY_16GB).fit).toBe('fits');
		expect(modelFit(embedding, { ...CPU_ONLY_16GB, totalMemoryBytes: 2 * GiB }).fit).toBe(
			'too-large'
		);
	});

	it('says every verdict in one sentence', () => {
		const machines = [
			INTEL_MACBOOK_8GB,
			M_SERIES_16GB,
			WINDOWS_32GB_RTX_8GB,
			LINUX_64GB_GPU_24GB,
			MAC_128GB,
			CPU_ONLY_16GB,
		];
		for (const machine of machines) {
			for (const model of [DENSE_4B, MOE_20B, MOE_30B, DENSE_31B, MOE_120B, MOE_HUGE]) {
				const { reason } = modelFit(model, machine);
				expect(reason).toMatch(/^[A-Z].*\.$/);
				expect(reason.split(/\.\s+[A-Z]/)).toHaveLength(1);
				expect(reason).not.toMatch(/[–—]/);
			}
		}
	});

	it('says "about" for the context share of a model whose attention shape is the typical one for its size', () => {
		const measured = modelFit(DENSE_4B, MAC_128GB).reason;
		expect(measured).not.toContain('about');
		const estimated = defineModel({
			id: 'user-4b',
			displayName: 'user-4b',
			kind: 'text-gen',
			runtime: 'llama',
			source: { repo: 'someone/model', revision: '0'.repeat(40) },
			license: { spdx: 'Apache-2.0', url: 'https://example.invalid/license' },
			description: 'Added by hand.',
			goodAt: 'Not measured.',
			roles: [],
			parameters: { totalB: 4, activeB: 4 },
			contextLength: 262_144,
			defaultContext: 32_768,
			kvLayout: estimateKvLayout(4),
			kvEstimated: true,
			files: [{ path: 'user-4b.gguf', sha256: SHA, bytes: 2.5 * GiB }],
			userAdded: true,
		});
		expect(estimated.memoryHint?.estimated).toBe(true);
		expect(modelMemoryNeed(estimated).kvEstimated).toBe(true);
		expect(kvBytesPer1kTokens(estimateKvLayout(4))).toBe(estimateKvBytesPer1kTokens(4));
		expect(modelFit(estimated, MAC_128GB).reason).toMatch(
			/model, about [\d.]+ GB for 32,768 tokens/
		);
	});

	it('names the hardware a verdict was judged against', () => {
		expect(describeHardwareProfile(MAC_128GB)).toBe('128.0 GB of unified memory (Apple Silicon)');
		expect(describeHardwareProfile(CPU_ONLY_16GB)).toBe('16.0 GB of RAM, no GPU');
		expect(describeHardwareProfile(WINDOWS_32GB_RTX_8GB)).toBe(
			'32.0 GB of RAM, NVIDIA GeForce RTX 4060 (8.0 GB), Intel(R) UHD Graphics 770 (memory not reported)'
		);
		expect(Object.keys(MODEL_FIT_LABELS).sort()).toEqual(['fits', 'tight', 'too-large']);
	});

	it('cuts the hardware down to a value and a caption for a stat tile', () => {
		expect(hardwareProfileStat(MAC_128GB)).toEqual({
			value: '128.0 GB',
			caption: 'Unified memory, Apple Silicon',
		});
		expect(hardwareProfileStat(CPU_ONLY_16GB)).toEqual({
			value: '16.0 GB',
			caption: 'RAM, no GPU',
		});
		// The GPU named is the one with the most memory, not the first listed.
		expect(hardwareProfileStat(WINDOWS_32GB_RTX_8GB)).toEqual({
			value: '32.0 GB',
			caption: 'RAM, NVIDIA GeForce RTX 4060 (8.0 GB)',
		});
		expect(
			hardwareProfileStat({
				...WINDOWS_32GB_RTX_8GB,
				gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramBytes: null, source: 'electron' }],
			}).caption
		).toBe('RAM, NVIDIA GeForce RTX 4060');
	});

	it('warns that a GPU with no memory reading is judged as a CPU, and only then', () => {
		const unread: HardwareProfile = {
			...WINDOWS_32GB_RTX_8GB,
			gpus: [{ name: 'NVIDIA GeForce RTX 4060', vramBytes: null, source: 'electron' }],
		};
		const caveat = hardwareFitCaveat(unread);
		expect(caveat).toContain('NVIDIA GeForce RTX 4060');
		expect(caveat).toContain('model server engine');
		expect(describeHardwareProfile(unread)).toContain('memory not reported');
		// The verdict it explains: the same model fits once the memory is known.
		expect(modelFit(DENSE_4B, unread).fit).toBe('tight');
		expect(modelFit(DENSE_4B, WINDOWS_32GB_RTX_8GB).fit).toBe('fits');
		for (const known of [WINDOWS_32GB_RTX_8GB, MAC_128GB, M_SERIES_16GB, CPU_ONLY_16GB]) {
			expect(hardwareFitCaveat(known)).toBeNull();
		}
	});
});
