/**
 * Hugging Face tokenizers for the ONNX model kinds (embeddings, classifiers).
 *
 * An ONNX encoder takes token ids, not text, and the ids have to be the exact
 * ones the model was trained on: a near-miss tokenizer produces a vector that
 * looks healthy and means nothing. So the tokenizer is never re-implemented
 * per model. Every model ships its own `tokenizer.json` (plus, usually, a
 * `tokenizer_config.json`), and `@huggingface/tokenizers` runs it: WordPiece,
 * Unigram and BPE, pure JavaScript, no native code.
 *
 * Three things this module adds on top of the library:
 *
 *   - **Truncation that keeps the special tokens.** The library has none, and
 *     cutting the encoded ids at `maxLength` drops the trailing `[SEP]` / `</s>`
 *     the model expects, which degrades the output silently. Truncation here
 *     shortens the CONTENT and re-wraps it in whatever the model's
 *     post-processor added, so the layout is right for every tokenizer family
 *     without knowing which one it is.
 *   - **Windows for text longer than the model reads.** The same layout lets
 *     {@link LocalTokenizer.encodeWindows} cut a long text into overlapping
 *     windows that are each wrapped correctly, for a classifier that must read
 *     all of a long input rather than its first 512 tokens.
 *   - **Tensors-ready output.** ONNX Runtime wants `int64` inputs, so ids come
 *     back as `BigInt64Array`s rather than number arrays each caller converts,
 *     and {@link LocalTokenizer.encodeBatch} pads a batch into the flat
 *     `[batch, sequence]` layout a tensor is built from.
 *
 * Loaded tokenizers are cached per directory: `tokenizer.json` is large (the
 * bge-small one is 700 KB of vocabulary) and parsing it per call would dwarf
 * the inference it feeds.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Tokenizer } from '@huggingface/tokenizers';

/** The tokenizer definition every Hugging Face model ships. */
export const TOKENIZER_FILENAME = 'tokenizer.json';

/** Optional metadata (special tokens, `model_max_length`). */
export const TOKENIZER_CONFIG_FILENAME = 'tokenizer_config.json';

/**
 * `model_max_length` values at or above this are the transformers library's
 * "no limit recorded" sentinel (it writes `1e30`), not a real window.
 */
const UNBOUNDED_MODEL_MAX_LENGTH = 1_000_000;

export interface TokenizerEncodeOptions {
	/**
	 * Longest sequence to produce, special tokens included. Defaults to the
	 * tokenizer's own `model_max_length` when it records one.
	 */
	maxLength?: number;
	/**
	 * Shorten an over-long input to `maxLength` (default `true`). With `false`
	 * the full sequence is returned, as the Python tokenizers do.
	 */
	truncation?: boolean;
}

export interface TokenizedInput {
	inputIds: BigInt64Array;
	attentionMask: BigInt64Array;
	/** Present when the tokenizer's post-processor assigns segment ids (BERT). */
	tokenTypeIds?: BigInt64Array;
}

/**
 * Several inputs padded to one length, flattened row-major into the
 * `[batchSize, sequenceLength]` layout an ONNX tensor is built from. Padding is
 * on the right and masked out (`attentionMask` 0), so a padded row produces the
 * same states for its real tokens as it would alone.
 */
export interface TokenizedBatch {
	batchSize: number;
	sequenceLength: number;
	inputIds: BigInt64Array;
	attentionMask: BigInt64Array;
	/** Present when the tokenizer assigns segment ids; padding positions are 0. */
	tokenTypeIds?: BigInt64Array;
}

export interface LocalTokenizer {
	/** Directory the tokenizer was loaded from (resolved). */
	readonly dir: string;
	/** The model's own window, or `undefined` when the config records none. */
	readonly modelMaxLength: number | undefined;
	/**
	 * The id padding positions carry. Read from the tokenizer's own padding
	 * block, else its `pad_token`; 0 when it names neither (the positions are
	 * masked out, so the value only has to be a valid id).
	 */
	readonly padTokenId: number;
	encode(text: string, options?: TokenizerEncodeOptions): TokenizedInput;
	/**
	 * How many CONTENT tokens a text is: no special tokens, no truncation. What
	 * a chunker sums to decide where a window ends, so the wrapper a model adds
	 * once per sequence is not counted once per sentence.
	 */
	countTokens(text: string): number;
	/** Encode every text and pad them to the longest. An empty list is an error. */
	encodeBatch(texts: readonly string[], options?: TokenizerEncodeOptions): TokenizedBatch;
	/**
	 * Encode a text as one or more overlapping windows, each at most
	 * `maxLength` tokens and each wrapped in the model's own special tokens.
	 * Truncation would read only the start of a long text; a screen that must
	 * see all of it reads every window instead. A text that fits is one window.
	 */
	encodeWindows(text: string, options: TokenizerWindowOptions): TokenizedInput[];
}

