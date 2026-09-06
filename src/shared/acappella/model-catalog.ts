/**
 * A Cappella model catalog - the bill of materials for every local model.
 *
 * A Cappella is the first Maestro feature that ships a binary payload the user
 * has to fetch, so this file is the contract that makes that honest: every byte
 * downloaded is named here, with a PINNED revision, a real SHA-256, a real size,
 * and the license it arrives under. Voice Setup renders this table verbatim -
 * there is no second list of "what we download" anywhere in the app.
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
 * Sizes are formatted for display with `formatSize()` from
 * `src/shared/formatters.ts`. Do not add another size formatter.
 */

import { formatSize } from '../formatters';

/** Which seam a model plugs into. Mirrors `VoiceProviderRole` plus the wake word. */
export type VoiceModelRole = 'stt' | 'tts' | 'brain' | 'wake-word';

/**
 * The capability a model unlocks, in the words Voice Setup uses. Distinct from
 * `role` because the reason a user is asked for 1 GB of disk is not the same
 * thing as the interface slot it lands in.
 */
export type VoiceModelCapability =
	| 'local-speech-to-text'
	| 'local-text-to-speech'
	| 'local-conductor-brain'
	| 'hands-free-wake-word';

/** One downloadable file. A model is one or more of these. */
export interface VoiceModelFile {
	/**
	 * Path under the model's install directory, and the path within the source
	 * repo. Always POSIX-separated: it is joined onto the install root, so it must
	 * never be absolute and must never contain `..`.
	 */
	readonly path: string;
	/** Fully pinned download URL. `/resolve/<40-hex revision>/`, never `/main/`. */
	readonly sourceUrl: string;
	/** Lowercase hex SHA-256 of the file contents. */
	readonly sha256: string;
	readonly bytes: number;
}

export interface VoiceModelEntry {
	/** Stable id. Also the install directory name, so it must be filename-safe. */
	readonly id: string;
	readonly displayName: string;
	readonly role: VoiceModelRole;
	/** Hugging Face repo id, for the "where did this come from" line. */
	readonly repo: string;
	/** The pinned commit. 40 hex characters; `main` is rejected by the guard below. */
	readonly revision: string;
	/** SPDX-ish identifier as published on the model card. */
	readonly license: string;
	readonly licenseUrl: string;
	/** What installing this unlocks. Read by the capability gate. */
	readonly requiredFor: VoiceModelCapability;
	/** One sentence for the bill of materials. */
	readonly description: string;
	readonly files: readonly VoiceModelFile[];
	/** Sum of every file's `bytes`. Computed, never typed by hand. */
	readonly bytes: number;
	/**
	 * Why nothing in this build can run the model yet, or undefined when it runs.
	 *
	 * A pending model stays in the catalog so a download that already happened
	 * can be seen, verified, and removed, but it is offered for download nowhere:
	 * not in a bundle and not on its own row. Fetching weights nothing can read
	 * is the one download this table must never invite.
	 */
	readonly pending?: string;
}

/** Build the pinned resolve URL for a repo file. */
function hfUrl(repo: string, revision: string, path: string): string {
	return `https://huggingface.co/${repo}/resolve/${revision}/${path}`;
}

interface ModelDraft {
	id: string;
	displayName: string;
	role: VoiceModelRole;
	repo: string;
	revision: string;
	license: string;
	licenseUrl: string;
	requiredFor: VoiceModelCapability;
	description: string;
	files: Array<{ path: string; sha256: string; bytes: number }>;
	pending?: string;
}

/**
 * Freeze a draft into a catalog entry: expand each file's pinned URL and sum the
 * total. Deep-frozen so a consumer cannot mutate the catalog it renders from -
 * this table is the thing the user consented to, and a renderer that could edit
 * a hash in place would make that consent meaningless.
 */
