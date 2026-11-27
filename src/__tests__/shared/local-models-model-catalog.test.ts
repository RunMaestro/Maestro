/**
 * @file local-models-model-catalog.test.ts
 *
 * The catalog is a promise to the user about exactly which bytes will be
 * fetched. These tests guard the properties that make that promise checkable:
 * pinned revisions (never `main`), real 64-hex SHA-256s, computed totals, and a
 * frozen table nothing downstream can edit in place.
 */

import { describe, it, expect } from 'vitest';

import {
	BGE_SMALL_EN_ID,
	DEBERTA_INJECTION_V2_ID,
	DEVSTRAL_SMALL_2_24B_ID,
	EMBEDDINGGEMMA_300M_ID,
	GEMMA_4_12B_ID,
	GEMMA_4_31B_ID,
	GEMMA_4_E4B_ID,
	GPT_OSS_120B_ID,
	GPT_OSS_20B_ID,
	HEY_JARVIS_WAKE_ID,
	KOKORO_82M_ID,
	LOCAL_MODEL_CATALOG,
	LOCAL_MODEL_KIND_LABELS,
	LOCAL_MODEL_KIND_ORDER,
	OPENWAKEWORD_BASE_ID,
	PARAKEET_TDT_V2_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	QWEN3_5_4B_ID,
	QWEN3_5_9B_ID,
	QWEN3_6_35B_A3B_ID,
	QWEN3_8_27B_ID,
	QWEN3_CODER_30B_A3B_ID,
	QWEN3_CODER_NEXT_ID,
	WHISPER_BASE_EN_ID,
	WHISPER_BASE_ID,
	WHISPER_SMALL_ID,
	defineModel,
	getLocalModel,
	ggufSplitPart,
	kvBytesPer1kTokens,
	localModelGgufFile,
	localModelProjectorFile,
	type LocalModelDraft,
	isLocalModelId,
	localModelsForRuntime,
	sumModelBytes,
} from '../../shared/local-models/model-catalog';
import { MODEL_SERVER_AGENT_MIN_CONTEXT } from '../../shared/local-models/model-server';
import { NATIVE_RUNTIMES } from '../../shared/local-models/native-runtimes';
import { MODEL_SETS } from '../../shared/acappella/voice-models';

const EMBEDDING_IDS = [BGE_SMALL_EN_ID, EMBEDDINGGEMMA_300M_ID];
const CLASSIFIER_IDS = [PROMPT_GUARD_2_22M_ID, DEBERTA_INJECTION_V2_ID];
/** The curated text models above the small default, smallest first. */
const CURATED_TEXT_IDS = [
	QWEN3_5_4B_ID,
	GEMMA_4_E4B_ID,
	QWEN3_5_9B_ID,
	GEMMA_4_12B_ID,
	GPT_OSS_20B_ID,
	DEVSTRAL_SMALL_2_24B_ID,
	QWEN3_CODER_30B_A3B_ID,
	QWEN3_6_35B_A3B_ID,
	GEMMA_4_31B_ID,
	QWEN3_8_27B_ID,
	QWEN3_CODER_NEXT_ID,
	GPT_OSS_120B_ID,
];

