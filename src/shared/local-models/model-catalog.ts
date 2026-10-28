/**
 * Local Models catalog - the bill of materials for every local model.
 *
 * Local models are the one part of Maestro that ships a binary payload the user
 * has to fetch, so this file is the contract that makes that honest: every byte
 * downloaded is named here, with a PINNED revision, a real SHA-256, a real size,
 * and the license it arrives under. Every setup surface renders this table
 * verbatim - there is no second list of "what we download" anywhere in the app.
 *
 * Three rules this file exists to enforce:
 *
 *   1. **Pinned revisions, never `main`.** A moving ref means the bytes behind a
 *      hash can change under us, which turns SHA-256 verification into a
 *      superstition and makes "it worked yesterday" unreproducible.
 *   2. **Sizes are data, not copy.** Every total is COMPUTED from the file sizes
 *      below, so a button can say "Download (~311 MB)" without a hard-coded
 *      number that drifts the moment a revision is bumped.
 *   3. **Multiple files per model where the model genuinely has them.** A wake
 *      word needs its mel front end AND its embedding head; a TTS voice needs a
 *      voice pack. Recording one file per model would have shipped a catalog
 *      that verifies clean and cannot run, which is exactly the class of failure
 *      the hashes are here to prevent. Every FILE carries its own `sourceUrl` /
 *      `sha256` / `bytes`; the model carries the total.
 *
 * The hashes are the Hugging Face LFS object ids, which ARE the SHA-256 of the
 * file contents, read from `/api/models/<repo>/paths-info/<revision>` at the
 * pinned revision. Do not hand-edit one without re-reading it from the API.
 *
 * This table is consumer-neutral. A feature that needs its own words for a model
 * (a capability tag, a bundle) keys them by model id in its own module rather
 * than adding a field here.
 *
 * Sizes are formatted for display with `formatSize()` from
 * `src/shared/formatters.ts`. Do not add another size formatter.
 */

import { MODEL_SERVER_AGENT_MIN_CONTEXT } from './model-server';
import type { NativeRuntimeId } from './native-runtimes';
import { LOCAL_MODEL_AGENT_HARNESSES } from './types';
import type {
	LocalClassifierSpec,
	LocalEmbeddingSpec,
	LocalEncoderGraph,
	LocalModelAgentHarness,
	LocalModelEntry,
	LocalModelFile,
	LocalModelKind,
	LocalModelKvLayout,
	LocalModelLicense,
	LocalModelParameters,
	LocalModelRole,
	LocalModelSource,
} from './types';

/** Where every model's bytes come from. */
export const HUGGING_FACE_BASE_URL = 'https://huggingface.co';

/** Build the pinned resolve URL for a repo file. */
function hfUrl(source: LocalModelSource, path: string): string {
	return `${HUGGING_FACE_BASE_URL}/${source.repo}/resolve/${source.revision}/${path}`;
}

interface ModelDraftBase {
	id: string;
	displayName: string;
	runtime: NativeRuntimeId;
	source: LocalModelSource;
	license: LocalModelLicense;
	description: string;
	goodAt: string;
	files: Array<{ path: string; sha256: string; bytes: number }>;
	pending?: string;
	/** A model the user added from Hugging Face. See `LocalModelEntry.userAdded`. */
	userAdded?: boolean;
}

/** What only a text model declares: its roles, size, context, and attention shape. */
interface TextGenDraft {
	kind: 'text-gen';
	roles: LocalModelRole[];
	/** The harnesses the model passed the agent qualification with. Required with `agent`. */
	agentHarnesses?: LocalModelAgentHarness[];
	parameters: LocalModelParameters;
	contextLength: number;
	defaultContext: number;
	kvLayout: LocalModelKvLayout;
	/** True when `kvLayout` is a typical shape for the size, not the model's own. */
	kvEstimated?: boolean;
}

/**
 * A draft carries its run spec exactly when its kind needs one, so an embedding
 * model without pooling metadata, a classifier without labels, or a text model
 * without its context and memory shape, does not compile.
 */
export type LocalModelDraft =
	| (ModelDraftBase & { kind: 'embedding'; embedding: LocalEmbeddingSpec })
	| (ModelDraftBase & { kind: 'classifier'; classifier: LocalClassifierSpec })
	| (ModelDraftBase & TextGenDraft)
	| (ModelDraftBase & {
			kind: Exclude<LocalModelKind, 'embedding' | 'classifier' | 'text-gen'>;
	  });

/** Bytes per K or V element in llama.cpp's default (f16) KV cache. */
const KV_CACHE_ELEMENT_BYTES = 2;

/**
 * KV cache bytes for 1,024 tokens of context: a key and a value per KV head per
 * full-attention layer, at f16.
 */
export function kvBytesPer1kTokens(layout: LocalModelKvLayout): number {
	return 2 * layout.layers * layout.kvHeads * layout.headDim * KV_CACHE_ELEMENT_BYTES * 1024;
}

/** `-00001-of-00003.gguf` in a split GGUF part's name. */
const GGUF_SPLIT_PART = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** Which part of a split GGUF set a path is, or null for a single-file GGUF. */
export function ggufSplitPart(path: string): { index: number; count: number } | null {
	const match = GGUF_SPLIT_PART.exec(path);
	return match ? { index: Number(match[1]), count: Number(match[2]) } : null;
}

/**
 * Whether a GGUF file is a vision projector (`mmproj-*.gguf`) rather than the
 * model's weights. llama.cpp loads it beside the model, never as the model.
 */
function isGgufProjector(path: string): boolean {
	return (path.split('/').pop() ?? path).toLowerCase().startsWith('mmproj');
}

/** The model-weight GGUF files of a file list: every part of a split set, or the one file. */
function modelGgufFiles<T extends { path: string }>(files: readonly T[]): T[] {
	return files.filter(
		(file) => file.path.toLowerCase().endsWith('.gguf') && !isGgufProjector(file.path)
	);
}

/**
 * Check that a text model's weights are one GGUF or one COMPLETE split set. A
 * set missing a part verifies clean (every file it lists matches its hash) and
 * then fails to load, so it is refused when the catalog module loads.
 */