function defineModel(draft: ModelDraft): VoiceModelEntry {
	const files = draft.files.map((file) =>
		Object.freeze({
			path: file.path,
			sourceUrl: hfUrl(draft.repo, draft.revision, file.path),
			sha256: file.sha256,
			bytes: file.bytes,
		})
	);

	return Object.freeze({
		id: draft.id,
		displayName: draft.displayName,
		role: draft.role,
		repo: draft.repo,
		revision: draft.revision,
		license: draft.license,
		licenseUrl: draft.licenseUrl,
		requiredFor: draft.requiredFor,
		description: draft.description,
		files: Object.freeze(files),
		bytes: files.reduce((total, file) => total + file.bytes, 0),
		...(draft.pending ? { pending: draft.pending } : {}),
	});
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const WHISPER_BASE_EN_ID = 'whisper-base-en';
export const KOKORO_82M_ID = 'kokoro-82m';
export const OPENWAKEWORD_BASE_ID = 'openwakeword-base';
export const QWEN3_1_7B_ID = 'qwen3-1.7b-instruct-q4km';

/**
 * Every model A Cappella can install, in the order Voice Setup lists them.
 *
 * Ordered smallest-commitment-first within a set so the panel reads as a
 * progression rather than as a wall of gigabytes.
 */
export const VOICE_MODEL_CATALOG: readonly VoiceModelEntry[] = Object.freeze([
	defineModel({
		id: WHISPER_BASE_EN_ID,
		displayName: 'Whisper Base (English)',
		role: 'stt',
		// The ONNX export, not the ggml one. Local speech-to-text runs on ONNX
		// Runtime - the same runtime text-to-speech and the wake word already need -
		// because the whisper.cpp binding publishes no prebuilt binary on any
		// platform and compiles at install time. That made it the one slot that
		// could never ship. See `providers/local/whisper/engine.ts`.
		repo: 'onnx-community/whisper-base.en',
		revision: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/onnx-community/whisper-base.en',
		requiredFor: 'local-speech-to-text',
		description:
			'English-only speech recognition that runs on the CPU. Transcribes on this machine, so no audio leaves it.',
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
		role: 'wake-word',
		repo: 'littlebearlabs/openwakeword-features',
		revision: '5e032d9ecdb798f9182ca8088284cf934f10d68e',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/littlebearlabs/openwakeword-features/blob/main/LICENSE',
		requiredFor: 'hands-free-wake-word',
		description:
			'The always-on front end that listens for the wake and stop words. Small, always local, and never optional: hands-free means something is listening, and that something must be on this machine.',
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
		id: KOKORO_82M_ID,
		displayName: 'Kokoro 82M',
		role: 'tts',
		repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
		revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
		requiredFor: 'local-text-to-speech',
		description:
			'Speech synthesis with one bundled voice. Replies are spoken from this machine rather than streamed from a service.',
		// The model takes phoneme ids and the grapheme-to-phoneme front end it
		// needs is not in this build. Until it is, the system voice speaks instead.
		pending:
			"Not usable yet: the phoneme front end this voice needs is not part of this build. Replies use your computer's own voice instead.",
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
		],
	}),
	defineModel({
		id: QWEN3_1_7B_ID,
		displayName: 'Qwen3 1.7B Instruct (Q4_K_M)',
		role: 'brain',
		repo: 'unsloth/Qwen3-1.7B-GGUF',
		revision: 'd7f544eead698dbd1f15126ef60b45a1e1933222',
		license: 'Apache-2.0',
		licenseUrl: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF',
		requiredFor: 'local-conductor-brain',
		description:
			'The Conductor Brain: decides which agent and tab an utterance is for, and reshapes replies for the ear. The largest download, and the one you can skip if you would rather route with an API model.',
		// The downloadable llama.cpp payload carries the binary and not the
		// JavaScript half of node-llama-cpp, so nothing can open this file yet.
		pending:
			'Not usable yet: the llama.cpp runtime that reads this model is not part of this build. Routing uses the built-in keyword router, or a hosted model, instead.',
		files: [
			{
				path: 'Qwen3-1.7B-Q4_K_M.gguf',
				sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
				bytes: 1107409472,
			},
		],
	}),
]);

const CATALOG_BY_ID = new Map(VOICE_MODEL_CATALOG.map((entry) => [entry.id, entry]));

/** Look a model up by id. Undefined for an id that is not in the catalog. */
export function getVoiceModel(id: string): VoiceModelEntry | undefined {
	return CATALOG_BY_ID.get(id);
}

/** True when `id` names a catalog entry. The guard every path boundary uses. */
export function isVoiceModelId(id: string): boolean {
	return CATALOG_BY_ID.has(id);
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export type VoiceModelSetId = 'hands-free-local';

export interface VoiceModelSet {
	readonly id: VoiceModelSetId;
	readonly displayName: string;
	readonly description: string;
	readonly modelIds: readonly string[];
	/** Computed sum over `modelIds`. Never a hard-coded number. */
	readonly bytes: number;
}

function defineSet(
	id: VoiceModelSetId,
	displayName: string,
	description: string,
	modelIds: readonly string[]
): VoiceModelSet {
	return Object.freeze({
		id,
		displayName,
		description,
		modelIds: Object.freeze([...modelIds]),
		bytes: modelIds.reduce((total, modelId) => total + (getVoiceModel(modelId)?.bytes ?? 0), 0),
	});
}

/**
 * The bundle Voice Setup offers.
 *
 * One set, and it is exactly the downloads the local trio needs: the recogniser
 * and the wake word. The voice is the operating system's own and the router is
 * built in, so neither costs a download. Kokoro and Qwen3 are deliberately NOT
 * in it - they are in the catalog above so an existing download can be seen and
 * removed, but neither can run in this build (see their `pending` notes), and a
 * bundle that fetched a gigabyte of weights nothing can read would be a lie on
 * the Download button.
 */
export const MODEL_SETS: Readonly<Record<VoiceModelSetId, VoiceModelSet>> = Object.freeze({
	'hands-free-local': defineSet(
		'hands-free-local',
		'Local speech',
		"Speech recognition and the wake word run on this machine. Replies use your computer's own voice and routing is built in, so nothing else is needed and nothing leaves this machine.",
		[WHISPER_BASE_EN_ID, OPENWAKEWORD_BASE_ID]
	),
});

/** The models in a set, in catalog order. */
export function getModelSetEntries(setId: VoiceModelSetId): VoiceModelEntry[] {
	const ids = new Set(MODEL_SETS[setId].modelIds);
	return VOICE_MODEL_CATALOG.filter((entry) => ids.has(entry.id));
}

/**
 * Total download size of a set, formatted. This is the string on the download
 * button, which is why it is derived here rather than written into copy.
 */
export function formatModelSetSize(setId: VoiceModelSetId): string {
	return formatSize(MODEL_SETS[setId].bytes);
}

/** Total bytes of an arbitrary selection of models. Unknown ids contribute zero. */
export function sumModelBytes(ids: readonly string[]): number {
	return ids.reduce((total, id) => total + (getVoiceModel(id)?.bytes ?? 0), 0);
}