describe('local model catalog', () => {
	it('contains every model Maestro can install', () => {
		expect(LOCAL_MODEL_CATALOG.map((entry) => entry.id).sort()).toEqual(
			[
				HEY_JARVIS_WAKE_ID,
				KOKORO_82M_ID,
				OPENWAKEWORD_BASE_ID,
				PARAKEET_TDT_V2_ID,
				QWEN3_1_7B_ID,
				WHISPER_BASE_EN_ID,
				WHISPER_BASE_ID,
				WHISPER_SMALL_ID,
				...CURATED_TEXT_IDS,
				...EMBEDDING_IDS,
				...CLASSIFIER_IDS,
			].sort()
		);
	});

	it('pins every revision to a commit, never a moving ref', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.source.revision).toMatch(/^[0-9a-f]{40}$/);
			expect(entry.source.revision).not.toBe('main');
			for (const file of entry.files) {
				// A `/main/` URL would make the hash below meaningless: the bytes
				// behind it could change without the catalog knowing.
				expect(file.sourceUrl).toBe(
					`https://huggingface.co/${entry.source.repo}/resolve/${entry.source.revision}/${file.path}`
				);
				expect(file.sourceUrl).not.toContain('/resolve/main/');
			}
		}
	});

	it('carries a real SHA-256 and a positive size for every file', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.files.length).toBeGreaterThan(0);
			for (const file of entry.files) {
				expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(file.bytes).toBeGreaterThan(0);
				// Relative, POSIX, and never escaping the install root.
				expect(file.path.startsWith('/')).toBe(false);
				expect(file.path).not.toContain('..');
				expect(file.path).not.toContain('\\');
			}
		}
	});

	it('names a license and a license URL for every model', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.license.spdx).toBeTruthy();
			expect(entry.license.url).toMatch(/^https:\/\//);
		}
	});

	it('says what every model is good at in one sentence', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.goodAt).toMatch(/^[A-Z"].*\.$/);
			expect(entry.goodAt).not.toContain('\n');
		}
	});

	it('gives every text model its roles, size, context and memory shape, and no other model any', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			const textGen = entry.kind === 'text-gen';
			for (const field of [
				entry.roles,
				entry.parameters,
				entry.contextLength,
				entry.defaultContext,
				entry.memoryHint,
			]) {
				expect(field !== undefined).toBe(textGen);
			}
			if (!textGen) continue;
			expect(entry.roles!.length).toBeGreaterThan(0);
			expect(entry.parameters!.activeB).toBeLessThanOrEqual(entry.parameters!.totalB);
			expect(entry.defaultContext!).toBeLessThanOrEqual(entry.contextLength!);
			if (entry.roles!.includes('agent')) {
				expect(entry.defaultContext!).toBeGreaterThanOrEqual(MODEL_SERVER_AGENT_MIN_CONTEXT);
			}
			expect((entry.agentHarnesses?.length ?? 0) > 0).toBe(entry.roles!.includes('agent'));
			expect(entry.memoryHint!.fileBytes).toBe(entry.bytes);
			expect(entry.memoryHint!.kvBytesPer1kTokens).toBe(
				kvBytesPer1kTokens(entry.memoryHint!.kvLayout)
			);
			expect(Object.isFrozen(entry.roles)).toBe(true);
			expect(Object.isFrozen(entry.memoryHint)).toBe(true);
		}
	});

	describe('curated text models', () => {
		const curated = CURATED_TEXT_IDS.map((id) => getLocalModel(id)!);

		it('are all text models the llama runtime opens, from a maker or a known GGUF publisher', () => {
			for (const entry of curated) {
				expect(entry.kind).toBe('text-gen');
				expect(entry.runtime).toBe('llama');
				expect(entry.source.repo).toMatch(/^(unsloth|ggml-org|google|mistralai|Qwen)\//);
				expect(localModelGgufFile(entry)?.path).toMatch(/(Q4_K_M|Q4_0|MXFP4)\.gguf$/);
			}
		});

		it('keep to open licenses', () => {
			for (const entry of curated) expect(entry.license.spdx).toBe('Apache-2.0');
		});

		it('name as agents exactly the models the harness qualification passed, with their harnesses', () => {
			// The 2026-10-12 results table in docs/architecture/local-models.md. Change
			// this only with a new qualification run, never from a model card.
			const agents = Object.fromEntries(
				LOCAL_MODEL_CATALOG.filter((entry) => entry.roles?.includes('agent')).map((entry) => [
					entry.id,
					entry.agentHarnesses,
				])
			);
			expect(agents).toEqual({
				[GEMMA_4_E4B_ID]: ['claude-code'],
				[GPT_OSS_20B_ID]: ['claude-code', 'codex'],
				[QWEN3_CODER_30B_A3B_ID]: ['claude-code'],
				[GEMMA_4_31B_ID]: ['claude-code'],
				[QWEN3_CODER_NEXT_ID]: ['claude-code', 'codex'],
				[GPT_OSS_120B_ID]: ['claude-code', 'codex'],
			});
		});

		it('hold a vision projector exactly when the model has the vision role', () => {
			for (const entry of curated) {
				expect(localModelProjectorFile(entry) !== undefined).toBe(entry.roles!.includes('vision'));
			}
			expect(curated.filter((entry) => entry.roles!.includes('vision')).map((e) => e.id)).toEqual([
				GEMMA_4_E4B_ID,
				GEMMA_4_12B_ID,
				GEMMA_4_31B_ID,
			]);
		});

		it('are listed smallest download first', () => {
			const sizes = curated.map((entry) => entry.bytes);
			// Qwen3-Coder-30B-A3B (18.6 GB) is listed before the 18.3 GB Gemma 31B on purpose:
			// they are one tier. Everything else is strictly ordered.
			for (let i = 1; i < sizes.length; i++) {
				expect(sizes[i]).toBeGreaterThan(sizes[i - 1] * 0.9);
			}
		});

		it('size the KV cache from full-attention layers only, so a hybrid model is not overstated', () => {
			// Qwen3.5 4B: 8 of 32 layers keep a whole-context cache, 4 KV heads x 256.
			const qwen = getLocalModel(QWEN3_5_4B_ID)!;
			expect(qwen.memoryHint!.kvLayout).toEqual({ layers: 8, kvHeads: 4, headDim: 256 });
			expect(qwen.memoryHint!.kvBytesPer1kTokens).toBe(2 * 8 * 4 * 256 * 2 * 1024);
			// A dense full-attention model keeps every layer.
			expect(getLocalModel(DEVSTRAL_SMALL_2_24B_ID)!.memoryHint!.kvLayout.layers).toBe(40);
		});

		it('record a mixture of experts with fewer active parameters than total', () => {
			for (const id of [
				GPT_OSS_20B_ID,
				GPT_OSS_120B_ID,
				QWEN3_CODER_30B_A3B_ID,
				QWEN3_CODER_NEXT_ID,
			]) {
				const { totalB, activeB } = getLocalModel(id)!.parameters!;
				expect(activeB).toBeLessThan(totalB / 3);
			}
			const dense = getLocalModel(DEVSTRAL_SMALL_2_24B_ID)!.parameters!;
			expect(dense.activeB).toBe(dense.totalB);
		});
	});

	it('records Qwen3 1.7B as its GGUF metadata describes it', () => {
		const qwen = getLocalModel(QWEN3_1_7B_ID)!;
		expect(qwen.roles).toEqual(['housekeeping', 'judge']);
		expect(qwen.contextLength).toBe(40_960);
		expect(qwen.defaultContext).toBe(40_960);
		// 28 layers x 8 KV heads x 128 dims x (K + V) x 2 bytes x 1,024 tokens = 112 MiB.
		expect(qwen.memoryHint!.kvBytesPer1kTokens).toBe(112 * 1024 * 1024);
	});

	it('computes each model total from its files', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.bytes).toBe(entry.files.reduce((total, file) => total + file.bytes, 0));
		}
	});

	it('is frozen all the way down', () => {
		expect(Object.isFrozen(LOCAL_MODEL_CATALOG)).toBe(true);
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(Object.isFrozen(entry)).toBe(true);
			expect(Object.isFrozen(entry.files)).toBe(true);
			for (const file of entry.files) expect(Object.isFrozen(file)).toBe(true);
		}
	});

	it('looks models up by id and rejects anything else', () => {
		expect(getLocalModel(WHISPER_BASE_EN_ID)?.kind).toBe('stt');
		expect(getLocalModel(PARAKEET_TDT_V2_ID)?.kind).toBe('stt');
		expect(getLocalModel('../../etc/passwd')).toBeUndefined();
		expect(isLocalModelId(KOKORO_82M_ID)).toBe(true);
		expect(isLocalModelId('nope')).toBe(false);
	});

	it('ignores unknown ids when summing', () => {
		expect(sumModelBytes(['nope'])).toBe(0);
		expect(sumModelBytes([WHISPER_BASE_EN_ID, 'nope'])).toBe(
			getLocalModel(WHISPER_BASE_EN_ID)!.bytes
		);
	});

	it('names a known runtime for every model, and maps each kind to the right one', () => {
		const runtimeIds = NATIVE_RUNTIMES.map((runtime) => runtime.id);
		for (const entry of LOCAL_MODEL_CATALOG) expect(runtimeIds).toContain(entry.runtime);
		// GGUF weights are read by llama.cpp; everything else in the catalog is ONNX.
		expect(getLocalModel(QWEN3_1_7B_ID)?.kind).toBe('text-gen');
		expect(getLocalModel(QWEN3_1_7B_ID)?.runtime).toBe('llama');
		expect(localModelsForRuntime('llama').map((entry) => entry.id)).toEqual([
			QWEN3_1_7B_ID,
			...CURATED_TEXT_IDS,
		]);
		expect(
			localModelsForRuntime('onnx')
				.map((entry) => entry.id)
				.sort()
		).toEqual(
			[
				HEY_JARVIS_WAKE_ID,
				KOKORO_82M_ID,
				OPENWAKEWORD_BASE_ID,
				PARAKEET_TDT_V2_ID,
				WHISPER_BASE_EN_ID,
				WHISPER_BASE_ID,
				WHISPER_SMALL_ID,
				...EMBEDDING_IDS,
				...CLASSIFIER_IDS,
			].sort()
		);
	});

	it('pins optional Small assets without adding it to any default voice model set', () => {
		const small = getLocalModel(WHISPER_SMALL_ID)!;
		expect(small.source).toEqual({
			repo: 'onnx-community/whisper-small',
			revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
		});
		expect(small.pending).toBeUndefined();
		expect(small.speechToText?.languages).toEqual(['de', 'en']);
		expect(small.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))).toEqual([
			{
				path: 'onnx/encoder_model.onnx',
				bytes: 352825870,
				sha256: 'b37cd6625dc36f9178ec7539a1876b9680ea26a910097e092be39dc766320c7b',
			},
			{
				path: 'onnx/decoder_model_merged_q4.onnx',
				bytes: 233149327,
				sha256: '795c61b344576719c2b249cc9911c78b4cc552c8c6a5407be21a3380a0791b13',
			},
			{
				path: 'tokenizer.json',
				bytes: 2480466,
				sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
			},
		]);
		expect(small.bytes).toBe(588455663);
		expect(JSON.stringify(MODEL_SETS)).not.toContain(WHISPER_SMALL_ID);
	});

	it('attributes multilingual Whisper weights to the pinned upstream MIT license', () => {
		expect(getLocalModel(WHISPER_BASE_ID)?.license).toEqual({
			spdx: 'MIT',
			url: 'https://github.com/openai/whisper/blob/86098128c0b4f24f0e2aa2994de830614b474227/LICENSE',
		});
	});

	it('offers the explicitly qualified multilingual checkpoint alongside English-only models', () => {
		expect(getLocalModel(WHISPER_BASE_ID)?.pending).toBeUndefined();
		expect(getLocalModel(WHISPER_BASE_ID)?.speechToText?.languages).toEqual(['de', 'en']);
		for (const id of [
			// Speaks since its phoneme front end shipped (`kokoro-e2e.test.ts`).
			KOKORO_82M_ID,
			// Installable since the llama runtime was proven on real hardware. What it
			// is NOT offered for is a per-task fact (`unofferedLocalModels`).
			QWEN3_1_7B_ID,
			PARAKEET_TDT_V2_ID,
			WHISPER_BASE_EN_ID,
			OPENWAKEWORD_BASE_ID,
			HEY_JARVIS_WAKE_ID,
			...EMBEDDING_IDS,
			...CLASSIFIER_IDS,
		]) {
			expect(getLocalModel(id)?.pending).toBeUndefined();
		}
	});

	it('carries a run spec exactly when the kind needs one', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			expect(entry.embedding !== undefined).toBe(entry.kind === 'embedding');
			expect(entry.classifier !== undefined).toBe(entry.kind === 'classifier');
		}
		for (const id of EMBEDDING_IDS) expect(getLocalModel(id)?.kind).toBe('embedding');
		for (const id of CLASSIFIER_IDS) expect(getLocalModel(id)?.kind).toBe('classifier');
		for (const id of [...EMBEDDING_IDS, ...CLASSIFIER_IDS]) {
			expect(getLocalModel(id)?.runtime).toBe('onnx');
		}
	});

	it('points every encoder spec at a graph and tokenizer the entry downloads', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			const spec = entry.embedding ?? entry.classifier;
			if (!spec) continue;
			const paths = entry.files.map((file) => file.path);
			expect(paths).toContain(spec.modelFile);
			expect(spec.modelFile).toMatch(/\.onnx$/);
			const tokenizerDir = spec.tokenizerDir ? `${spec.tokenizerDir}/` : '';
			expect(paths).toContain(`${tokenizerDir}tokenizer.json`);
			expect(paths).toContain(`${tokenizerDir}tokenizer_config.json`);
			expect(spec.maxTokens).toBeGreaterThan(0);
			expect(spec.outputName).toBeTruthy();
			expect(Object.isFrozen(spec)).toBe(true);
		}
	});

	it('downloads the external weights beside a graph that needs them', () => {
		// The q4 EmbeddingGemma graph keeps its weights in `.onnx_data`, opened by
		// relative path, so both must sit in the same directory.
		const gemma = getLocalModel(EMBEDDINGGEMMA_300M_ID)!;
		const paths = gemma.files.map((file) => file.path);
		expect(paths).toContain(`${gemma.embedding!.modelFile}_data`);
	});

	it('records the pooling and dimensions each embedding model needs', () => {
		const bge = getLocalModel(BGE_SMALL_EN_ID)!.embedding!;
		expect(bge).toMatchObject({
			dimensions: 384,
			pooling: 'cls',
			normalize: true,
			outputName: 'last_hidden_state',
		});
		expect(bge.queryPrefix).toBeUndefined();
		const gemma = getLocalModel(EMBEDDINGGEMMA_300M_ID)!.embedding!;
		// The graph pools and projects itself; re-pooling its token states would
		// skip the projection.
		expect(gemma).toMatchObject({
			dimensions: 768,
			pooling: 'graph',
			normalize: true,
			outputName: 'sentence_embedding',
			maxTokens: 2048,
		});
		expect(gemma.queryPrefix).toBe('task: search result | query: ');
		expect(gemma.documentPrefix).toBe('title: none | text: ');
	});

	it('names each classifier label in logit order, with a flagged label among them', () => {
		for (const id of CLASSIFIER_IDS) {
			const spec = getLocalModel(id)!.classifier!;
			expect(spec.labels).toContain(spec.positiveLabel);
			expect(spec.maxTokens).toBe(512);
			expect(spec.outputName).toBe('logits');
			expect(Object.isFrozen(spec.labels)).toBe(true);
		}
		expect(getLocalModel(PROMPT_GUARD_2_22M_ID)!.classifier!.labels).toEqual([
			'BENIGN',
			'MALICIOUS',
		]);
		expect(getLocalModel(PROMPT_GUARD_2_22M_ID)!.classifier!.positiveLabel).toBe('MALICIOUS');
		expect(getLocalModel(DEBERTA_INJECTION_V2_ID)!.classifier!.labels).toEqual([
			'SAFE',
			'INJECTION',
		]);
	});

	it('reads the ProtectAI tokenizer from the onnx directory it was exported with', () => {
		const spec = getLocalModel(DEBERTA_INJECTION_V2_ID)!.classifier!;
		expect(spec.tokenizerDir).toBe('onnx');
		expect(spec.modelFile).toBe('onnx/model.onnx');
	});

	it('keeps embedding and classifier models out of every voice bundle', () => {
		for (const set of Object.values(MODEL_SETS)) {
			for (const id of [...EMBEDDING_IDS, ...CLASSIFIER_IDS]) {
				expect(set.modelIds).not.toContain(id);
			}
		}
	});
});