export interface TokenizerWindowOptions {
	/** Longest window, special tokens included. */
	maxLength: number;
	/**
	 * Content tokens each window repeats from the one before it, so a span cut
	 * at a window edge is still read whole by one window. Clamped to under half
	 * a window's content, which keeps the walk moving forward.
	 */
	overlap: number;
}

const cache = new Map<string, Promise<LocalTokenizer>>();

/**
 * Load (once) the tokenizer in a model's install directory.
 *
 * A failed load is not cached, so a model repaired after a bad install is
 * picked up on the next call rather than failing until restart.
 */
export function loadTokenizer(dir: string): Promise<LocalTokenizer> {
	const key = path.resolve(dir);
	const cached = cache.get(key);
	if (cached) return cached;
	const pending = readTokenizer(key);
	cache.set(key, pending);
	pending.catch(() => {
		if (cache.get(key) === pending) cache.delete(key);
	});
	return pending;
}

/**
 * Forget a cached tokenizer (one directory, or all of them). A model's files
 * change on reinstall and removal; the cache must not outlive them.
 */
export function clearTokenizerCache(dir?: string): void {
	if (dir === undefined) cache.clear();
	else cache.delete(path.resolve(dir));
}

async function readTokenizer(dir: string): Promise<LocalTokenizer> {
	const definition = JSON.parse(await fs.readFile(path.join(dir, TOKENIZER_FILENAME), 'utf8'));
	const config = await readOptionalJson(path.join(dir, TOKENIZER_CONFIG_FILENAME));
	return createLocalTokenizer(dir, definition, config);
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	return JSON.parse(raw) as Record<string, unknown>;
}

/** Build a tokenizer from already-parsed files. Exported for tests. */
export function createLocalTokenizer(
	dir: string,
	definition: object,
	config: Record<string, unknown>
): LocalTokenizer {
	const tokenizer = new Tokenizer(definition, config);
	const declared = config.model_max_length;
	const modelMaxLength =
		typeof declared === 'number' && declared > 0 && declared < UNBOUNDED_MODEL_MAX_LENGTH
			? declared
			: undefined;
	const padTokenId = resolvePadTokenId(tokenizer, definition, config);

	const local: LocalTokenizer = {
		dir: path.resolve(dir),
		modelMaxLength,
		padTokenId,
		encode(text, options = {}) {
			const maxLength = options.maxLength ?? modelMaxLength;
			const truncation = options.truncation ?? true;
			const full = tokenizer.encode(text, { return_token_type_ids: true });
			if (!truncation || maxLength === undefined || full.ids.length <= maxLength) {
				return toTokenizedInput(full.ids, full.token_type_ids);
			}
			const content = tokenizer.encode(text, { add_special_tokens: false }).ids;
			const layout = contentLayout(full.ids, content, maxLength);
			const kept = <T>(values: readonly T[]) => sliceContent(values, layout, 0);
			return toTokenizedInput(
				kept(full.ids),
				full.token_type_ids ? kept(full.token_type_ids) : undefined
			);
		},
		countTokens(text) {
			return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
		},
		encodeBatch(texts, options = {}) {
			if (texts.length === 0) throw new Error('Cannot encode an empty batch');
			const rows = texts.map((text) => local.encode(text, options));
			return padTokenizedRows(rows, padTokenId);
		},
		encodeWindows(text, { maxLength, overlap }) {
			const full = tokenizer.encode(text, { return_token_type_ids: true });
			if (full.ids.length <= maxLength) return [toTokenizedInput(full.ids, full.token_type_ids)];
			const content = tokenizer.encode(text, { add_special_tokens: false }).ids;
			const layout = contentLayout(full.ids, content, maxLength);
			const repeat = Math.max(0, Math.min(Math.floor(overlap), Math.ceil(layout.budget / 2) - 1));
			const stride = layout.budget - repeat;
			const windows: TokenizedInput[] = [];
			for (let start = 0; ; start += stride) {
				const slice = <T>(values: readonly T[]) => sliceContent(values, layout, start);
				windows.push(
					toTokenizedInput(
						slice(full.ids),
						full.token_type_ids ? slice(full.token_type_ids) : undefined
					)
				);
				if (start + layout.budget >= content.length) break;
			}
			return windows;
		},
	};
	return local;
}