function assertGgufSet(draft: ModelDraftBase): void {
	const ggufs = modelGgufFiles(draft.files);
	if (ggufs.length === 0) {
		throw new Error(`Model "${draft.id}" is a text model with no GGUF file.`);
	}
	const parts = ggufs.map((file) => ggufSplitPart(file.path));
	if (ggufs.length === 1 && parts[0] === null) return;
	const count = parts[0]?.count ?? 0;
	const prefix = ggufs[0].path.replace(GGUF_SPLIT_PART, '');
	const indexes = new Set<number>();
	for (const [i, part] of parts.entries()) {
		if (!part || part.count !== count || ggufs[i].path.replace(GGUF_SPLIT_PART, '') !== prefix) {
			throw new Error(`Model "${draft.id}" mixes GGUF files that are not one split set.`);
		}
		indexes.add(part.index);
	}
	for (let index = 1; index <= count; index++) {
		if (!indexes.has(index)) {
			throw new Error(`Model "${draft.id}" is missing part ${index} of ${count} of its GGUF.`);
		}
	}
	if (indexes.size !== ggufs.length) {
		throw new Error(`Model "${draft.id}" lists a GGUF part twice.`);
	}
}

/**
 * The harnesses a text model qualified with, frozen in badge order, or
 * undefined for a model that is not an agent. The `agent` role and the harness
 * list come together: a role with no harness named was granted from a model
 * card, and a harness list without the role would never show its badge.
 */
function qualifiedHarnesses(
	draft: ModelDraftBase & TextGenDraft
): readonly LocalModelAgentHarness[] | undefined {
	const named = draft.agentHarnesses ?? [];
	const isAgent = draft.roles.includes('agent');
	if (isAgent && named.length === 0) {
		throw new Error(
			`Model "${draft.id}" has the agent role but names no harness it passed the agent qualification with.`
		);
	}
	if (!isAgent && named.length > 0) {
		throw new Error(`Model "${draft.id}" names qualified harnesses but lacks the agent role.`);
	}
	if (!isAgent) return undefined;
	if (new Set(named).size !== named.length) {
		throw new Error(`Model "${draft.id}" names a qualified harness twice.`);
	}
	return Object.freeze(LOCAL_MODEL_AGENT_HARNESSES.filter((harness) => named.includes(harness)));
}

/** Freeze a text model's spec, checking its context and weights. */
function freezeTextGenSpec(
	draft: ModelDraftBase & TextGenDraft,
	fileBytes: number
): Pick<
	LocalModelEntry,
	'roles' | 'agentHarnesses' | 'parameters' | 'contextLength' | 'defaultContext' | 'memoryHint'
> {
	assertGgufSet(draft);
	const agentHarnesses = qualifiedHarnesses(draft);
	if (draft.defaultContext > draft.contextLength) {
		throw new Error(
			`Model "${draft.id}" runs at ${draft.defaultContext} tokens, past its ${draft.contextLength}-token context.`
		);
	}
	if (draft.roles.includes('agent') && draft.defaultContext < MODEL_SERVER_AGENT_MIN_CONTEXT) {
		throw new Error(
			`Model "${draft.id}" is an agent model but runs at ${draft.defaultContext} tokens, under the ${MODEL_SERVER_AGENT_MIN_CONTEXT} an agent harness needs.`
		);
	}
	if (draft.parameters.activeB > draft.parameters.totalB) {
		throw new Error(`Model "${draft.id}" has more active parameters than total.`);
	}
	const kvLayout = Object.freeze({ ...draft.kvLayout });
	return {
		roles: Object.freeze([...draft.roles]),
		...(agentHarnesses ? { agentHarnesses } : {}),
		parameters: Object.freeze({ ...draft.parameters }),
		contextLength: draft.contextLength,
		defaultContext: draft.defaultContext,
		memoryHint: Object.freeze({
			fileBytes,
			kvBytesPer1kTokens: kvBytesPer1kTokens(kvLayout),
			kvLayout,
			...(draft.kvEstimated ? { estimated: true as const } : {}),
		}),
	};
}

/**
 * Check that an encoder spec points at files the entry actually downloads. A
 * spec naming a graph or tokenizer outside the file list would verify clean and
 * then fail to load, so it is refused when the catalog module loads.
 */
function assertEncoderGraphFiles(draft: ModelDraftBase, graph: LocalEncoderGraph): void {
	const paths = new Set(draft.files.map((file) => file.path));
	const tokenizerPath = graph.tokenizerDir
		? `${graph.tokenizerDir}/tokenizer.json`
		: 'tokenizer.json';
	for (const required of [graph.modelFile, tokenizerPath]) {
		if (!paths.has(required)) {
			throw new Error(`Model "${draft.id}" needs "${required}" but does not download it.`);
		}
	}
}

/** Freeze the kind-specific run spec, validating it against the file list. */
function freezeRunSpec(draft: LocalModelDraft): Pick<LocalModelEntry, 'embedding' | 'classifier'> {
	if (draft.kind === 'embedding') {
		assertEncoderGraphFiles(draft, draft.embedding);
		return { embedding: Object.freeze({ ...draft.embedding }) };
	}
	if (draft.kind === 'classifier') {
		assertEncoderGraphFiles(draft, draft.classifier);
		if (!draft.classifier.labels.includes(draft.classifier.positiveLabel)) {
			throw new Error(
				`Model "${draft.id}" flags "${draft.classifier.positiveLabel}", which is not one of its labels.`
			);
		}
		return {
			classifier: Object.freeze({
				...draft.classifier,
				labels: Object.freeze([...draft.classifier.labels]),
			}),
		};
	}
	return {};
}

/**
 * Freeze a draft into a catalog entry: expand each file's pinned URL and sum the
 * total. Deep-frozen so a consumer cannot mutate the catalog it renders from -
 * this table is the thing the user consented to, and a renderer that could edit
 * a hash in place would make that consent meaningless.
 *
 * Throws for a draft that would verify clean and then fail to run: an encoder
 * spec naming a file it does not download, an incomplete split GGUF, or a text
 * model whose server context is past its own or under the agent floor.
 */