describe('kind labels and grouping', () => {
	it('labels and orders every kind exactly once', () => {
		expect([...LOCAL_MODEL_KIND_ORDER].sort()).toEqual(Object.keys(LOCAL_MODEL_KIND_LABELS).sort());
		expect(new Set(LOCAL_MODEL_KIND_ORDER).size).toBe(LOCAL_MODEL_KIND_ORDER.length);
	});
});

describe('text model drafts', () => {
	const SHA = 'a'.repeat(64);

	function textDraft(over: Partial<Extract<LocalModelDraft, { kind: 'text-gen' }>> = {}) {
		return {
			id: 'test-text',
			displayName: 'Test Text',
			kind: 'text-gen' as const,
			runtime: 'llama' as const,
			source: { repo: 'maestro/test', revision: '0'.repeat(40) },
			license: { spdx: 'Apache-2.0', url: 'https://example.invalid/license' },
			description: 'A test model.',
			goodAt: 'Tests.',
			roles: ['housekeeping' as const],
			parameters: { totalB: 30, activeB: 3 },
			contextLength: 262_144,
			defaultContext: 65_536,
			kvLayout: { layers: 48, kvHeads: 4, headDim: 128 },
			files: [{ path: 'Test-Q4_K_M.gguf', sha256: SHA, bytes: 100 }],
			...over,
		};
	}

	function split(count: number, indexes: number[], prefix = 'Big-Q4_K_M') {
		return indexes.map((index) => ({
			path: `${prefix}-${String(index).padStart(5, '0')}-of-${String(count).padStart(5, '0')}.gguf`,
			sha256: SHA,
			bytes: 10,
		}));
	}

	it('reads the part of a split GGUF set from its name', () => {
		expect(ggufSplitPart('Q-Q4_K_M-00002-of-00003.gguf')).toEqual({ index: 2, count: 3 });
		expect(ggufSplitPart('Q-Q4_K_M.gguf')).toBeNull();
	});

	it('loads part 1 of a complete split set, listed in any order', () => {
		const entry = defineModel(textDraft({ files: split(3, [3, 1, 2]) }));
		expect(entry.files).toHaveLength(3);
		expect(localModelGgufFile(entry)?.path).toBe('Big-Q4_K_M-00001-of-00003.gguf');
		expect(entry.memoryHint!.fileBytes).toBe(30);
	});

	it('loads the model GGUF, never the vision projector beside it', () => {
		const entry = defineModel(
			textDraft({
				roles: ['vision'],
				files: [
					{ path: 'mmproj-F16.gguf', sha256: SHA, bytes: 5 },
					{ path: 'Test-Q4_K_M.gguf', sha256: SHA, bytes: 100 },
				],
			})
		);
		expect(localModelGgufFile(entry)?.path).toBe('Test-Q4_K_M.gguf');
		// The projector is loaded too, so it counts toward memory.
		expect(entry.memoryHint!.fileBytes).toBe(105);
	});

	it('finds the vision projector beside the weights, and none on a text-only model', () => {
		const withProjector = defineModel(
			textDraft({
				roles: ['vision'],
				files: [
					{ path: 'Test-Q4_K_M.gguf', sha256: SHA, bytes: 100 },
					{ path: 'mmproj-F16.gguf', sha256: SHA, bytes: 5 },
				],
			})
		);
		expect(localModelProjectorFile(withProjector)?.path).toBe('mmproj-F16.gguf');
		expect(localModelProjectorFile(defineModel(textDraft()))).toBeUndefined();
		expect(localModelProjectorFile(getLocalModel(PARAKEET_TDT_V2_ID)!)).toBeUndefined();
	});

	it('refuses a split set with a part missing, repeated, or from another set', () => {
		expect(() => defineModel(textDraft({ files: split(3, [1, 3]) }))).toThrow(
			/missing part 2 of 3/
		);
		expect(() => defineModel(textDraft({ files: split(2, [1, 2, 2]) }))).toThrow(/twice/);
		expect(() =>
			defineModel(textDraft({ files: [...split(2, [1, 2]), ...split(2, [1], 'Other')] }))
		).toThrow(/not one split set/);
		expect(() =>
			defineModel(
				textDraft({ files: [...split(2, [1, 2]), { path: 'Loose.gguf', sha256: SHA, bytes: 1 }] })
			)
		).toThrow(/not one split set/);
	});

	it('refuses a text model with no GGUF', () => {
		expect(() =>
			defineModel(textDraft({ files: [{ path: 'weights.bin', sha256: SHA, bytes: 1 }] }))
		).toThrow(/no GGUF/);
	});

	it('refuses a server context past the model own, or under the agent floor for an agent', () => {
		expect(() => defineModel(textDraft({ defaultContext: 300_000 }))).toThrow(/past its/);
		expect(() =>
			defineModel(
				textDraft({
					roles: ['agent'],
					agentHarnesses: ['codex'],
					defaultContext: MODEL_SERVER_AGENT_MIN_CONTEXT - 1,
				})
			)
		).toThrow(/agent harness needs/);
		expect(
			defineModel(textDraft({ roles: ['agent'], agentHarnesses: ['codex'] })).defaultContext
		).toBe(65_536);
	});

	it('grants the agent role only with the harnesses that qualified the model, in badge order', () => {
		expect(() => defineModel(textDraft({ roles: ['agent', 'housekeeping'] }))).toThrow(
			/names no harness/
		);
		expect(() => defineModel(textDraft({ agentHarnesses: ['codex'] }))).toThrow(
			/lacks the agent role/
		);
		expect(() =>
			defineModel(textDraft({ roles: ['agent'], agentHarnesses: ['codex', 'codex'] }))
		).toThrow(/twice/);

		const agent = defineModel(
			textDraft({ roles: ['agent'], agentHarnesses: ['codex', 'claude-code'] })
		);
		expect(agent.agentHarnesses).toEqual(['claude-code', 'codex']);
		expect(Object.isFrozen(agent.agentHarnesses)).toBe(true);
		expect(defineModel(textDraft()).agentHarnesses).toBeUndefined();
	});

	it('refuses more active parameters than total', () => {
		expect(() => defineModel(textDraft({ parameters: { totalB: 3, activeB: 30 } }))).toThrow(
			/active parameters/
		);
	});

	it('computes the KV cache per 1,024 tokens from the attention shape', () => {
		const entry = defineModel(textDraft());
		// 48 x 4 x 128 x 2 (K and V) x 2 bytes x 1,024 tokens.
		expect(entry.memoryHint!.kvBytesPer1kTokens).toBe(48 * 4 * 128 * 2 * 2 * 1024);
		expect(entry.memoryHint!.kvLayout).toEqual({ layers: 48, kvHeads: 4, headDim: 128 });
	});
});