/** The pad id, from the padding block, else the configured `pad_token`, else 0. */
function resolvePadTokenId(
	tokenizer: Tokenizer,
	definition: object,
	config: Record<string, unknown>
): number {
	const padding = (definition as { padding?: { pad_id?: unknown } | null }).padding;
	if (typeof padding?.pad_id === 'number') return padding.pad_id;
	const declared = config.pad_token;
	// `pad_token` is a bare string in most configs and an AddedToken object in some.
	const token =
		typeof declared === 'string'
			? declared
			: typeof (declared as { content?: unknown } | null)?.content === 'string'
				? (declared as { content: string }).content
				: undefined;
	return (token !== undefined ? tokenizer.token_to_id(token) : undefined) ?? 0;
}

function toTokenizedInput(ids: readonly number[], typeIds?: readonly number[]): TokenizedInput {
	return {
		inputIds: toInt64(ids),
		attentionMask: new BigInt64Array(ids.length).fill(1n),
		...(typeIds ? { tokenTypeIds: toInt64(typeIds) } : {}),
	};
}

/**
 * Pad already-encoded rows into one batch. {@link LocalTokenizer.encodeBatch}
 * is this over freshly encoded texts; a caller holding rows of its own (the
 * windows of one long text) batches them here. An empty list is an error.
 */
export function padTokenizedRows(
	rows: readonly TokenizedInput[],
	padTokenId: number
): TokenizedBatch {
	if (rows.length === 0) throw new Error('Cannot pad an empty batch');
	const sequenceLength = Math.max(...rows.map((row) => row.inputIds.length));
	const size = rows.length * sequenceLength;
	const inputIds = new BigInt64Array(size).fill(BigInt(padTokenId));
	const attentionMask = new BigInt64Array(size);
	// Segment ids are all-or-nothing per tokenizer, so the first row decides.
	const tokenTypeIds = rows[0].tokenTypeIds ? new BigInt64Array(size) : undefined;
	rows.forEach((row, index) => {
		const offset = index * sequenceLength;
		inputIds.set(row.inputIds, offset);
		attentionMask.set(row.attentionMask, offset);
		if (tokenTypeIds && row.tokenTypeIds) tokenTypeIds.set(row.tokenTypeIds, offset);
	});
	return {
		batchSize: rows.length,
		sequenceLength,
		inputIds,
		attentionMask,
		...(tokenTypeIds ? { tokenTypeIds } : {}),
	};
}

/**
 * Where the content sits inside a wrapped sequence, and how much of it fits.
 *
 * A single sequence is post-processed as `prefix + content + suffix` (`[CLS]
 * ... [SEP]`, `<s> ... </s>`, `<bos> ...`), so the prefix length is wherever the
 * content run starts. Everything outside the content is kept on every cut;
 * `budget` is how many content tokens fit beside it in `maxLength`.
 */
interface ContentLayout {
	prefix: number;
	contentEnd: number;
	budget: number;
}

function contentLayout(
	full: readonly number[],
	content: readonly number[],
	maxLength: number
): ContentLayout {
	const specials = full.length - content.length;
	const budget = maxLength - specials;
	if (budget < 1) {
		throw new Error(
			`Tokenizer maxLength ${maxLength} leaves no room for content beside ${specials} special tokens`
		);
	}
	const prefix = findContentStart(full, content);
	return { prefix, contentEnd: prefix + content.length, budget };
}

/**
 * The wrapped sequence with only `budget` content tokens from `start` kept.
 * Applied to the ids and the token type ids alike, so both are cut at exactly
 * the same positions.
 */
function sliceContent<T>(values: readonly T[], layout: ContentLayout, start: number): T[] {
	const from = layout.prefix + start;
	const to = Math.min(from + layout.budget, layout.contentEnd);
	return [
		...values.slice(0, layout.prefix),
		...values.slice(from, to),
		...values.slice(layout.contentEnd),
	];
}

function findContentStart(full: readonly number[], content: readonly number[]): number {
	const specials = full.length - content.length;
	for (let start = 0; start <= specials; start++) {
		let matches = true;
		for (let i = 0; i < content.length; i++) {
			if (full[start + i] !== content[i]) {
				matches = false;
				break;
			}
		}
		if (matches) return start;
	}
	// The post-processor rewrote content tokens rather than wrapping them. No
	// tokenizer in the catalog does that; failing beats truncating the wrong span.
	throw new Error('Tokenizer post-processor does not wrap its content; cannot truncate safely');
}

function toInt64(values: readonly number[]): BigInt64Array {
	const out = new BigInt64Array(values.length);
	for (let i = 0; i < values.length; i++) out[i] = BigInt(values[i]);
	return out;
}
