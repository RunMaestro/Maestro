/**
 * Core Local Models types.
 *
 * Local Models is the one place Maestro downloads, verifies, stores, and runs a
 * model on this machine. Every feature that wants a local model (voice, tab
 * naming, AI command mode, semantic search, and whatever comes next) is a
 * CONSUMER of this vocabulary, never a second owner of it. A consumer that needs
 * its own words for a model (the voice slot a recogniser fills, the bundle a
 * setup screen offers) layers them on top, keyed by model id, in its own module.
 *
 * Nothing here knows which feature asked for a model. That is the rule that
 * keeps this table from growing one field per consumer.
 */

import type { NativeRuntimeId } from './native-runtimes';

/**
 * What a model does, in consumer-neutral terms.
 *
 * Deliberately not a list of features: a `text-gen` model can route a spoken
 * command, name a tab, or draft a shell command, and the catalog must not have to
 * change when a fourth consumer starts using it.
 */
export type LocalModelKind = 'wake-word' | 'stt' | 'tts' | 'text-gen' | 'embedding' | 'classifier';

/** One downloadable file. A model is one or more of these. */
export interface LocalModelFile {
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

/**
 * Where an encoder model's graph and tokenizer live inside its install
 * directory. Shared by every kind that runs a tokenizer in front of an ONNX
 * graph, because a model's files are not always at the root (an `onnx/`
 * subdirectory is common) and a service must never guess which `.onnx` in the
 * file list is the graph rather than its external weights.
 */
export interface LocalEncoderGraph {
	/** The ONNX graph to load. Always one of the entry's `files[].path`. */
	readonly modelFile: string;
	/**
	 * Directory holding `tokenizer.json` (and `tokenizer_config.json`), relative
	 * to the install directory. Empty string for the root.
	 */
	readonly tokenizerDir: string;
	/** The model's token window. Longer input is truncated or windowed by the caller. */
	readonly maxTokens: number;
	/** The graph output the service reads. */
	readonly outputName: string;
}

/**
 * How an embedding model's per-token states become one vector.
 *
 * - `cls`: the first token's hidden state (BERT-style retrieval models).
 * - `mean`: the attention-masked average of every token's hidden state.
 * - `graph`: the graph already pools (and projects) and `outputName` is the
 *   finished sentence embedding. Re-pooling its token states instead would skip
 *   the projection layers and produce vectors in the wrong space.
 */
export type LocalEmbeddingPooling = 'cls' | 'mean' | 'graph';

export interface LocalEmbeddingSpec extends LocalEncoderGraph {
	/** Width of the vector the service returns. */
	readonly dimensions: number;
	readonly pooling: LocalEmbeddingPooling;
	/** L2-normalize so cosine similarity is a dot product. */
	readonly normalize: true;
	/** Prepended to a search query before tokenizing, for models trained with one. */
	readonly queryPrefix?: string;
	/** Prepended to an indexed document before tokenizing, for models trained with one. */
	readonly documentPrefix?: string;
}

/**
 * What a text model is fit to do, in the words a Library groups by.
 *
 * - `judge`: short yes or no decisions (the Cue gate, a local System One judge).
 * - `housekeeping`: tab names, short summaries, shell commands, PR drafts.
 * - `agent`: drives an agent harness (Claude Code, Codex). Granted only by a
 *   real-harness qualification run, never from a model card.
 * - `vision`: reads images and screenshots.
 */
export type LocalModelRole = 'judge' | 'housekeeping' | 'agent' | 'vision';

/**
 * A harness the agent qualification runs a model through. A model that passed
 * with at least one carries the `agent` role and names the ones it passed.
 */
export type LocalModelAgentHarness = 'claude-code' | 'codex';

/** Every qualified harness, in the order a badge names them. */
export const LOCAL_MODEL_AGENT_HARNESSES: readonly LocalModelAgentHarness[] = Object.freeze([
	'claude-code',
	'codex',
]);

/** Every role, in the order a Library lists its groups. */
export const LOCAL_MODEL_ROLES: readonly LocalModelRole[] = Object.freeze([
	'agent',
	'housekeeping',
	'judge',
	'vision',
]);

/** Where a model's bytes come from: a Hugging Face repo at a pinned commit. */
export interface LocalModelSource {
	/** Hugging Face repo id, for the "where did this come from" line. */
	readonly repo: string;
	/** The pinned commit. 40 hex characters; `main` is rejected by the tests. */
	readonly revision: string;
}

/** The license a model arrives under. */
export interface LocalModelLicense {
	/**
	 * SPDX identifier as the model card publishes it. A license SPDX does not
	 * list (Gemma, Llama) keeps the card's own name.
	 */
	readonly spdx: string;
	/** Where the full terms are read. */
	readonly url: string;
}

/** A text model's size in billions of parameters. */
export interface LocalModelParameters {
	readonly totalB: number;
	/** Parameters used per token. Equal to `totalB` for a dense model; smaller for a MoE. */
	readonly activeB: number;
}

/**
 * The attention shape that sizes a model's KV cache, read from its GGUF
 * metadata (`<arch>.block_count`, `<arch>.attention.head_count_kv`,
 * `<arch>.attention.key_length`).
 */
export interface LocalModelKvLayout {
	/**
	 * Layers that keep a KV cache for the whole context. For a hybrid model
	 * (linear-attention or sliding-window layers mixed in) this is only the
	 * full-attention layers, since the others hold a small fixed state.
	 */
	readonly layers: number;
	readonly kvHeads: number;
	readonly headDim: number;
}

/** What a model costs in memory, the input to the hardware fit rule. */
export interface LocalModelMemoryHint {
	/** Bytes loaded for the weights: every file of the entry (GGUF parts and any projector). */
	readonly fileBytes: number;
	/** KV cache bytes per 1,024 tokens of context, at f16 keys and values. */
	readonly kvBytesPer1kTokens: number;
	/** The layout `kvBytesPer1kTokens` was computed from. */
	readonly kvLayout: LocalModelKvLayout;
	/**
	 * True when `kvLayout` is the typical shape for a model of this size rather
	 * than the model's own GGUF metadata (a model the user added by hand). The
	 * fit rule says so in its verdict.
	 */
	readonly estimated?: true;
}

export interface LocalClassifierSpec extends LocalEncoderGraph {
	/** Label per output index, in the graph's logit order (the model's `id2label`). */
	readonly labels: readonly string[];
	/** The label that means "flag this". Always one of `labels`. */
	readonly positiveLabel: string;
}

export interface LocalModelEntry {
	/** Stable id. Also the install directory name, so it must be filename-safe. */
	readonly id: string;
	readonly displayName: string;
	readonly kind: LocalModelKind;
	/**
	 * The native runtime that reads this model's weights.
	 *
	 * Recorded on the model rather than on the runtime, so a runtime never has to
	 * know which features exist: a consumer asks "which runtime does this model
	 * need?" and derives its own grouping from the answer.
	 */
	readonly runtime: NativeRuntimeId;
	/** The repo and pinned revision every file is fetched from. */
	readonly source: LocalModelSource;
	readonly license: LocalModelLicense;
	/** One sentence for the bill of materials. */
	readonly description: string;
	/** What the model is good at, in one plain sentence. Shown on its Library row. */
	readonly goodAt: string;
	/** What a text model is fit to do. Present exactly when `kind` is `text-gen`. */
	readonly roles?: readonly LocalModelRole[];
	/**
	 * The harnesses this model passed the agent qualification with, in
	 * `LOCAL_MODEL_AGENT_HARNESSES` order. Present exactly when `roles` has
	 * `agent`: the role is granted by the qualification, never by a model card.
	 */
	readonly agentHarnesses?: readonly LocalModelAgentHarness[];
	/** Present exactly when `kind` is `text-gen`. */
	readonly parameters?: LocalModelParameters;
	/** The context the model was trained for, in tokens. Present exactly when `kind` is `text-gen`. */
	readonly contextLength?: number;
	/**
	 * The context the model server runs it at, in tokens. Never above
	 * `contextLength`, and at least `MODEL_SERVER_AGENT_MIN_CONTEXT` for an
	 * `agent`. Present exactly when `kind` is `text-gen`.
	 */
	readonly defaultContext?: number;
	/** Present exactly when `kind` is `text-gen`. */
	readonly memoryHint?: LocalModelMemoryHint;
	readonly files: readonly LocalModelFile[];
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
	/**
	 * True for a model the user added from Hugging Face. Its revision is pinned
	 * and its files are hashed on download, but against the hash Hugging Face
	 * reports, not one Maestro read and recorded: every surface labels it
	 * `USER_MODEL_UNVERIFIED_LABEL`. Its roles are empty, since nothing was measured.
	 */
	readonly userAdded?: true;
	/** How to run the model. Present exactly when `kind` is `embedding`. */
	readonly embedding?: LocalEmbeddingSpec;
	/** How to run the model. Present exactly when `kind` is `classifier`. */
	readonly classifier?: LocalClassifierSpec;
}