export function defineModel(draft: LocalModelDraft): LocalModelEntry {
	const files = draft.files.map((file) =>
		Object.freeze({
			path: file.path,
			sourceUrl: hfUrl(draft.source, file.path),
			sha256: file.sha256,
			bytes: file.bytes,
		})
	);
	const bytes = files.reduce((total, file) => total + file.bytes, 0);

	return Object.freeze({
		id: draft.id,
		displayName: draft.displayName,
		kind: draft.kind,
		runtime: draft.runtime,
		source: Object.freeze({ ...draft.source }),
		license: Object.freeze({ ...draft.license }),
		description: draft.description,
		goodAt: draft.goodAt,
		files: Object.freeze(files),
		bytes,
		...(draft.pending ? { pending: draft.pending } : {}),
		...(draft.userAdded ? { userAdded: true as const } : {}),
		...(draft.kind === 'text-gen' ? freezeTextGenSpec(draft, bytes) : {}),
		...freezeRunSpec(draft),
	});
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const PARAKEET_TDT_V2_ID = 'parakeet-tdt-0.6b-v2';
export const WHISPER_BASE_EN_ID = 'whisper-base-en';
export const KOKORO_82M_ID = 'kokoro-82m';
export const OPENWAKEWORD_BASE_ID = 'openwakeword-base';
export const HEY_JARVIS_WAKE_ID = 'openwakeword-hey-jarvis';
export const QWEN3_1_7B_ID = 'qwen3-1.7b-instruct-q4km';
export const QWEN3_5_4B_ID = 'qwen3.5-4b-q4km';
export const GEMMA_4_E4B_ID = 'gemma-4-e4b-it-q4-0';
export const QWEN3_5_9B_ID = 'qwen3.5-9b-q4km';
export const GEMMA_4_12B_ID = 'gemma-4-12b-it-q4km';
export const GPT_OSS_20B_ID = 'gpt-oss-20b-mxfp4';
export const DEVSTRAL_SMALL_2_24B_ID = 'devstral-small-2-24b-q4km';
export const QWEN3_CODER_30B_A3B_ID = 'qwen3-coder-30b-a3b-q4km';
export const QWEN3_6_35B_A3B_ID = 'qwen3.6-35b-a3b-q4km';
export const GEMMA_4_31B_ID = 'gemma-4-31b-it-q4km';
export const QWEN3_8_27B_ID = 'qwen3.8-27b-q4km';
export const QWEN3_CODER_NEXT_ID = 'qwen3-coder-next-80b-a3b-q4km';
export const GPT_OSS_120B_ID = 'gpt-oss-120b-mxfp4';
export const BGE_SMALL_EN_ID = 'bge-small-en-v1.5';
export const EMBEDDINGGEMMA_300M_ID = 'embeddinggemma-300m';
export const PROMPT_GUARD_2_22M_ID = 'prompt-guard-2-22m';
export const DEBERTA_INJECTION_V2_ID = 'deberta-v3-base-prompt-injection-v2';

/**
 * Every model Maestro can install, in the order a setup surface lists them.
 *
 * Ordered smallest-commitment-first within a kind so a panel reads as a
 * progression rather than as a wall of gigabytes.
 */
export const LOCAL_MODEL_CATALOG: readonly LocalModelEntry[] = Object.freeze([
	defineModel({
		id: PARAKEET_TDT_V2_ID,
		displayName: 'Parakeet TDT 0.6B (English)',
		kind: 'stt',
		runtime: 'onnx',
		// NVIDIA's Parakeet TDT 0.6B v2, exported to ONNX by the onnx-asr project.
		// The local default: it gets agent names, casing, and punctuation right
		// where Whisper Base does not, and decodes a few seconds of speech in
		// about 150 ms. The int8 graphs, because the fp32 encoder is 2.4 GB for no
		// audible gain on dictated commands. See `local-models/stt/parakeet/engine.ts`.
		source: {
			repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
			revision: '0bbb45a3365852604aef28b538a8f066f4ccaa85',
		},
		license: { spdx: 'CC-BY-4.0', url: 'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2' },
		description:
			'Fast, accurate English speech recognition that runs on the CPU. Transcribes on this machine, so no audio leaves it.',
		goodAt: 'Dictated English: names, casing and punctuation, quickly, on the CPU.',
		files: [
			{
				// The NeMo log-mel front end, as a graph, so it is never re-derived by hand.
				path: 'nemo128.onnx',
				sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f',
				bytes: 139764,
			},
			{
				path: 'encoder-model.int8.onnx',
				sha256: '3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155',
				bytes: 652184014,
			},
			{
				path: 'decoder_joint-model.int8.onnx',
				sha256: 'a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3',
				bytes: 8998286,
			},
			{
				// Not an LFS object, so this is the SHA-256 of the bytes served at the
				// pinned revision rather than an LFS oid.
				path: 'vocab.txt',
				sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d',
				bytes: 9384,
			},
		],
	}),
	defineModel({
		id: WHISPER_BASE_EN_ID,
		displayName: 'Whisper Base (English)',
		kind: 'stt',
		runtime: 'onnx',
		// The ONNX export, not the ggml one. Local speech-to-text runs on ONNX
		// Runtime - the same runtime text-to-speech and the wake word already need -
		// because the whisper.cpp binding publishes no prebuilt binary on any
		// platform and compiles at install time. That made it the one slot that
		// could never ship. See `local-models/stt/whisper/engine.ts`.
		source: {
			repo: 'onnx-community/whisper-base.en',
			revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/onnx-community/whisper-base.en' },
		description:
			'English-only speech recognition that runs on the CPU. Transcribes on this machine, so no audio leaves it.',
		goodAt: 'Plain English dictation on modest hardware, as a fallback recognizer.',
		// Encoder plus the MERGED q4 decoder. The merged graph carries both the
		// with-cache and without-cache branches, so one file serves the first pass
		// and every step after it; the q4 weights cost about a third of the fp32
		// download for no measurable accuracy loss on dictated commands.
		files: [
			{
				path: 'onnx/encoder_model.onnx',
				sha256: '1cc86302d480b061452d348638064383ab41b6f3333ddd0e423532d14edaf535',
				bytes: 82468078,
			},
			{
				path: 'onnx/decoder_model_merged_q4.onnx',
				sha256: '7770ac574b71a704191ec52becac42b4a4126af26f54ed653f31c8f16af31f99',
				bytes: 123600371,
			},
			{
				path: 'tokenizer.json',
				sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0',
				bytes: 2405679,
			},
		],
	}),
	defineModel({
		id: OPENWAKEWORD_BASE_ID,
		displayName: 'openWakeWord Base',
		kind: 'wake-word',
		runtime: 'onnx',
		source: {
			repo: 'littlebearlabs/openwakeword-features',
			revision: '5e032d9ecdb798f9182ca8088284cf934f10d68e',
		},
		license: {
			spdx: 'Apache-2.0',
			url: 'https://huggingface.co/littlebearlabs/openwakeword-features/blob/main/LICENSE',
		},
		description:
			'The always-on front end that listens for the wake and stop words. Small, always local, and never optional: hands-free means something is listening, and that something must be on this machine.',
		goodAt: 'Hearing the wake and stop words with little CPU, all the time.',
		files: [
			{
				path: 'melspectrogram.onnx',
				sha256: 'ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f',
				bytes: 1087958,
			},
			{
				path: 'embedding_model.onnx',
				sha256: '70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f',
				bytes: 1326578,
			},
		],
	}),
	defineModel({
		id: HEY_JARVIS_WAKE_ID,
		displayName: 'Wake phrase: "Hey Jarvis"',
		kind: 'wake-word',
		runtime: 'onnx',
		// openWakeWord's own pretrained "hey jarvis" classifier (release v0.5.1).
		// Served from a pinned Hugging Face mirror so it rides the same pinned
		// resolve URL as every other model; the hash is the one published with the
		// official GitHub release asset, verified byte for byte against the mirror.
		source: {
			repo: 'harvestsu/openwakeword-onnx',
			revision: '93d1bd6f4f48750cb6a76206ce5bd92d846820c8',
		},
		// The openWakeWord CODE is Apache-2.0, but its pretrained models are not:
		// they are non-commercial. Stated here so the setup surface shows it before the
		// download rather than burying it in a README.
		license: { spdx: 'CC-BY-NC-SA-4.0', url: 'https://github.com/dscripka/openWakeWord#license' },
		description:
			'The detector for the default wake phrase, "hey jarvis". Runs on this machine on top of the wake word front end.',
		goodAt: 'Hearing "hey jarvis" to start a hands-free voice session.',
		files: [
			{
				path: 'hey_jarvis_v0.1.onnx',
				sha256: '94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb',
				bytes: 1271370,
			},
		],
	}),
	defineModel({
		id: KOKORO_82M_ID,
		displayName: 'Kokoro 82M',
		kind: 'tts',
		runtime: 'onnx',
		source: {
			repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
			revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
		},
		license: {
			spdx: 'Apache-2.0',
			url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
		},
		description:
			'A neural voice that speaks replies and spoken notices from this machine, in American English. One bundled voice (Heart).',
		goodAt: 'Reading replies and notices aloud in a natural American English voice.',
		// Speaks since the phoneme front end shipped (espeak-ng through the
		// `phonemizer` package, `src/main/acappella/providers/local/kokoro/`).
		files: [
			{
				path: 'onnx/model.onnx',
				sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
				bytes: 325532232,
			},
			{
				path: 'voices/af_heart.bin',
				sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
				bytes: 522240,
			},
			// The phoneme vocabulary. Small, but the model is unusable without it:
			// its ids are what the front end maps phonemes onto.
			{
				path: 'tokenizer.json',
				sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
				bytes: 3497,
			},
		],
	}),
	defineModel({
		id: QWEN3_1_7B_ID,
		displayName: 'Qwen3 1.7B Instruct (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/Qwen3-1.7B-GGUF',
			revision: 'd7f544eead698dbd1f15126ef60b45a1e1933222',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF' },
		description:
			'The smallest and fastest text model here: names tabs, writes short summaries and pull request drafts, and answers yes or no for the Cue gate. It is not offered for shell commands or voice routing, which Qwen3.5 4B does well.',
		goodAt: 'The fastest small judgments: tab names, yes or no gate answers and short summaries.',
		// Kept beside Qwen3.5 4B because nothing smaller beat it (2026-10-12,
		// docs/architecture/local-models.md, "the small models compared"): it is
		// 2.5 times faster on a tab name and a gate answer, and Qwen3.5 2B, the
		// only candidate near its size, missed a bug report this model caught.
		roles: ['housekeeping', 'judge'],
		// GGUF metadata at the pinned revision: 1.72B parameters, `qwen3.context_length`
		// 40,960, 28 layers of 8 KV heads at head dimension 128.
		parameters: { totalB: 1.7, activeB: 1.7 },
		contextLength: 40_960,
		// Claude Code and Codex completed turns against it at 40,960 (2026-10-11).
		defaultContext: 40_960,
		kvLayout: { layers: 28, kvHeads: 8, headDim: 128 },
		// Installable since the llama runtime was proven on real hardware
		// (docs/architecture/local-models.md, "Llama runtime on real hardware").
		// It is NOT offered for voice routing, shell commands or model routing: see
		// `unofferedLocalModels` on each task for the measured reason.
		files: [
			{
				path: 'Qwen3-1.7B-Q4_K_M.gguf',
				sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
				bytes: 1107409472,
			},
		],
	}),

	defineModel({
		id: QWEN3_5_4B_ID,
		displayName: 'Qwen3.5 4B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/Qwen3.5-4B-GGUF',
			revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-4B' },
		description:
			'The small model to start with. It does every housekeeping task well: tab names, shell commands, pull request drafts, summaries, yes or no answers for the Cue gate, and sending a spoken request to the agent it names.',
		goodAt:
			'Every housekeeping task: tab names, shell commands, PR drafts, gate answers and voice routing.',
		// The offered housekeeping model. Measured on 2026-10-12 against Qwen3 1.7B
		// and Qwen3.5 2B on the shipped prompts (`llama-housekeeping-e2e.test.ts`,
		// docs/architecture/local-models.md, "the small models compared"): 8 of 8 tab
		// names with both ID numbers kept, 8 of 8 correct shell commands and none
		// destructive, 8 of 8 gate answers, and 6 of 6 spoken requests routed. No
		// task records it under `unofferedLocalModels`.
		roles: ['housekeeping', 'judge'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): not an agent here. Its chat template refuses a system message after the first, which both harnesses send.
		// GGUF metadata: 32 layers, one in four (`full_attention_interval` 4) is full attention, 4 KV heads at head dimension 256. The rest are linear-attention layers with a small fixed state.
		parameters: { totalB: 4.2, activeB: 4.2 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 8, kvHeads: 4, headDim: 256 },
		files: [
			{
				path: 'Qwen3.5-4B-Q4_K_M.gguf',
				sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
				bytes: 2740937888,
			},
		],
	}),
	defineModel({
		id: GEMMA_4_E4B_ID,
		displayName: 'Gemma 4 E4B (Q4_0)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'ggml-org/gemma-4-E4B-it-GGUF',
			revision: 'b8093469224f83f5c38f691eb906c380e9e63114',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/google/gemma-4-E4B-it' },
		description:
			"Google's efficient Gemma 4 model with an image encoder. It reads screenshots and photos, answers in many languages, and replies quickly on a laptop.",
		goodAt: 'Reading screenshots and images, many languages, and fast replies on laptops.',
		roles: ['agent', 'housekeeping', 'vision'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): passed with Claude Code (2 of 3); with Codex it never fixed the bug.
		agentHarnesses: ['claude-code'],
		// GGUF metadata: 42 layers, 7 of them full attention (the rest slide a 512-token window), and the last 18 reuse earlier layers' KV, so 4 layers keep a whole-context cache: 2 KV heads at head dimension 512. The vision projector is downloaded with it.
		parameters: { totalB: 7.5, activeB: 4.5 },
		contextLength: 131_072,
		defaultContext: 40_960,
		kvLayout: { layers: 4, kvHeads: 2, headDim: 512 },
		files: [
			{
				path: 'gemma-4-E4B-it-Q4_0.gguf',
				sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2',
				bytes: 4590807392,
			},
			{
				path: 'mmproj-gemma-4-E4B-it-BF16.gguf',
				sha256: 'f77995e4b6a569ab8f0d1bfdb7e8da4a0fa5b9e6f309b9bf3bdb76164d75e29f',
				bytes: 991552256,
			},
		],
	}),
	defineModel({
		id: QWEN3_5_9B_ID,
		displayName: 'Qwen3.5 9B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/Qwen3.5-9B-GGUF',
			revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-9B' },
		description:
			'A mid-size general model with better writing than the 4B: commit and pull request drafts, shell commands and summaries.',
		goodAt: 'Commit and PR drafts, shell commands and summaries.',
		roles: ['housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): not an agent here. Its chat template refuses a system message after the first, which both harnesses send.
		// GGUF metadata: 32 layers, one in four is full attention, 4 KV heads at head dimension 256.
		parameters: { totalB: 9, activeB: 9 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 8, kvHeads: 4, headDim: 256 },
		files: [
			{
				path: 'Qwen3.5-9B-Q4_K_M.gguf',
				sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
				bytes: 5680522464,
			},
		],
	}),
	defineModel({
		id: GEMMA_4_12B_ID,
		displayName: 'Gemma 4 12B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/gemma-4-12b-it-GGUF',
			revision: 'fc034cfff751157913579611efad8462ac1be606',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/google/gemma-4-12B-it' },
		description:
			"Google's mid-size Gemma 4 model with an image encoder, strong at writing and at languages other than English.",
		goodAt: 'Writing and multilingual work, with images.',
		roles: ['housekeeping', 'vision'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): not an agent here. It fixed the bug with both harnesses, but in 11 to 15 turns.
		// GGUF metadata: 48 layers, 8 of them full attention (the rest slide a 1,024-token window), 1 KV head at head dimension 512 on those. The vision projector is downloaded with it.
		parameters: { totalB: 11.9, activeB: 11.9 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 8, kvHeads: 1, headDim: 512 },
		files: [
			{
				path: 'gemma-4-12b-it-Q4_K_M.gguf',
				sha256: '0a270ec9fe6b34f4a0d33992b6135117b484ebc4766ab76b51d4ae8c457e4c42',
				bytes: 7121861440,
			},
			{
				path: 'mmproj-F16.gguf',
				sha256: '91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e',
				bytes: 175115840,
			},
		],
	}),
	defineModel({
		id: GPT_OSS_20B_ID,
		displayName: 'gpt-oss 20B (MXFP4)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'ggml-org/gpt-oss-20b-GGUF',
			revision: 'ef9b12f2ff56c69cf32153a02784e7a3c88bf524',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/openai/gpt-oss-20b' },
		description:
			"OpenAI's open-weight reasoning model. A mixture of experts, so only 3.6B parameters run per token and it answers fast for its size.",
		goodAt:
			'Reasoning with tool calls; the smallest model here that drives both Claude Code and Codex.',
		roles: ['agent', 'housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): passed with both harnesses, every attempt.
		agentHarnesses: ['claude-code', 'codex'],
		// GGUF metadata: 24 layers alternating a 128-token window with full attention, so 12 keep a whole-context cache: 8 KV heads at head dimension 64. A mixture of experts: 32 experts, 4 used per token.
		parameters: { totalB: 20.9, activeB: 3.6 },
		contextLength: 131_072,
		defaultContext: 40_960,
		kvLayout: { layers: 12, kvHeads: 8, headDim: 64 },
		files: [
			{
				path: 'gpt-oss-20b-MXFP4.gguf',
				sha256: '27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901',
				bytes: 12109566624,
			},
		],
	}),
	defineModel({
		id: DEVSTRAL_SMALL_2_24B_ID,
		displayName: 'Devstral Small 2 24B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF',
			revision: '6e458b8add42681bfd023de5eab93637694aaf82',
		},
		license: {
			spdx: 'Apache-2.0',
			url: 'https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512',
		},
		description:
			"Mistral's coding-agent model: it edits several files at once in a large repository. A dense model, so it is slower than the mixture-of-experts coders at the same size.",
		goodAt: 'Built for coding agents: multi-file edits in large repositories.',
		roles: ['housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): not an agent here. Its chat template refuses the system message both harnesses send after the first turn, so no turn starts.
		// GGUF metadata: 40 layers, all full attention, 8 KV heads at head dimension 128. Mistral's own weights, in unsloth's GGUF.
		parameters: { totalB: 23.6, activeB: 23.6 },
		contextLength: 393_216,
		defaultContext: 40_960,
		kvLayout: { layers: 40, kvHeads: 8, headDim: 128 },
		files: [
			{
				path: 'Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf',
				sha256: 'd14ba9edee1bb4c4996a726deb81e49ae81800a3216f0774634238c380aee496',
				bytes: 14334446752,
			},
		],
	}),
	defineModel({
		id: QWEN3_CODER_30B_A3B_ID,
		displayName: 'Qwen3-Coder 30B-A3B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
			revision: 'b17cb02dd882d5b6ab62fc777ad2995f19668350',
		},
		license: {
			spdx: 'Apache-2.0',
			url: 'https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct',
		},
		description:
			'A fast coding model: a mixture of experts that runs about 3B parameters per token, tuned for tool use.',
		goodAt: 'A fast coding agent with tool use.',
		roles: ['agent', 'housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): passed with Claude Code; with Codex it fixed the bug in 12 turns (it called apply_patch through the shell).
		agentHarnesses: ['claude-code'],
		// GGUF metadata: 48 layers, all full attention, 4 KV heads at head dimension 128. A mixture of experts: 128 experts, 8 used per token.
		parameters: { totalB: 30.5, activeB: 3 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 48, kvHeads: 4, headDim: 128 },
		files: [
			{
				path: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
				sha256: 'fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad',
				bytes: 18556689568,
			},
		],
	}),
	defineModel({
		id: QWEN3_6_35B_A3B_ID,
		displayName: 'Qwen3.6 35B-A3B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'ggml-org/Qwen3.6-35B-A3B-GGUF',
			revision: 'baec3ebee244827cda0f4557eafa8b28f7545fa6',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B' },
		description:
			'A general-purpose mixture-of-experts model that runs about 3B parameters per token, with a very long context.',
		goodAt: 'General agent work: fast, with a long context.',
		roles: ['housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): not an agent here. Its chat template refuses a system message after the first, which both harnesses send.
		// GGUF metadata: 40 layers, one in four is full attention, 2 KV heads at head dimension 256. A mixture of experts: 256 experts, 8 used per token.
		parameters: { totalB: 34.7, activeB: 3 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 10, kvHeads: 2, headDim: 256 },
		files: [
			{
				path: 'Qwen3.6-35B-A3B-Q4_K_M.gguf',
				sha256: '671e47e0ec53c665d048b98c3ecbfd5236b5ca9c3e02ed19fc8f81f7b85140c7',
				bytes: 20419565568,
			},
		],
	}),
	defineModel({
		id: GEMMA_4_31B_ID,
		displayName: 'Gemma 4 31B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/gemma-4-31B-it-GGUF',
			revision: 'c1ac76e99d5513b141e8adde7288b85c3f9c32ec',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/google/gemma-4-31B-it' },
		description:
			'The largest Gemma 4: strong tool calling and image reading. A dense model, so it is slower than the mixture-of-experts models of similar size.',
		goodAt: 'The strongest Gemma: tool calling and images (dense, so slower).',
		roles: ['agent', 'housekeeping', 'vision'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): passed with Claude Code; with Codex it fixed the bug in 11 to 17 turns.
		agentHarnesses: ['claude-code'],
		// GGUF metadata: 60 layers, 10 of them full attention (the rest slide a 1,024-token window), 4 KV heads at head dimension 512 on those. The vision projector is downloaded with it.
		parameters: { totalB: 30.7, activeB: 30.7 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 10, kvHeads: 4, headDim: 512 },
		files: [
			{
				path: 'gemma-4-31B-it-Q4_K_M.gguf',
				sha256: '38bd64c852c4b460434cc7162fa9bdcf242faf86502581a754cb72956bb17f84',
				bytes: 18323733440,
			},
			{
				path: 'mmproj-F16.gguf',
				sha256: '6edcca228213c28d3567a35d22f849eea52d8360875093851959adf5d2f270eb',
				bytes: 1198957024,
			},
		],
	}),
	defineModel({
		id: QWEN3_8_27B_ID,
		displayName: 'Qwen3.8 27B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'ggml-org/Qwen3.8-27B-GGUF',
			revision: '71bc7b627595dc8a91039addd9c791ae548d6747',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.8-27B' },
		description:
			'The newest dense Qwen: strong at hard reasoning and coding, and slower than the mixture-of-experts models.',
		goodAt: 'Hard reasoning and coding (dense, so slower than the mixture-of-experts models).',
		roles: ['housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): not an agent here. Its chat template refuses a system message after the first, which both harnesses send.
		// GGUF metadata: 64 layers, one in four is full attention, 4 KV heads at head dimension 256.
		parameters: { totalB: 26.9, activeB: 26.9 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 16, kvHeads: 4, headDim: 256 },
		files: [
			{
				path: 'Qwen3.8-27B-Q4_K_M.gguf',
				sha256: 'c600de0300ae8a0eb3a6c0b8b5561b8b96f16bd2c863c2a66c42de29d391a747',
				bytes: 18973870528,
			},
		],
	}),
	defineModel({
		id: QWEN3_CODER_NEXT_ID,
		displayName: 'Qwen3-Coder-Next 80B-A3B (Q4_K_M)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'unsloth/Qwen3-Coder-Next-GGUF',
			revision: 'ce09c67b53bc8739eef83fe67b2f5d293c270632',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3-Coder-Next' },
		description:
			'The strongest local coding model here. A large mixture of experts that runs about 3B parameters per token, and needs a machine with plenty of memory to hold it.',
		goodAt:
			'The strongest local coding agent; its model card names Claude Code as a supported harness.',
		roles: ['agent', 'housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): passed with Claude Code, and with Codex 2 of 3 (one run looped for 79 turns).
		agentHarnesses: ['claude-code', 'codex'],
		// GGUF metadata: 48 layers, one in four is full attention, 2 KV heads at head dimension 256. A mixture of experts: 512 experts, 10 used per token. The model card names Claude Code as a supported harness.
		parameters: { totalB: 79.7, activeB: 3 },
		contextLength: 262_144,
		defaultContext: 40_960,
		kvLayout: { layers: 12, kvHeads: 2, headDim: 256 },
		files: [
			{
				path: 'Qwen3-Coder-Next-Q4_K_M.gguf',
				sha256: '9e6032d2f3b50a60f17ce8bf5a1d85c71af9b53b89c7978020ae7c660f29b090',
				bytes: 48528320544,
			},
		],
	}),
	defineModel({
		id: GPT_OSS_120B_ID,
		displayName: 'gpt-oss 120B (MXFP4)',
		kind: 'text-gen',
		runtime: 'llama',
		source: {
			repo: 'ggml-org/gpt-oss-120b-GGUF',
			revision: '238abdd290bb874b90a5da1b4549881b7d05c091',
		},
		license: { spdx: 'Apache-2.0', url: 'https://huggingface.co/openai/gpt-oss-120b' },
		description:
			"OpenAI's large open-weight reasoning model. It needs a workstation with a lot of memory.",
		goodAt: 'The strongest local reasoning and tool use.',
		roles: ['agent', 'housekeeping'],
		// Agent qualification (2026-10-12, docs/architecture/local-models.md): passed with both harnesses, every attempt.
		agentHarnesses: ['claude-code', 'codex'],
		// GGUF metadata: 36 layers alternating a 128-token window with full attention, so 18 keep a whole-context cache: 8 KV heads at head dimension 64. A mixture of experts: 128 experts, 4 used per token.
		parameters: { totalB: 116.8, activeB: 5.1 },
		contextLength: 131_072,
		defaultContext: 40_960,
		kvLayout: { layers: 18, kvHeads: 8, headDim: 64 },
		files: [
			{
				path: 'gpt-oss-120b-MXFP4.gguf',
				sha256: '582bd40f6886200101f4c4ed9f25f3fe80cc14c86e9e2b37746cd8904a0c622d',
				bytes: 63387346208,
			},
		],
	}),

	// Embedding and classifier models. Small JSON files (configs, tokenizers
	// under a few MB) are not LFS objects in these repos, so their hashes are the
	// SHA-256 of the bytes served at the pinned revision rather than LFS oids.

	defineModel({
		id: BGE_SMALL_EN_ID,
		displayName: 'BGE Small (English)',
		kind: 'embedding',
		runtime: 'onnx',
		// BAAI's bge-small-en-v1.5, exported to ONNX by Xenova. The default
		// embedding model: 384 dimensions, a 34 MB download, and quick on the CPU.
		// `model_quantized.onnx` is the q8 graph transformers.js loads by default.
		source: {
			repo: 'Xenova/bge-small-en-v1.5',
			revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
		},
		license: { spdx: 'MIT', url: 'https://huggingface.co/BAAI/bge-small-en-v1.5' },
		description:
			'Turns text into vectors so history, transcripts, and documents can be found by meaning. Small and fast, and runs on this machine.',
		goodAt: 'Quick search by meaning over history, transcripts and notes in English.',
		embedding: {
			modelFile: 'onnx/model_quantized.onnx',
			tokenizerDir: '',
			maxTokens: 512,
			outputName: 'last_hidden_state',
			dimensions: 384,
			pooling: 'cls',
			normalize: true,
			// BGE v1.5 retrieves well without an instruction; documents and queries
			// are embedded as written.
		},
		files: [
			{
				path: 'onnx/model_quantized.onnx',
				sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
				bytes: 34014426,
			},
			{
				path: 'tokenizer.json',
				sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
				bytes: 711396,
			},
			{
				path: 'tokenizer_config.json',
				sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
				bytes: 366,
			},
			{
				path: 'special_tokens_map.json',
				sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
				bytes: 125,
			},
			{
				path: 'config.json',
				sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
				bytes: 683,
			},
		],
	}),
	defineModel({
		id: EMBEDDINGGEMMA_300M_ID,
		displayName: 'EmbeddingGemma 300M',
		kind: 'embedding',
		runtime: 'onnx',
		// Google's EmbeddingGemma, ONNX export by onnx-community. The quality
		// option: 768 dimensions (Matryoshka-truncatable to 512, 256, or 128) and a
		// 2048-token window. The q4 graph keeps its weights in an external
		// `.onnx_data` file beside it, which ONNX Runtime opens by relative path, so
		// both must land in the same `onnx/` directory.
		//
		// The graph pools and projects itself: its `sentence_embedding` output is
		// the finished vector. Mean-pooling `last_hidden_state` instead would skip
		// the dense projection layers. It is trained with task prefixes, so a query
		// and a document are embedded differently.
		source: {
			repo: 'onnx-community/embeddinggemma-300m-ONNX',
			revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
		},
		// Distributed under the Gemma Terms of Use, which require passing the terms
		// (and the prohibited use policy) along with the model.
		license: { spdx: 'Gemma', url: 'https://ai.google.dev/gemma/terms' },
		description:
			'Higher-quality search by meaning with a longer reading window. A larger download than BGE Small, and runs on this machine.',
		goodAt: 'Higher-quality search by meaning over longer text, in many languages.',
		embedding: {
			modelFile: 'onnx/model_q4.onnx',
			tokenizerDir: '',
			maxTokens: 2048,
			outputName: 'sentence_embedding',
			dimensions: 768,
			pooling: 'graph',
			normalize: true,
			queryPrefix: 'task: search result | query: ',
			documentPrefix: 'title: none | text: ',
		},
		files: [
			{
				path: 'onnx/model_q4.onnx',
				sha256: 'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043',
				bytes: 519322,
			},
			{
				path: 'onnx/model_q4.onnx_data',
				sha256: '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02',
				bytes: 196725760,
			},
			{
				path: 'tokenizer.json',
				sha256: '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
				bytes: 20323312,
			},
			{
				path: 'tokenizer_config.json',
				sha256: '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
				bytes: 1156830,
			},
			{
				path: 'special_tokens_map.json',
				sha256: '2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397',
				bytes: 662,
			},
			{
				path: 'config.json',
				sha256: '6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b',
				bytes: 1765,
			},
		],
	}),
	defineModel({
		id: PROMPT_GUARD_2_22M_ID,
		displayName: 'Llama Prompt Guard 2 22M',
		kind: 'classifier',
		runtime: 'onnx',
		// Meta's Llama Prompt Guard 2 (22M, DeBERTa-xsmall), the default
		// prompt-injection classifier. Meta's own repo is gated, so this is
		// gravitee-io's ONNX re-upload. A third-party mirror is trustworthy here
		// ONLY because the revision and every hash below are pinned: the bytes
		// cannot change without this table changing too. `model.quant.onnx` is
		// their quantized graph (72 MB against 284 MB unquantized).
		//
		// License: the Llama 4 Community License. Redistribution or a product
		// built with it must display "Built with Llama" and carry the notice
		// "Llama 4 is licensed under the Llama 4 Community License, Copyright ©
		// Meta Platforms, Inc. All Rights Reserved." The user docs repeat this.
		source: {
			repo: 'gravitee-io/Llama-Prompt-Guard-2-22M-onnx',
			revision: 'da68d0f6023c7aeaf6b256eec549de295d5e8740',
		},
		license: { spdx: 'Llama-4-Community-License', url: 'https://www.llama.com/llama4/license/' },
		description:
			'Scores untrusted text, such as an issue comment, for prompt injection before an agent reads it. Small, and runs on this machine.',
		goodAt: 'Catching prompt injection in untrusted text before an agent reads it.',
		classifier: {
			modelFile: 'model.quant.onnx',
			tokenizerDir: '',
			maxTokens: 512,
			outputName: 'logits',
			labels: ['BENIGN', 'MALICIOUS'],
			positiveLabel: 'MALICIOUS',
		},
		files: [
			{
				path: 'model.quant.onnx',
				sha256: '38c3f03e30a4d5d229aeb7bf638e778322f8179d0ed0d4953eb22f88d8e0cf6b',
				bytes: 72542430,
			},
			{
				path: 'tokenizer.json',
				sha256: '92c8b45d0b12ae0dd9680fbfe9804503542c377d65838558cd0b48a795385dde',
				bytes: 8649291,
			},
			{
				path: 'tokenizer_config.json',
				sha256: 'b1c18af55c6bab08e20873c67d7dc5783eda002a7934f543c4db33f3f89c5099',
				bytes: 1475,
			},
			{
				path: 'special_tokens_map.json',
				sha256: 'b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21',
				bytes: 970,
			},
			{
				path: 'config.json',
				sha256: 'db1a6dabb734766632a009e17fa72ac4d110505f4be0651654dafc30002461cc',
				bytes: 1006,
			},
		],
	}),
	defineModel({
		id: DEBERTA_INJECTION_V2_ID,
		displayName: 'DeBERTa v3 Prompt Injection v2',
		kind: 'classifier',
		runtime: 'onnx',
		// ProtectAI's fine-tuned DeBERTa-v3-base, the alternative classifier: a
		// permissive license, at about ten times Prompt Guard's download. Its ONNX
		// export and the tokenizer that matches it live in the repo's `onnx/`
		// directory, so the files keep that prefix and the tokenizer is read from
		// there.
		source: {
			repo: 'protectai/deberta-v3-base-prompt-injection-v2',
			revision: '90c9989b1a342275dd0d1a95aad283c04e075671',
		},
		license: {
			spdx: 'Apache-2.0',
			url: 'https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2',
		},
		description:
			'An alternative prompt-injection classifier under a permissive license. A much larger download than Prompt Guard, and runs on this machine.',
		goodAt: 'Catching prompt injection under a permissive license, at a larger size.',
		classifier: {
			modelFile: 'onnx/model.onnx',
			tokenizerDir: 'onnx',
			maxTokens: 512,
			outputName: 'logits',
			labels: ['SAFE', 'INJECTION'],
			positiveLabel: 'INJECTION',
		},
		files: [
			{
				path: 'onnx/model.onnx',
				sha256: 'f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c',
				bytes: 738563188,
			},
			{
				path: 'onnx/tokenizer.json',
				sha256: '752fe5f0d5678ad563e1bd2ecc1ddf7a3ba7e2024d0ac1dba1a72975e26dff2f',
				bytes: 8648886,
			},
			{
				path: 'onnx/tokenizer_config.json',
				sha256: '77d3dd1a9c30397a06545251ed9274bd92e4a85feb98497eeed50c920f962274',
				bytes: 1392,
			},
			{
				path: 'onnx/special_tokens_map.json',
				sha256: 'b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21',
				bytes: 970,
			},
			{
				path: 'onnx/config.json',
				sha256: '3093743035223c46b1497a72e939e56fa0a50afbd7bafbf7eb8aad060b8d23f8',
				bytes: 1014,
			},
		],
	}),
]);

const CATALOG_BY_ID = new Map(LOCAL_MODEL_CATALOG.map((entry) => [entry.id, entry]));

// ---------------------------------------------------------------------------
// Models the user added
// ---------------------------------------------------------------------------

/**
 * Models the user added from Hugging Face, beside the curated table.
 *
 * `LOCAL_MODEL_CATALOG` is what Maestro ships and stays frozen. A user entry is
 * data on this machine, so each process holds its own copy and is told what it
 * is: the main process from its store (`src/main/local-models/user-models.ts`),
 * a renderer from the main process, the CLI from the same file. Every lookup
 * below reads both, so a user model is installed, verified, served and assigned
 * through exactly the code a curated one is.
 */
let userModels: readonly LocalModelEntry[] = Object.freeze([]);
let userModelsById = new Map<string, LocalModelEntry>();

/**
 * Replace this process's user models. An entry whose id a curated model already
 * has, or that repeats an earlier one, is dropped: a user entry can never
 * shadow the table Maestro ships.
 */
export function setUserLocalModels(entries: readonly LocalModelEntry[]): void {
	const byId = new Map<string, LocalModelEntry>();
	for (const entry of entries) {
		if (!entry.userAdded || CATALOG_BY_ID.has(entry.id) || byId.has(entry.id)) continue;
		byId.set(entry.id, entry);
	}
	userModelsById = byId;
	userModels = Object.freeze([...byId.values()]);
}

/** The models the user added, in the order they were added. */
export function userLocalModels(): readonly LocalModelEntry[] {
	return userModels;
}

/** Every model this process knows: the curated catalog, then the user's own. */
export function allLocalModels(): readonly LocalModelEntry[] {
	return userModels.length === 0 ? LOCAL_MODEL_CATALOG : [...LOCAL_MODEL_CATALOG, ...userModels];
}

/** Look a model up by id, curated or user-added. Undefined for an id that names neither. */
export function getLocalModel(id: string): LocalModelEntry | undefined {
	return CATALOG_BY_ID.get(id) ?? userModelsById.get(id);
}

/** True when `id` names a curated or user-added model. The guard every path boundary uses. */
export function isLocalModelId(id: string): boolean {
	return CATALOG_BY_ID.has(id) || userModelsById.has(id);
}

/** True when `id` names a model Maestro ships, which a user entry may never take. */
export function isCuratedLocalModelId(id: string): boolean {
	return CATALOG_BY_ID.has(id);
}

/** Every model a runtime reads, curated then user-added. */
export function localModelsForRuntime(runtimeId: NativeRuntimeId): LocalModelEntry[] {
	return allLocalModels().filter((entry) => entry.runtime === runtimeId);
}

/**
 * The GGUF file llama.cpp opens for a text-generation model, or undefined for
 * an entry that is not one. For a split set this is part 1: llama.cpp finds the
 * other parts beside it by name. The in-process engine and the model server
 * both load this file, so they cannot disagree on which of a model's files it is.
 */
export function localModelGgufFile(entry: LocalModelEntry): LocalModelFile | undefined {
	if (entry.kind !== 'text-gen' || entry.runtime !== 'llama') return undefined;
	const ggufs = modelGgufFiles(entry.files);
	return ggufs.find((file) => ggufSplitPart(file.path)?.index === 1) ?? ggufs[0];
}

/**
 * The vision projector (`mmproj-*.gguf`) a text model loads beside its weights,
 * or undefined for a model that reads no images. llama-server is handed it
 * with `mmproj`; without it a `vision` model would answer an image with text only.
 */
export function localModelProjectorFile(entry: LocalModelEntry): LocalModelFile | undefined {
	if (entry.kind !== 'text-gen' || entry.runtime !== 'llama') return undefined;
	return entry.files.find(
		(file) => file.path.toLowerCase().endsWith('.gguf') && isGgufProjector(file.path)
	);
}

/** Total bytes of an arbitrary selection of models. Unknown ids contribute zero. */
export function sumModelBytes(ids: readonly string[]): number {
	return ids.reduce((total, id) => total + (getLocalModel(id)?.bytes ?? 0), 0);
}

/**
 * What each kind is called in front of a person. One table so the Settings tab,
 * the CLI, and the docs cannot name a kind three different ways.
 */
export const LOCAL_MODEL_KIND_LABELS: Readonly<Record<LocalModelKind, string>> = Object.freeze({
	'text-gen': 'Text generation',
	embedding: 'Embeddings',
	classifier: 'Classifiers',
	stt: 'Speech-to-text',
	tts: 'Text-to-speech',
	'wake-word': 'Wake word',
});

/**
 * The order kinds are listed in. General-purpose kinds first, voice kinds last,
 * so a user who never turns voice on reads the models they can use before the
 * ones they cannot.
 */
export const LOCAL_MODEL_KIND_ORDER: readonly LocalModelKind[] = Object.freeze([
	'text-gen',
	'embedding',
	'classifier',
	'stt',
	'tts',
	'wake-word',
]);
